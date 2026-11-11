import { modelPolicySchema, providerSchema } from "@agentgate/protocol";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { checkRevision, revision } from "../configuration.ts";
import { pkce } from "../credentials.ts";
import * as cursor from "../llm/cursor.ts";
import { resetCooldown } from "../llm/policy.ts";
import { providerLogins } from "../llm/providers.ts";
import { resetRouting } from "../llm/routing.ts";
import { setAccount } from "../operations.ts";
import type { Account, Store } from "../store.ts";
import { controlOp, UserError } from "./registry.ts";

/** The accounts family's control operations. */

const id = z.string().min(1).max(512);
const label = z.string().trim().min(1).max(320); // an account is named by its email until renamed
const expected = z.string().length(64).optional();

function existing(s: Store, accountId: string) {
  const account = s.get("account", accountId);
  if (!account) throw new UserError(`No account ${accountId}`);
  return account;
}

/** Writes one field of an account, refused when `revision` is given and someone else changed the account since. */
function change(s: Store, accountId: string, patch: Partial<Account>, revisionSeen?: string) {
  return s.transaction(() => {
    existing(s, accountId);
    if (revisionSeen) checkRevision(s, "account", accountId, revisionSeen);
    const account = setAccount(s, accountId, patch);
    return { ...account, revision: revision(s, "account", accountId) };
  });
}

/** The words `<id>` and nothing else. */
function justId(args: string[]) {
  const [accountId, ...extra] = args;
  if (!accountId || extra.length) throw new UserError();
  return { input: { id: accountId } };
}

/** `--name value` options after the positional words. A misspelt option fails instead of being ignored. */
function flags<K extends string>(args: string[], names: readonly K[]) {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: Object.fromEntries(names.map((name) => [name, { type: "string" as const }])),
      allowPositionals: true,
      strict: true,
    });
    return { values: values as Partial<Record<K, string>>, positionals };
  } catch (e) {
    throw new UserError(e instanceof Error ? e.message : "");
  }
}

/** The provider adapters throw a plain Error with text written for the user, such as a missing login file or a state
 * that does not match. Anything else, such as a JSON parse error quoting a credentials file, stays hidden. */
async function adapter<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Error && e.constructor === Error) throw new UserError(e.message);
    throw e;
  }
}

controlOp({
  name: "accounts rename",
  summary: "change the name an account is shown with",
  input: z.object({ id, label, revision: expected }).strict(),
  needs: "store",
  run: (input, { s }) => change(s, input.id, { label: input.label }, input.revision),
  terminal: {
    usage: "accounts rename <id> <name>",
    parse(args) {
      const [accountId, ...words] = args;
      if (!accountId || !words.length) throw new UserError();
      return { input: { id: accountId, label: words.join(" ") } };
    },
    print: (a) => [`${a.id} is now called ${a.label}`],
  },
});

controlOp({
  name: "accounts priority",
  summary: "higher is tried first (default 0)",
  input: z.object({ id, priority: z.number().finite(), revision: expected }).strict(),
  needs: "store",
  run: (input, { s }) => change(s, input.id, { priority: input.priority }, input.revision),
  terminal: {
    usage: "accounts priority <id> <n>",
    parse(args) {
      const [accountId, n, ...extra] = args;
      if (!accountId || !n || extra.length) throw new UserError();
      if (!/^-?\d+(\.\d+)?$/.test(n)) throw new UserError(`The priority is a number, such as 10, not ${n}`);
      return { input: { id: accountId, priority: Number(n) } };
    },
    print: (a) => [`${a.id} has priority ${a.priority}`],
  },
});

controlOp({
  name: "accounts policy",
  summary: "the account's retry limit and the models it may or may not serve",
  input: z.object({ id, policy: modelPolicySchema, revision: expected }).strict(),
  needs: "store",
  run: (input, { s }) => change(s, input.id, { policy: input.policy }, input.revision),
  terminal: {
    usage: "accounts policy <id> --file policy.json",
    parse(args, _stdin, cwd) {
      const { values, positionals } = flags(args, ["file"]);
      const [accountId, ...extra] = positionals;
      if (!accountId || !values.file || extra.length) throw new UserError();
      let policy: unknown;
      try {
        policy = JSON.parse(readFileSync(resolve(cwd ?? ".", values.file), "utf8"));
      } catch {
        throw new UserError(`Couldn't read ${values.file} as JSON`);
      }
      return { input: { id: accountId, policy } };
    },
    print: () => ["Policy saved; synchronizes to paired machines"],
  },
});

for (const [name, patch, summary, done] of [
  ["accounts enable", { enabled: true }, "let sessions use an account again", "is enabled"],
  ["accounts disable", { enabled: false }, "keep sessions off an account without removing it", "is disabled"],
  [
    "accounts pin",
    { pinned: true },
    "prefer an account while it has room, instead of choosing automatically",
    "is pinned",
  ],
  ["accounts unpin", { pinned: false }, "go back to choosing the account automatically", "is no longer pinned"],
] as const)
  controlOp({
    name,
    summary,
    input: z.object({ id }).strict(),
    needs: "store",
    run: (input, { s }) => change(s, input.id, patch),
    terminal: { usage: `${name} <id>`, parse: justId, print: (a) => [`${a.id} ${done}`] },
  });

/** Removes the account, its login and usage from every machine, and this machine's state about it. */
export function deleteAccount(s: Store, id: string) {
  s.transaction(() => {
    const provider = s.get("account", id)?.provider;
    for (const kind of ["account", "credential", "usage"] as const) s.del(kind, id);
    s.del("refreshRequest", `credential:${id}`);
    s.setLocal(`refreshError:credential:${id}`, undefined);
    for (const key of ["models", "modelError", "quotaHealth"]) s.setLocal(`${key}:${id}`, undefined);
    resetCooldown(s, id);
    resetRouting(s, id);
    if (provider && s.local(`active:${provider}`) === id) s.setLocal(`active:${provider}`, undefined);
  });
}

controlOp({
  name: "accounts rm",
  summary: "remove an account and its login from every machine",
  input: z.object({ id }).strict(),
  needs: "store",
  run(input, { s }) {
    existing(s, input.id);
    deleteAccount(s, input.id);
    return { id: input.id };
  },
  terminal: { usage: "accounts rm <id>", parse: justId, print: (r) => [`${r.id} deleted`] },
});

// A test aid: the pool skips the account as if it had hit its quota, until a usage refresh or the time runs out.
controlOp({
  name: "accounts exhaust",
  summary: "treat an account as out of quota for a while (for testing)",
  input: z
    .object({
      id,
      minutes: z
        .number()
        .positive()
        .max(7 * 24 * 60),
    })
    .strict(),
  needs: "store",
  run(input, { s }) {
    existing(s, input.id);
    const until = s.now() + input.minutes * 60_000;
    s.put("usage", input.id, {
      accountId: input.id,
      observedAt: s.now(),
      observedBy: s.nodeId,
      windows: [],
      status: "exhausted",
      exhaustedUntil: until,
      source: "manual",
    });
    return input;
  },
  terminal: {
    usage: "accounts exhaust <id> [minutes]",
    parse(args) {
      const [accountId, minutes = "60", ...extra] = args;
      if (!accountId || extra.length || !/^\d+$/.test(minutes)) throw new UserError();
      return { input: { id: accountId, minutes: Number(minutes) } };
    },
    print: (r) => [`${r.id} counts as exhausted for ${r.minutes} minutes`],
  },
});

// Loopback only: it reads a login folder on this machine.
controlOp({
  name: "import",
  summary: "take over an existing login",
  input: z.object({ provider: providerSchema, dir: z.string().min(1).max(4096), label: label.optional() }).strict(),
  needs: "store",
  loopbackOnly: true,
  async run({ provider, dir, label }, { s }) {
    const from = dir.replace(/^~(?=$|\/)/, homedir());
    return { id: await adapter(() => providerLogins[provider].importFrom(s, from, label)) };
  },
  terminal: {
    usage: "import claude|codex|cursor --from <dir> [--label work]",
    parse(args, _stdin, cwd) {
      const { values, positionals } = flags(args, ["from", "label"]);
      const [provider, ...extra] = positionals;
      if (!providerSchema.safeParse(provider).success || extra.length) throw new UserError();
      if (!values.from) throw new UserError("--from <dir> is required");
      const dir = values.from.startsWith("~") ? values.from : resolve(cwd ?? ".", values.from);
      return { input: { provider, dir, ...(values.label !== undefined && { label: values.label }) } };
    },
    print: (r, { input }) => [
      `imported ${r.id}`,
      "",
      `WARNING: agentgate now owns this login. Stop using ${input.dir} directly: its CLI would refresh the token and log agentgate out.`,
    ],
  },
});

/** Browser sign-ins the app started and has not finished, by OAuth state (Cursor: the UUID it polls on). */
const pending = new WeakMap<
  Store,
  Map<string, { provider: z.infer<typeof providerSchema>; verifier: string; label?: string; at: number }>
>();
const LOGIN_TTL = 30 * 60_000;
function attempts(s: Store) {
  let map = pending.get(s);
  if (!map) pending.set(s, (map = new Map()));
  return map;
}

controlOp({
  name: "accounts login start",
  summary: "start a browser sign-in for a new or signed-out account",
  input: z.object({ provider: providerSchema, label: label.optional(), email: z.email().max(320).optional() }).strict(),
  needs: "daemon",
  async run(input, { s }) {
    const map = attempts(s);
    for (const [state, p] of map) if (s.now() - p.at > LOGIN_TTL) map.delete(state);
    if (map.size >= 128) throw new UserError("Too many pending logins");
    const { verifier, challenge, state: oauthState } = await pkce();
    // Cursor names the attempt with a UUID that it polls on, rather than an OAuth state.
    const state = input.provider === "cursor" ? crypto.randomUUID() : oauthState;
    map.set(state, { provider: input.provider, label: input.label, verifier, at: s.now() });
    return {
      state,
      provider: input.provider,
      url: providerLogins[input.provider].authorizeUrl(challenge, state, input.email),
    };
  },
});

controlOp({
  name: "accounts login finish",
  summary: "finish a browser sign-in with the code the provider showed",
  input: z.object({ state: z.string().min(1).max(512), code: z.string().min(1).max(8192).optional() }).strict(),
  needs: "daemon",
  async run(input, { s, daemon }) {
    const map = attempts(s);
    const p = map.get(input.state);
    if (!p || s.now() - p.at > LOGIN_TTL) {
      map.delete(input.state);
      throw new UserError("That login expired; start again");
    }
    const { provider, verifier, label } = p;
    // Cursor has no code to paste: wait for the browser sign-in, and answer `pending` before the app's request times out.
    if (provider === "cursor") {
      const signal = daemon?.abort.signal ?? AbortSignal.timeout(90_000);
      const accountId = await adapter(() => cursor.finish(s, input.state, verifier, label, signal));
      if (accountId) map.delete(input.state);
      return accountId ? { id: accountId } : { pending: true as const };
    }
    map.delete(input.state);
    const { code } = input;
    if (!code) throw new UserError("Paste the code shown after signing in");
    return { id: await adapter(() => providerLogins[provider].exchange(s, code, verifier, label, input.state)) };
  },
});

controlOp({
  name: "accounts login cancel",
  summary: "forget a browser sign-in that was not finished",
  input: z.object({ state: z.string().min(1).max(512) }).strict(),
  needs: "daemon",
  run(input, { s }) {
    attempts(s).delete(input.state);
    return null;
  },
});

/**
 * `agentgate login` runs the provider's own sign-in in the terminal, so it saves the account from the CLI's process.
 * The daemon keeps each account's backoff and session routing in memory, which that process cannot reach; the CLI
 * calls this afterwards so the account is tried again at once.
 */
controlOp({
  name: "accounts signed-in",
  summary: "an account signed in again outside the daemon: forget its backoff and session routing",
  input: z.object({ id }).strict(),
  needs: "daemon",
  run(input, { s }) {
    resetCooldown(s, input.id);
    resetRouting(s, input.id);
    return null;
  },
});
