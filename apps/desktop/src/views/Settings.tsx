import { useState } from "react";
import { Copy, Terminal } from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Button } from "@heroui/react";
import { confirmDialog } from "@hanskristoffer/taurio/runtime";
import { Modal, Panel, Toggle } from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { backupFile, localAction, restoreFile, type LocalAction } from "../api.ts";
import { Diagnostics, PoolSettings } from "../features/proxy/PoolSettings.tsx";

export function Settings({ data, connection, perform, local, desktop }: ViewProps) {
  const [output, setOutput] = useState("");
  const [secrets, setSecrets] = useState(false);
  // cursorMcp and antigravityMcp are absent when the machine lacks that tool (setup skips it), so it does not count then.
  const mcpOn = !!desktop?.mcp && desktop.cursorMcp !== false && desktop.antigravityMcp !== false;
  const others = [desktop?.cursorMcp && "Cursor", desktop?.antigravityMcp && "Antigravity"].filter(Boolean);
  const selfNode = data.nodes.find((n) => n.id === data.node);
  const routing = selfNode?.routing;
  const primaryOn = routing ? routing.claude || routing.codex : !!desktop?.routing;
  const primaryDetail = routing
    ? routing.claude && routing.codex
      ? "On · your Claude Code and Codex settings route through the pool. Claude Desktop is configured on Accounts."
      : routing.claude || routing.codex
        ? `On for ${routing.claude ? "Claude Code" : "Codex"} · turn off to restore its own login.`
        : "Off · turn on to point your existing Claude Code and Codex settings at the pool."
    : "Points your existing Claude Code and Codex settings at the pool. Claude Desktop is configured on Accounts.";
  const action = (name: LocalAction) =>
    perform(async () => setOutput(await localAction(name, connection)), "Command completed");
  return (
    <>
      {local && (
        <Panel title="Coding tools" detail="Provider and MCP setup for Claude Code, Codex, Cursor and Antigravity">
          <Toggle
            label="Route your own Claude Code and Codex"
            description={primaryDetail}
            isSelected={primaryOn}
            onChange={(on) =>
              perform(
                () => localAction(on ? "primary-on" : "primary-off", connection),
                on ? "Claude Code and Codex now use Agentgate" : "Claude Code and Codex restored to their own logins",
                "primary-routing",
              )
            }
          />
          {desktop && (
            <Toggle
              label="Agentgate's MCP servers"
              description={
                mcpOn
                  ? `On for Claude Code, Claude Desktop's Code tab${others.map((t) => `, ${t}`).join("")}.`
                  : "Off · turn on to expose your MCP servers without routing subscriptions."
              }
              isSelected={mcpOn}
              onChange={(on) =>
                perform(
                  () => localAction(on ? "mcp-on" : "mcp-off", connection),
                  on ? "MCP servers added" : "MCP servers removed",
                  "mcp-routing",
                )
              }
            />
          )}
          <div className="item">
            <span className="labelled">
              Separate folders for T3 Code
              <small>
                Creates dedicated Claude and Codex config folders and prints their paths instead of changing your own
                logins.
              </small>
            </span>
            <Button size="sm" variant="tertiary" onPress={() => void action("setup")}>
              <Terminal size={14} />
              Configure
            </Button>
          </div>
        </Panel>
      )}
      <PoolSettings data={data} connection={connection} perform={perform} />
      {local && (
        <>
          <Panel
            title="Background service"
            detail="Installed independently of this app in ~/.config/agentgate/bin"
            foot={
              <>
                Add <code>~/.config/agentgate/bin</code> to your shell PATH to use the bundled CLI.
              </>
            }
          >
            <div className="item">
              <span className="labelled">
                Service
                <small>Starts the daemon at login and keeps it running.</small>
              </span>
              {/* This page only opens while the daemon answers. When it stops, the banner above every page offers Start. */}
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
              <Button size="sm" variant="tertiary" onPress={() => void action("install")}>
                Install / update
              </Button>
            </div>
            <div className="item">
              <span className="labelled">
                Admin token
                <small>Needed to connect to this daemon from another machine.</small>
              </span>
              <Button size="sm" variant="tertiary" onPress={() => void action("admin-token")}>
                Show token
              </Button>
            </div>
          </Panel>
          <Panel title="Backup & restore" detail="Export or restore your configuration as JSON">
            <Toggle
              label="Include credentials"
              description={
                secrets
                  ? "Full backup with working credentials. Store it somewhere private."
                  : "Inventory only (no logins or transport secrets). Restored servers need sign-in again."
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
      <Diagnostics data={data} connection={connection} perform={perform} />
      {output && (
        <Modal title="Agentgate output" close={() => setOutput("")}>
          <pre className="output">{output}</pre>
          <Button
            size="sm"
            variant="tertiary"
            onPress={() => void perform(() => navigator.clipboard.writeText(output), "Copied")}
          >
            <Copy size={15} />
            Copy
          </Button>
        </Modal>
      )}
    </>
  );
}
