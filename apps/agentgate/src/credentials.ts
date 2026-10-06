import { z } from "zod";
import { readBody, sleep, Unavailable } from "./runtime.ts";
import type { Credential, Data, Store } from "./store.ts";
import { lastSeen, listeningFor } from "./sync.ts";

export interface Tokens { accessToken: string; refreshToken: string; expiresAt: number; }
export class InvalidGrant extends Error { }
export class NeedsLogin extends Error { }
export type OwnedKind = "credential" | "mcpCredential";
type Owned = Data<OwnedKind>;
const MIN = 60_000;
const flights = new WeakMap<Store, Map<string, Promise<Owned>>>();
export const accessToken = (c: Owned) => "accessToken" in c ? c.accessToken : c.tokens?.access_token ?? "";
export const tokenHash = (c: Owned) => new Bun.CryptoHasher("sha256").update(accessToken(c)).digest("hex");
const identity = (c: Owned) => JSON.stringify([accessToken(c), "refreshToken" in c ? c.refreshToken : c.tokens?.refresh_token, c.holder, "loginId" in c ? c.loginId : undefined]);

export function canRefresh(s: Store, c: { holder: string; expiresAt?: number }, force = false): boolean {
  if (c.holder === s.nodeId) return force || (c.expiresAt ?? Infinity) - s.now() < 30 * MIN;
  // Take over only after syncing for a while without hearing from the holder. A node just back from sleep sees the
  // holder as long gone, and holds a refresh token the holder may already have rotated; using it gets the login
  // revoked for every machine.
  const expiring = force || (c.expiresAt ?? Infinity) - s.now() < 10 * MIN;
  return expiring && s.now() - lastSeen(s, c.holder) > 2 * MIN && listeningFor(s) >= 2 * MIN;
}

export function requestRefresh(s: Store, kind: OwnedKind, id: string, c: Owned) {
  const key = `${kind}:${id}`;
  const prev = s.get("refreshRequest", key);
  if (prev?.tokenHash === tokenHash(c) && s.now() - prev.requestedAt < MIN) return;
  s.put("refreshRequest", key, { targetKind: kind, targetId: id, tokenHash: tokenHash(c), requestedAt: s.now() });
}

/** Ownership, cross-process lease and guarded persistence shared by both OAuth integrations. */
export function refreshOwned<K extends OwnedKind>(s: Store, kind: K, id: string, refresh: (c: Data<K>) => Promise<Data<K>>, pull: () => Promise<unknown>, force = true): Promise<Data<K>> {
  let active = flights.get(s);
  if (!active) flights.set(s, active = new Map());
  const key = `${kind}:${id}`;
  const running = active.get(key);
  if (running) return running as Promise<Data<K>>;
  const task = (async (): Promise<Data<K>> => {
    let c = s.get(kind, id);
    if (!c || c.needsLogin) throw new NeedsLogin(id);
    if (!canRefresh(s, c, force)) {
      const before = identity(c);
      await pull().catch(() => { });
      c = s.get(kind, id);
      if (!c || c.needsLogin) throw new NeedsLogin(id);
      if (identity(c) !== before && (!c.expiresAt || c.expiresAt > s.now())) return c;
      requestRefresh(s, kind, id, c);
      throw new Unavailable(`${id}: waiting for the credential holder to refresh`);
    }
    const beforeLease = identity(c);
    const owner = crypto.randomUUID();
    const leaseKey = `refresh-lease:${key}`;
    const deadline = Date.now() + 30_000;
    while (!s.acquireLease(leaseKey, owner)) {
      if (Date.now() > deadline) throw new Unavailable(`${id}: refresh is busy`);
      const previous = identity(c);
      await sleep(100);
      const current = s.get(kind, id);
      if (!current || current.needsLogin) throw new NeedsLogin(id);
      if (identity(current) !== previous) return current;
    }
    const renew = setInterval(() => s.acquireLease(leaseKey, owner), 10_000);
    renew.unref();
    try {
      c = s.get(kind, id);
      if (!c || c.needsLogin) throw new NeedsLogin(id);
      if (identity(c) !== beforeLease) return c;
      if (!canRefresh(s, c, force)) throw new Unavailable(`${id}: credential holder changed`);
      const original = c;
      try {
        const next = await refresh(original);
        return s.transaction(() => {
          const current = s.get(kind, id);
          if (!current || current.needsLogin) throw new NeedsLogin(id);
          if (identity(current) !== identity(original)) return current;
          const saved = s.put(kind, id, { ...next, holder: s.nodeId, needsLogin: false });
          const requested = s.get("refreshRequest", key);
          if (requested?.tokenHash === tokenHash(original)) s.del("refreshRequest", key);
          s.setLocal(`refreshError:${key}`, undefined);
          s.log(kind === "credential" ? s.get("account", id)?.provider ?? "oauth" : "mcp", id, "", 0, 0, original.holder === s.nodeId ? "refresh" : `refresh (took over from ${original.holder})`);
          return saved;
        });
      } catch (e) {
        if (e instanceof NeedsLogin || e instanceof Unavailable) throw e;
        await pull().catch(() => { });
        const current = s.get(kind, id);
        if (!current || current.needsLogin) throw new NeedsLogin(id);
        if (identity(current) !== identity(original)) return current;
        if (e instanceof InvalidGrant) {
          s.put(kind, id, { ...current, needsLogin: true });
          s.log(kind === "credential" ? "oauth" : "mcp", id, "", 401, 0, "invalid_grant; needs login");
          throw new NeedsLogin(id);
        }
        s.setLocal(`refreshError:${key}`, JSON.stringify({ at: s.now(), error: "token refresh failed; retrying while the current token is valid" }));
        s.log(kind === "credential" ? "oauth" : "mcp", id, "", 0, 0, "token refresh failed");
        if (!force && current.expiresAt && current.expiresAt > s.now()) return current;
        throw new Unavailable(`${id}: token refresh failed`);
      }
    } finally { clearInterval(renew); s.releaseLease(leaseKey, owner); }
  })().finally(() => active!.delete(key));
  active.set(key, task);
  return task;
}

export async function drainRefresh(s: Store) { await Promise.allSettled(flights.get(s)?.values() ?? []); }

type Refresh = (provider: import("./llm/provider.ts").ProviderName, refreshToken: string) => Promise<Tokens>;
export class Credentials {
  constructor(private s: Store, private refreshFn: Refresh, private pull: () => Promise<unknown>) { }

  async token(accountId: string): Promise<Credential> {
    const c = this.s.get("credential", accountId);
    if (!c || c.needsLogin) throw new NeedsLogin(accountId);
    const requested = this.s.get("refreshRequest", `credential:${accountId}`)?.tokenHash === tokenHash(c);
    if (this.shouldRefresh(c) || (requested && c.holder === this.s.nodeId)) return this.refresh(accountId, requested);
    if (c.expiresAt <= this.s.now()) { requestRefresh(this.s, "credential", accountId, c); throw new Unavailable(`${accountId}: access token has expired`); }
    return c;
  }
  shouldRefresh(c: Credential) { return canRefresh(this.s, c); }
  refresh(accountId: string, force = true): Promise<Credential> {
    return refreshOwned(this.s, "credential", accountId, async c => {
      const account = this.s.get("account", accountId);
      if (!account) throw new NeedsLogin(accountId);
      const t = await this.refreshFn(account.provider, c.refreshToken);
      return { ...c, ...t };
    }, this.pull, force);
  }
  async tick(signal?: AbortSignal) {
    const self = this.s.get("node", this.s.nodeId);
    for (const c of this.s.list("credential")) {
      if (signal?.aborted) break;
      if (c.needsLogin) continue;
      if (self?.alwaysOn && c.holder !== this.s.nodeId && !this.s.get("node", c.holder)?.alwaysOn && c.expiresAt - this.s.now() > 45 * MIN)
        this.s.put("credential", c.accountId, { ...c, holder: this.s.nodeId });
      await this.token(c.accountId).catch(() => { });
    }
  }
}

const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");

export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge, state: b64url(crypto.getRandomValues(new Uint8Array(32))) };
}

export function jwtClaims(jwt: string): Record<string, any> {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
  } catch {
    return {};
  }
}

/** POST a token request; maps OAuth errors that mean "this refresh token is dead" to InvalidGrant. */
const tokenResponse = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().positive().optional(), id_token: z.string().optional(), account_id: z.string().optional(), account: z.object({ uuid: z.string().optional(), email_address: z.string().optional() }).optional() });
export async function tokenRequest(url: string, body: Record<string, string>, form = false) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", accept: "application/json" },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = new TextDecoder().decode(await readBody(res.body, 1024 * 1024, AbortSignal.timeout(30000)));
  if (res.ok) return tokenResponse.parse(JSON.parse(text));
  if (/invalid_grant|refresh_token_(reused|expired|invalidated)/.test(text)) throw new InvalidGrant("refresh token is no longer valid");
  throw new Error(`token endpoint returned ${res.status}`);
}
