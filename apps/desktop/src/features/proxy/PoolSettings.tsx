import { useState, type FormEvent } from "react";
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
import {
  Choice,
  Field,
  NumberInput,
  Panel,
  Toggle,
} from "../../components/ui.tsx";
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
          Object.entries(data.daemon.providers).map(([provider, features]) => (
            <div className="item" key={provider}>
              <strong className="grow">{provider}</strong>
              <small>
                {Object.entries(features)
                  .map(
                    ([name, supported]) =>
                      `${name}: ${supported ? "available" : "unsupported"}`,
                  )
                  .join(" · ")}
              </small>
            </div>
          ))}
      </Panel>
      <Panel
        title="Pool behavior"
        detail="Policy syncs to paired machines. Activity and backoff remain local to each daemon."
      >
        {base.revision !== data.settingsRevision && (
          <p role="status" className="note">
            Settings changed since you opened this editor. Your draft is
            preserved; reload to review the latest settings.
          </p>
        )}
        <form onSubmit={previewChanges}>
          <Choice
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
          {error && <p role="alert">{error}</p>}
          <div className="row">
            <Button type="submit" size="sm">
              Preview changes
            </Button>
            <Button variant="ghost" size="sm" onPress={reload}>
              Reload current settings
            </Button>
          </div>
        </form>
        {preview && (
          <div className="policy-preview">
            <h3>Review changes</h3>
            {Object.keys(preview).length ? (
              <>
                <table className="compare">
                  <thead>
                    <tr>
                      <th>Setting</th>
                      <th>Before</th>
                      <th>After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(preview).map(([key, value]) => (
                      <tr key={key}>
                        <td>{key}</td>
                        <td>
                          {JSON.stringify(base.settings[key as keyof Settings])}
                        </td>
                        <td>{JSON.stringify(value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Button size="sm" onPress={() => void saveChanges()}>
                  Save reviewed changes
                </Button>
              </>
            ) : (
              <p>No changes.</p>
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
            label="Provider"
            name="provider"
            defaultValue="claude"
            options={[
              { id: "claude", label: "Claude" },
              { id: "codex", label: "Codex" },
            ]}
          />
          <Field
            label="Model"
            name="model"
            placeholder="Optional exact model identifier"
          />
          <Button type="submit" size="sm">
            Explain selection
          </Button>
        </form>
        {explanation && (
          <div className="policy-preview">
            <p>
              {explanation.routedModel || "Any model"} · {explanation.reason} ·{" "}
              {data.accounts.find((a) => a.account.id === explanation.account)
                ?.account.label ?? "No account selected"}
            </p>
            {explanation.candidates.map((c) => (
              <div className="item" key={c.id}>
                <strong className="grow">
                  {data.accounts.find((a) => a.account.id === c.id)?.account
                    .label ?? c.id}
                </strong>
                <small>
                  {c.eligible ? "Eligible" : c.reasons.join(", ")} ·{" "}
                  {c.inFlight} in flight
                </small>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}
