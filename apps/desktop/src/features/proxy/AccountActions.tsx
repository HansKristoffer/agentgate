import { useState } from "react";
import { Button } from "@heroui/react";
import type {
  AccountStatus,
  BatchResult,
  Verification,
} from "@agentgate/protocol";
import type { ViewProps } from "../../types.ts";
import { request } from "../../api.ts";
import { Badge, Choice, Field, Modal, Panel } from "../../components/ui.tsx";
import { useGeneration } from "./useGeneration.ts";

const actions = [
  { id: "quota", label: "Refresh usage" },
  { id: "verify", label: "Verify accounts" },
  { id: "models", label: "Discover models" },
  { id: "refresh", label: "Refresh logins" },
  { id: "enable", label: "Enable" },
  { id: "disable", label: "Disable" },
  { id: "reset-cooldown", label: "Reset local backoff" },
];
export function useAccountActions(
  { data, connection, perform }: ViewProps,
  selected: Set<string>,
  setSelected: (ids: Set<string>) => void,
) {
  const [action, setAction] = useState("quota"),
    [results, setResults] = useState<BatchResult[]>(),
    [probe, setProbe] = useState<AccountStatus>();
  const capture = useGeneration(connection);
  const supported = (account: AccountStatus, operation: string) => {
    const feature =
      operation === "quota"
        ? "quota"
        : operation === "models"
          ? "models"
          : operation === "probe"
            ? "probe"
            : undefined;
    return (
      !feature ||
      !!data.daemon?.providers[account.account.provider][
        feature as "quota" | "models" | "probe"
      ]
    );
  };
  const targets = data.accounts.filter(
    (a) => !selected.size || selected.has(a.account.id),
  );
  const disabled = actions
    .filter((action) => !targets.some((a) => supported(a, action.id)))
    .map((action) => action.id);
  const run = (ids: string[], operation: string) =>
    perform(async () => {
      const current = capture();
      const result = await request<BatchResult[]>(
        connection,
        "/accounts/batch",
        "POST",
        { ids, action: operation },
      );
      if (current()) setResults(result);
    });
  const needed = data.accounts.filter(
    (a) =>
      a.needsLogin ||
      a.refreshError ||
      a.quotaState !== "fresh" ||
      a.account.policy?.allowModels?.length ||
      a.account.policy?.excludeModels?.length ||
      a.modelError ||
      a.cooldowns?.length,
  );
  const controls = data.accounts.length > 0 && (
    <Panel
      title="Pool operations"
      detail={`Runs on ${data.node}. Usage, models, and read-only verification do not send inference requests.`}
    >
      {needed.length > 0 && (
        <div className="item">
          <span className="grow">
            <strong>{needed.length} accounts need attention</strong>
            <small>
              {needed
                .slice(0, 4)
                .map((a) => a.account.label)
                .join(", ")}
              {needed.length > 4 ? ", …" : ""}
            </small>
          </span>
          <Button
            size="sm"
            variant="ghost"
            onPress={() =>
              setSelected(
                new Set(needed.slice(0, 100).map((a) => a.account.id)),
              )
            }
          >
            Select these
          </Button>
        </div>
      )}
      <div className="item proxy-actions">
        <Choice
          label="Action"
          value={action}
          onChange={(v) => setAction(String(v))}
          options={actions}
          disabledKeys={disabled}
        />
        <Button
          size="sm"
          variant="ghost"
          onPress={() =>
            setSelected(
              selected.size
                ? new Set()
                : new Set(data.accounts.slice(0, 100).map((a) => a.account.id)),
            )
          }
        >
          {selected.size ? "Clear selection" : "Select all"}
        </Button>
        <Button
          size="sm"
          isDisabled={!selected.size || disabled.includes(action)}
          onPress={() => void run([...selected], action)}
        >
          Run on {selected.size} selected
        </Button>
      </div>
      {results && (
        <Modal
          title="Account operation results"
          close={() => setResults(undefined)}
        >
          {results.map((r) => {
            const verification = r.result as Verification | undefined;
            return (
              <div className="item stack" key={r.id}>
                <div className="row">
                  <strong className="grow">
                    {data.accounts.find((a) => a.account.id === r.id)?.account
                      .label ?? r.id}
                  </strong>
                  <Badge good={r.ok}>
                    {r.ok ? "Completed" : "Needs attention"}
                  </Badge>
                </div>
                {r.error && <p>{r.error}</p>}
                {verification?.checks &&
                  Object.entries(verification.checks).map(([key, check]) => (
                    <div className="row" key={key}>
                      <span>{key}</span>
                      <Badge good={check.status === "ok"}>{check.status}</Badge>
                      <small>{check.message}</small>
                    </div>
                  ))}
                {Array.isArray(r.result) && (
                  <p>{r.result.join(", ") || "No models returned"}</p>
                )}
              </div>
            );
          })}
        </Modal>
      )}
      {probe && (
        <Modal
          title={`Inference probe · ${probe.account.label}`}
          close={() => setProbe(undefined)}
        >
          <p>
            This sends a small model request using this account's quota on{" "}
            {data.node}.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const model = String(
                new FormData(e.currentTarget).get("model") ?? "",
              );
              void perform(async () => {
                const current = capture();
                const result = await request<Verification>(
                  connection,
                  `/accounts/${encodeURIComponent(probe.account.id)}/verify`,
                  "POST",
                  { probe: true, model },
                );
                if (current()) {
                  setProbe(undefined);
                  setResults([
                    {
                      id: probe.account.id,
                      ok: Object.values(result.checks).every(
                        (c) => c.status === "ok" || c.status === "unsupported",
                      ),
                      result,
                    },
                  ]);
                }
              });
            }}
          >
            <Field
              label="Model"
              name="model"
              isRequired
              placeholder={
                probe.account.provider === "claude"
                  ? "claude-sonnet-4-5"
                  : "gpt-5-codex"
              }
            />
            <Button type="submit">Send inference probe</Button>
          </form>
        </Modal>
      )}
    </Panel>
  );
  return {
    controls,
    supported,
    run: (id: string, operation: string) => run([id], operation),
    probe: setProbe,
  };
}
