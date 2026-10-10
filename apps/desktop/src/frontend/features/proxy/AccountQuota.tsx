import { useSyncExternalStore } from "react";
import { TriangleAlert } from "lucide-react";
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
/** The account's limits as small bars with their resets, on Overview and Accounts. Stale usage gets a warning icon; `onRefresh` makes it a refresh button. */
export function AccountQuota({ account, onRefresh }: { account: AccountStatus; onRefresh?: () => void }) {
  const now = useSyncExternalStore(subscribe, snapshot, () => 0) * 1000;
  const updated = account.observedAt ? `Updated ${ago(account.observedAt)}` : "Usage unknown";
  const stale = account.quotaState === "stale" && account.windows.length > 0;
  const staleNote = `Usage is out of date. ${updated}.${onRefresh ? " Click to refresh." : ""}`;
  return (
    <div className={stale ? "mini-quotas stale" : "mini-quotas"} title={updated}>
      {stale &&
        (onRefresh ? (
          <button type="button" className="stale-usage" title={staleNote} aria-label={staleNote} onClick={onRefresh}>
            <TriangleAlert size={13} />
          </button>
        ) : (
          <span className="stale-usage" title={staleNote}>
            <TriangleAlert size={13} />
          </span>
        ))}
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

/** Problems the bars can't show: failed usage and backoffs. Nothing when all is well. */
export function QuotaNotes({ account }: { account: AccountStatus }) {
  const now = useSyncExternalStore(subscribe, snapshot, () => 0) * 1000;
  const cooldowns = (account.cooldowns ?? []).filter((c) => c.retryAt > now);
  if (!account.quotaHealth?.error && !account.modelError && !cooldowns.length) return null;
  return (
    <div className="quota-details">
      {account.quotaHealth?.error && <small>{account.quotaHealth.error}</small>}
      {account.modelError && <small>{account.modelError}</small>}
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
