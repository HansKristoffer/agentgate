import { Button } from "@heroui/react";
import type { Settings } from "@agentgate/protocol";
import { Choice, Field } from "../../components/ui.tsx";

export function ModelAliases({
  aliases,
  change,
}: {
  aliases: Settings["aliases"];
  change: (aliases: Settings["aliases"]) => void;
}) {
  return (
    <div className="policy-preview">
      <h3>Model aliases</h3>
      <p className="note">
        Map a client-facing model name to an exact upstream model. Aliases
        resolve before routing; duplicate names and cycles are rejected.
      </p>
      {aliases.map((alias, index) => (
        <div className="alias-row" key={index}>
          <Choice
            label="Provider"
            value={alias.provider}
            onChange={(v) =>
              change(
                aliases.map((row, i) =>
                  i === index
                    ? { ...row, provider: String(v) as "claude" | "codex" }
                    : row,
                ),
              )
            }
            options={[
              { id: "claude", label: "Claude" },
              { id: "codex", label: "Codex" },
            ]}
          />
          <Field
            label="Client model name"
            value={alias.alias}
            onChange={(v) =>
              change(
                aliases.map((row, i) =>
                  i === index ? { ...row, alias: v } : row,
                ),
              )
            }
          />
          <Field
            label="Upstream model"
            value={alias.target}
            onChange={(v) =>
              change(
                aliases.map((row, i) =>
                  i === index ? { ...row, target: v } : row,
                ),
              )
            }
          />
          <Button
            size="sm"
            variant="ghost"
            onPress={() => change(aliases.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="tertiary"
        isDisabled={aliases.length >= 200}
        onPress={() =>
          change([...aliases, { provider: "claude", alias: "", target: "" }])
        }
      >
        Add alias
      </Button>
    </div>
  );
}
