import { useState, type FormEvent } from "react";
import { Button } from "@heroui/react";
import {
  accountPatchSchema,
  type AccountStatus,
  type Connection,
} from "@agentgate/protocol";
import type { Perform } from "../../types.ts";
import { request } from "../../api.ts";
import { Choice, Field, Modal, NumberInput } from "../../components/ui.tsx";
import { useGeneration } from "./useGeneration.ts";
const list = (value: FormDataEntryValue | null) =>
  String(value ?? "")
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
export function AccountPolicy({
  account,
  connection,
  perform,
  close,
}: {
  account: AccountStatus;
  connection: Connection;
  perform: Perform;
  close: () => void;
}) {
  const [patch, setPatch] =
      useState<ReturnType<typeof accountPatchSchema.parse>>(),
    [error, setError] = useState("");
  const capture = useGeneration(connection);
  const current = account.account;
  const previewChanges = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = accountPatchSchema.safeParse({
      label: form.get("label"),
      priority: Number(form.get("priority")),
      policy: {
        retryLimit:
          form.get("retryMode") === "inherit"
            ? undefined
            : Number(form.get("retryLimit")),
        allowModels: list(form.get("allowModels")),
        excludeModels: list(form.get("excludeModels")),
      },
    });
    if (!result.success) {
      setError("Check the model identifiers and retry count.");
      return;
    }
    setPatch(result.data);
    setError("");
  };
  const saveChanges = () =>
    perform(async () => {
      const isCurrent = capture();
      await request(
        connection,
        `/accounts/${encodeURIComponent(current.id)}`,
        "PATCH",
        { ...patch, revision: account.revision },
      );
      if (isCurrent()) close();
    }, "Account policy saved");
  const changes = patch && [
    ["Label", current.label, patch.label],
    ["Priority", current.priority, patch.priority],
    [
      "Retries",
      current.policy?.retryLimit ?? "Inherit",
      patch.policy?.retryLimit ?? "Inherit",
    ],
    [
      "Allowed models",
      current.policy?.allowModels?.join(", ") || "Automatic",
      patch.policy?.allowModels?.join(", ") || "Automatic",
    ],
    [
      "Excluded models",
      current.policy?.excludeModels?.join(", ") || "None",
      patch.policy?.excludeModels?.join(", ") || "None",
    ],
  ];
  return (
    <Modal title={`Edit ${current.label}`} close={close}>
      <p>
        These choices sync to paired machines. Empty model lists keep automatic
        eligibility.
      </p>
      <form onChange={() => setPatch(undefined)} onSubmit={previewChanges}>
        <Field
          label="Label"
          name="label"
          isRequired
          defaultValue={current.label}
        />
        <NumberInput
          label="Priority"
          name="priority"
          defaultValue={current.priority}
        />
        <Choice
          label="Rate-limit retries"
          name="retryMode"
          defaultValue={
            current.policy?.retryLimit === undefined ? "inherit" : "custom"
          }
          options={[
            { id: "inherit", label: "Inherit pool default" },
            { id: "custom", label: "Use account override" },
          ]}
        />
        <NumberInput
          label="Override retry count"
          description="Zero disables retries when the override is selected."
          name="retryLimit"
          minValue={0}
          maxValue={10}
          defaultValue={current.policy?.retryLimit ?? 0}
        />
        <Field
          label="Allow models"
          description="Optional. One exact model identifier per line."
          name="allowModels"
          multiline
          defaultValue={current.policy?.allowModels?.join("\n") ?? ""}
        />
        <Field
          label="Exclude models"
          description="One exact model identifier per line."
          name="excludeModels"
          multiline
          defaultValue={current.policy?.excludeModels?.join("\n") ?? ""}
        />
        {account.models && (
          <p className="note">
            Discovered models: {account.models.models.join(", ") || "none"}.
            Checked {new Date(account.models.at).toLocaleString()}.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <Button type="submit">Preview changes</Button>
      </form>
      {patch && (
        <div className="policy-preview">
          <h3>Review changes</h3>
          <table className="compare">
            <thead>
              <tr>
                <th>Setting</th>
                <th>Before</th>
                <th>After</th>
              </tr>
            </thead>
            <tbody>
              {changes?.map(([label, before, after]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td>{before}</td>
                  <td>{after}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Button onPress={() => void saveChanges()}>
            Save reviewed changes
          </Button>
        </div>
      )}
    </Modal>
  );
}
