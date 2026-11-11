import { isModelReason, type AccountState, type AccountStatus, type Failure } from "@agentgate/protocol";
import { clamp, isRecord, raceAbort, safeJsonParse, startTimer, typedSwitch, typedSwitchGroup } from "hanzio";
import { type Credentials, NeedsLogin, refreshFailure } from "../credentials.ts";
import { z } from "zod";
import { revision } from "../configuration.ts";
import { defineLocal } from "../local-state.ts";
import { BodyTooLarge, MAX_PROXY_BODY, fetchHeaders, readBody, sleep, streamBody } from "../runtime.ts";
import { sent, type Account, type Data, type Store } from "../store.ts";
import { Budget } from "./policy.ts";
import { cool, cooldowns, retryAfterMs } from "./policy.ts";
import { PLACEHOLDER_TOKEN } from "../setup.ts";
import { classify, type Provider, type ProviderName } from "./provider.ts";
import { exhausted, recordUsage, normalizedWindow, quotaHealth, QUOTA_STALE, relevant } from "./quota.ts";
import {
  activeAccount,
  beginRoute,
  eligibility,
  continuationAccount,
  earliestReset,
  filterModelList,
  modelErrors,
  modelsFor,
  rememberContinuation,
  resolveModel,
  route,
} from "./routing.ts";
import { recordSessionUsage, trackedSession } from "./sessions.ts";
import { Telemetry, streamObserver } from "./telemetry.ts";
export { recordUsage } from "./quota.ts";
/** Rate-limit waits up to this long retry the same account; longer ones move to the next account. */
const SHORT_RATE_WAIT = 5000;
/** Since when a provider's responses have carried no quota headers, per provider. */
const quotaUnknown = defineLocal("quotaUnknown:", z.string(), { topic: "status" });
/** `/status`'s `unknownQuota`: for each of `providers` that reports quota in its headers, since when it has not. */
export const unknownQuota = (s: Store, providers: Provider[]) =>
  Object.fromEntries(
    providers.filter((p) => p.headerQuota !== false).map((p) => [p.name, quotaUnknown.get(s, p.name)]),
  );
const HOP_HEADERS = [
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "authorization",
  "x-api-key",
  "accept-encoding",
];

export function exhaustedResponse(provider: ProviderName, resetAt: number | undefined, now: number): Response {
  const secs = resetAt ? Math.max(1, Math.ceil((resetAt - now) / 1000)) : 3600;
  const message = `agentgate: every ${provider} account has reached its usage limit; resets in ${Math.ceil(secs / 60)} min`;
  const body = typedSwitch(provider, {
    claude: () => ({ type: "error", error: { type: "rate_limit_error", message } }),
    ...typedSwitchGroup(provider, ["codex", "cursor"], () => ({
      error: { type: "usage_limit_reached", message, resets_in_seconds: secs },
    })),
  });
  return Response.json(body, { status: 429, headers: { "retry-after": String(secs) } });
}
/** Bookkeeping on the proxy path (telemetry, the request log, local state, observed quota) is best-effort, as in
 * sessions.ts: a full disk or a busy store must not fail a request the upstream can serve, least of all one it already
 * accepted. Each kind of failure is logged once, by error name and SQLite code only. */
const bookkeepingFailed = new Set<string>();
function bestEffort<T>(kind: string, write: () => T): T | undefined {
  try {
    return write();
  } catch (e) {
    if (bookkeepingFailed.has(kind)) return;
    bookkeepingFailed.add(kind);
    const code = isRecord(e) && typeof e.code === "string" ? ` ${e.code}` : "";
    console.error(`proxy: ${kind} not recorded: ${e instanceof Error ? e.name : "error"}${code}`);
  }
}
/** Telemetry over a store that reads as closed records nothing: the stand-in when the real one cannot write. */
const silentTelemetry = (s: Store, provider: ProviderName, sensitive: string[] = []) =>
  new Telemetry(Object.assign(Object.create(s) as Store, { closed: true }), provider, sensitive);
function cleanHeaders(h: Headers): Headers {
  const out = new Headers(h);
  for (const key of ["content-encoding", "content-length", "transfer-encoding", "connection"]) out.delete(key);
  return out;
}
export async function proxy(
  s: Store,
  creds: Credentials,
  provider: Provider,
  req: Request,
  path: string,
  limits = { headerTimeout: 30000, streamIdle: 300000, maxBody: MAX_PROXY_BODY },
  options: { accountId?: string } = {},
): Promise<Response> {
  const settings = s.settings(),
    sensitive = [
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "",
      req.headers.get("x-api-key") ?? "",
    ],
    telemetry =
      bestEffort("telemetry", () => new Telemetry(s, provider.name, sensitive)) ??
      silentTelemetry(s, provider.name, sensitive),
    budget = new Budget(req.signal, settings.bootstrapTimeoutMs);
  const track = (write: () => void) => bestEffort("telemetry", write);
  const attemptOn = (account: string, selection: string) =>
    bestEffort("telemetry", () => telemetry.attempt(account, selection)) ??
    silentTelemetry(s, provider.name).attempt(account, selection);
  const log = (account: string, status: number, ms: number, note: string) =>
    bestEffort("request log", () => s.log(provider.name, account, telemetry.request.routedModel, status, ms, note));
  const observe = (id: string, observation: Parameters<typeof recordUsage>[2], until?: number) =>
    bestEffort("quota", () => recordUsage(s, id, observation, until));
  let body: Uint8Array | undefined, json: Record<string, unknown> | undefined;
  const error = (status: number, message: string, failure: Failure) => {
    budget.close();
    track(() => {
      telemetry.headers(status);
      telemetry.finish(failure === "cancelled" ? "cancelled" : "failed", failure, "none");
    });
    return Response.json(
      { error: { type: status === 429 ? "rate_limit_error" : "api_error", message: `agentgate: ${message}` } },
      { status },
    );
  };
  try {
    body =
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : await readBody(req.body, limits.maxBody, AbortSignal.any([budget.signal, AbortSignal.timeout(30000)]));
    if (body?.length) {
      const value = safeJsonParse(new TextDecoder().decode(body)).data;
      if (isRecord(value)) json = value;
    }
  } catch (e) {
    return error(
      e instanceof BodyTooLarge ? 413 : 408,
      e instanceof BodyTooLarge ? e.message : "request body cancelled or timed out",
      req.signal.aborted ? "cancelled" : "request",
    );
  }
  const requestedModel = provider.requestedModel?.(json) ?? (typeof json?.model === "string" ? json.model : undefined);
  const model = resolveModel(s, provider.name, requestedModel);
  track(() => telemetry.models(requestedModel, model));
  if (json && model && model !== requestedModel) {
    json = provider.rewriteModel?.(json, model) ?? { ...json, model };
    body = new TextEncoder().encode(JSON.stringify(json));
  }
  const headers = new Headers(req.headers);
  for (const key of HOP_HEADERS) headers.delete(key);
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1],
    own = bearer && bearer !== PLACEHOLDER_TOKEN ? bearer : undefined;
  // One id serves affinity, which keys on its hash, and session usage, which counts under it as the client named it.
  const clientSession = provider.session?.(req.headers, json);
  const session = clientSession && new Bun.CryptoHasher("sha256").update(clientSession).digest("hex");
  // Session usage counts the factory's runs; with the factory off nothing reads it, so nothing is written.
  const usageSession = settings.factory ? trackedSession(provider.name, clientSession) : undefined;
  const previousResponse = provider.stateful?.(json) ? String(json?.previous_response_id ?? "") : undefined;
  const requiredAccount =
    options.accountId ?? (previousResponse ? continuationAccount(s, previousResponse) : undefined);
  // A response that is not streamed sends its headers only once the model is done (Codex compaction, non-streaming
  // Claude calls): waiting only the short header deadline would fail a request the upstream completes and bills.
  const headerWait = () => Math.min(json && json.stream !== true ? Infinity : limits.headerTimeout, budget.remaining());
  const deliver = (res: Response, accountId: string, release: () => void) => {
    budget.close();
    track(() => telemetry.headers(res.status));
    const observer = streamObserver((id) => {
      if (accountId) rememberContinuation(s, id, accountId);
    });
    const stream = streamBody(res.body, req.signal, limits.streamIdle, {
      chunk: (bytes) => {
        telemetry.firstByte();
        if (res.headers.get("content-type")?.includes("text/event-stream")) observer.chunk(bytes);
      },
      end: (outcome) => {
        release();
        track(() => telemetry.tokens(observer.tokens));
        if (usageSession)
          recordSessionUsage(s, {
            session: usageSession,
            provider: provider.name,
            model: telemetry.tokenModel,
            ...observer.tokens,
            at: s.now(),
          });
        const streamOutcome = outcome === "eof" ? (observer.terminal ?? "eof") : outcome;
        track(() =>
          telemetry.finish(
            outcome === "cancelled"
              ? "cancelled"
              : outcome !== "eof"
                ? "interrupted"
                : !res.ok || observer.terminal === "provider-error"
                  ? "failed"
                  : "success",
            outcome === "cancelled"
              ? "cancelled"
              : !res.ok
                ? classify(provider, res.status, res.headers, "")
                : observer.terminal === "provider-error" || outcome !== "eof"
                  ? "transient"
                  : undefined,
            streamOutcome,
          ),
        );
      },
    });
    return new Response(stream, { status: res.status, statusText: res.statusText, headers: cleanHeaders(res.headers) });
  };
  const passthrough = async () => {
    const attempt = attemptOn("", "client login fallback"),
      elapsed = startTimer();
    const up = provider.prepare(path, new Headers(headers), body, {
      accessToken: own,
    } as import("../store.ts").Credential);
    try {
      const res = await fetchHeaders(
        up.url,
        { method: req.method, headers: up.headers, body: up.body, redirect: "manual", signal: budget.signal },
        headerWait(),
      );
      attempt.status = res.status;
      attempt.headersMs = Math.round(elapsed());
      if (!res.ok) attempt.failure = classify(provider, res.status, res.headers, "");
      track(() => telemetry.saveAttempt(attempt));
      return deliver(res, "", () => {});
    } catch {
      attempt.status = 502;
      attempt.failure = "transient";
      attempt.headersMs = Math.round(elapsed());
      track(() => telemetry.saveAttempt(attempt));
      return error(
        req.signal.aborted ? 408 : 502,
        "upstream unreachable or timed out",
        req.signal.aborted ? "cancelled" : "transient",
      );
    }
  };
  if (own && !provider.pooled(path)) return passthrough();
  if (previousResponse && !requiredAccount)
    return own ? passthrough() : error(409, "continuation owner is unknown; start a new response", "stateful");
  const tried = new Set<string>();
  /** Accounts whose login failed during this request: no usable token, or refused even after a refresh. */
  const loginFailed = new Set<string>();
  /** The last upstream rate-limit rejection, returned once no other account can take the request. */
  let rateLimited: { text: string; headers: Headers } | undefined;
  let waited = false,
    accountCount = 0;
  for (;;) {
    if (budget.signal.aborted)
      return error(408, "request cancelled or bootstrap budget exhausted", req.signal.aborted ? "cancelled" : "budget");
    const decision = route(s, provider.name, requestedModel, { exclude: tried, session, requiredAccount });
    const account = decision.account ? s.get("account", decision.account) : undefined;
    if (!account || accountCount >= settings.maxAccounts) {
      if (rateLimited) {
        budget.close();
        track(() => {
          telemetry.headers(429);
          telemetry.finish("failed", "rate", "none");
        });
        return new Response(rateLimited.text, { status: 429, headers: rateLimited.headers });
      }
      if (requiredAccount) return error(409, "selected account cannot serve this continuation or probe", "stateful");
      if (own) return passthrough();
      const reset = earliestReset(s, provider.name, model);
      const enabled = s.list("account").filter((a) => a.provider === provider.name && a.enabled);
      const loginBlocked = (a: Account) =>
        loginFailed.has(a.id) || !s.get("credential", a.id) || !!s.get("credential", a.id)?.needsLogin;
      const eligible = enabled.filter((a) => !eligibility(s, a, model).some(isModelReason));
      const usable = eligible.filter((a) => !loginBlocked(a));
      // Only when logins are why nothing could serve: an account skipped for quota or a cooldown still owes the client
      // its 429 and retry-after, or a wait for its reset.
      if (!enabled.length || enabled.every(loginBlocked) || (eligible.length && !usable.length))
        return error(
          503,
          !enabled.length ? "no enabled accounts configured" : "no valid account login available; check account status",
          "login",
        );
      if (decision.candidates.every((c) => c.reasons.some(isModelReason)))
        return error(400, "no eligible account for this model", "model");
      if (accountCount >= settings.maxAccounts) return error(429, "maximum accounts attempted", "budget");
      if (
        settings.whenExhausted === "wait" &&
        !waited &&
        reset &&
        reset - s.now() <= Math.min(600000, budget.remaining())
      ) {
        try {
          await sleep(Math.max(0, reset - s.now()), budget.signal);
        } catch {
          continue;
        }
        waited = true;
        tried.clear();
        continue;
      }
      if (usable.length && !usable.some((a) => exhausted(s.get("usage", a.id), model, s.now()))) {
        const blocked = usable.flatMap((a) => cooldowns(s, a.id, model));
        const rate = blocked.some((c) => c.reason === "rate");
        const response = error(
          rate ? 429 : 503,
          rate
            ? "accounts are rate limited; retry after local backoff"
            : "accounts are temporarily unavailable; retry after local backoff",
          rate ? "rate" : "transient",
        );
        if (reset) response.headers.set("retry-after", String(Math.max(1, Math.ceil((reset - s.now()) / 1000))));
        return response;
      }
      const response = exhaustedResponse(provider.name, reset, s.now());
      budget.close();
      track(() => {
        telemetry.headers(429);
        telemetry.finish("failed", "quota", "none");
      });
      return response;
    }
    accountCount++;
    let credential: import("../store.ts").Credential;
    // Cancelling stops only this wait; coordinated credential work stays owned and drained by Credentials.
    try {
      credential = await raceAbort(creds.token(account.id), budget.signal);
    } catch (e) {
      if (budget.signal.aborted) continue;
      if (!(e instanceof NeedsLogin)) log(account.id, 0, 0, "credential unavailable");
      tried.add(account.id);
      loginFailed.add(account.id);
      continue;
    }
    let authRetried = false,
      rateRetries = 0;
    for (;;) {
      if (budget.signal.aborted) break;
      const up = provider.prepare(path, new Headers(headers), body, credential, json);
      const attempt = attemptOn(account.id, decision.reason),
        elapsed = startTimer();
      const release = beginRoute(s, provider.name, account.id, session);
      let res: Response;
      try {
        res = await fetchHeaders(
          up.url,
          { method: req.method, headers: up.headers, body: up.body, redirect: "manual", signal: budget.signal },
          headerWait(),
        );
      } catch {
        release();
        attempt.status = 502;
        attempt.headersMs = Math.round(elapsed());
        attempt.failure = req.signal.aborted ? "cancelled" : budget.signal.aborted ? "budget" : "transient";
        track(() => telemetry.saveAttempt(attempt));
        if (!budget.signal.aborted) cool(s, account.id, "transient", s.now() + 15000);
        return error(
          req.signal.aborted ? 408 : 502,
          "upstream unreachable or timed out; outcome uncertain",
          attempt.failure,
        );
      }
      attempt.status = res.status;
      attempt.headersMs = Math.round(elapsed());
      const observed = provider.usage(res.headers);
      // Holds when quota went unknown, so it is written only when that starts or ends, not on every response.
      bestEffort("local state", () => {
        if (provider.headerQuota !== false && res.ok && !observed && provider.pooled(path)) {
          if (!quotaUnknown.get(s, provider.name)) quotaUnknown.set(s, provider.name, String(s.now()));
        } else if (observed) quotaUnknown.set(s, provider.name, undefined);
      });
      if (res.status === 429 || res.status === 401 || res.status === 400 || res.status === 404) {
        let text = "";
        try {
          text = new TextDecoder().decode(
            await readBody(res.body, 1024 * 1024, AbortSignal.any([budget.signal, AbortSignal.timeout(10000)])),
          );
        } catch {
          release();
          return error(502, "upstream rejection response too large or timed out", "transient");
        }
        release();
        const failure = classify(provider, res.status, res.headers, text);
        attempt.failure = failure;
        track(() => telemetry.saveAttempt(attempt));
        if (res.status === 401) {
          if (!authRetried) {
            authRetried = true;
            try {
              const next = await raceAbort(creds.refresh(account.id), budget.signal);
              if (next.accessToken !== credential.accessToken) {
                credential = next;
                continue;
              }
            } catch {}
          }
          tried.add(account.id);
          loginFailed.add(account.id);
          break;
        }
        if (failure === "quota") {
          const windows = observed?.windows.filter((w) => w.usedPct >= 100) ?? [],
            global = windows.filter((w) => normalizedWindow(w).scope?.kind === "account");
          const until = global.length
            ? Math.max(...global.map((w) => w.resetsAt ?? s.now() + Math.max(1000, retryAfterMs(res.headers))))
            : !windows.length
              ? s.now() + Math.max(1000, retryAfterMs(res.headers))
              : undefined;
          observe(account.id, { windows: observed?.windows ?? [], status: "exhausted" }, until);
          log(account.id, 429, Math.round(elapsed()), "quota exhausted; switching");
          tried.add(account.id);
          break;
        }
        if (observed) observe(account.id, observed);
        if (failure === "model" && model) {
          cool(s, account.id, "model", s.now() + 300000, model);
          tried.add(account.id);
          break;
        }
        if (failure === "rate") {
          const delay = retryAfterMs(res.headers, s.now());
          cool(s, account.id, "rate", s.now() + delay);
          if (
            delay <= SHORT_RATE_WAIT &&
            rateRetries++ < (account.policy?.retryLimit ?? settings.retryLimit) &&
            delay < budget.remaining()
          ) {
            try {
              await sleep(delay + clamp(budget.remaining() - delay - 1, 0, 250) * Math.random(), budget.signal);
            } catch {
              break;
            }
            continue;
          }
          // A 429 is a certain rejection, so another account replays nothing; the client sees it only when none is left.
          rateLimited = { text, headers: cleanHeaders(res.headers) };
          tried.add(account.id);
          break;
        }
        budget.close();
        track(() => {
          telemetry.headers(res.status);
          telemetry.finish("failed", failure, "none");
        });
        return new Response(text, { status: res.status, headers: cleanHeaders(res.headers) });
      }
      if (!res.ok) attempt.failure = classify(provider, res.status, res.headers, "");
      if (attempt.failure === "transient") cool(s, account.id, "transient", s.now() + 15000);
      track(() => telemetry.saveAttempt(attempt));
      if (observed) observe(account.id, observed);
      if (res.ok && activeAccount.get(s, provider.name) !== account.id) {
        bestEffort("local state", () => activeAccount.set(s, provider.name, account.id));
        log(account.id, 0, 0, "active subscription changed");
      }
      const listing = req.method === "GET" && res.ok ? provider.modelList?.(path) : undefined;
      if (listing) {
        try {
          const bytes = await readBody(res.body, 256 * 1024, budget.signal);
          const filtered = filterModelList(s, provider.name, JSON.parse(new TextDecoder().decode(bytes)), listing);
          res = new Response(JSON.stringify(filtered), { status: res.status, headers: cleanHeaders(res.headers) });
        } catch {
          release();
          return error(502, "model list unreadable or too large", "transient");
        }
      }
      return deliver(res, account.id, release);
    }
  }
}
/** The one reading of an account's flags that the app, the CLI and the factory label it by. A login this machine holds
 * refreshes itself on the next request, and a cooldown benches the account even while its quota has room. */
export function accountState(s: Store, account: Account, now = s.now()): AccountState {
  const c = s.get("credential", account.id),
    u = s.get("usage", account.id);
  if (!c || c.needsLogin) return { kind: "needs-login" };
  const expired = c.expiresAt <= now;
  if (expired && c.holder !== s.nodeId) return { kind: "waiting-for-holder", holder: c.holder };
  if (refreshFailure(s, "credential", account.id)) return { kind: "refresh-failed" };
  if (expired) return { kind: "refreshing" };
  if (!account.enabled) return { kind: "disabled" };
  if (exhausted(u, undefined, now)) {
    const resets = relevant(u, undefined, now).flatMap((w) => (w.usedPct >= 100 && w.resetsAt ? [w.resetsAt] : []));
    if (u?.exhaustedUntil && u.exhaustedUntil > now) resets.push(u.exhaustedUntil);
    return { kind: "exhausted", until: resets.length ? Math.max(...resets) : undefined };
  }
  const benched = cooldowns(s, account.id)
    .filter((cooldown) => cooldown.scope === "account")
    .sort((a, b) => b.retryAt - a.retryAt)[0];
  if (benched) return { kind: "cooling", until: benched.retryAt, reason: benched.reason };
  return { kind: "ready" };
}
export function accountStatus(s: Store, account: Account): AccountStatus & { state: AccountState } {
  const now = s.now(),
    u = s.get("usage", account.id),
    c = s.get("credential", account.id);
  return {
    state: accountState(s, account, now),
    account: sent<Data<"account">>(account),
    windows: (u?.windows ?? []).map((w) => ({
      ...normalizedWindow(w),
      inferredReset: w.inferredReset || !!(w.resetsAt && w.resetsAt <= now),
    })),
    exhausted: exhausted(u, undefined, now),
    exhaustedUntil: u?.exhaustedUntil && u.exhaustedUntil > now ? u.exhaustedUntil : undefined,
    observedAt: u?.observedAt,
    observedBy: u?.observedBy,
    observationSource: u?.source,
    active: activeAccount.get(s, account.provider) === account.id,
    needsLogin: !c || !!c.needsLogin,
    holder: c?.holder,
    expiresAt: c?.expiresAt,
    expired: !!c && c.expiresAt <= now,
    waitingFor: c && !c.needsLogin && c.expiresAt <= now && c.holder !== s.nodeId ? c.holder : undefined,
    refreshError: refreshFailure(s, "credential", account.id) ? "token refresh failed" : undefined,
    revision: revision(s, "account", account.id),
    quotaState: !u ? "unknown" : now - u.observedAt >= QUOTA_STALE ? "stale" : "fresh",
    quotaHealth: quotaHealth(s, account.id),
    cooldowns: cooldowns(s, account.id),
    models: modelsFor(s, account.id),
    modelError: modelErrors.get(s, account.id),
  };
}
