import { useSyncExternalStore } from "react";
import { typedSwitch } from "hanzio";
import { TriangleAlert } from "lucide-react";
import { Spinner } from "@heroui/react";
import type { AccountStatus } from "@agentgate/protocol";
import { Badge, Quota } from "../../components/ui.tsx";
import { ago, resetIn, windowName } from "../../views/utils.ts";

function createTicker(ms: number) {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (!timer)
      timer = setInterval(() => {
        for (const notify of listeners) notify();
      }, ms);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  };
  const snapshot = () => Math.floor(Date.now() / ms) * ms;
  return { subscribe, snapshot };
}

// Quota bars display minute-resolution countdowns ("in 3 h 47 min"), so a 30s ticker keeps them fresh with 30x fewer re-renders.
const minuteClock = createTicker(30_000);
// Cooldowns count down in seconds, and subscribe only when an account actually has one active.
const secondClock = createTicker(1_000);

/** The account's limits as small bars with their resets, on Overview and Accounts. Stale usage gets a warning icon; `onRefresh` makes it a refresh button. */
export function AccountQuota({
  account,
  onRefresh,
  refreshing,
}: {
  account: AccountStatus;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const now = useSyncExternalStore(minuteClock.subscribe, minuteClock.snapshot, () => 0);
  const updated = account.observedAt ? `Updated ${ago(account.observedAt)}` : "Usage unknown";
  const stale = account.quotaState === "stale" && account.windows.length > 0;
  const staleNote = `Usage is out of date. ${updated}.${onRefresh ? " Click to refresh." : ""}`;
  return (
    <div className={stale ? "mini-quotas stale" : "mini-quotas"} title={updated}>
      {refreshing ? (
        <span className="stale-usage" title="Refreshing usage">
          <Spinner size="sm" color="current" />
        </span>
      ) : (
        stale &&
        (onRefresh ? (
          <button type="button" className="stale-usage" title={staleNote} aria-label={staleNote} onClick={onRefresh}>
            <TriangleAlert size={13} />
          </button>
        ) : (
          <span className="stale-usage" title={staleNote}>
            <TriangleAlert size={13} />
          </span>
        ))
      )}
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

function ActiveCooldowns({ cooldowns }: { cooldowns: NonNullable<AccountStatus["cooldowns"]> }) {
  const now = useSyncExternalStore(secondClock.subscribe, secondClock.snapshot, () => 0);
  const active = cooldowns.filter((c) => c.retryAt > now);
  if (!active.length) return null;
  return (
    <>
      {active.map((c) => (
        <div className="row" key={`${c.scope}:${c.model ?? ""}`}>
          <Badge>
            {typedSwitch(
              c.reason,
              { rate: () => "Rate limited", model: () => "Model unavailable" },
              () => "Upstream backoff",
            )}
          </Badge>
          <small>
            {c.model ?? "All models"} · retry in {Math.max(1, Math.ceil((c.retryAt - now) / 1000))} s
          </small>
        </div>
      ))}
    </>
  );
}

/** Problems the bars can't show: failed usage and backoffs. Nothing when all is well. */
export function QuotaNotes({ account }: { account: AccountStatus }) {
  const hasCooldowns = !!account.cooldowns?.some((c) => c.retryAt > Date.now());
  if (!account.quotaHealth?.error && !account.modelError && !hasCooldowns) return null;
  return (
    <div className="quota-details">
      {account.quotaHealth?.error && <small>{account.quotaHealth.error}</small>}
      {account.modelError && <small>{account.modelError}</small>}
      {hasCooldowns && <ActiveCooldowns cooldowns={account.cooldowns!} />}
    </div>
  );
}
