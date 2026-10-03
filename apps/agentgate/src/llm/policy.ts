import { cooldownSchema, type Cooldown, type Failure } from "@agentgate/protocol";
import type { Store } from "../store.ts";

const state = new WeakMap<Store, Map<string, Cooldown>>();
function timers(s: Store) { let m = state.get(s); if (!m) state.set(s, m = new Map()); return m; }
export function cooldowns(s: Store, accountId: string, model?: string): Cooldown[] {
  const map = timers(s);
  for (const [key, entry] of map) if (entry.retryAt <= s.now() || !s.get("account", entry.accountId)) map.delete(key);
  return [...map.values()].filter(c => c.accountId === accountId && (!model || c.scope === "account" || c.model === model));
}
export function cool(s: Store, accountId: string, reason: Failure, retryAt: number, model?: string) {
  if (!s.get("account", accountId) || retryAt <= s.now()) return;
  const m = timers(s), key = `${accountId}\0${model ?? ""}`;
  if (m.size >= 5000 && !m.has(key)) m.delete(m.keys().next().value!);
  const prev = m.get(key);
  m.set(key, cooldownSchema.parse({ accountId, scope: model ? "model" : "account", model, reason, retryAt: Math.max(retryAt, prev?.retryAt ?? 0), observedAt: s.now() }));
}
export function resetCooldown(s: Store, accountId: string) { for (const [key, c] of timers(s)) if (c.accountId === accountId) timers(s).delete(key); }

export function retryAfterMs(headers: Headers, now = Date.now()): number {
  const value = headers.get("retry-after");
  if (value === null) return 2000;
  const seconds = Number(value);
  if (value.trim() && Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, Number.MAX_SAFE_INTEGER);
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? Math.max(0, instant - now) : 2000;
}
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
  remaining() { return Math.max(0, this.deadline - performance.now()); }
  close() { clearTimeout(this.timer); }
}
/** Cancellation stops the caller's wait; coordinated credential work remains owned and drained by Credentials. */
export async function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([task, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
