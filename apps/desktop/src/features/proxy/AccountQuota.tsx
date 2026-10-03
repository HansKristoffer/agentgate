import { useSyncExternalStore } from "react";
import { matchesQuotaWindow, type AccountStatus } from "@agentgate/protocol";
import { Badge, Quota } from "../../components/ui.tsx";
import { ago, windowName } from "../../views/utils.ts";

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
export function AccountQuota({
  account,
  model,
}: {
  account: AccountStatus;
  model?: string;
}) {
  const now = useSyncExternalStore(subscribe, snapshot, () => 0) * 1000;
  const windows = account.windows.filter(
    (w) => !model || matchesQuotaWindow(w, model),
  );
  const cooldowns = (account.cooldowns ?? []).filter(
    (c) =>
      c.retryAt > now && (!model || c.scope === "account" || c.model === model),
  );
  const blockers = windows
    .filter((w) => w.usedPct >= 100 && w.resetsAt && w.resetsAt > now)
    .map((w) => w.resetsAt!);
  if (account.exhaustedUntil && account.exhaustedUntil > now)
    blockers.push(account.exhaustedUntil);
  blockers.push(...cooldowns.map((c) => c.retryAt));
  const availableAt = blockers.length ? Math.max(...blockers) : undefined;
  return (
    <div className="quota-details">
      <small className="muted">
        {account.observedAt
          ? `Last measured ${ago(account.observedAt)} on ${account.observedBy ?? "this machine"}${account.observationSource ? ` (${account.observationSource})` : ""}`
          : "Usage unknown"}
        {account.quotaState === "stale" ? " · Refresh needed" : ""}
      </small>
      <div className="usage">
        {windows.map((w) => {
          const passed = !!w.resetsAt && w.resetsAt <= now;
          return (
            <div
              key={w.name}
              title={
                w.resetsAt
                  ? new Date(w.resetsAt).toLocaleString()
                  : "Reset time unknown"
              }
            >
              <span>
                {windowName(w.name)}
                {w.scope?.kind === "model" ? ` · ${w.scope.model}` : ""}
              </span>
              <Quota value={w.usedPct} />
              <strong>{Math.round(w.usedPct)}%</strong>
              <small>
                {passed
                  ? "Reset passed; last measurement"
                  : w.resetsAt
                    ? `Resets in ${Math.max(1, Math.ceil((w.resetsAt - now) / 60000))} min · ${new Date(w.resetsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${w.inferredReset ? " (estimated)" : ""}`
                    : "Reset unknown"}
              </small>
            </div>
          );
        })}
      </div>
      {!windows.length && (
        <small className="muted">
          Refresh usage to check available capacity.
        </small>
      )}
      {account.quotaHealth?.error && <small>{account.quotaHealth.error}</small>}
      {account.modelError && <small>{account.modelError}</small>}
      {availableAt && (
        <small>
          Relevant restrictions end {new Date(availableAt).toLocaleString()}
        </small>
      )}
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
