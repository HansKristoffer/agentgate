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
      <Panel
        title="Pool behavior"
        detail="These settings sync to every paired machine."
      >
        <form
          key={JSON.stringify(data.settings)}
          className="settings-form"
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
          <label>
            Switch account at quota %
            <input
              name="threshold"
              type="number"
              min={1}
              max={100}
              required
              defaultValue={data.settings.threshold}
            />
          </label>
          <label>
            When every account is exhausted
            <select
              name="whenExhausted"
              defaultValue={data.settings.whenExhausted}
            >
              <option value="fail">Return a limit response</option>
              <option value="wait">Wait for the next reset</option>
            </select>
          </label>
          <label>
            Maximum retries
            <input
              name="retryLimit"
              type="number"
              min={0}
              max={10}
              required
              defaultValue={data.settings.retryLimit}
            />
          </label>
          <label>
            Activity log retention
            <input
              name="logRetention"
              type="number"
              min={100}
              max={100000}
              required
              defaultValue={data.settings.logRetention}
            />
          </label>
          <div>
            <button className="button primary">Save settings</button>
          </div>
        </form>
      </Panel>
      {local && (
        <>
          <Panel
            title="Coding tools"
            detail="Write provider and MCP settings for Claude Code, Codex, and T3 Code."
          >
            <div className="row wrap">
              <button className="button" onClick={() => void action("setup")}>
                <Terminal size={15} />
                Configure coding tools
              </button>
              <button
                className="button"
                onClick={() => void action("primary-on")}
              >
                Route existing CLI logins
              </button>
              <button
                className="button quiet"
                onClick={() => void action("primary-off")}
              >
                Undo primary routing
              </button>
            </div>
            <p className="note">
              Configure coding tools creates dedicated Claude and Codex config
              folders and prints their paths. Primary routing updates your
              existing CLI settings.
            </p>
          </Panel>
          <Panel
            title="Background service"
            detail="Installed independently of the app in ~/.config/agentgate/bin."
          >
            <div className="row wrap">
              <button className="button" onClick={() => void action("install")}>
                Install / update service
              </button>
              <button className="button" onClick={() => void action("start")}>
                Start service
              </button>
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
                Stop service
              </button>
              <button
                className="button quiet"
                onClick={() => void action("admin-token")}
              >
                Show admin token
              </button>
            </div>
            <p className="note">
              Add <code>~/.config/agentgate/bin</code> to your shell PATH to use
              the bundled CLI.
            </p>
          </Panel>
          <Panel
            title="Backup & restore"
            detail="Backups are written to the file you choose."
          >
            <label className="check">
              <input
                type="checkbox"
                checked={secrets}
                onChange={(e) => setSecrets(e.target.checked)}
              />
              Include working credentials and transport secrets
            </label>
            <p className="note">
              {secrets
                ? "A full backup contains working credentials. Store it somewhere private."
                : "An inventory omits logins and transport secrets. Restored servers need configuration again."}
            </p>
            <div className="row">
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
                Export backup
              </button>
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
                Import backup
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
