import { useMemo, useState, type FormEvent } from "react";
import { buildQueryString, typedKeys } from "hanzio";
import { Button } from "@heroui/react";
import {
  settingsSchema,
  settingsPatchSchema,
  type Settings,
  type RouteExplanation,
  type SettingsUpdateResult,
} from "@agentgate/protocol";
import type { ViewProps } from "../../types.ts";
import { request } from "../../api.ts";
import { Badge, Choice, Disclosure, Field, NumberInput, Panel, Toggle } from "../../components/ui.tsx";
import { formatBytes, formatDurationMs, providerIcon, providerName, providerOptions } from "../../views/utils.ts";
import { ModelAliases } from "./ModelAliases.tsx";
import { useGeneration } from "./useGeneration.ts";

export function PoolSettings({ data, connection, perform }: Pick<ViewProps, "data" | "connection" | "perform">) {
  const [base, setBase] = useState(() => ({
    settings: data.settings,
    revision: data.settingsRevision,
  }));
  const [draft, setDraft] = useState<Settings>(base.settings);
  const [error, setError] = useState("");
  const capture = useGeneration(connection);
  const change = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((old) => ({ ...old, [key]: value }));
    setError("");
  };
  const reload = () => {
    setBase({ settings: data.settings, revision: data.settingsRevision });
    setDraft(data.settings);
    setError("");
  };
  const changedKeys = useMemo(
    () =>
      (Object.keys(draft) as (keyof Settings)[]).filter(
        (key) => JSON.stringify(draft[key]) !== JSON.stringify(base.settings[key]),
      ),
    [draft, base.settings],
  );
  const dirty = changedKeys.length > 0;

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = settingsSchema.safeParse(draft);
    if (!result.success) {
      setError(result.error.issues.map((issue) => issue.message).join("; "));
      return;
    }
    const patch = settingsPatchSchema.parse(Object.fromEntries(changedKeys.map((key) => [key, result.data[key]])));
    if (!Object.keys(patch).length) return;
    setError("");
    void perform(async () => {
      const current = capture();
      const { revision, ...settings } = await request<SettingsUpdateResult>(connection, "/settings", "PATCH", {
        revision: base.revision,
        patch,
      });
      if (!current()) return;
      setBase({ settings, revision });
      setDraft(settings);
    }, "Pool settings saved");
  };

  return (
    <Panel title="Pool behavior" detail="Syncs to paired machines. Activity and backoffs stay local to each daemon">
      {base.revision !== data.settingsRevision && (
        <div className="item" role="status">
          <span className="grow">
            <strong>Settings changed elsewhere</strong>
            <small>Your draft is preserved. Reload to start from the latest settings.</small>
          </span>
          <Button variant="tertiary" size="sm" onPress={reload}>
            Reload
          </Button>
        </div>
      )}
      <form onSubmit={save}>
        <Choice
          className="item"
          label="Selection strategy"
          value={draft.strategy}
          onChange={(v) => change("strategy", String(v) as Settings["strategy"])}
          options={[
            {
              id: "automatic",
              label: "Automatic: soonest weekly reset first, then priority",
            },
            { id: "priority", label: "Highest priority" },
            { id: "round-robin", label: "Round robin" },
          ]}
        />
        <NumberInput
          className="item"
          label="Switch threshold (%)"
          description="Move to another account once usage reaches this level"
          minValue={1}
          maxValue={100}
          value={draft.threshold}
          onChange={(v) => change("threshold", v)}
        />
        <Choice
          className="item"
          label="When capacity is exhausted"
          value={draft.whenExhausted}
          onChange={(v) => change("whenExhausted", String(v) as Settings["whenExhausted"])}
          options={[
            { id: "fail", label: "Return a retry time" },
            { id: "wait", label: "Wait within the startup budget" },
          ]}
        />
        <Toggle
          label="Session affinity"
          description="Prefer the same eligible account for a recognized session"
          isSelected={draft.sessionAffinity}
          onChange={(v) => change("sessionAffinity", v)}
        />
        {draft.sessionAffinity && (
          <NumberInput
            className="item"
            label="Session affinity lifetime (ms)"
            description={`Currently ${formatDurationMs(draft.affinityTtlMs)}`}
            minValue={1000}
            maxValue={86400000}
            value={draft.affinityTtlMs}
            onChange={(v) => change("affinityTtlMs", v)}
          />
        )}
        <Toggle
          label="Background Codex usage polling"
          description="Opt in to background Codex quota checks. Manual refresh is always available"
          isSelected={draft.codexQuotaPolling}
          onChange={(v) => change("codexQuotaPolling", v)}
        />
        <Disclosure
          summary="Advanced pool settings"
          detail={
            draft.aliases.length
              ? `Retries, timeouts, activity retention and ${draft.aliases.length} model ${draft.aliases.length === 1 ? "alias" : "aliases"}`
              : "Retries, timeouts, activity retention and model aliases"
          }
        >
          <NumberInput
            className="item"
            label="Rate-limit retries"
            minValue={0}
            maxValue={10}
            value={draft.retryLimit}
            onChange={(v) => change("retryLimit", v)}
          />
          <NumberInput
            className="item"
            label="Maximum accounts per request"
            minValue={1}
            maxValue={1000}
            value={draft.maxAccounts}
            onChange={(v) => change("maxAccounts", v)}
          />
          <NumberInput
            className="item"
            label="Request startup budget (ms)"
            description={`Currently ${formatDurationMs(draft.bootstrapTimeoutMs)}`}
            minValue={1000}
            maxValue={900000}
            value={draft.bootstrapTimeoutMs}
            onChange={(v) => change("bootstrapTimeoutMs", v)}
          />
          <NumberInput
            className="item"
            label="Retained requests"
            description="Completed requests kept in local activity history"
            minValue={100}
            maxValue={100000}
            value={draft.logRetention}
            onChange={(v) => change("logRetention", v)}
          />
          <NumberInput
            className="item"
            label="Activity storage budget (bytes)"
            description={`Currently ${formatBytes(draft.logRetentionBytes)}`}
            minValue={65536}
            maxValue={268435456}
            value={draft.logRetentionBytes}
            onChange={(v) => change("logRetentionBytes", v)}
          />
          <ModelAliases aliases={draft.aliases} change={(rows) => change("aliases", rows)} />
        </Disclosure>
        {error && (
          <div className="item danger" role="alert">
            {error}
          </div>
        )}
        {dirty && (
          <div className="item item-actions">
            <small className="grow">
              {changedKeys.length} unsaved {changedKeys.length === 1 ? "change" : "changes"}
            </small>
            <Button variant="ghost" size="sm" onPress={reload}>
              Discard
            </Button>
            <Button type="submit" size="sm">
              Save
            </Button>
          </div>
        )}
      </form>
    </Panel>
  );
}

/** Troubleshooting tools tucked into one calm panel at the bottom of Settings. */
export function Diagnostics({ data, connection, perform }: Pick<ViewProps, "data" | "connection" | "perform">) {
  const [explanation, setExplanation] = useState<RouteExplanation>();
  const capture = useGeneration(connection);
  const daemon = data.daemon;
  const label = (id?: string) => data.accounts.find((a) => a.account.id === id)?.account.label ?? id;
  const explainRouting = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const query = buildQueryString({
      provider: String(form.get("provider")),
      model: String(form.get("model") ?? "").trim() || undefined,
    });
    void perform(async () => {
      const current = capture();
      const result = await request<RouteExplanation>(connection, `/proxy/route?${query}`);
      if (current()) setExplanation(result);
    });
  };
  return (
    <Panel title="Diagnostics" detail="Inspect routing decisions and daemon capabilities">
      <Disclosure summary="Explain routing" detail={`Test current selection on ${data.node} without sending inference`}>
        <form onSubmit={explainRouting}>
          <Choice className="item" label="Provider" name="provider" defaultValue="claude" options={providerOptions} />
          <Field
            className="item"
            label="Model"
            description="Optional. Leave empty for any model"
            name="model"
            placeholder="Exact model identifier"
          />
          <div className="item item-actions">
            <Button type="submit" size="sm" variant="tertiary">
              Explain selection
            </Button>
          </div>
        </form>
        {explanation && (
          <>
            <div className="item">
              <span className="grow">
                <strong>
                  {explanation.account ? `Routes to ${label(explanation.account)}` : "No account selected"}
                </strong>
                <small>
                  {explanation.routedModel || "Any model"} · {explanation.reason}
                </small>
              </span>
            </div>
            {explanation.candidates.map((c) => (
              <div className="item" key={c.id}>
                <span className="grow">
                  <strong>{label(c.id)}</strong>
                  <small>{[...(c.eligible ? [] : c.reasons), `${c.inFlight} in flight`].join(" · ")}</small>
                </span>
                <Badge good={c.eligible}>{c.eligible ? "Eligible" : "Skipped"}</Badge>
              </div>
            ))}
          </>
        )}
      </Disclosure>
      <Disclosure
        summary="Daemon capabilities"
        detail={
          daemon
            ? `v${daemon.version} · ${daemon.build} · ${data.node}`
            : "This daemon does not advertise optional capabilities"
        }
      >
        {daemon &&
          typedKeys(daemon.providers).map((provider) => (
            <div className="item" key={provider}>
              <div className={`provider-icon ${provider}`}>{providerIcon(provider)}</div>
              <strong className="grow">{providerName(provider)}</strong>
              <div className="row wrap">
                {Object.entries(daemon.providers[provider]).map(([name, supported]) => (
                  <Badge key={name} good={supported}>
                    {supported ? name : `${name} unsupported`}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
      </Disclosure>
    </Panel>
  );
}
