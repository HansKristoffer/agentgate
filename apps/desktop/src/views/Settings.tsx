import { useState } from "react";
import { Copy, Terminal } from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Modal, Panel } from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { backupFile, localAction, request, restoreFile } from "../api.ts";
import { field } from "./utils.ts";

export function Settings({ data, connection, perform, local }: ViewProps) {
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
          <label className="item">
            <span className="label">
              Switch account at quota
              <small>Percent used before the next account takes over.</small>
            </span>
            <input
              name="threshold"
              type="number"
              min={1}
              max={100}
              required
              defaultValue={data.settings.threshold}
            />
          </label>
          <label className="item">
            <span className="label">
              When every account is exhausted
              <small>What a session gets once the whole pool is used up.</small>
            </span>
            <select
              name="whenExhausted"
              defaultValue={data.settings.whenExhausted}
            >
              <option value="fail">Return a limit response</option>
              <option value="wait">Wait for the next reset</option>
            </select>
          </label>
          <label className="item">
            <span className="label">
              Maximum retries
              <small>Times a rate-limited request waits and tries again.</small>
            </span>
            <input
              name="retryLimit"
              type="number"
              min={0}
              max={10}
              required
              defaultValue={data.settings.retryLimit}
            />
          </label>
          <label className="item">
            <span className="label">
              Activity log retention
              <small>Requests kept in the activity log.</small>
            </span>
            <input
              name="logRetention"
              type="number"
              min={100}
              max={100000}
              required
              defaultValue={data.settings.logRetention}
            />
          </label>
          <div className="item item-actions">
            <button className="button primary">Save settings</button>
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
              <span className="label">
                Configure coding tools
                <small>
                  Creates dedicated Claude and Codex config folders and prints
                  their paths.
                </small>
              </span>
              <button className="button" onClick={() => void action("setup")}>
                <Terminal size={14} />
                Configure
              </button>
            </div>
            <div className="item">
              <span className="label">
                Route existing CLI logins
                <small>Updates your existing CLI settings to use the pool.</small>
              </span>
              <button
                className="button quiet"
                onClick={() => void action("primary-off")}
              >
                Undo
              </button>
              <button
                className="button"
                onClick={() => void action("primary-on")}
              >
                Route
              </button>
            </div>
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
              <span className="label">
                Service
                <small>Starts the daemon at login and keeps it running.</small>
              </span>
              <button
                className="button quiet"
                onClick={() => {
                  if (
                    window.confirm(
                      "Stop Agentgate? Your agents cannot reach its providers or MCP servers until it starts again.",
                    )
                  )
                    void action("stop");
                }}
              >
                Stop
              </button>
              <button className="button" onClick={() => void action("start")}>
                Start
              </button>
              <button
                className="button"
                onClick={() => void action("install")}
              >
                Install / update
              </button>
            </div>
            <div className="item">
              <span className="label">
                Admin token
                <small>Needed to connect to this daemon from another machine.</small>
              </span>
              <button
                className="button"
                onClick={() => void action("admin-token")}
              >
                Show token
              </button>
            </div>
          </Panel>
          <Panel
            title="Backup & restore"
            detail="Backups are written to the file you choose."
          >
            <label className="item">
              <span className="label">
                Include credentials
                <small>
                  {secrets
                    ? "A full backup contains working credentials. Store it somewhere private."
                    : "An inventory omits logins and transport secrets. Restored servers need configuration again."}
                </small>
              </span>
              <input
                type="checkbox"
                className="switch"
                checked={secrets}
                onChange={(e) => setSecrets(e.target.checked)}
              />
            </label>
            <div className="item item-actions">
              <button
                className="button"
                onClick={() =>
                  void perform(async () => {
                    const path = await open({
                      multiple: false,
                      filters: [{ name: "JSON backup", extensions: ["json"] }],
                    });
                    if (
                      typeof path === "string" &&
                      window.confirm(
                        "Import this backup into your current setup? Restored records will sync to paired machines.",
                      )
                    ) {
                      const result = await restoreFile(connection, path);
                      setOutput(`Restored ${result.restored} records`);
                    }
                  })
                }
              >
                Import backup…
              </button>
              <button
                className="button"
                onClick={() =>
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
              </button>
            </div>
          </Panel>
        </>
      )}
      {output && (
        <Modal title="Agentgate output" close={() => setOutput("")}>
          <pre className="output">{output}</pre>
          <button
            className="button"
            onClick={() =>
              void perform(
                () => navigator.clipboard.writeText(output),
                "Copied",
              )
            }
          >
            <Copy size={15} />
            Copy
          </button>
        </Modal>
      )}
    </>
  );
}
