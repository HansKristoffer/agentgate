import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { localClaudeLoginSchema } from "@agentgate/protocol";
import { defineLocal } from "./local-state.ts";
import { killGroup } from "./runtime.ts";
import { DEV, liveOnly, type Store } from "./store.ts";

const credentials = z.object({
  claudeAiOauth: z.object({
    loginEnded: z.string().optional(),
    refreshTokenExpiresAt: z.number().optional(),
  }),
});

/** Claude Code owns these files and Keychain entries. Read only; never refresh its tokens. */
export const host = {
  home: homedir(),
  async keychain(service: string) {
    const child = Bun.spawn(["security", "find-generic-password", "-s", service, "-w"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 2_000,
    });
    const [text, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return exit === 0 ? text : undefined;
  },
  async signIn(signal: AbortSignal, onUrl: (url: string) => void, code: Promise<string>) {
    const bin = [join(host.home, ".local/bin/claude"), Bun.which("claude")].find((path) => path && existsSync(path));
    if (!bin) throw new Error("Claude Code is not installed");
    // This is the primary login, even when the daemon was launched from an isolated agent session.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: host.home };
    for (const key of ["CLAUDE_CONFIG_DIR", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"])
      delete env[key];
    signal.throwIfAborted();
    const child = Bun.spawn([bin, "auth", "login", "--claudeai"], {
      env,
      cwd: host.home,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    const stop = () => killGroup(child);
    const timer = setTimeout(stop, 10 * 60_000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    let active = true;
    void code
      .then(async (value) => {
        if (!active || signal.aborted) return;
        child.stdin.write(`${value}\n`);
        await child.stdin.flush();
        child.stdin.end();
      })
      .catch(stop);
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      let text = "";
      for await (const chunk of stream) {
        text = (text + decoder.decode(chunk, { stream: true })).slice(-16_384);
        const url = text.match(
          /https:\/\/(?:claude\.com|claude\.ai)\/(?:cai\/)?oauth\/authorize\?[^\s\x1b]+(?=[\s\x1b])/,
        )?.[0];
        if (url) onUrl(url);
      }
    };
    try {
      const [exit] = await Promise.all([child.exited, read(child.stdout), read(child.stderr)]);
      return exit === 0;
    } catch {
      stop();
      await child.exited;
      return false;
    } finally {
      active = false;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    }
  },
};

async function readLocalClaudeLogin(s: Store) {
  if (DEV && host.home === homedir()) return undefined;
  const dir = join(host.home, ".claude");
  let email: string | undefined;
  try {
    email = z
      .email()
      .safeParse(JSON.parse(readFileSync(join(host.home, ".claude.json"), "utf8")).oauthAccount?.emailAddress).data;
  } catch {
    /* The terminal marker still matters when the identity file is missing. */
  }
  try {
    const file = join(dir, ".credentials.json");
    let raw = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    if (!raw && process.platform === "darwin") {
      const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
      raw =
        (await host.keychain(`Claude Code-credentials-${hash}`)) ?? (await host.keychain("Claude Code-credentials"));
    }
    const oauth = raw && credentials.safeParse(JSON.parse(raw)).data?.claudeAiOauth;
    // An expired access token can still refresh. Only a terminal marker or refresh expiry requires the user.
    if (
      oauth &&
      (oauth.loginEnded ||
        (oauth.refreshTokenExpiresAt && oauth.refreshTokenExpiresAt > 0 && oauth.refreshTokenExpiresAt <= s.now()))
    )
      return { email, state: "needs-login" as const };
  } catch {
    // Missing, locked or unfamiliar credentials are unknown, not proof that a login failed.
  }
  return undefined;
}

const state = defineLocal("claudeCode:login", localClaudeLoginSchema, { topic: "status" });
const checks = new WeakMap<Store, { home: string; at: number; task: Promise<void> }>();
const running = new WeakMap<
  Store,
  { controller: AbortController; ready: Promise<string>; task: Promise<void>; code: (value: string) => void }
>();

/** Cached status contains only identity and health; secrets never enter the store, the API or sync. */
export async function localClaudeLogin(s: Store) {
  if (!running.has(s)) {
    let check = checks.get(s);
    if (!check || check.home !== host.home || s.now() - check.at >= 30_000) {
      check = { home: host.home, at: s.now(), task: Promise.resolve() };
      const current = check;
      check.task = readLocalClaudeLogin(s).then((value) => {
        if (checks.get(s) === current && !running.has(s)) state.set(s, undefined, value);
      });
      checks.set(s, check);
    }
    await check.task;
  }
  return state.get(s);
}

/** The official CLI saves its own primary login. It never imports that rotating token into the pool. */
export async function startLocalClaudeLogin(s: Store, signal: AbortSignal, pending: Set<Promise<void>>) {
  if (host.home === homedir()) liveOnly("Signing in to this machine's Claude Code");
  let flight = running.get(s);
  if (!flight) {
    const controller = new AbortController();
    let resolve!: (url: string) => void, reject!: (error: Error) => void;
    const ready = new Promise<string>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const previous = state.get(s);
    let submit!: (value: string) => void;
    const code = new Promise<string>((resolve) => {
      submit = resolve;
    });
    state.set(s, undefined, { email: previous?.email, state: "signing-in" });
    const stop = () => controller.abort();
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const timer = setTimeout(() => {
      reject(new Error("Claude Code did not open its login page. Try again."));
      stop();
    }, 15_000);
    const task = (async () => {
      try {
        const ok = await host.signIn(
          controller.signal,
          (url) => {
            clearTimeout(timer);
            resolve(url);
          },
          code,
        );
        if (!ok) throw new Error("sign-in did not finish");
      } catch {
        state.set(s, undefined, {
          email: previous?.email,
          state: "needs-login",
          error: "Claude Code sign-in did not finish. Try again.",
        });
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        reject(new Error("Claude Code sign-in did not finish. Try again."));
        running.delete(s);
        checks.delete(s);
        // A successful sign-in clears the problem as soon as the CLI finishes.
        if (state.get(s)?.state === "signing-in") await localClaudeLogin(s);
      }
    })();
    flight = { controller, ready, task, code: submit };
    running.set(s, flight);
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
  }
  return { url: await flight.ready, opened: process.platform === "darwin" };
}

export async function finishLocalClaudeLogin(s: Store, code: string) {
  const flight = running.get(s);
  if (!flight) throw new Error("Start Claude Code sign-in again");
  flight.code(code);
  await flight.task;
  if (state.get(s)?.state === "needs-login") throw new Error("Claude Code sign-in did not finish. Try again.");
}

export async function cancelLocalClaudeLogin(s: Store) {
  const flight = running.get(s);
  if (!flight) return;
  flight.controller.abort();
  await flight.task;
  checks.delete(s);
  await localClaudeLogin(s);
}
