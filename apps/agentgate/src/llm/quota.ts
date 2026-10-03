import {
  quotaHealthSchema,
  normalizeQuotaWindow as normalizedWindow,
  matchesQuotaWindow as matchesWindow,
  type QuotaWindow,
} from "@agentgate/protocol";
import type { Credentials } from "../credentials.ts";
import type { Store, Usage } from "../store.ts";
import { revision } from "../configuration.ts";
import { abortable } from "./policy.ts";
import type { Observation, Provider, ProviderName } from "./provider.ts";

export const QUOTA_STALE = 10 * 60_000;
export { normalizedWindow, matchesWindow };
export function relevant(
  u: Usage | undefined,
  model: string | undefined,
  now: number,
): QuotaWindow[] {
  return (u?.windows ?? [])
    .filter((w) => matchesWindow(w, model))
    .map((w) => (w.resetsAt && w.resetsAt <= now ? { ...w, usedPct: 0 } : w));
}
export function exhausted(
  u: Usage | undefined,
  model: string | undefined,
  now: number,
): boolean {
  return (
    !!(u?.exhaustedUntil && u.exhaustedUntil > now) ||
    relevant(u, model, now).some((w) => w.usedPct >= 100)
  );
}
export function recordUsage(
  s: Store,
  id: string,
  observation: Observation,
  until?: number,
  source: Usage["source"] = "headers",
) {
  if (!s.get("account", id)) return;
  const previous = s.get("usage", id),
    windows = new Map(
      (previous?.windows ?? []).map((w) => [w.name, normalizedWindow(w)]),
    );
  for (let w of observation.windows) {
    w = normalizedWindow(w);
    if (w.usedPct >= 100 && !w.resetsAt)
      w = { ...w, resetsAt: until ?? s.now() + 60000, inferredReset: true };
    const old = windows.get(w.name);
    if (
      old?.usedPct === 100 &&
      (!old.resetsAt || old.resetsAt > s.now()) &&
      w.usedPct < 100
    )
      continue;
    windows.set(w.name, w);
  }
  const next = {
    accountId: id,
    observedAt: s.now(),
    observedBy: s.nodeId,
    windows: [...windows.values()].sort((a, b) => a.name.localeCompare(b.name)),
    status: observation.status,
    source,
    exhaustedUntil:
      until ??
      (previous?.exhaustedUntil && previous.exhaustedUntil > s.now()
        ? previous.exhaustedUntil
        : undefined),
  };
  const key = (u: Usage) =>
    JSON.stringify([
      u.status,
      u.exhaustedUntil,
      u.source,
      u.windows.map((w) => [
        w.name,
        Math.round(w.usedPct),
        Math.round((w.resetsAt ?? 0) / 60000),
        w.scope,
      ]),
    ]);
  if (
    previous &&
    key(previous) === key(next) &&
    s.now() - previous.observedAt < 300000
  )
    return;
  s.put("usage", id, next);
}
export function quotaHealth(s: Store, id: string) {
  return quotaHealthSchema.parse(
    JSON.parse(s.local(`quotaHealth:${id}`) ?? "{}"),
  );
}
const flights = new WeakMap<Store, Map<string, Promise<boolean>>>();
export class Quotas {
  constructor(
    readonly s: Store,
    readonly creds: Pick<Credentials, "token">,
    readonly providers: Partial<Record<ProviderName, Provider>>,
  ) {}
  refresh(id: string, signal: AbortSignal, force = false): Promise<boolean> {
    let map = flights.get(this.s);
    if (!map) flights.set(this.s, (map = new Map()));
    const running = map.get(id);
    if (running) return abortable(running, signal);
    const task = this.fetch(id, signal, force);
    map.set(id, task);
    void task.finally(() => map!.delete(id)).catch(() => {});
    return task;
  }
  private async fetch(id: string, signal: AbortSignal, force: boolean) {
    const s = this.s,
      account = s.get("account", id),
      credential = s.get("credential", id);
    if (!account || !credential || credential.needsLogin || !account.enabled)
      throw new Error("Account has no usable login or is disabled");
    const provider = this.providers[account.provider];
    if (!provider?.fetchQuota) throw new Error("Usage refresh is unsupported");
    if (
      !force &&
      (credential.holder !== s.nodeId ||
        (account.provider === "codex" && !s.settings().codexQuotaPolling))
    )
      return false;
    const prior = quotaHealth(s, id),
      usageRev = revision(s, "usage", id);
    if (
      !force &&
      (s.now() - (s.get("usage", id)?.observedAt ?? 0) < QUOTA_STALE ||
        s.now() - (prior.attemptedAt ?? 0) < QUOTA_STALE)
    )
      return false;
    const attemptedAt = s.now();
    const combined = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    let credentialRev = revision(s, "credential", id);
    try {
      const token = await abortable(this.creds.token(id), combined);
      credentialRev = revision(s, "credential", id);
      const result = await provider.fetchQuota(token, combined);
      combined.throwIfAborted();
      if (
        s.closed ||
        !s.get("account", id) ||
        revision(s, "credential", id) !== credentialRev
      )
        return false;
      if (!result)
        throw new Error("Provider returned no recognizable quota windows");
      if (revision(s, "usage", id) === usageRev)
        recordUsage(s, id, result, undefined, "poll");
      s.setLocal(
        `quotaHealth:${id}`,
        JSON.stringify({ attemptedAt, succeededAt: s.now() }),
      );
      return true;
    } catch (error) {
      if (
        !s.closed &&
        !signal.aborted &&
        s.get("account", id) &&
        revision(s, "credential", id) === credentialRev
      )
        s.setLocal(
          `quotaHealth:${id}`,
          JSON.stringify({
            ...prior,
            attemptedAt,
            error: "Usage refresh failed; last observation retained",
          }),
        );
      throw error;
    }
  }
  async poll(signal: AbortSignal) {
    const ids = this.s
      .list("account")
      .filter((a) => a.enabled)
      .map((a) => a.id);
    await bounded(ids, async (id) => {
      if (!signal.aborted) await this.refresh(id, signal).catch(() => {});
    });
  }
}
export async function bounded<T, R>(
  items: T[],
  run: (item: T) => Promise<R>,
  concurrency = 4,
): Promise<R[]> {
  const result = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        result[i] = await run(items[i]!);
      }
    }),
  );
  return result;
}
