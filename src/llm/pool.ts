import type { Account, Credential, Store, Usage } from "../store.ts";
import { type Credentials, NeedsLogin, type Tokens } from "../credentials.ts";

export type Window = Usage["windows"][number];
export type ProviderName = "claude" | "codex";

export interface Provider {
  name: ProviderName;
  /** Build the upstream request for one account. `path` is everything after `/anthropic` or `/codex`. */
  prepare(path: string, headers: Headers, body: Uint8Array | undefined, cred: Credential): { url: string; headers: Headers; body?: Uint8Array };
  /** Quota windows from response headers; undefined when none were recognised. */
  usage(headers: Headers): { windows: Window[]; status: Usage["status"] } | undefined;
  /** A used-up quota (switch accounts) or a short rate limit (retry the same account)? */
  classify429(headers: Headers, body: string): "quota" | "rate";
  refresh(refreshToken: string): Promise<Tokens>;
  /** Paths that spend quota and go through the pool; other paths keep a client's own login when it has one. */
  pooled(path: string): boolean;
}

/** The placeholder token `setup` gives dedicated client dirs; anything else is the client's own login. */
export const PLACEHOLDER_TOKEN = "agentgate";

const MAX_WAIT = 10 * 60_000;
const HOP_HEADERS = ["host", "connection", "content-length", "transfer-encoding", "keep-alive", "authorization", "x-api-key", "accept-encoding"];

/** Windows that limit `model`: the plain ones plus model-specific ones like `7d:opus`. */
export function relevant(u: Usage | undefined, model: string | undefined, now: number): Window[] {
  if (!u) return [];
  return u.windows
    .filter((w) => !w.name.includes(":") || (model ?? "").toLowerCase().includes(w.name.split(":")[1]!))
    .map((w) => (w.resetsAt && w.resetsAt <= now ? { ...w, usedPct: 0 } : w));
}

export function exhausted(u: Usage | undefined, model: string | undefined, now: number): boolean {
  if (u?.exhaustedUntil && u.exhaustedUntil > now) return true;
  return relevant(u, model, now).some((w) => w.usedPct >= 100);
}

/** The window closest to its limit. */
function tightest(u: Usage | undefined, model: string | undefined, now: number): Window | undefined {
  return relevant(u, model, now).sort((a, b) => b.usedPct - a.usedPct)[0];
}

export function candidates(s: Store, provider: ProviderName, model: string | undefined, exclude: Set<string> = new Set()): Account[] {
  const now = s.now();
  return s.list("account").filter((a) => {
    if (a.provider !== provider || !a.enabled || exclude.has(a.id)) return false;
    const c = s.get("credential", a.id);
    return c && !c.needsLogin && !exhausted(s.get("usage", a.id), model, now);
  });
}

/** PLAN §6.4: pinned, then sticky, then the account whose tightest window resets soonest. */
export function choose(s: Store, provider: ProviderName, model: string | undefined, exclude?: Set<string>): Account | undefined {
  const cands = candidates(s, provider, model, exclude);
  const pinned = cands.find((a) => a.pinned);
  if (pinned) return pinned;
  const now = s.now();
  const { threshold } = s.settings();
  const under = cands.filter((a) => (tightest(s.get("usage", a.id), model, now)?.usedPct ?? 0) < threshold);
  const active = s.local(`active:${provider}`);
  const sticky = under.find((a) => a.id === active);
  if (sticky) return sticky;
  const resetOf = (a: Account) => tightest(s.get("usage", a.id), model, now)?.resetsAt ?? Infinity;
  return (under.length ? under : cands).sort((a, b) => resetOf(a) - resetOf(b) || b.priority - a.priority)[0];
}

/** When the soonest exhausted account frees up again. */
export function earliestReset(s: Store, provider: ProviderName, model: string | undefined): number | undefined {
  const now = s.now();
  const resets = s
    .list("account")
    .filter((a) => a.provider === provider && a.enabled && !s.get("credential", a.id)?.needsLogin)
    .map((a) => {
      const u = s.get("usage", a.id);
      const ws = relevant(u, model, now).filter((w) => w.usedPct >= 100 && w.resetsAt).map((w) => w.resetsAt!);
      if (u?.exhaustedUntil && u.exhaustedUntil > now) ws.push(u.exhaustedUntil);
      return ws.length ? Math.max(...ws) : undefined;
    })
    .filter((r): r is number => r !== undefined);
  return resets.length ? Math.min(...resets) : undefined;
}

/** Save observed quota. Skips the write (and the sync traffic) when nothing changed that matters. */
export function recordUsage(s: Store, accountId: string, observed: { windows: Window[]; status: Usage["status"] }, exhaustedUntil?: number) {
  const prev = s.get("usage", accountId);
  const key = (u: { windows: Window[]; status: string; exhaustedUntil?: number }) =>
    JSON.stringify([u.status, u.exhaustedUntil ?? 0, u.windows.map((w) => [w.name, Math.round(w.usedPct), Math.round((w.resetsAt ?? 0) / 60_000)])]);
  // A response that finishes late must not erase an exhaustion recorded meanwhile; the mark expires on its own.
  if (exhaustedUntil === undefined && prev?.exhaustedUntil && prev.exhaustedUntil > s.now()) exhaustedUntil = prev.exhaustedUntil;
  const next = { accountId, observedAt: s.now(), observedBy: s.nodeId, ...observed, exhaustedUntil };
  if (prev && key(prev) === key(next) && s.now() - prev.observedAt < 5 * 60_000) return;
  s.put("usage", accountId, next);
}

function modelOf(body: Uint8Array | undefined): string | undefined {
  if (!body?.length) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(body)).model;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(h: Headers): number {
  const v = h.get("retry-after");
  const n = Number(v);
  if (v && !Number.isNaN(n)) return n * 1000;
  if (v) return Math.max(0, Date.parse(v) - Date.now());
  return 2000;
}

export function exhaustedResponse(provider: ProviderName, resetAt: number | undefined, now: number): Response {
  const secs = resetAt ? Math.max(1, Math.ceil((resetAt - now) / 1000)) : 3600;
  const message = `agentgate: every ${provider} account has reached its usage limit; resets in ${Math.ceil(secs / 60)} min`;
  const body = provider === "claude"
    ? { type: "error", error: { type: "rate_limit_error", message } }
    : { error: { type: "usage_limit_reached", message, resets_in_seconds: secs } };
  return Response.json(body, { status: 429, headers: { "retry-after": String(secs) } });
}

/**
 * Forward one client request through the pool. The body is held in memory so a quota 429 that arrives
 * before the first response byte can be replayed on the next account; the client never sees it.
 */
export async function proxy(s: Store, creds: Credentials, provider: Provider, req: Request, path: string): Promise<Response> {
  const started = s.now();
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(await req.arrayBuffer());
  const model = modelOf(body);
  const headers = new Headers(req.headers);
  for (const h of HOP_HEADERS) headers.delete(h);
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const own = bearer && bearer !== PLACEHOLDER_TOKEN ? bearer : undefined;

  // A client with its own login (e.g. the primary ~/.claude): forward untouched with that login.
  const passthrough = async (note?: string) => {
    const up = provider.prepare(path, new Headers(headers), body, { accessToken: own } as Credential);
    try {
      const res = await fetch(up.url, { method: req.method, headers: up.headers, body: up.body, redirect: "manual", signal: req.signal });
      if (note) s.log(provider.name, "", model ?? "", res.status, s.now() - started, note);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: cleanHeaders(res.headers) });
    } catch (e) {
      return Response.json({ error: { type: "api_error", message: `agentgate: upstream unreachable: ${e}` } }, { status: 502 });
    }
  };
  if (own && !provider.pooled(path)) return passthrough();

  const tried = new Set<string>();
  const { retryLimit, whenExhausted } = s.settings();
  let waited = false;

  for (;;) {
    const account = choose(s, provider.name, model, tried);
    if (!account) {
      if (own) return passthrough("no pooled account usable; sent with the client's own login");
      const reset = earliestReset(s, provider.name, model);
      if (whenExhausted === "wait" && !waited && reset && reset - s.now() <= MAX_WAIT) {
        s.log(provider.name, "", model ?? "", 0, 0, `all accounts exhausted; waiting ${Math.ceil((reset - s.now()) / 1000)}s`);
        await sleep(reset - s.now());
        waited = true;
        tried.clear();
        continue;
      }
      s.log(provider.name, "", model ?? "", 429, s.now() - started, "all accounts exhausted");
      return exhaustedResponse(provider.name, reset, s.now());
    }

    let cred: Credential;
    try {
      cred = await creds.token(account.id);
    } catch (e) {
      if (!(e instanceof NeedsLogin)) s.log(provider.name, account.id, model ?? "", 0, 0, `token: ${e}`);
      tried.add(account.id);
      continue;
    }

    let rateRetries = 0;
    let authRetried = false;
    for (;;) {
      const up = provider.prepare(path, new Headers(headers), body, cred);
      let res: Response;
      try {
        res = await fetch(up.url, { method: req.method, headers: up.headers, body: up.body, redirect: "manual", signal: req.signal });
      } catch (e) {
        s.log(provider.name, account.id, model ?? "", 502, s.now() - started, `upstream: ${e}`);
        return Response.json({ error: { type: "api_error", message: `agentgate: upstream unreachable: ${e}` } }, { status: 502 });
      }
      const observed = provider.usage(res.headers);

      if (res.status === 429) {
        const text = await res.text();
        if (provider.classify429(res.headers, text) === "quota") {
          const until = observed?.windows.filter((w) => w.usedPct >= 100 && w.resetsAt).map((w) => w.resetsAt!)[0] ?? s.now() + retryAfterMs(res.headers);
          recordUsage(s, account.id, { windows: observed?.windows ?? [], status: "exhausted" }, until);
          s.log(provider.name, account.id, model ?? "", 429, s.now() - started, "quota exhausted; switching");
          tried.add(account.id);
          break;
        }
        if (observed) recordUsage(s, account.id, observed);
        if (rateRetries++ < retryLimit) {
          await sleep(Math.min(retryAfterMs(res.headers), 60_000));
          continue;
        }
        s.log(provider.name, account.id, model ?? "", 429, s.now() - started, "rate limited");
        return new Response(text, { status: 429, headers: cleanHeaders(res.headers) });
      }

      if (res.status === 401 && !authRetried) {
        authRetried = true;
        await res.body?.cancel();
        cred = await creds.refresh(account.id).catch(() => cred);
        continue;
      }

      if (observed) recordUsage(s, account.id, observed);
      const prev = s.local(`active:${provider.name}`);
      if (prev !== account.id) {
        s.setLocal(`active:${provider.name}`, account.id);
        s.log(provider.name, account.id, model ?? "", 0, 0, prev ? `switched from ${prev}` : "active");
      }
      s.log(provider.name, account.id, model ?? "", res.status, s.now() - started);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: cleanHeaders(res.headers) });
    }
  }
}

/** fetch already decompressed the body, so the encoding and length headers no longer apply. */
function cleanHeaders(h: Headers): Headers {
  const out = new Headers(h);
  for (const k of ["content-encoding", "content-length", "transfer-encoding", "connection"]) out.delete(k);
  return out;
}

/** What the dashboard and `agentgate status` show for one account. */
export function accountStatus(s: Store, a: Account) {
  const now = s.now();
  const u = s.get("usage", a.id);
  const c = s.get("credential", a.id);
  return {
    account: a,
    windows: (u?.windows ?? []).map((w) => (w.resetsAt && w.resetsAt <= now ? { ...w, usedPct: 0 } : w)),
    exhausted: exhausted(u, undefined, now),
    exhaustedUntil: u?.exhaustedUntil && u.exhaustedUntil > now ? u.exhaustedUntil : undefined,
    observedBy: u?.observedBy,
    active: s.local(`active:${a.provider}`) === a.id,
    needsLogin: !c || !!c.needsLogin,
    holder: c?.holder,
    expiresAt: c?.expiresAt,
  };
}
