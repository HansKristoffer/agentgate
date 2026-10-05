import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import { InvalidGrant, NeedsLogin, canRefresh, refreshOwned, tokenHash } from "../credentials.ts";
import { fetchHeaders } from "../runtime.ts";
import type { McpCredential, Store } from "../store.ts";
import { syncAll } from "../relay.ts";
import { resolve } from "./templates.ts";

const SESSION_TTL = 10 * 60_000;
const sessionSchema = z.object({ id: z.string(), loginId: z.string(), expiresAt: z.number(), verifier: z.string().optional() });
export function expireLogins(s: Store) {
  for (const row of s.db.query("select key, value from local where key like 'oauth-state:%'").all() as { key: string; value: string }[]) {
    let value: unknown; try { value = JSON.parse(row.value); } catch { }
    const result = sessionSchema.safeParse(value);
    if (!result.success || result.data.expiresAt <= s.now()) s.setLocal(row.key, undefined);
  }
}

/** The SDK handles discovery and PKCE; ownership and persistence are controlled here. */
export class InstanceAuth implements OAuthClientProvider {
  authUrl?: URL;
  staged: Partial<McpCredential> = {};
  private stateValue?: string;
  constructor(private s: Store, private id: string, private interactive = false, private deferred = false, private verifier?: string, private snapshot?: McpCredential) { }
  private credential() {
    const c = this.snapshot ?? this.s.get("mcpCredential", this.id);
    if (!c || !this.s.get("mcp", this.id)) throw new NeedsLogin(`${this.id}: needs a login`);
    return { ...c, ...this.staged };
  }
  private update(patch: Partial<McpCredential>) {
    if (this.deferred) this.staged = { ...this.staged, ...patch };
    else this.s.put("mcpCredential", this.id, { ...this.credential(), ...patch });
  }
  get redirectUrl() { return this.credential().redirectUri; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "agentgate", redirect_uris: [this.redirectUrl ?? ""], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  state() {
    if (!this.interactive) throw new NeedsLogin(`${this.id}: needs a login`);
    const state = crypto.randomUUID();
    const c = this.credential();
    this.stateValue = state;
    this.s.setLocal(`oauth-state:${state}`, JSON.stringify({ id: this.id, loginId: c.loginId, expiresAt: this.s.now() + SESSION_TTL }));
    return state;
  }
  clientInformation() { return this.credential().client as OAuthClientInformationMixed | undefined; }
  saveClientInformation(client: OAuthClientInformationMixed) { this.update({ client }); }
  tokens() { return this.credential().tokens as OAuthTokens | undefined; }
  saveTokens(tokens: OAuthTokens) {
    this.update({ tokens, expiresAt: tokens.expires_in ? this.s.now() + tokens.expires_in * 1000 : undefined, needsLogin: false });
    // A recorded "needs login" (serverHealth in gateway.ts) was about the old tokens.
    this.s.setLocal(`mcpHealth:${this.id}`, undefined);
  }
  redirectToAuthorization(url: URL) {
    if (!this.interactive) throw new NeedsLogin(`${this.id}: needs a login`);
    this.authUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    if (!this.stateValue) throw new Error("no pending login");
    const key = `oauth-state:${this.stateValue}`;
    const pending = sessionSchema.parse(JSON.parse(this.s.local(key)!));
    this.s.setLocal(key, JSON.stringify({ ...pending, verifier }));
  }
  codeVerifier() { if (!this.verifier) throw new Error("login expired; start it again"); return this.verifier; }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (this.deferred && (scope === "all" || scope === "tokens")) throw new InvalidGrant("MCP refresh token is no longer valid");
    if (scope === "all") this.update({ client: undefined, tokens: undefined, needsLogin: true });
    if (scope === "client") this.update({ client: undefined });
    if (scope === "tokens") this.update({ tokens: undefined, needsLogin: true });
  }
}

export async function refreshMcp(s: Store, id: string, force = false): Promise<McpCredential> {
  const credential = s.get("mcpCredential", id);
  if (!credential?.tokens || credential.needsLogin) throw new NeedsLogin(`${id}: needs a login`);
  const requested = s.get("refreshRequest", `mcpCredential:${id}`)?.tokenHash === tokenHash(credential);
  if (!force && !canRefresh(s, credential) && !(requested && credential.holder === s.nodeId) && (credential.expiresAt === undefined || credential.expiresAt > s.now())) return credential;
  return refreshOwned(s, "mcpCredential", id, async c => {
    const inst = s.get("mcp", id);
    const url = inst && resolve(inst).url;
    if (!url) throw new NeedsLogin(id);
    const provider = new InstanceAuth(s, id, false, true, undefined, c);
    const signal = AbortSignal.timeout(30_000);
    const result = await auth(provider, { serverUrl: url, fetchFn: (url, init) => fetchHeaders(url, { ...init, signal }) });
    if (result !== "AUTHORIZED" || !provider.staged.tokens) throw new NeedsLogin(`${id}: needs a login`);
    return { ...c, ...provider.staged };
  }, () => syncAll(s), force || requested);
}

/** Never let an independent SDK transport rotate a shared token itself. */
export function authenticatedFetch(s: Store, id: string) {
  return async (url: string | URL, init: RequestInit = {}) => {
    let c = s.get("mcpCredential", id);
    if (c?.tokens) c = await refreshMcp(s, id);
    const send = (token?: string) => {
      const headers = new Headers(init.headers);
      if (token) headers.set("authorization", `Bearer ${token}`);
      return fetchHeaders(url, { ...init, headers }, init.method === "DELETE" ? 2000 : 30000);
    };
    const res = await send(c?.tokens?.access_token);
    if (res.status !== 401 || !c?.tokens) return res;
    await res.body?.cancel();
    const next = await refreshMcp(s, id, true);
    if (!next.tokens || next.tokens.access_token === c.tokens.access_token) throw new NeedsLogin(`${id}: needs a login`);
    return send(next.tokens.access_token); // 401 guarantees the operation was not accepted
  };
}

export async function startLogin(s: Store, id: string, callbackUrl: string): Promise<URL | undefined> {
  const inst = s.get("mcp", id);
  if (!inst?.url) throw new Error(`${id} is not an HTTP server`);
  expireLogins(s);
  const previous = s.get("mcpCredential", id);
  const client = previous?.redirectUri === callbackUrl ? previous.client : undefined;
  s.put("mcpCredential", id, { instanceId: id, redirectUri: callbackUrl, client, holder: s.nodeId, loginId: crypto.randomUUID() });
  const provider = new InstanceAuth(s, id, true);
  const signal = AbortSignal.timeout(30_000);
  const result = await auth(provider, { serverUrl: resolve(inst).url!, fetchFn: (url, init) => fetchHeaders(url, { ...init, signal }) });
  return result === "REDIRECT" ? provider.authUrl : undefined;
}

export async function finishLogin(s: Store, state: string, code: string): Promise<string> {
  const pending = s.transaction(() => {
    const raw = s.local(`oauth-state:${state}`);
    if (!raw) throw new Error("unknown or expired login; start it again");
    s.setLocal(`oauth-state:${state}`, undefined);
    const session = sessionSchema.parse(JSON.parse(raw));
    if (session.expiresAt <= s.now() || session.loginId !== s.get("mcpCredential", session.id)?.loginId || !session.verifier) throw new Error("login expired; start it again");
    return session;
  });
  const inst = s.get("mcp", pending.id);
  if (!inst?.url) throw new Error(`no MCP instance ${pending.id}`);
  const provider = new InstanceAuth(s, pending.id, true, true, pending.verifier);
  const signal = AbortSignal.timeout(30_000);
  const result = await auth(provider, { serverUrl: resolve(inst).url!, authorizationCode: code, fetchFn: (url, init) => fetchHeaders(url, { ...init, signal }) });
  if (result !== "AUTHORIZED" || !provider.staged.tokens) throw new Error("authorization did not issue tokens");
  s.transaction(() => {
    const current = s.get("mcpCredential", pending.id);
    if (!current || current.loginId !== pending.loginId || !s.get("mcp", pending.id)) throw new Error("login replaced or server deleted; start again");
    s.put("mcpCredential", pending.id, { ...current, ...provider.staged, holder: s.nodeId, needsLogin: false });
  });
  return pending.id;
}

export async function tickMcp(s: Store, signal?: AbortSignal) {
  for (const c of s.list("mcpCredential")) {
    if (signal?.aborted) break;
    if (c.needsLogin || !c.tokens) continue;
    if (s.get("node", s.nodeId)?.alwaysOn && c.holder !== s.nodeId && !s.get("node", c.holder)?.alwaysOn && (c.expiresAt ?? 0) - s.now() > 45 * 60_000)
      s.put("mcpCredential", c.instanceId, { ...c, holder: s.nodeId });
    await refreshMcp(s, c.instanceId).catch(() => { });
  }
}
