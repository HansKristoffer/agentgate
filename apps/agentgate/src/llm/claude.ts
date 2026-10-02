import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { tokenRequest, type Tokens } from "../credentials.ts";
import { saveAccount } from "../operations.ts";
import { fetchHeaders } from "../runtime.ts";
import type { Store } from "../store.ts";
import type { Provider, Window } from "./pool.ts";

// Undocumented upstream details, kept in one place (PLAN §16). Mutable so tests can point them at fakes.
export const CLAUDE = {
  api: "https://api.anthropic.com",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  authorizeUrl: "https://claude.com/cai/oauth/authorize",
  redirectUri: "https://platform.claude.com/oauth/code/callback",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  scopes: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins",
  oauthBeta: "oauth-2025-04-20",
  quotaPrefix: "anthropic-ratelimit-unified-",
};

export function toTokens(t: { access_token: string; refresh_token?: string; expires_in?: number }, previousRefresh = ""): Tokens {
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? previousRefresh, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 };
}

/** Claude Code puts the account uuid in metadata.user_id, either as JSON or as `user_…_account_<uuid>_session_…`. */
export function rewriteUserId(userId: string, uuid: string): string {
  try {
    const o = JSON.parse(userId);
    if (o && typeof o === "object" && "account_uuid" in o) return JSON.stringify({ ...o, account_uuid: uuid });
  } catch { }
  return userId.replace(/account_[0-9a-f-]*_/, `account_${uuid}_`);
}

export const claude: Provider = {
  name: "claude",

  prepare(path, headers, body, cred) {
    headers.set("authorization", `Bearer ${cred.accessToken}`);
    const betas = (headers.get("anthropic-beta") ?? "").split(",").map((b) => b.trim()).filter(Boolean);
    if (!betas.includes(CLAUDE.oauthBeta)) headers.set("anthropic-beta", [...betas, CLAUDE.oauthBeta].join(","));
    if (body?.length && cred.accountUuid && headers.get("content-type")?.includes("json")) {
      try {
        const json = JSON.parse(new TextDecoder().decode(body));
        if (typeof json?.metadata?.user_id === "string") {
          json.metadata.user_id = rewriteUserId(json.metadata.user_id, cred.accountUuid);
          body = new TextEncoder().encode(JSON.stringify(json));
        }
      } catch { }
    }
    return { url: CLAUDE.api + path, headers, body };
  },

  usage(h) {
    const windows: Window[] = [];
    h.forEach((value, key) => {
      const m = key.match(new RegExp(`^${CLAUDE.quotaPrefix}(5h|7d(?:_[a-z0-9]+)?)-utilization$`));
      if (!m) return;
      const w = m[1]!;
      const reset = Number(h.get(`${CLAUDE.quotaPrefix}${w}-reset`));
      if (!Number.isFinite(Number(value)) || Number(value) < 0) return;
      const rejected = h.get(`${CLAUDE.quotaPrefix}${w}-status`) === "rejected";
      windows.push({
        name: w.replace("_", ":"),
        usedPct: rejected ? 100 : Math.min(100, Number(value) * 100),
        resetsAt: Number.isFinite(reset) && reset > 0 ? Math.floor(reset * 1000) : undefined,
      });
    });
    const status = h.get(`${CLAUDE.quotaPrefix}status`);
    if (!windows.length && !status) return undefined;
    return { windows, status: status === "rejected" ? "exhausted" : status === "allowed_warning" ? "limited" : "ok" };
  },

  pooled: (path) => path.startsWith("/v1/messages"),

  classify429(h) {
    return h.get(`${CLAUDE.quotaPrefix}status`) === "rejected" ? "quota" : "rate";
  },

  async refresh(refreshToken) {
    const t = await tokenRequest(CLAUDE.tokenUrl, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE.clientId });
    return toTokens(t, refreshToken);
  },
};

/** `email` pre-selects that account on the login page (OAuth login_hint). */
export function authorizeUrl(challenge: string, state: string, email?: string) {
  const q = new URLSearchParams({
    code: "true", client_id: CLAUDE.clientId, response_type: "code", redirect_uri: CLAUDE.redirectUri,
    scope: CLAUDE.scopes, code_challenge: challenge, code_challenge_method: "S256", state, ...(email && { login_hint: email }),
  });
  return `${CLAUDE.authorizeUrl}?${q}`;
}

/** Finish the web login: the callback page shows `code#state`, which the user pastes back. */
export async function exchange(s: Store, pasted: string, verifier: string, label?: string, expectedState?: string) {
  const [code, state] = pasted.trim().split("#");
  if (!code || (expectedState && state !== expectedState)) throw new Error("login state does not match; start again");
  const t = await tokenRequest(CLAUDE.tokenUrl, {
    grant_type: "authorization_code", code: code!, state: state ?? "", client_id: CLAUDE.clientId, redirect_uri: CLAUDE.redirectUri, code_verifier: verifier,
  });
  const id = save(s, toTokens(t), { uuid: t.account?.uuid, email: t.account?.email_address }, label);
  await enrich(s, id);
  return id;
}

function save(s: Store, tokens: Tokens, who: { uuid?: string; email?: string; plan?: string }, label?: string) {
  // Same Claude account logged in twice → same record, fresh tokens.
  const id = `claude-${(who.uuid ?? crypto.randomUUID()).slice(0, 8)}`;
  const prev = s.get("account", id);
  return saveAccount(s, { ...prev, id, provider: "claude", enabled: prev?.enabled ?? true, priority: prev?.priority ?? 0, label: label ?? prev?.label ?? who.email ?? id, email: who.email, plan: who.plan ?? prev?.plan }, { accountId: id, ...tokens, accountUuid: who.uuid, holder: s.nodeId });
}

async function profile(accessToken: string): Promise<{ uuid?: string; email?: string; plan?: string }> {
  const res = await fetchHeaders(`${CLAUDE.api}/api/oauth/profile`, { headers: { authorization: `Bearer ${accessToken}`, "anthropic-beta": CLAUDE.oauthBeta }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) return {};
  const p = (await res.json()) as any;
  return { uuid: p.account?.uuid, email: p.account?.email, plan: p.organization?.organization_type };
}

async function enrich(s: Store, id: string) {
  const credential = s.get("credential", id);
  if (!credential) return;
  const who = await profile(credential.accessToken).catch(() => ({} as { uuid?: string; email?: string; plan?: string }));
  s.transaction(() => {
    const current = s.get("credential", id), account = s.get("account", id);
    if (!current || !account || current.accessToken !== credential.accessToken) return;
    s.put("credential", id, { ...current, accountUuid: who.uuid ?? current.accountUuid });
    s.put("account", id, { ...account, email: who.email ?? account.email, plan: who.plan ?? account.plan });
  });
}

const keychainNames = (dir: string) => [`Claude Code-credentials-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`, "Claude Code-credentials"];

/** Take over a Claude Code login from a config dir (`.credentials.json`, or the macOS Keychain). */
/** Who Claude Code itself is signed in as on this machine. Reads only ~/.claude.json, never the keychain or tokens. */
export function detect(dir = join(homedir(), ".claude")): { email: string; plan?: string } | undefined {
  const file = dir === join(homedir(), ".claude") ? join(homedir(), ".claude.json") : join(dir, ".claude.json");
  try {
    const a = JSON.parse(readFileSync(file, "utf8")).oauthAccount;
    return typeof a?.emailAddress === "string" ? { email: a.emailAddress, plan: typeof a.organizationType === "string" ? a.organizationType : undefined } : undefined;
  } catch { return undefined; }
}

export async function importFrom(s: Store, dir: string, label?: string, cleanupKeychain = false) {
  let raw: string | undefined;
  let cleanupName: string | undefined;
  const file = join(dir, ".credentials.json");
  if (existsSync(file)) raw = await Bun.file(file).text();
  else if (process.platform === "darwin") {
    const isDefault = dir === join(homedir(), ".claude");
    for (const name of isDefault ? keychainNames(dir).slice(1) : keychainNames(dir).slice(0, 1)) {
      const r = Bun.spawnSync(["security", "find-generic-password", "-a", userInfo().username, "-s", name, "-w"], { timeout: 10000 });
      if (r.exitCode === 0) {
        raw = r.stdout.toString().trim();
        if (cleanupKeychain) cleanupName = name;
        break;
      }
    }
  }
  const o = raw && JSON.parse(raw).claudeAiOauth;
  if (!o?.refreshToken) throw new Error(`no Claude login found in ${dir}`);
  const tokens = { accessToken: o.accessToken, refreshToken: o.refreshToken, expiresAt: o.expiresAt };
  // Account info lives in .claude.json: inside the dir when CLAUDE_CONFIG_DIR is set, next to ~/.claude otherwise.
  let who: { uuid?: string; email?: string; plan?: string } = {};
  for (const f of [join(dir, ".claude.json"), join(dir, "..", ".claude.json")]) {
    if (!existsSync(f)) continue;
    const acc = (await Bun.file(f).json()).oauthAccount;
    if (acc?.accountUuid) {
      who = { uuid: acc.accountUuid, email: acc.emailAddress, plan: o.subscriptionType };
      break;
    }
  }
  const id = save(s, tokens, who, label);
  if (cleanupName) Bun.spawnSync(["security", "delete-generic-password", "-a", userInfo().username, "-s", cleanupName], { timeout: 10000 });
  if (!who.uuid) await enrich(s, id);
  return id;
}

/** `agentgate login claude`: the official login in a throwaway config dir, then import and delete it. */
export async function login(s: Store, label?: string) {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-claude-"));
  let imported = false;
  try {
    const p = Bun.spawn(["claude", "auth", "login"], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, stdio: ["inherit", "inherit", "inherit"] });
    if ((await p.exited) !== 0) throw new Error("claude login failed");
    const id = await importFrom(s, dir, label, true); imported = true; return id;
  } catch (e) {
    throw new Error(`Login was not imported: ${e}. Temporary login retained at ${dir}; retry import from that folder.`);
  } finally {
    if (imported) rmSync(dir, { recursive: true, force: true });
  }
}
