import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jwtClaims, tokenRequest, type Tokens } from "../credentials.ts";
import { saveAccount } from "../operations.ts";
import type { Store } from "../store.ts";
import type { Provider, Window } from "./pool.ts";

// Undocumented upstream details, kept in one place (PLAN §16). Mutable so tests can point them at fakes.
export const CODEX = {
  api: "https://chatgpt.com",
  tokenUrl: "https://auth.openai.com/oauth/token",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  redirectUri: "http://localhost:1455/auth/callback",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  accountHeader: "chatgpt-account-id",
};

const AUTH_CLAIM = "https://api.openai.com/auth";

function toTokens(t: { access_token: string; refresh_token?: string }, previousRefresh = ""): Tokens {
  const exp = jwtClaims(t.access_token).exp;
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? previousRefresh, expiresAt: typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? Math.floor(exp * 1000) : Date.now() + 3600_000 };
}

/** Windows are named by their length, never by the primary/secondary slot they arrive in. */
function windowName(minutes: number, family: string): string {
  const base = minutes <= 6 * 60 ? "5h" : minutes >= 6 * 24 * 60 ? "7d" : `${minutes}m`;
  const extra = family.replace(/^codex-?/, "");
  return extra ? `${base}:${extra}` : base;
}

export const codex: Provider = {
  name: "codex",

  prepare(path, headers, body, cred) {
    headers.set("authorization", `Bearer ${cred.accessToken}`);
    if (cred.chatgptAccountId) headers.set(CODEX.accountHeader, cred.chatgptAccountId);
    return { url: CODEX.api + path, headers, body };
  },

  usage(h) {
    const windows: Window[] = [];
    h.forEach((value, key) => {
      const m = key.match(/^x-(.+)-(primary|secondary)-used-percent$/);
      if (!m) return;
      const p = `x-${m[1]}-${m[2]}`;
      const minutes = Number(h.get(`${p}-window-minutes`) ?? 0);
      const resetAt = Number(h.get(`${p}-reset-at`) ?? 0);
      const after = Number(h.get(`${p}-reset-after-seconds`) ?? 0);
      if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isFinite(Number(value)) || Number(value) < 0) return;
      windows.push({
        name: windowName(minutes, m[1]!),
        usedPct: Math.min(100, Number(value)),
        resetsAt: Number.isFinite(resetAt) && resetAt > 0 ? Math.floor(resetAt * 1000) : Number.isFinite(after) && after > 0 ? Date.now() + Math.floor(after * 1000) : undefined,
      });
    });
    if (!windows.length) return undefined;
    const max = Math.max(...windows.map((w) => w.usedPct));
    return { windows, status: max >= 100 ? "exhausted" : max >= 90 ? "limited" : "ok" };
  },

  pooled: () => true,

  classify429(h, body) {
    if (/usage_limit_reached|usage_not_included/.test(body)) return "quota";
    return (this.usage(h)?.status ?? "ok") === "exhausted" ? "quota" : "rate";
  },

  async refresh(refreshToken) {
    const t = await tokenRequest(CODEX.tokenUrl, { client_id: CODEX.clientId, grant_type: "refresh_token", refresh_token: refreshToken, scope: "openid profile email" });
    return toTokens(t, refreshToken);
  },
};

export function authorizeUrl(challenge: string, state: string) {
  const q = new URLSearchParams({
    response_type: "code", client_id: CODEX.clientId, redirect_uri: CODEX.redirectUri, scope: "openid profile email offline_access",
    code_challenge: challenge, code_challenge_method: "S256", id_token_add_organizations: "true", codex_cli_simplified_flow: "true",
    state, originator: "codex_cli_rs",
  });
  return `${CODEX.authorizeUrl}?${q}`;
}

/** Finish the web login: the browser lands on a localhost URL that won't load; the user pastes that URL back. */
export async function exchange(s: Store, pasted: string, verifier: string, label?: string, expectedState?: string) {
  const callback = pasted.includes("code=") ? new URL(pasted.trim()) : undefined;
  if (expectedState && callback?.searchParams.get("state") !== expectedState) throw new Error("login state does not match; paste the full callback URL");
  const code = callback?.searchParams.get("code") ?? pasted.trim();
  if (!code) throw new Error("no authorization code");
  const t = await tokenRequest(CODEX.tokenUrl, { grant_type: "authorization_code", code, redirect_uri: CODEX.redirectUri, client_id: CODEX.clientId, code_verifier: verifier }, true);
  return save(s, t, label);
}

function save(s: Store, t: { id_token?: string; access_token: string; refresh_token?: string; account_id?: string }, label?: string) {
  if (!t.refresh_token) throw new Error("login did not issue a refresh token");
  const claims = jwtClaims(t.id_token ?? "");
  const auth = claims[AUTH_CLAIM] ?? jwtClaims(t.access_token)[AUTH_CLAIM] ?? {};
  const chatgptAccountId: string | undefined = t.account_id ?? auth.chatgpt_account_id;
  const email: string | undefined = claims.email;
  const id = `codex-${(chatgptAccountId ?? crypto.randomUUID()).replace(/-/g, "").slice(0, 8)}${email ? "-" + email.split("@")[0]!.replace(/\W/g, "").slice(0, 8) : ""}`;
  const prev = s.get("account", id);
  return saveAccount(s, { ...prev, id, provider: "codex", enabled: prev?.enabled ?? true, priority: prev?.priority ?? 0, label: label ?? prev?.label ?? email ?? id, email, plan: auth.chatgpt_plan_type }, { accountId: id, ...toTokens(t), chatgptAccountId, holder: s.nodeId });
}

/** Take over a Codex login from a CODEX_HOME (`auth.json`). */
export async function importFrom(s: Store, dir: string, label?: string) {
  const file = join(dir, "auth.json");
  if (!existsSync(file)) throw new Error(`no auth.json in ${dir} (Codex may keep it in the OS keyring; set cli_auth_credentials_store = "file")`);
  const auth = await Bun.file(file).json();
  if (!auth.tokens?.refresh_token) throw new Error(`${file} has no ChatGPT login`);
  return save(s, auth.tokens, label);
}

/** `agentgate login codex`: the official login in a throwaway CODEX_HOME, then import and delete it. */
export async function login(s: Store, label?: string) {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-codex-"));
  let imported = false;
  try {
    writeFileSync(join(dir, "config.toml"), 'cli_auth_credentials_store = "file"\n');
    const p = Bun.spawn(["codex", "login"], { env: { ...process.env, CODEX_HOME: dir }, stdio: ["inherit", "inherit", "inherit"] });
    if ((await p.exited) !== 0) throw new Error("codex login failed");
    const id = await importFrom(s, dir, label); imported = true; return id;
  } catch (e) {
    throw new Error(`Login was not imported: ${e}. Temporary login retained at ${dir}; retry import from that folder.`);
  } finally {
    if (imported) rmSync(dir, { recursive: true, force: true });
  }
}
