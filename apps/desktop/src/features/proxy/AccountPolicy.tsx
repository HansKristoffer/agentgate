import { useState, type FormEvent } from "react";
import { Button } from "@heroui/react";
import { accountPatchSchema, type AccountStatus, type Connection } from "@agentgate/protocol";
import type { Perform } from "../../types.ts";
import { control } from "../../api.ts";
import { Choice, Disclosure, Field, Modal, NumberInput } from "../../components/ui.tsx";
import { useGeneration } from "./useGeneration.ts";

/** Model identifiers are typed one per line or comma-separated. */
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
  const current = account.account;
  const [retryMode, setRetryMode] = useState<"inherit" | "custom">(
    current.policy?.retryLimit === undefined ? "inherit" : "custom",
  );
  const [error, setError] = useState("");
  const capture = useGeneration(connection);
  const hasAdvanced =
    current.policy?.retryLimit !== undefined ||
    !!current.policy?.allowModels?.length ||
    !!current.policy?.excludeModels?.length;

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = accountPatchSchema.safeParse({
      label: form.get("label"),
      priority: Number(form.get("priority")),
      policy: {
        retryLimit: retryMode === "inherit" ? undefined : Number(form.get("retryLimit")),
        allowModels: list(form.get("allowModels")),
        excludeModels: list(form.get("excludeModels")),
      },
    });
    if (!result.success) {
      setError("Check the label, priority, retry count, and model identifiers.");
      return;
    }
    setError("");
    const patch = result.data;
    // One operation per field, each passing the revision the one before saved, so a change made elsewhere since this
    // dialog opened stops the save instead of being overwritten.
    void perform(async () => {
      const isCurrent = capture();
      const id = current.id;
      let { revision } = account;
      if (patch.label !== undefined && patch.label !== current.label)
        ({ revision } = await control(connection, "accounts rename", { id, label: patch.label, revision }));
      if (patch.priority !== undefined && patch.priority !== current.priority)
        ({ revision } = await control(connection, "accounts priority", { id, priority: patch.priority, revision }));
      if (JSON.stringify(patch.policy ?? {}) !== JSON.stringify(current.policy ?? {}))
        await control(connection, "accounts policy", { id, policy: patch.policy ?? {}, revision });
      if (isCurrent()) close();
    }, "Account saved");
  };

  return (
    <Modal title={`Edit ${current.label}`} close={close}>
      <p>Changes sync to paired machines.</p>
      <form onSubmit={save}>
        <Field label="Label" name="label" isRequired defaultValue={current.label} />
        <NumberInput
          label="Priority"
          description="Higher numbers are preferred when accounts tie."
          name="priority"
          defaultValue={current.priority}
        />
        <Disclosure
          summary="Advanced routing"
          detail="Retry overrides and model allow/exclude lists"
          defaultOpen={hasAdvanced}
        >
          <Choice
            label="Rate-limit retries"
            value={retryMode}
            onChange={(key) => setRetryMode(String(key) as "inherit" | "custom")}
            options={[
              { id: "inherit", label: "Inherit pool default" },
              { id: "custom", label: "Use account override" },
            ]}
          />
          {retryMode === "custom" && (
            <NumberInput
              label="Override retry count"
              description="Zero disables retries on rate limits."
              name="retryLimit"
              minValue={0}
              maxValue={10}
              defaultValue={current.policy?.retryLimit ?? 0}
            />
          )}
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
              Discovered models: {account.models.models.join(", ") || "none"}. Checked{" "}
              {new Date(account.models.at).toLocaleString()}.
            </p>
          )}
        </Disclosure>
        {error && (
          <p className="danger note" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" size="sm">
          Save
        </Button>
      </form>
    </Modal>
  );
}
