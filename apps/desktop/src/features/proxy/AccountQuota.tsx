import { useSyncExternalStore } from "react";
import type { AccountStatus } from "@agentgate/protocol";
import { Badge, Quota } from "../../components/ui.tsx";
import { ago, resetIn, windowName } from "../../views/utils.ts";

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (!timer)
    timer = setInterval(() => {
      for (const notify of listeners) notify();
    }, 1000);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
    }
  };
};
const snapshot = () => Math.floor(Date.now() / 1000);
/** The account's limits as small bars with their resets, on Overview and Accounts. */
export function AccountQuota({ account }: { account: AccountStatus }) {
  const now = useSyncExternalStore(subscribe, snapshot, () => 0) * 1000;
  const updated = account.observedAt ? `Updated ${ago(account.observedAt)}` : "Usage unknown";
  return (
    <div className="mini-quotas" title={account.quotaState === "stale" ? `${updated} · out of date` : updated}>
      {account.windows.length ? (
        account.windows.map((w) => {
          const model = w.scope?.kind === "model" ? ` · ${w.scope.model}` : "";
          const name = `${windowName(w.name)}${model}`;
          const estimated = w.inferredReset ? " (estimated)" : "";
          const reset = w.resetsAt
            ? `${name} resets ${new Date(w.resetsAt).toLocaleString()}${estimated}`
            : `${name}: reset time unknown`;
          return (
            <div key={w.name} title={reset}>
              <span>{name}</span>
              <Quota value={w.usedPct} />
              <small>{Math.round(w.usedPct)}%</small>
              <small>{resetIn(w.resetsAt, now)}</small>
            </div>
          );
        })
      ) : (
        <small>No usage data yet</small>
      )}
    </div>
  );
}

/** Problems the bars can't show: stale or failed usage, backoffs, and when a blocked account frees up. Nothing when all is well. */
export function QuotaNotes({ account }: { account: AccountStatus }) {
  const now = useSyncExternalStore(subscribe, snapshot, () => 0) * 1000;
  const cooldowns = (account.cooldowns ?? []).filter((c) => c.retryAt > now);
  const blockers = account.windows
    .filter((w) => w.usedPct >= 100 && w.resetsAt && w.resetsAt > now)
    .map((w) => w.resetsAt!);
  if (account.exhaustedUntil && account.exhaustedUntil > now)
    blockers.push(account.exhaustedUntil);
  blockers.push(...cooldowns.map((c) => c.retryAt));
  const availableAt = blockers.length ? Math.max(...blockers) : undefined;
  const stale = account.quotaState === "stale" && account.windows.length > 0;
  if (!stale && !account.quotaHealth?.error && !account.modelError && !availableAt && !cooldowns.length) return null;
  return (
    <div className="quota-details">
      {stale && <small className="muted">Usage is out of date. Refresh it from the ⋯ menu.</small>}
      {account.quotaHealth?.error && <small>{account.quotaHealth.error}</small>}
      {account.modelError && <small>{account.modelError}</small>}
      {availableAt && <small>Available again {new Date(availableAt).toLocaleString()}</small>}
      {cooldowns.map((c) => (
        <div className="row" key={`${c.scope}:${c.model ?? ""}`}>
          <Badge>
            {c.reason === "rate"
              ? "Rate limited"
              : c.reason === "model"
                ? "Model unavailable"
                : "Upstream backoff"}
          </Badge>
          <small>
            {c.model ?? "All models"} · retry in{" "}
            {Math.max(1, Math.ceil((c.retryAt - now) / 1000))} s
          </small>
        </div>
      ))}
    </div>
  );
}
