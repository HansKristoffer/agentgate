import { useState } from "react";
import { Copy, Terminal } from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Button } from "@heroui/react";
import { confirmDialog } from "@hanskristoffer/taurio/runtime";
import {
  Choice,
  Modal,
  NumberInput,
  Panel,
  Toggle,
} from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { backupFile, localAction, request, restoreFile } from "../api.ts";
import { field } from "./utils.ts";

export function Settings({ data, connection, perform, local, desktop }: ViewProps) {
  const [output, setOutput] = useState("");
  const [secrets, setSecrets] = useState(false);
  const action = (name: string) =>
    perform(
      async () => setOutput(await localAction(name, connection)),
      "Command completed",
    );
  return (
    <>
      <form
        key={JSON.stringify(data.settings)}
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void perform(
            () =>
              request(connection, "/settings", "PUT", {
                threshold: Number(f.get("threshold")),
                whenExhausted: field(f, "whenExhausted"),
                retryLimit: Number(f.get("retryLimit")),
                logRetention: Number(f.get("logRetention")),
              }),
            "Settings saved",
          );
        }}
      >
        <Panel
          title="Pool behavior"
          detail="These settings sync to every paired machine."
        >
          <NumberInput
            className="item"
            label="Switch account at quota"
            description="Percent used before the next account takes over."
            name="threshold"
            minValue={1}
            maxValue={100}
            isRequired
            defaultValue={data.settings.threshold}
          />
          <Choice
            className="item"
            label="When every account is exhausted"
            description="What a session gets once the whole pool is used up."
            name="whenExhausted"
            defaultValue={data.settings.whenExhausted}
            options={[
              { id: "fail", label: "Return a limit response" },
              { id: "wait", label: "Wait for the next reset" },
            ]}
          />
          <NumberInput
            className="item"
            label="Maximum retries"
            description="Times a rate-limited request waits and tries again."
            name="retryLimit"
            minValue={0}
            maxValue={10}
            isRequired
            defaultValue={data.settings.retryLimit}
          />
          <NumberInput
            className="item"
            label="Activity log retention"
            description="Requests kept in the activity log."
            name="logRetention"
            minValue={100}
            maxValue={100000}
            isRequired
            defaultValue={data.settings.logRetention}
          />
          <div className="item item-actions">
            <Button type="submit" size="sm">
              Save settings
            </Button>
          </div>
        </Panel>
      </form>
      {local && (
        <>
          <Panel
            title="Coding tools"
            detail="Provider and MCP settings for Claude Code, Codex, and T3 Code."
          >
            <div className="item">
              <span className="labelled">
                Configure coding tools
                <small>
                  Creates dedicated Claude and Codex config folders and prints
                  their paths.
                </small>
              </span>
              <Button
                size="sm"
                variant="tertiary"
                onPress={() => void action("setup")}
              >
                <Terminal size={14} />
                Configure
              </Button>
            </div>
            <div className="item">
              <span className="labelled">
                Route existing CLI logins
                <small>
                  Updates your existing Claude Code and Codex settings to use
                  the pool. Claude Desktop isn't affected; see Claude Desktop
                  in the sidebar.
                </small>
              </span>
              <Button
                size="sm"
                variant="ghost"
                onPress={() => void action("primary-off")}
              >
                Undo
              </Button>
              <Button
                size="sm"
                variant="tertiary"
                onPress={() => void action("primary-on")}
              >
                Route
              </Button>
            </div>
            {desktop && (
              <Toggle
                label="Agentgate's MCP servers in Claude Code"
                description={
                  desktop.mcp
                    ? "On for Claude Code in the terminal and Claude Desktop's Code tab."
                    : "Off. Turn on to use your MCP servers without routing the subscriptions."
                }
                isSelected={desktop.mcp}
                onChange={(on) =>
                  void perform(
                    () => localAction(on ? "mcp-on" : "mcp-off", connection),
                    on ? "MCP servers added" : "MCP servers removed",
                  )
                }
              />
            )}
          </Panel>
          <Panel
            title="Background service"
            detail="Installed independently of the app in ~/.config/agentgate/bin."
            foot={
              <>
                Add <code>~/.config/agentgate/bin</code> to your shell PATH to
                use the bundled CLI.
              </>
            }
          >
            <div className="item">
              <span className="labelled">
                Service
                <small>Starts the daemon at login and keeps it running.</small>
              </span>
              <Button
                size="sm"
                variant="ghost"
                onPress={async () => {
                  if (
                    await confirmDialog(
                      "Stop Agentgate? Your agents cannot reach its providers or MCP servers until it starts again.",
                      { destructive: true, okLabel: "Stop" },
                    )
                  )
                    void action("stop");
                }}
              >
                Stop
              </Button>
              <Button
                size="sm"
                variant="tertiary"
                onPress={() => void action("start")}
              >
                Start
              </Button>
              <Button
                size="sm"
                variant="tertiary"
                onPress={() => void action("install")}
              >
                Install / update
              </Button>
            </div>
            <div className="item">
              <span className="labelled">
                Admin token
                <small>
                  Needed to connect to this daemon from another machine.
                </small>
              </span>
              <Button
                size="sm"
                variant="tertiary"
                onPress={() => void action("admin-token")}
              >
                Show token
              </Button>
            </div>
          </Panel>
          <Panel
            title="Backup & restore"
            detail="Backups are written to the file you choose."
          >
            <Toggle
              label="Include credentials"
              description={
                secrets
                  ? "A full backup contains working credentials. Store it somewhere private."
                  : "An inventory omits logins and transport secrets. Restored servers need configuration again."
              }
              isSelected={secrets}
              onChange={setSecrets}
            />
            <div className="item item-actions">
              <Button
                size="sm"
                variant="tertiary"
                onPress={() =>
                  void perform(async () => {
                    const path = await open({
                      multiple: false,
                      filters: [{ name: "JSON backup", extensions: ["json"] }],
                    });
                    if (
                      typeof path === "string" &&
                      (await confirmDialog(
                        "Import this backup into your current setup? Restored records will sync to paired machines.",
                        { destructive: true, okLabel: "Import" },
                      ))
                    ) {
                      const result = await restoreFile(connection, path);
                      setOutput(`Restored ${result.restored} records`);
                    }
                  })
                }
              >
                Import backup…
              </Button>
              <Button
                size="sm"
                variant="tertiary"
                onPress={() =>
                  void perform(async () => {
                    const path = await save({
                      defaultPath: `agentgate-${secrets ? "backup" : "inventory"}.json`,
                      filters: [{ name: "JSON backup", extensions: ["json"] }],
                    });
                    if (path) {
                      await backupFile(connection, path, secrets);
                      setOutput(`Backup saved to ${path}`);
                    }
                  })
                }
              >
                Export backup…
              </Button>
            </div>
          </Panel>
        </>
      )}
      {output && (
        <Modal title="Agentgate output" close={() => setOutput("")}>
          <pre className="output">{output}</pre>
          <Button
            size="sm"
            variant="tertiary"
            onPress={() =>
              void perform(
                () => navigator.clipboard.writeText(output),
                "Copied",
              )
            }
          >
            <Copy size={15} />
            Copy
          </Button>
        </Modal>
      )}
    </>
  );
}
