import { cooldownSchema, type Cooldown, type Failure } from "@agentgate/protocol";
import { parseRetryAfter } from "hanzio";
import type { Store } from "../store.ts";

const state = new WeakMap<Store, Map<string, Cooldown>>();
function timers(s: Store) {
  let m = state.get(s);
  if (!m) state.set(s, (m = new Map()));
  return m;
}
export function cooldowns(s: Store, accountId: string, model?: string): Cooldown[] {
  const map = timers(s);
  for (const [key, entry] of map) if (entry.retryAt <= s.now() || !s.get("account", entry.accountId)) map.delete(key);
  return [...map.values()].filter(
    (c) => c.accountId === accountId && (!model || c.scope === "account" || c.model === model),
  );
}
export function cool(s: Store, accountId: string, reason: Failure, retryAt: number, model?: string) {
  if (!s.get("account", accountId) || retryAt <= s.now()) return;
  const m = timers(s),
    key = `${accountId}\0${model ?? ""}`;
  if (m.size >= 5000 && !m.has(key)) m.delete(m.keys().next().value!);
  const prev = m.get(key);
  // A shorter cooldown cannot cut a longer one short, and the reason stays the longer one's: a rate limit followed by a
  // brief transient failure is still a rate limit.
  const kept = prev && prev.retryAt > retryAt ? prev : undefined;
  const next = cooldownSchema.parse({
    accountId,
    scope: model ? "model" : "account",
    model,
    reason: kept?.reason ?? reason,
    retryAt: kept?.retryAt ?? retryAt,
    observedAt: s.now(),
  });
  m.set(key, next);
  // The app shows the reason and retryAt, and works out the end from retryAt itself.
  if (next.retryAt !== prev?.retryAt || next.reason !== prev.reason) s.bump("status");
}
export function resetCooldown(s: Store, accountId: string) {
  const m = timers(s),
    before = m.size;
  for (const [key, c] of m) if (c.accountId === accountId) m.delete(key);
  if (m.size !== before) s.bump("status");
}

export const retryAfterMs = (headers: Headers, now = Date.now()) =>
  parseRetryAfter(headers.get("retry-after"), now) ?? 2000;
/** One wall-clock bootstrap deadline, independent of the provider's stream lifetime. */
export class Budget {
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  readonly deadline: number;
  constructor(signal: AbortSignal, ms: number) {
    this.deadline = performance.now() + ms;
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.timer = setTimeout(() => this.controller.abort(new Error("bootstrap budget exhausted")), ms);
    this.timer.unref();
  }
  remaining() {
    return Math.max(0, this.deadline - performance.now());
  }
  close() {
    clearTimeout(this.timer);
  }
}
