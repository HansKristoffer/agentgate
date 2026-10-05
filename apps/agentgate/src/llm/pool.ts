import type { AccountStatus, Failure } from "@agentgate/protocol";
import { type Credentials, NeedsLogin } from "../credentials.ts";
import { revision } from "../configuration.ts";
import { BodyTooLarge, MAX_BODY, fetchHeaders, readBody, sleep, streamBody } from "../runtime.ts";
import type { Store, Usage } from "../store.ts";
import { Budget, abortable } from "./policy.ts";
import { cool, cooldowns, retryAfterMs } from "./policy.ts";
import { classify, type Provider, type ProviderName } from "./provider.ts";
import { exhausted, recordUsage, relevant, normalizedWindow, quotaHealth, QUOTA_STALE } from "./quota.ts";
import { beginRoute, eligibility, candidates, choose, continuationAccount, earliestReset, filterModelList, modelsFor, rememberContinuation, resolveModel, route } from "./routing.ts";
import { Telemetry, streamObserver } from "./telemetry.ts";
export { relevant, exhausted, recordUsage } from "./quota.ts";
export { candidates, choose, earliestReset } from "./routing.ts";
export { retryAfterMs } from "./policy.ts";
export type { Provider, ProviderName, Window } from "./provider.ts";
export const PLACEHOLDER_TOKEN = "agentgate";
const HOP_HEADERS = ["host", "connection", "content-length", "transfer-encoding", "keep-alive", "authorization", "x-api-key", "accept-encoding"];

export function exhaustedResponse(provider: ProviderName, resetAt: number | undefined, now: number): Response {
  const secs = resetAt ? Math.max(1, Math.ceil((resetAt - now) / 1000)) : 3600;
  const message = `agentgate: every ${provider} account has reached its usage limit; resets in ${Math.ceil(secs / 60)} min`;
  const body = provider === "claude" ? { type: "error", error: { type: "rate_limit_error", message } } : { error: { type: "usage_limit_reached", message, resets_in_seconds: secs } };
  return Response.json(body, { status: 429, headers: { "retry-after": String(secs) } });
}
function cleanHeaders(h: Headers): Headers {
  const out = new Headers(h); for (const key of ["content-encoding", "content-length", "transfer-encoding", "connection"]) out.delete(key); return out;
}
export async function proxy(s: Store, creds: Credentials, provider: Provider, req: Request, path: string, limits = { headerTimeout: 30000, streamIdle: 300000, maxBody: MAX_BODY }, options: { accountId?: string } = {}): Promise<Response> {
  const settings = s.settings(), telemetry = new Telemetry(s, provider.name, [req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "", req.headers.get("x-api-key") ?? ""]), budget = new Budget(req.signal, settings.bootstrapTimeoutMs);
  let body: Uint8Array | undefined, json: Record<string, unknown> | undefined;
  const error = (status: number, message: string, failure: Failure) => {
    budget.close(); telemetry.headers(status); telemetry.finish(failure === "cancelled" ? "cancelled" : "failed", failure, "none");
    return Response.json({ error: { type: status === 429 ? "rate_limit_error" : "api_error", message: `agentgate: ${message}` } }, { status });
  };
  try {
    body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req.body, limits.maxBody, AbortSignal.any([budget.signal, AbortSignal.timeout(30000)]));
    if (body?.length) { try { const value = JSON.parse(new TextDecoder().decode(body)); if (value && typeof value === "object" && !Array.isArray(value)) json = value; } catch {} }
  } catch (e) { return error(e instanceof BodyTooLarge ? 413 : 408, e instanceof BodyTooLarge ? e.message : "request body cancelled or timed out", req.signal.aborted ? "cancelled" : "request"); }
  const requestedModel = typeof json?.model === "string" ? json.model : undefined;
  const model = resolveModel(s, provider.name, requestedModel); telemetry.models(requestedModel, model);
  if (json && model && model !== requestedModel) { json = { ...json, model }; body = new TextEncoder().encode(JSON.stringify(json)); }
  const headers = new Headers(req.headers); for (const key of HOP_HEADERS) headers.delete(key);
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1], own = bearer && bearer !== PLACEHOLDER_TOKEN ? bearer : undefined;
  const session = provider.session?.(req.headers, json);
  const previousResponse = provider.stateful?.(json) ? String(json?.previous_response_id ?? "") : undefined;
  const requiredAccount = options.accountId ?? (previousResponse ? continuationAccount(s, previousResponse) : undefined);
  const deliver = (res: Response, accountId: string, release: () => void) => {
    budget.close(); telemetry.headers(res.status);
    const observer = streamObserver(id => { if (accountId) rememberContinuation(s, id, accountId); });
    const stream = streamBody(res.body, req.signal, limits.streamIdle, {
      chunk: bytes => { telemetry.firstByte(); if (res.headers.get("content-type")?.includes("text/event-stream")) observer.chunk(bytes); },
      end: outcome => {
        release(); telemetry.tokens(observer.tokens);
        const streamOutcome = outcome === "eof" ? observer.terminal ?? "eof" : outcome;
        telemetry.finish(outcome === "cancelled" ? "cancelled" : outcome !== "eof" ? "interrupted" : !res.ok || observer.terminal === "provider-error" ? "failed" : "success", outcome === "cancelled" ? "cancelled" : !res.ok ? classify(provider, res.status, res.headers, "") : observer.terminal === "provider-error" || outcome !== "eof" ? "transient" : undefined, streamOutcome);
      },
    });
    return new Response(stream, { status: res.status, statusText: res.statusText, headers: cleanHeaders(res.headers) });
  };
  const passthrough = async () => {
    const attempt = telemetry.attempt("", "client login fallback"), started = performance.now();
    const up = provider.prepare(path, new Headers(headers), body, { accessToken: own } as import("../store.ts").Credential);
    try {
      const res = await fetchHeaders(up.url, { method: req.method, headers: up.headers, body: up.body, redirect: "manual", signal: budget.signal }, Math.min(limits.headerTimeout, budget.remaining()));
      attempt.status = res.status; attempt.headersMs = Math.round(performance.now() - started); if (!res.ok) attempt.failure = classify(provider, res.status, res.headers, ""); telemetry.saveAttempt(attempt);
      return deliver(res, "", () => {});
    } catch { attempt.status = 502; attempt.failure = "transient"; attempt.headersMs = Math.round(performance.now() - started); telemetry.saveAttempt(attempt); return error(req.signal.aborted ? 408 : 502, "upstream unreachable or timed out", req.signal.aborted ? "cancelled" : "transient"); }
  };
  if (own && !provider.pooled(path)) return passthrough();
  if (previousResponse && !requiredAccount) return own ? passthrough() : error(409, "continuation owner is unknown; start a new response", "stateful");
  const tried = new Set<string>(); let waited = false, unavailable = false, accountCount = 0;
  for (;;) {
    if (budget.signal.aborted) return error(408, "request cancelled or bootstrap budget exhausted", req.signal.aborted ? "cancelled" : "budget");
    const decision = route(s, provider.name, requestedModel, { exclude: tried, session, requiredAccount });
    const account = decision.account ? s.get("account", decision.account) : undefined;
    if (!account || accountCount >= settings.maxAccounts) {
      if (requiredAccount) return error(409, "selected account cannot serve this continuation or probe", "stateful");
      if (own) return passthrough();
      const reset = earliestReset(s, provider.name, model);
      const enabled = s.list("account").filter(a => a.provider === provider.name && a.enabled);
      if (unavailable || !enabled.length || enabled.every(a => !s.get("credential", a.id) || s.get("credential", a.id)?.needsLogin)) return error(503, !enabled.length ? "no enabled accounts configured" : "no valid account login available; check account status", "login");
      if (decision.candidates.every(c => c.reasons.some(r => r.startsWith("model")))) return error(400, "no eligible account for this model", "model");
      if (accountCount >= settings.maxAccounts) return error(429, "maximum accounts attempted", "budget");
      if (settings.whenExhausted === "wait" && !waited && reset && reset - s.now() <= Math.min(600000, budget.remaining())) {
        try { await sleep(Math.max(0, reset - s.now()), budget.signal); } catch { continue; }
        waited = true; tried.clear(); continue;
      }
      const usable = enabled.filter(a => s.get("credential", a.id) && !s.get("credential", a.id)?.needsLogin && !eligibility(s, a, model).some(r => r.startsWith("model")));
      if (usable.length && !usable.some(a => exhausted(s.get("usage", a.id), model, s.now()))) {
        const blocked = usable.flatMap(a => cooldowns(s, a.id, model));
        const rate = blocked.some(c => c.reason === "rate");
        const response = error(rate ? 429 : 503, rate ? "accounts are rate limited; retry after local backoff" : "accounts are temporarily unavailable; retry after local backoff", rate ? "rate" : "transient");
        if (reset) response.headers.set("retry-after", String(Math.max(1, Math.ceil((reset - s.now()) / 1000))));
        return response;
      }
      const response = exhaustedResponse(provider.name, reset, s.now()); budget.close(); telemetry.headers(429); telemetry.finish("failed", "quota", "none"); return response;
    }
    accountCount++;
    let credential: import("../store.ts").Credential;
    try { credential = await abortable(creds.token(account.id), budget.signal); }
    catch (e) { if (budget.signal.aborted) continue; if (!(e instanceof NeedsLogin)) s.log(provider.name, account.id, telemetry.request.routedModel, 0, 0, "credential unavailable"); tried.add(account.id); unavailable = true; continue; }
    let authRetried = false, rateRetries = 0;
    for (;;) {
      if (budget.signal.aborted) break;
      const up = provider.prepare(path, new Headers(headers), body, credential);
      const attempt = telemetry.attempt(account.id, decision.reason), started = performance.now();
      const release = beginRoute(s, provider.name, account.id, session);
      let res: Response;
      try { res = await fetchHeaders(up.url, { method: req.method, headers: up.headers, body: up.body, redirect: "manual", signal: budget.signal }, Math.min(limits.headerTimeout, budget.remaining())); }
      catch {
        release(); attempt.status = 502; attempt.headersMs = Math.round(performance.now() - started); attempt.failure = req.signal.aborted ? "cancelled" : budget.signal.aborted ? "budget" : "transient"; telemetry.saveAttempt(attempt);
        if (!budget.signal.aborted) cool(s, account.id, "transient", s.now() + 15000);
        return error(req.signal.aborted ? 408 : 502, "upstream unreachable or timed out; outcome uncertain", attempt.failure);
      }
      attempt.status = res.status; attempt.headersMs = Math.round(performance.now() - started);
      const observed = provider.usage(res.headers);
      if (res.ok && !observed && provider.pooled(path)) s.setLocal(`quotaUnknown:${provider.name}`, String(s.now())); else if (observed) s.setLocal(`quotaUnknown:${provider.name}`, undefined);
      if (res.status === 429 || res.status === 401 || (res.status === 400 || res.status === 404)) {
        let text = "";
        try { text = new TextDecoder().decode(await readBody(res.body, 1024 * 1024, AbortSignal.any([budget.signal, AbortSignal.timeout(10000)]))); }
        catch { release(); return error(502, "upstream rejection response too large or timed out", "transient"); }
        release(); const failure = classify(provider, res.status, res.headers, text); attempt.failure = failure; telemetry.saveAttempt(attempt);
        if (res.status === 401) {
          if (!authRetried) { authRetried = true; try { const next = await abortable(creds.refresh(account.id), budget.signal); if (next.accessToken !== credential.accessToken) { credential = next; continue; } } catch {} }
          tried.add(account.id); unavailable = true; break;
        }
        if (failure === "quota") {
          const windows = observed?.windows.filter(w => w.usedPct >= 100) ?? [], global = windows.filter(w => normalizedWindow(w).scope?.kind === "account");
          const until = global.length ? Math.max(...global.map(w => w.resetsAt ?? s.now() + Math.max(1000, retryAfterMs(res.headers)))) : !windows.length ? s.now() + Math.max(1000, retryAfterMs(res.headers)) : undefined;
          recordUsage(s, account.id, { windows: observed?.windows ?? [], status: "exhausted" }, until);
          s.log(provider.name, account.id, telemetry.request.routedModel, 429, Math.round(performance.now() - started), "quota exhausted; switching"); tried.add(account.id); break;
        }
        if (observed) recordUsage(s, account.id, observed);
        if (failure === "model" && model) { cool(s, account.id, "model", s.now() + 300000, model); tried.add(account.id); break; }
        if (failure === "rate") {
          const delay = retryAfterMs(res.headers, s.now()); cool(s, account.id, "rate", s.now() + delay);
          if (rateRetries++ < (account.policy?.retryLimit ?? settings.retryLimit) && delay < budget.remaining()) {
            try { await sleep(delay + Math.min(250, Math.max(0, budget.remaining() - delay - 1)) * Math.random(), budget.signal); } catch { break; }
            continue;
          }
        }
        budget.close(); telemetry.headers(res.status); telemetry.finish("failed", failure, "none");
        return new Response(text, { status: res.status, headers: cleanHeaders(res.headers) });
      }
      if (!res.ok) attempt.failure = classify(provider, res.status, res.headers, "");
      if (attempt.failure === "transient") cool(s, account.id, "transient", s.now() + 15000);
      telemetry.saveAttempt(attempt);
      if (observed) recordUsage(s, account.id, observed);
      const previous = s.local(`active:${provider.name}`);
      if (res.ok && previous !== account.id) { s.setLocal(`active:${provider.name}`, account.id); s.log(provider.name, account.id, telemetry.request.routedModel, 0, 0, "active subscription changed"); }
      s.log(provider.name, account.id, telemetry.request.routedModel, res.status, Math.round(performance.now() - started));
      const listing = req.method === "GET" && res.ok ? provider.modelList?.(path) : undefined;
      if (listing) {
        try {
          const bytes = await readBody(res.body, 256 * 1024, budget.signal);
          const filtered = filterModelList(s, provider.name, JSON.parse(new TextDecoder().decode(bytes)), listing);
          res = new Response(JSON.stringify(filtered), { status: res.status, headers: cleanHeaders(res.headers) });
        } catch { release(); return error(502, "model list unreadable or too large", "transient"); }
      }
      return deliver(res, account.id, release);
    }
  }
}
export function accountStatus(s: Store, account: import("../store.ts").Account): AccountStatus {
  const now = s.now(), u = s.get("usage", account.id), c = s.get("credential", account.id);
  return { account, windows: (u?.windows ?? []).map(w => ({ ...normalizedWindow(w), inferredReset: w.inferredReset || !!(w.resetsAt && w.resetsAt <= now) })), exhausted: exhausted(u, undefined, now), exhaustedUntil: u?.exhaustedUntil && u.exhaustedUntil > now ? u.exhaustedUntil : undefined, observedAt: u?.observedAt, observedBy: u?.observedBy, observationSource: u?.source, active: s.local(`active:${account.provider}`) === account.id, needsLogin: !c || !!c.needsLogin, holder: c?.holder, expiresAt: c?.expiresAt, expired: !!c && c.expiresAt <= now, refreshError: s.local(`refreshError:credential:${account.id}`) ? "token refresh failed" : undefined, revision: revision(s, "account", account.id), quotaState: !u ? "unknown" : now - u.observedAt >= QUOTA_STALE || u.windows.some(w => w.resetsAt && w.resetsAt <= now) ? "stale" : "fresh", quotaHealth: quotaHealth(s, account.id), cooldowns: cooldowns(s, account.id), models: modelsFor(s, account.id), modelError: s.local(`modelError:${account.id}`) };
}
