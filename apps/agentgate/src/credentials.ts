import { z } from "zod";
import { readBody, sleep, Unavailable } from "./runtime.ts";
import type { Credential, Data, Store } from "./store.ts";
import { awakeFor, lastSeen, listeningFor } from "./sync.ts";

export interface Tokens { accessToken: string; refreshToken: string; expiresAt: number; }
export class InvalidGrant extends Error { }
export class NeedsLogin extends Error { }
export type OwnedKind = "credential" | "mcpCredential";
type Owned = Data<OwnedKind>;
const MIN = 60_000;
const EXPIRED_PULL_WAIT = 3_000;
const flights = new WeakMap<Store, Map<string, Promise<Owned>>>();
export const accessToken = (c: Owned) => "accessToken" in c ? c.accessToken : c.tokens?.access_token ?? "";
export const tokenHash = (c: Owned) => new Bun.CryptoHasher("sha256").update(accessToken(c)).digest("hex");
const login = (c: Owned) => JSON.stringify([accessToken(c), "refreshToken" in c ? c.refreshToken : c.tokens?.refresh_token, "loginId" in c ? c.loginId : undefined]);
const identity = (c: Owned) => `${login(c)}${c.holder}`;
/** Whether a pull heard from the other machines: syncAll answers with its errors. */
const heard = (pull: () => Promise<unknown>) => pull().then((errors) => !(Array.isArray(errors) && errors.length), () => false);

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
    // A holder back from sleep may have lost the role meanwhile, and the taker rotated the refresh token this one holds.
    // Using it gets the login revoked for every machine, so hear from the others first. Nobody answering right after a
    // wake says little (the network may not be back yet); after two minutes awake, they are offline and this node goes on.
    if (c.holder === s.nodeId && listeningFor(s) === 0) {
      const answered = await heard(pull);
      c = s.get(kind, id);
      if (!c || c.needsLogin) throw new NeedsLogin(id);
      if (c.holder === s.nodeId && !answered && awakeFor(s) < 2 * MIN) {
        if (!force && (c.expiresAt ?? Infinity) > s.now()) return c;
        throw new Unavailable(`${id}: waiting to hear from the other machines before refreshing`);
      }
    }
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
        // Refused once already: sending it again only tells the provider a revoked token is in use.
        if (s.local(`refused:${key}`) === tokenHash(original)) throw new InvalidGrant("refresh token was refused");
        const next = await refresh(original);
        return s.transaction(() => {
          const current = s.get(kind, id);
          if (!current || current.needsLogin) throw new NeedsLogin(id);
          // Only a new login wins here. A holder change that synced in meanwhile does not: the provider just rotated
          // the refresh token, and these tokens are the only working ones.
          if (login(current) !== login(original)) return current;
          const saved = s.put(kind, id, { ...next, holder: s.nodeId, needsLogin: false });
          const requested = s.get("refreshRequest", key);
          if (requested?.tokenHash === tokenHash(original)) s.del("refreshRequest", key);
          s.setLocal(`refreshError:${key}`, undefined);
          s.setLocal(`refused:${key}`, undefined);
          s.log(kind === "credential" ? s.get("account", id)?.provider ?? "oauth" : "mcp", id, "", 0, 0, original.holder === s.nodeId ? "refresh" : `refresh (took over from ${original.holder})`);
          return saved;
        });
      } catch (e) {
        if (e instanceof NeedsLogin || e instanceof Unavailable) throw e;
        const synced = await heard(pull);
        const current = s.get(kind, id);
        if (!current || current.needsLogin) throw new NeedsLogin(id);
        if (identity(current) !== identity(original)) return current;
        // Refused, and no machine has a newer copy. One that did not answer may: marking this login dead would then
        // overwrite that copy everywhere. So it waits until every machine answered, or, as a takeover does, until this
        // one has been awake for two minutes without hearing from them.
        const refused = e instanceof InvalidGrant;
        if (refused && (synced || awakeFor(s) >= 2 * MIN)) {
          s.setLocal(`refused:${key}`, undefined);
          s.put(kind, id, { ...current, needsLogin: true });
          s.log(kind === "credential" ? "oauth" : "mcp", id, "", 401, 0, "invalid_grant; needs login");
          throw new NeedsLogin(id);
        }
        const first = !refused || s.local(`refused:${key}`) !== tokenHash(original);
        if (refused) s.setLocal(`refused:${key}`, tokenHash(original));
        s.setLocal(`refreshError:${key}`, JSON.stringify({ at: s.now(), error: "token refresh failed; retrying while the current token is valid" }));
        if (first) s.log(kind === "credential" ? "oauth" : "mcp", id, "", 0, 0, refused ? "refresh token refused; waiting to hear from the other machines" : "token refresh failed");
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
    // Another machine holds this login and has most likely refreshed it while this one slept: fetch its copy.
    if (c.expiresAt <= this.s.now()) return this.refresh(accountId, false);
    return c;
  }
  shouldRefresh(c: Credential) { return canRefresh(this.s, c); }
  /** Waits for other machines' copies only briefly, so a request another account could serve is not held up by a slow
   * peer; the pull itself goes on. */
  private pullBriefly = () => Promise.race([this.pull(), sleep(EXPIRED_PULL_WAIT).then(() => ["no answer yet"])]);
  refresh(accountId: string, force = true, pull = this.pullBriefly): Promise<Credential> {
    return refreshOwned(this.s, "credential", accountId, async c => {
      const account = this.s.get("account", accountId);
      if (!account) throw new NeedsLogin(accountId);
      const t = await this.refreshFn(account.provider, c.refreshToken);
      return { ...c, ...t };
    }, pull, force);
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
