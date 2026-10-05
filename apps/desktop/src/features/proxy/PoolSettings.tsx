import { useState, type FormEvent } from "react";
import { Button } from "@heroui/react";
import {
  settingsSchema,
  settingsPatchSchema,
  type Settings,
  type RouteExplanation,
  type SettingsUpdateResult,
  type Provider,
} from "@agentgate/protocol";
import type { ViewProps } from "../../types.ts";
import { request } from "../../api.ts";
import {
  Badge,
  Changes,
  Choice,
  Field,
  NumberInput,
  Panel,
  Toggle,
} from "../../components/ui.tsx";
import { providerIcon, providerName } from "../../views/utils.ts";
import { ModelAliases } from "./ModelAliases.tsx";
import { useGeneration } from "./useGeneration.ts";

const numbers = [
  ["threshold", "Switch threshold (%)", 1, 100],
  ["retryLimit", "Rate-limit retries", 0, 10],
  ["maxAccounts", "Maximum accounts per request", 1, 1000],
  ["bootstrapTimeoutMs", "Request startup budget (ms)", 1000, 900000],
  ["affinityTtlMs", "Session affinity lifetime (ms)", 1000, 86400000],
  ["logRetention", "Retained requests", 100, 100000],
  ["logRetentionBytes", "Activity storage budget (bytes)", 65536, 268435456],
] as const;
export function PoolSettings({ data, connection, perform }: ViewProps) {
  const [base, setBase] = useState(() => ({
    settings: data.settings,
    revision: data.settingsRevision,
  }));
  const [draft, setDraft] = useState<Settings>(base.settings);
  const [preview, setPreview] = useState<Partial<Settings>>(),
    [error, setError] = useState("");
  const [explanation, setExplanation] = useState<RouteExplanation>();
  const capture = useGeneration(connection);
  const change = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((old) => ({ ...old, [key]: value }));
    setPreview(undefined);
  };
  const reload = () => {
    setBase({ settings: data.settings, revision: data.settingsRevision });
    setDraft(data.settings);
    setPreview(undefined);
    setError("");
  };
  const previewChanges = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = settingsSchema.safeParse(draft);
    if (!result.success) {
      setError(result.error.issues.map((issue) => issue.message).join("; "));
      return;
    }
    const changed = Object.entries(result.data).filter(
      ([key, value]) =>
        JSON.stringify(value) !==
        JSON.stringify(base.settings[key as keyof Settings]),
    );
    setPreview(settingsPatchSchema.parse(Object.fromEntries(changed)));
    setError("");
  };
  const saveChanges = () =>
    perform(async () => {
      const current = capture();
      const { revision, ...settings } = await request<SettingsUpdateResult>(
        connection,
        "/settings",
        "PATCH",
        { revision: base.revision, patch: preview },
      );
      if (!current()) return;
      setBase({ settings, revision });
      setDraft(settings);
      setPreview(undefined);
    }, "Pool settings saved");
  const explainRouting = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const query = new URLSearchParams({
      provider: String(form.get("provider")),
    });
    const model = String(form.get("model") ?? "").trim();
    if (model) query.set("model", model);
    void perform(async () => {
      const current = capture();
      const result = await request<RouteExplanation>(
        connection,
        `/proxy/route?${query}`,
      );
      if (current()) setExplanation(result);
    });
  };
  const label = (id?: string) =>
    data.accounts.find((a) => a.account.id === id)?.account.label ?? id;
  return (
    <>
      <Panel
        title="Daemon capabilities"
        detail={
          data.daemon
            ? `Version ${data.daemon.version} · Build ${data.daemon.build} · ${data.node}`
            : "This daemon does not advertise optional capabilities."
        }
      >
        {data.daemon &&
          (Object.keys(data.daemon.providers) as Provider[]).map((provider) => (
            <div className="item" key={provider}>
              <div className={`provider-icon ${provider}`}>
                {providerIcon(provider)}
              </div>
              <strong className="grow">{providerName(provider)}</strong>
              <div className="row wrap">
                {Object.entries(data.daemon!.providers[provider]).map(
                  ([name, supported]) => (
                    <Badge key={name} good={supported}>
                      {supported ? name : `${name} unsupported`}
                    </Badge>
                  ),
                )}
              </div>
            </div>
          ))}
      </Panel>
      <Panel
        title="Pool behavior"
        detail="Policy syncs to paired machines. Activity and backoff remain local to each daemon."
      >
        {base.revision !== data.settingsRevision && (
          <div className="item" role="status">
            <span className="grow">
              <strong>Settings changed elsewhere</strong>
              <small>
                Your draft is preserved. Reload to review the latest settings.
              </small>
            </span>
            <Button variant="tertiary" size="sm" onPress={reload}>
              Reload
            </Button>
          </div>
        )}
        <form onSubmit={previewChanges}>
          <Choice
            className="item"
            label="Selection strategy"
            value={draft.strategy}
            onChange={(v) =>
              change("strategy", String(v) as Settings["strategy"])
            }
            options={[
              {
                id: "automatic",
                label: "Automatic: active account, then reset and priority",
              },
              { id: "priority", label: "Highest priority" },
              { id: "round-robin", label: "Round robin" },
            ]}
          />
          <Choice
            className="item"
            label="When capacity is exhausted"
            value={draft.whenExhausted}
            onChange={(v) =>
              change("whenExhausted", String(v) as Settings["whenExhausted"])
            }
            options={[
              { id: "fail", label: "Return a retry time" },
              { id: "wait", label: "Wait within the startup budget" },
            ]}
          />
          {numbers.map(([key, label, min, max]) => (
            <NumberInput
              key={key}
              className="item"
              label={label}
              minValue={min}
              maxValue={max}
              value={draft[key]}
              onChange={(v) => change(key, v)}
            />
          ))}
          <Toggle
            label="Session affinity"
            description="Prefer the same eligible account for a recognized session."
            isSelected={draft.sessionAffinity}
            onChange={(v) => change("sessionAffinity", v)}
          />
          <Toggle
            label="Background Codex usage polling"
            description="Opt in to the candidate read-only endpoint. Manual refresh remains available."
            isSelected={draft.codexQuotaPolling}
            onChange={(v) => change("codexQuotaPolling", v)}
          />
          <ModelAliases
            aliases={draft.aliases}
            change={(rows) => change("aliases", rows)}
          />
          {error && (
            <div className="item danger" role="alert">
              {error}
            </div>
          )}
          <div className="item item-actions">
            <Button variant="ghost" size="sm" onPress={reload}>
              Discard changes
            </Button>
            <Button type="submit" size="sm">
              Preview changes
            </Button>
          </div>
        </form>
        {preview && (
          <div className="item stack">
            <strong>Review changes</strong>
            {Object.keys(preview).length ? (
              <>
                <Changes
                  rows={Object.entries(preview).map(([key, value]) => [
                    key,
                    JSON.stringify(base.settings[key as keyof Settings]),
                    JSON.stringify(value),
                  ])}
                />
                <Button
                  size="sm"
                  className="self-end"
                  onPress={() => void saveChanges()}
                >
                  Save reviewed changes
                </Button>
              </>
            ) : (
              <small>No changes.</small>
            )}
          </div>
        )}
      </Panel>
      <Panel
        title="Explain routing"
        detail={`Inspect the current policy on ${data.node} without sending inference.`}
      >
        <form onSubmit={explainRouting}>
          <Choice
            className="item"
            label="Provider"
            name="provider"
            defaultValue="claude"
            options={[
              { id: "claude", label: "Claude" },
              { id: "codex", label: "Codex" },
            ]}
          />
          <Field
            className="item"
            label="Model"
            description="Optional. Leave empty for any model."
            name="model"
            placeholder="Exact model identifier"
          />
          <div className="item item-actions">
            <Button type="submit" size="sm">
              Explain selection
            </Button>
          </div>
        </form>
        {explanation && (
          <>
            <div className="item">
              <span className="grow">
                <strong>
                  {explanation.account
                    ? `Routes to ${label(explanation.account)}`
                    : "No account selected"}
                </strong>
                <small>
                  {explanation.routedModel || "Any model"} ·{" "}
                  {explanation.reason}
                </small>
              </span>
            </div>
            {explanation.candidates.map((c) => (
              <div className="item" key={c.id}>
                <span className="grow">
                  <strong>{label(c.id)}</strong>
                  <small>
                    {[...(c.eligible ? [] : c.reasons), `${c.inFlight} in flight`].join(" · ")}
                  </small>
                </span>
                <Badge good={c.eligible}>
                  {c.eligible ? "Eligible" : "Skipped"}
                </Badge>
              </div>
            ))}
          </>
        )}
      </Panel>
    </>
  );
}
