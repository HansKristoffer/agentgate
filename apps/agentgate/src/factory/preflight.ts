import { homedir } from "node:os";
import { z } from "zod";
import type { FactoryCheck } from "@agentgate/protocol";
import { PeerError } from "../handoff/jobs.ts";
import { claudeHomes, host as t3Host, t3Client, t3State, T3Error } from "../handoff/t3.ts";
import { fetchHeaders, readBody } from "../runtime.ts";
import { claudeStatus, codexStatus, PRIMARY_CLAUDE_DIR, PRIMARY_CODEX_DIR } from "../setup.ts";
import { lastSeen } from "../sync.ts";
import { runCanary } from "./canary.ts";
import { currentFolder } from "./config.ts";
import {
  logError,
  operation,
  toFactoryMachine,
  UsageError,
  type Caller,
  type CheckSource,
  type FactoryRuntime,
} from "./runtime.ts";

/**
 * The preflight: what the factory needs, each check with its fix. Each feature registers the checks it owns
 * (`f.checks`); this file runs them for `agentgate factory doctor` and the board, and owns the checks of this
 * machine's T3 Code, which no factory feature does. The checks that ask gh or T3 Code are `slow`: the board shows their
 * last answer, which the loop below refreshes and `doctor` asks again, so the board never waits for them.
 */

/** How old the slow checks' answers may get before the loop asks again. */
const FRESH_FOR = 5 * 60_000;

const memory = (f: FactoryRuntime) =>
  f.memory("preflight", () => ({
    last: new Map<CheckSource, { at: number; checks: FactoryCheck[] }>(),
    refreshing: undefined as Promise<void> | undefined,
  }));

/** A source's checks, or one row that says it failed, by the error's name only: its text could hold anything. */
async function checksOf(source: CheckSource): Promise<FactoryCheck[]> {
  try {
    return await source.run();
  } catch (e) {
    return [{ id: source.name, title: source.name, state: "unknown", detail: `the check failed: ${logError(e)}` }];
  }
}

/** Asks every slow source again; one refresh at a time. */
function refresh(f: FactoryRuntime): Promise<void> {
  const m = memory(f);
  m.refreshing ??= Promise.all(
    f.checks
      .filter((source) => source.slow)
      .map(async (source) => void m.last.set(source, { at: f.s.now(), checks: await checksOf(source) })),
  ).then(
    () => void (m.refreshing = undefined),
    () => void (m.refreshing = undefined),
  );
  return m.refreshing;
}

/** Every check, in the order the features registered them. `fresh` asks the slow ones again first; otherwise they are
 * their last answer, none before the first. */
export async function preflight(f: FactoryRuntime, { fresh }: { fresh: boolean }): Promise<FactoryCheck[]> {
  if (fresh) await refresh(f);
  const { last } = memory(f);
  const lists = await Promise.all(
    f.checks.map((source) => (source.slow ? (last.get(source)?.checks ?? []) : checksOf(source))),
  );
  return lists.flat();
}

/** What a machine says when the factory machine does not answer it: its board and `doctor` are then only its own. */
export function unreachableCheck(f: FactoryRuntime, node: string): FactoryCheck {
  const seen = lastSeen(f.s, node);
  return {
    id: "factory-machine",
    title: `The factory machine ${node} answers`,
    state: "fail",
    detail: `${node} did not answer ${f.s.nodeId}, or runs a release without the factory${seen ? `; last seen ${new Date(seen).toISOString()}` : ""}. Until it does, nothing here shows its items`,
    fix: `start or update agentgate on ${node}; or run the factory elsewhere with agentgate factory move <machine> --now`,
  };
}

// ---- this machine's T3 Code

const home = (dir: string) => (dir.startsWith(homedir()) ? `~${dir.slice(homedir().length)}` : dir);

function t3Connection(f: FactoryRuntime): FactoryCheck[] {
  const t3 = t3State(f.s);
  const check = { id: "t3", title: "T3 Code is connected" };
  if (!t3.url) return [{ ...check, state: "fail", detail: `not on ${f.s.nodeId}`, fix: "agentgate t3 connect" }];
  if (!t3.connected)
    return [{ ...check, state: "fail", detail: "agentgate's token expired", fix: "agentgate t3 connect" }];
  if (t3.repair)
    return [
      {
        ...check,
        state: "warn",
        detail: `agentgate's token ends ${new Date(t3.expiresAt ?? 0).toISOString()}`,
        fix: "agentgate t3 connect",
      },
    ];
  return [{ ...check, state: "ok", detail: t3.label ?? t3.url }];
}

/** The version the running T3 Code says it is, from its unauthenticated descriptor; undefined when it does not say. */
async function serverVersion(url: string) {
  try {
    const res = await fetchHeaders(`${url}/.well-known/t3/environment`, {}, 5000);
    const text = new TextDecoder().decode(await readBody(res.body, 64 * 1024, AbortSignal.timeout(5000)));
    const parsed = z.object({ serverVersion: z.string().min(1) }).safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.serverVersion.replace(/^v/, "") : undefined;
  } catch {
    return undefined; // not reachable, or not JSON: the connection check says the first
  }
}

/**
 * The `t3` the factory runs for its MCP sign-in (`t3 pair`) against the running server's version (B2): an older `t3`
 * mints pairing codes the server refuses. A server's own binary lives under `runtime/versions/<version>/t3`, so its
 * path names its version; a `t3` from elsewhere is not run to ask, and is only a warning.
 */
async function t3Binary(f: FactoryRuntime): Promise<FactoryCheck[]> {
  const check = { id: "t3-binary", title: "agentgate's t3 is the running T3 Code's own" };
  const bin = t3Host.t3();
  if (!bin)
    return [
      {
        ...check,
        state: "fail",
        detail: "no t3 command on this machine; the factory's sign-in to T3 Code's MCP runs t3 pair",
        fix: "open T3 Code on this machine once, or put its t3 on PATH",
      },
    ];
  const url = t3State(f.s).url;
  const server = url ? await serverVersion(url) : undefined;
  if (!server) return [{ ...check, state: "unknown", detail: `uses ${bin}; T3 Code did not say which version runs` }];
  const own = /\/runtime\/versions\/([^/]+)\/t3$/.exec(bin)?.[1]?.replace(/^v/, "");
  if (own === server) return [{ ...check, state: "ok", detail: `${server} at ${bin}` }];
  const fix = `put T3 Code ${server}'s own t3 first on PATH, or set T3CODE_HOME to the T3 Code folder that runs it`;
  return own
    ? [{ ...check, state: "fail", detail: `${bin} is ${own}, but T3 Code runs ${server}`, fix }]
    : [
        {
          ...check,
          state: "warn",
          detail: `${bin} may not be T3 Code ${server}'s, whose pairing codes it accepts`,
          fix,
        },
      ];
}

const cleanupRules = z
  .object({
    worktreeAfterDays: z.number().nullable().optional(),
    worktreeOnMerge: z.boolean().optional(),
    worktreeOnDelete: z.boolean().optional(),
    worktreeUnchanged: z.boolean().optional(),
  })
  .passthrough();
/** T3 Code's worktree cleanup as its `ServerSettings` holds it (October 2026): `worktreeCleanup` turns it off or sets
 * rules of its own, and otherwise `storageCleanup` holds them. Project overrides are not read. */
const t3Settings = z
  .object({
    settings: z
      .object({
        worktreeCleanup: z
          .union([
            z.object({ mode: z.literal("off") }).passthrough(),
            z.object({ mode: z.literal("custom"), rules: cleanupRules }).passthrough(),
          ])
          .nullable()
          .optional(),
        storageCleanup: cleanupRules.optional(),
      })
      .passthrough(),
  })
  .passthrough();

const CLEANUP = { id: "t3-worktrees", title: "T3 Code removes the factory's old worktrees" };

/** Each stage makes a worktree, and T3 Code keeps every one unless a cleanup rule removes them. */
function worktreeCleanup(config: unknown): FactoryCheck {
  const check = CLEANUP;
  const fix = "turn on Settings → Worktree cleanup in T3 Code";
  const parsed = t3Settings.safeParse(config);
  const { worktreeCleanup: own, storageCleanup } = parsed.success ? parsed.data.settings : {};
  if (own?.mode === "off") return { ...check, state: "warn", detail: "worktree cleanup is off", fix };
  const rules = own?.mode === "custom" ? own.rules : storageCleanup;
  if (!rules)
    return { ...check, state: "unknown", detail: "T3 Code's settings do not say; each stage makes a worktree", fix };
  const { worktreeAfterDays, worktreeOnMerge, worktreeOnDelete, worktreeUnchanged } = rules;
  if (worktreeAfterDays || worktreeOnMerge || worktreeOnDelete || worktreeUnchanged) return { ...check, state: "ok" };
  return { ...check, state: "warn", detail: "T3 Code keeps every worktree, and each stage makes one", fix };
}

/**
 * What the provider homes T3 Code runs sessions in hold: agentgate's MCP server, without which a factory thread cannot
 * report, and this daemon's proxy, without which the tokens of its items read 0 and `limits.itemTokens` cannot hold.
 * Claude's homes come from T3 Code's settings; Codex's is its default home, read when the folder names a Codex model.
 * One RPC to T3 Code, which also answers the worktree cleanup.
 */
async function t3Homes(f: FactoryRuntime): Promise<FactoryCheck[]> {
  const mcpCheck = { id: "mcp", title: "agentgate's MCP server is in every provider home T3 Code uses" };
  const proxyCheck = { id: "proxy", title: "T3 Code's sessions pass through this machine's proxy" };
  let read: { config: unknown; homes: [string, string][] };
  try {
    read = await t3Client(f.s).rpc(async (call) => ({
      config: await call("server.getConfig", {}),
      homes: await claudeHomes(call, f.ctx.handoffs.options.claudeDir),
    }));
  } catch (e) {
    const detail = `T3 Code's settings could not be read: ${e instanceof T3Error ? e.message : logError(e)}`;
    return [mcpCheck, proxyCheck, CLEANUP].map((check) => ({ ...check, state: "unknown", detail }));
  }
  const folder = currentFolder(f);
  const models = [
    ...Object.values(folder?.stages ?? {}).map((stage) => stage.file.model),
    ...(folder?.config.sources ?? []).map((source) => (source.type === "scout" ? source.model : undefined)),
  ];
  const homes = [
    ...[...new Set(read.homes.map(([, dir]) => dir))].map((dir) => ({ dir, codex: false, ...claudeStatus(dir) })),
    ...(models.some((m) => m?.provider.toLowerCase().includes("codex"))
      ? [{ dir: PRIMARY_CODEX_DIR, codex: true, ...codexStatus(PRIMARY_CODEX_DIR) }]
      : []),
  ];
  const listed = (list: typeof homes) => list.map((h) => home(h.dir)).join(", ");
  const noMcp = homes.filter((h) => !h.mcp);
  const unrouted = homes.filter((h) => !h.routing);
  const mcpFix = noMcp.map((h) =>
    h.codex
      ? "agentgate setup --primary for Codex"
      : h.dir === PRIMARY_CLAUDE_DIR
        ? "agentgate setup --mcp"
        : `copy the agentgate entry of mcpServers in ~/.claude.json into ${home(h.dir)}/.claude.json`,
  );
  return [
    noMcp.length
      ? {
          ...mcpCheck,
          state: "fail",
          detail: `missing from ${listed(noMcp)}, so a factory thread there cannot report`,
          fix: mcpFix.join("; "),
        }
      : { ...mcpCheck, state: "ok", detail: listed(homes) },
    unrouted.length
      ? {
          ...proxyCheck,
          state: "warn",
          detail: `${listed(unrouted)} ${unrouted.length === 1 ? "goes" : "go"} to the provider directly, so items' tokens read 0 and limits.itemTokens is not enforced`,
          fix: "agentgate setup --primary",
        }
      : { ...proxyCheck, state: "ok" },
    worktreeCleanup(read.config),
  ];
}

// ---- doctor

export interface DoctorResult {
  checks: FactoryCheck[];
}

/** `doctor`: the factory machine's preflight, asked again now. Another machine asks the factory machine for it, and
 * says so when that machine does not answer. The canary starts its thread where the factory runs, so it is run
 * there: a forwarded call would end before the thread could report. */
async function doctor(f: FactoryRuntime, input: { canary?: boolean }, caller: Caller): Promise<DoctorResult> {
  const pointer = f.pointer();
  const forward = toFactoryMachine(f);
  if (pointer && forward) {
    if (input.canary)
      throw new Error(`The canary starts a thread on ${pointer.node}: run agentgate factory doctor --canary there`);
    try {
      return (await forward({ name: "doctor", input, caller })) as DoctorResult;
    } catch (e) {
      if (e instanceof PeerError) throw e;
      return { checks: [unreachableCheck(f, pointer.node)] };
    }
  }
  const off: FactoryCheck[] = pointer
    ? []
    : [
        {
          id: "factory",
          title: "The factory is on",
          state: "unknown",
          detail: `it is off, so these are ${f.s.nodeId}'s own checks`,
          fix: "agentgate factory init <owner/repo>",
        },
      ];
  const checks = [...off, ...(await preflight(f, { fresh: true }))];
  if (input.canary) checks.push(await runCanary(f));
  return { checks };
}

const LABELS = { ok: "ok", warn: "warn", fail: "FAIL", unknown: "?" } as const;

/** The checks for a terminal, each with its fix unless it passed, then a count. */
export function doctorText(checks: FactoryCheck[]): string[] {
  const lines = checks.flatMap((c) => [
    `${LABELS[c.state].padEnd(4)}  ${c.title}${c.detail ? `: ${c.detail}` : ""}`,
    ...(c.fix && c.state !== "ok" ? [`      fix: ${c.fix}`] : []),
  ]);
  const count = (state: FactoryCheck["state"]) => checks.filter((c) => c.state === state).length;
  const [failing, warnings] = [count("fail"), count("warn")];
  lines.push(
    "",
    failing || warnings
      ? `${failing} failing, ${warnings} ${warnings === 1 ? "warning" : "warnings"}.`
      : "Nothing failing.",
  );
  return lines;
}

export function setup(f: FactoryRuntime): void {
  f.checks.push(
    { name: "T3 Code", run: () => t3Connection(f) },
    { name: "T3 Code's t3", slow: true, run: () => t3Binary(f) },
    { name: "T3 Code's settings", slow: true, run: () => t3Homes(f) },
  );
  // Asks again once the last answers are old, and soon after the factory turns on here.
  f.loops.push({
    name: "factory-preflight",
    everyMs: 30_000,
    where: "factory-node",
    async run() {
      const { last } = memory(f);
      const stale = f.checks.some((c) => c.slow && f.s.now() - (last.get(c)?.at ?? -Infinity) >= FRESH_FOR);
      if (stale) await refresh(f);
    },
  });
  operation(f, {
    name: "doctor",
    summary: "check what the factory needs, each with its fix; --canary also runs one short thread that only reports",
    input: z.object({ canary: z.boolean().optional() }),
    local: true,
    run: (input, caller) => doctor(f, input, caller),
    terminal: {
      usage: "doctor [--canary] [--json]",
      parse(args) {
        if (args.some((a) => a !== "--canary" && a !== "--json")) throw new UsageError();
        return { input: { ...(args.includes("--canary") && { canary: true }) }, json: args.includes("--json") };
      },
      print: ({ checks }, { json }) => ({
        lines: json ? [JSON.stringify(checks, null, 2)] : doctorText(checks),
        code: checks.some((c) => c.state === "fail") ? 1 : 0,
      }),
    },
  });
}
