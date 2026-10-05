import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { InvalidGrant, jwtClaims, pkce, type Tokens } from "../credentials.ts";
import { saveAccount } from "../operations.ts";
import { fetchHeaders, readBody, sleep } from "../runtime.ts";
import type { Store } from "../store.ts";
import type { Observation, Provider } from "./provider.ts";

// Undocumented upstream details from the Cursor CLI and IDE bundles, kept in one place. Mutable so tests can point them at fakes.
export const CURSOR = {
  api: "https://api2.cursor.sh",
  website: "https://cursor.com",
  clientId: "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB",
  pollMs: 2000,
};

function toTokens(accessToken: string, refreshToken: string): Tokens {
  const exp = jwtClaims(accessToken).exp;
  return { accessToken, refreshToken, expiresAt: typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? Math.floor(exp * 1000) : Date.now() + 3600_000 };
}

/** A Connect unary call to Cursor's dashboard service, in its JSON encoding. */
async function dashboard(method: string, accessToken: string, signal: AbortSignal) {
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "connect-protocol-version": "1", "x-cursor-client-type": "cli" };
  const res = await fetchHeaders(`${CURSOR.api}/aiserver.v1.DashboardService/${method}`, { method: "POST", headers, body: "{}", signal, redirect: "manual" }, 10000);
  if (!res.ok) { await res.body?.cancel(); throw new Error(`Cursor ${method} failed (${res.status})`); }
  return JSON.parse(new TextDecoder().decode(await readBody(res.body, 256 * 1024, signal)));
}

/** Plan usage for the billing cycle. Cursor splits it into auto and API pools; the total is what the account has left. */
export function parseQuota(payload: unknown): Observation | undefined {
  const body = payload as { billingCycleEnd?: unknown; planUsage?: { totalPercentUsed?: unknown } } | null;
  const used = body?.planUsage?.totalPercentUsed;
  if (typeof used !== "number" || !Number.isFinite(used)) return undefined;
  const reset = Number(body?.billingCycleEnd);
  const usedPct = Math.min(100, Math.max(0, used));
  return { windows: [{ name: "month", usedPct, resetsAt: Number.isFinite(reset) && reset > 0 ? reset : undefined, scope: { kind: "account" } }], status: usedPct >= 100 ? "exhausted" : "ok" };
}

/** Agentgate keeps Cursor logins and usage; Cursor's own traffic does not go through the proxy, so nothing routes here. */
export const cursor: Provider = {
  name: "cursor",
  fetchQuota: async (credential, signal) => parseQuota(await dashboard("GetCurrentPeriodUsage", credential.accessToken, signal)),
  prepare(path, headers, body, cred) {
    headers.set("authorization", `Bearer ${cred.accessToken}`);
    return { url: CURSOR.api + path, headers, body };
  },
  usage: () => undefined,
  pooled: () => false,
  classify429: () => "rate",

  async refresh(refreshToken) {
    const res = await fetch(`${CURSOR.api}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: CURSOR.clientId, refresh_token: refreshToken }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = new TextDecoder().decode(await readBody(res.body, 1024 * 1024, AbortSignal.timeout(30_000)));
    const body = (() => { try { return JSON.parse(text) as { access_token?: unknown; shouldLogout?: unknown }; } catch { return {}; } })();
    if (body.shouldLogout === true) throw new InvalidGrant("Cursor ended this login");
    if (!res.ok || typeof body.access_token !== "string" || !body.access_token) throw new Error(`Cursor token endpoint returned ${res.status}`);
    // The IDE keeps the new access token as its refresh token too.
    return toTokens(body.access_token, body.access_token);
  },
};

const pollResponse = z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1) });

/** Where the browser sign-in starts. `uuid` names this attempt when polling; Cursor has no login hint, so `email` is unused. */
export function authorizeUrl(challenge: string, uuid: string, _email?: string) {
  return `${CURSOR.website}/loginDeepControl?${new URLSearchParams({ challenge, uuid, mode: "login", redirectTarget: "cli" })}`;
}

/** Wait up to `ms` for the browser sign-in started at `authorizeUrl`. Undefined when it is not finished yet; poll again. */
export async function finish(s: Store, uuid: string, verifier: string, label: string | undefined, signal: AbortSignal, ms = 90_000): Promise<string | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const res = await fetchHeaders(`${CURSOR.api}/auth/poll?${new URLSearchParams({ uuid, verifier })}`, { headers: { "x-cursor-client-type": "cli" }, signal, redirect: "manual" }, 10000);
    if (res.ok) {
      const t = pollResponse.parse(JSON.parse(new TextDecoder().decode(await readBody(res.body, 64 * 1024, signal))));
      return save(s, toTokens(t.accessToken, t.refreshToken), label);
    }
    await res.body?.cancel();
    // 404 means not signed in yet; Cursor's CLI retries server errors the same way.
    if (res.status !== 404 && res.status < 500) throw new Error(`Cursor sign-in failed (${res.status})`);
    await sleep(Math.min(CURSOR.pollMs, Math.max(0, deadline - Date.now())), signal);
  }
  return undefined;
}

async function save(s: Store, tokens: Tokens, label?: string) {
  const signal = AbortSignal.timeout(10_000);
  const me = await dashboard("GetMe", tokens.accessToken, signal).catch(() => ({})) as { authId?: unknown; email?: unknown };
  const plan = await dashboard("GetPlanInfo", tokens.accessToken, signal).then(p => p?.planInfo?.planName, () => undefined);
  const subject = typeof me.authId === "string" && me.authId ? me.authId : jwtClaims(tokens.accessToken).sub;
  if (typeof subject !== "string" || !subject) throw new Error("Cursor login did not identify the account");
  const email = typeof me.email === "string" && me.email ? me.email : undefined;
  // Same Cursor account signed in twice → same record, fresh tokens.
  const id = `cursor-${new Bun.CryptoHasher("sha256").update(subject).digest("hex").slice(0, 8)}`;
  const prev = s.get("account", id);
  return saveAccount(s, { ...prev, id, provider: "cursor", enabled: prev?.enabled ?? true, priority: prev?.priority ?? 0, label: label ?? prev?.label ?? email ?? id, email: email ?? prev?.email, plan: typeof plan === "string" && plan ? plan : prev?.plan }, { accountId: id, ...tokens, holder: s.nodeId });
}

/** Who the Cursor CLI is signed in as on this machine. Reads only its settings file, never the Keychain or tokens. */
export function detect(file = join(homedir(), ".cursor", "cli-config.json")): { email: string; plan?: string } | undefined {
  try {
    const email = JSON.parse(readFileSync(file, "utf8")).authInfo?.email;
    return typeof email === "string" && email ? { email } : undefined;
  } catch { return undefined; }
}

/** Take over a Cursor CLI login kept in a file (`auth.json`: Linux, or `AGENT_CLI_CREDENTIAL_STORE=file`). */
export async function importFrom(s: Store, dir: string, label?: string) {
  const file = join(dir, "auth.json");
  if (!existsSync(file)) throw new Error(`no auth.json in ${dir} (on macOS the Cursor CLI keeps its login in the Keychain; use agentgate login cursor)`);
  const t = pollResponse.safeParse(await Bun.file(file).json());
  if (!t.success) throw new Error(`${file} has no Cursor login`);
  return save(s, toTokens(t.data.accessToken, t.data.refreshToken), label);
}

/** `agentgate login cursor`: print the sign-in page and wait for it. Works on a headless server too. */
export async function login(s: Store, label?: string) {
  const { verifier, challenge } = await pkce(), uuid = crypto.randomUUID();
  console.log(`Open this page to sign in to Cursor:\n\n  ${authorizeUrl(challenge, uuid)}\n`);
  const id = await finish(s, uuid, verifier, label, AbortSignal.timeout(310_000), 300_000);
  if (!id) throw new Error("Cursor sign-in timed out; start again");
  return id;
}
