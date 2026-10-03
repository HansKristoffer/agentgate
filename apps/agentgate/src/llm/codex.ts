import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { jwtClaims, tokenRequest, type Tokens } from "../credentials.ts";
import { saveAccount } from "../operations.ts";
import type { Store } from "../store.ts";
import type { Observation, Provider, Window } from "./provider.ts";
import { fetchHeaders, readBody } from "../runtime.ts";

// Undocumented upstream details, kept in one place (PLAN §16). Mutable so tests can point them at fakes.
export const CODEX = {
  api: "https://chatgpt.com",
  usagePath: "/backend-api/wham/usage",
  modelsPath: "/backend-api/codex/models?client_version=0.149.1",
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
  const base = minutes === 300 ? "5h" : minutes === 10080 ? "7d" : `${minutes}m`;
  const extra = family.replace(/^codex-?/, "");
  return extra ? `${base}:${extra}` : base;
}

export const codex: Provider = {
  name: "codex",
  modelList: path => /^\/backend-api\/codex\/models(?:\?|$)/.test(path) ? { collection: "models", id: "slug" } : undefined,
  fetchQuota: async (credential, signal) => parseQuota(await readCodex(CODEX.usagePath, credential, signal)),
  discoverModels: async (credential, signal) => {
    const payload = await readCodex(CODEX.modelsPath, credential, signal);
    const models = payload.models ?? payload.data;
    if (!Array.isArray(models)) throw new Error("Unrecognized model response");
    return models.flatMap((m: { slug?: unknown; id?: unknown }) => typeof (m.slug ?? m.id) === "string" ? [String(m.slug ?? m.id)] : []);
  },
  session: headers => {
    const id = headers.get("session_id") ?? headers.get("x-codex-session-id");
    return id && id.length <= 128 ? new Bun.CryptoHasher("sha256").update(id).digest("hex") : undefined;
  },
  stateful: body => typeof body?.previous_response_id === "string" && !!body.previous_response_id,
  classifyFailure: (status, _headers, body) => (status === 404 || status === 400) && /model_not_found|model_not_supported/.test(body) ? "model" : status >= 500 ? "transient" : "request",
  probe: { path: "/backend-api/codex/responses", body: model => ({ model, instructions: "Reply OK", input: [{ role: "user", content: [{ type: "input_text", text: "Reply OK" }] }], stream: true, store: false }) },

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

async function readCodex(path: string, credential: import("../store.ts").Credential, signal: AbortSignal) {
  const headers = new Headers({ authorization: `Bearer ${credential.accessToken}`, accept: "application/json" });
  if (credential.chatgptAccountId) headers.set(CODEX.accountHeader, credential.chatgptAccountId);
  const result = await fetchHeaders(CODEX.api + path, { headers, signal, redirect: "manual" }, 10000);
  if (!result.ok) { await result.body?.cancel(); throw new Error("Codex read-only check failed"); }
  return JSON.parse(new TextDecoder().decode(await readBody(result.body, 256 * 1024, signal)));
}
export function parseQuota(payload: unknown): Observation | undefined {
  const object = payload as { rate_limit?: { primary_window?: unknown; secondary_window?: unknown }; additional_rate_limits?: { limit_name?: string; rate_limit?: { primary_window?: unknown; secondary_window?: unknown } }[] } | null;
  if (!object || typeof object !== "object") return undefined;
  const windows: Window[] = [];
  const add = (raw: unknown, family = "") => {
    const w = raw as { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown; reset_after_seconds?: unknown } | null;
    if (!w || typeof w.used_percent !== "number" || !Number.isFinite(w.used_percent) || w.used_percent < 0 || typeof w.limit_window_seconds !== "number" || !Number.isFinite(w.limit_window_seconds) || w.limit_window_seconds <= 0) return;
    const duration = w.limit_window_seconds * 1000;
    const reset = typeof w.reset_at === "number" && Number.isFinite(w.reset_at) && w.reset_at > 0 ? w.reset_at * 1000 : typeof w.reset_after_seconds === "number" && Number.isFinite(w.reset_after_seconds) && w.reset_after_seconds > 0 ? Date.now() + w.reset_after_seconds * 1000 : undefined;
    windows.push({ name: windowName(w.limit_window_seconds / 60, family), durationMs: duration, scope: family ? { kind: "model", model: family } : { kind: "account" }, usedPct: Math.min(100, w.used_percent), resetsAt: reset });
  };
  add(object.rate_limit?.primary_window); add(object.rate_limit?.secondary_window);
  for (const entry of Array.isArray(object.additional_rate_limits) ? object.additional_rate_limits : []) {
    if (typeof entry.limit_name !== "string" || !/^[\w.-]{1,128}$/.test(entry.limit_name)) continue;
    add(entry.rate_limit?.primary_window, entry.limit_name); add(entry.rate_limit?.secondary_window, entry.limit_name);
  }
  if (!windows.length) return undefined;
  return { windows, status: windows.some(w => w.usedPct >= 100) ? "exhausted" : "ok" };
}

/** `email` pre-selects that account on the login page (OAuth login_hint). */
export function authorizeUrl(challenge: string, state: string, email?: string) {
  const q = new URLSearchParams({
    ...(email && { login_hint: email }),
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
/** Who Codex itself is signed in as on this machine: the ID token's identity claims, nothing that grants access. */
export function detect(dir = process.env.CODEX_HOME ?? join(homedir(), ".codex")): { email: string; plan?: string } | undefined {
  try {
    const claims = jwtClaims(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")).tokens?.id_token) as { email?: unknown; "https://api.openai.com/auth"?: { chatgpt_plan_type?: unknown } } | undefined;
    const plan = claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type;
    return typeof claims?.email === "string" ? { email: claims.email, plan: typeof plan === "string" ? plan : undefined } : undefined;
  } catch { return undefined; }
}

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
