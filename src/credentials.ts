import type { Credential, Store } from "./store.ts";
import { lastSeen } from "./sync.ts";

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export class InvalidGrant extends Error {}
export class NeedsLogin extends Error {}

const MIN = 60_000;
const HOLDER_REFRESH_AT = 30 * MIN;
const FAILOVER_REFRESH_AT = 10 * MIN;
const HOLDER_SILENT_AFTER = 2 * MIN;
// A reclaim is a write with the old tokens. Doing it only while the current holder is far from
// refreshing keeps it from racing (and overwriting) a rotated refresh token.
const RECLAIM_ONLY_ABOVE = 45 * MIN;

type Refresh = (provider: "claude" | "codex", refreshToken: string) => Promise<Tokens>;

/** Holder rules, refresh, failover and invalid_grant recovery (PLAN §5). */
export class Credentials {
  private inflight = new Map<string, Promise<Credential>>();

  constructor(
    private s: Store,
    private refreshFn: Refresh,
    /** Pull from every reachable peer; used after invalid_grant. */
    private pull: () => Promise<unknown>,
  ) {}

  /** A credential that is fine to use now, refreshed first if this node should. */
  async token(accountId: string): Promise<Credential> {
    const c = this.s.get("credential", accountId);
    if (!c || c.needsLogin) throw new NeedsLogin(accountId);
    return this.shouldRefresh(c) ? this.refresh(accountId) : c;
  }

  shouldRefresh(c: Credential): boolean {
    const left = c.expiresAt - this.s.now();
    if (c.holder === this.s.nodeId) return left < HOLDER_REFRESH_AT;
    return left < FAILOVER_REFRESH_AT && this.s.now() - lastSeen(this.s, c.holder) > HOLDER_SILENT_AFTER;
  }

  /** Refresh now (also used after an upstream 401). One refresh per account at a time. */
  refresh(accountId: string): Promise<Credential> {
    let p = this.inflight.get(accountId);
    if (!p) {
      p = this.doRefresh(accountId).finally(() => this.inflight.delete(accountId));
      this.inflight.set(accountId, p);
    }
    return p;
  }

  private async doRefresh(accountId: string): Promise<Credential> {
    const c = this.s.get("credential", accountId);
    const account = this.s.get("account", accountId);
    if (!c || !account || c.needsLogin) throw new NeedsLogin(accountId);
    try {
      const t = await this.refreshFn(account.provider, c.refreshToken);
      // Saved before the caller continues: a rotated refresh token that is lost means logging in again.
      const next = this.s.put("credential", accountId, { ...c, ...t, holder: this.s.nodeId, needsLogin: false });
      this.s.log(account.provider, accountId, "", 0, 0, c.holder === this.s.nodeId ? "refresh" : `refresh (took over from ${c.holder})`);
      return next;
    } catch (e) {
      if (!(e instanceof InvalidGrant)) {
        this.s.log(account.provider, accountId, "", 0, 0, `refresh failed: ${e}`);
        return c; // Network trouble: keep using the current token while it lasts.
      }
      await this.pull().catch(() => {});
      const pulled = this.s.get("credential", accountId);
      if (pulled && pulled.refreshToken !== c.refreshToken && !pulled.needsLogin) {
        this.s.log(account.provider, accountId, "", 0, 0, "invalid_grant; using newer copy from a peer");
        return pulled;
      }
      this.s.put("credential", accountId, { ...c, needsLogin: true });
      this.s.log(account.provider, accountId, "", 0, 0, "invalid_grant; needs login");
      throw new NeedsLogin(accountId);
    }
  }

  /** Background pass: the alwaysOn node claims the holder role, then everyone refreshes what they should. */
  async tick() {
    const self = this.s.get("node", this.s.nodeId);
    for (const c of this.s.list("credential")) {
      if (c.needsLogin) continue;
      if (self?.alwaysOn && c.holder !== this.s.nodeId && !this.s.get("node", c.holder)?.alwaysOn && c.expiresAt - this.s.now() > RECLAIM_ONLY_ABOVE)
        this.s.put("credential", c.accountId, { ...c, holder: this.s.nodeId });
      await this.token(c.accountId).catch(() => {});
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
export async function tokenRequest(url: string, body: Record<string, string>, form = false): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", accept: "application/json" },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (res.ok) return JSON.parse(text);
  if (/invalid_grant|refresh_token_(reused|expired|invalidated)/.test(text)) throw new InvalidGrant(text);
  throw new Error(`token endpoint ${res.status}: ${text.slice(0, 300)}`);
}
