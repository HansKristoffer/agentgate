import { useEffect, useState } from "react";
import { ArrowRight, Boxes, ExternalLink, Plus, Trash2 } from "lucide-react";
import type { Preset, ToolPreview } from "@agentgate/protocol";
import { Badge, Empty, Modal, Panel } from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { openExternal, request } from "../api.ts";
import { field, idPath, confirmDelete } from "./utils.ts";

export function Servers({ data, connection, perform }: ViewProps) {
  const [add, setAdd] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [preset, setPreset] = useState("");
  const [mode, setMode] = useState("http");
  const [tools, setTools] = useState<{ id: string; tools: ToolPreview[] }>();
  const [rename, setRename] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    void request<Preset[]>(connection, "/presets")
      .then((p) => {
        if (!cancelled) setPresets(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [connection]);
  const signIn = (id: string) =>
    perform(async () => {
      const result = await request<{ url?: string }>(
        connection,
        `/servers/${idPath(id)}/login`,
        "POST",
      );
      if (result.url) await openExternal(result.url);
    }, "Login started. Complete it in your browser; the server updates automatically.");
  return (
    <>
      <div className="section-toolbar">
        <span className="muted">{data.servers.length} connected servers</span>
        <button className="button primary" onClick={() => setAdd(true)}>
          <Plus size={15} />
          Connect server
        </button>
      </div>
      {!data.servers.length && (
        <Panel title="A tool for every project">
          <Empty>
            <Boxes size={26} />
            <strong>Connect your first MCP server.</strong>
            <p>Use a hosted server, a preset, or a local command.</p>
          </Empty>
        </Panel>
      )}
      {data.servers.map((server) => (
        <Panel
          key={server.id}
          title={server.id}
          detail={server.endpoint}
          action={
            <Badge good={server.loggedIn}>
              {server.needsLogin
                ? "Needs login"
                : server.mode === "perSession"
                  ? "Per session"
                  : server.loggedIn
                    ? "Signed in"
                    : server.transport === "http"
                      ? "HTTP"
                      : "Local"}
            </Badge>
          }
        >
          <div className="server-body">
            <span className="muted">
              {
                data.projects.filter((p) =>
                  Object.values(p.mcp).includes(server.id),
                ).length
              }{" "}
              project mappings
              {server.refreshError ? ` · ${server.refreshError}` : ""}
            </span>
            <div className="row wrap">
              <button
                className="button"
                onClick={() =>
                  void perform(async () => {
                    const result = await request<{ tools: ToolPreview[] }>(
                      connection,
                      `/servers/${idPath(server.id)}/test`,
                      "POST",
                    );
                    setTools({ id: server.id, tools: result.tools });
                  })
                }
              >
                Test connection
              </button>
              {server.transport === "http" && (
                <button
                  className="button"
                  onClick={() => void signIn(server.id)}
                >
                  Sign in
                  <ExternalLink size={14} />
                </button>
              )}
              <button
                className="button quiet"
                onClick={() => setRename(server.id)}
              >
                Rename
              </button>
              <button
                className="icon-button danger"
                aria-label={`Delete ${server.id}`}
                onClick={() => {
                  if (confirmDelete(server.id))
                    void perform(
                      () =>
                        request(
                          connection,
                          `/servers/${idPath(server.id)}`,
                          "DELETE",
                        ),
                      "Server deleted",
                    );
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        </Panel>
      ))}
      {add && (
        <Modal title="Connect an MCP server" close={() => setAdd(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void perform(async () => {
                const id = field(f, "id");
                await request(connection, "/servers", "POST", {
                  id,
                  target:
                    preset || (mode === "http" ? field(f, "url") : undefined),
                  command:
                    !preset && mode === "stdio"
                      ? field(f, "command")
                      : undefined,
                  perSession: f.get("perSession") === "on",
                  headers: field(f, "headers"),
                });
                setAdd(false);
              }, "Server added. Test the connection or sign in, then map it to a project.");
            }}
          >
            <label>
              Server name
              <input
                name="id"
                required
                pattern="[A-Za-z0-9_-]+"
                placeholder="e.g. posthog-work"
              />
            </label>
            <label>
              Preset
              <select
                value={preset}
                onChange={(e) => setPreset(e.target.value)}
              >
                <option value="">Custom server</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
              </select>
            </label>
            {preset ? (
              <p className="note">
                {presets.find((p) => p.id === preset)?.note ??
                  presets.find((p) => p.id === preset)?.url ??
                  "Runs a local MCP command."}
              </p>
            ) : (
              <>
                <label>
                  Connection type
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value)}
                  >
                    <option value="http">HTTP server</option>
                    <option value="stdio">Local command</option>
                  </select>
                </label>
                {mode === "http" ? (
                  <label>
                    Server URL
                    <input
                      name="url"
                      type="url"
                      required
                      placeholder="https://example.com/mcp"
                    />
                  </label>
                ) : (
                  <>
                    <label>
                      Command
                      <input
                        name="command"
                        required
                        placeholder="npx -y @modelcontextprotocol/server-filesystem"
                      />
                    </label>
                    <label className="check">
                      <input name="perSession" type="checkbox" />
                      Start separately in each session's worktree
                    </label>
                  </>
                )}
              </>
            )}
            <label>
              Extra headers
              <textarea
                name="headers"
                placeholder={"Authorization: Bearer …\nx-project-id: …"}
              />
            </label>
            <button className="button primary">
              Connect server
              <ArrowRight size={15} />
            </button>
          </form>
        </Modal>
      )}
      {tools && (
        <Modal
          title={`${tools.id} · ${tools.tools.length} tools`}
          close={() => setTools(undefined)}
        >
          <div className="tool-list">
            {tools.tools.map((t) => (
              <div key={t.name}>
                <code>{t.name}</code>
                <p>{t.description}</p>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {rename && (
        <Modal title="Rename server" close={() => setRename(undefined)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void perform(async () => {
                await request(
                  connection,
                  `/servers/${idPath(rename)}/rename`,
                  "POST",
                  { id: field(f, "id") },
                );
                setRename(undefined);
              }, "Server renamed; project mappings updated");
            }}
          >
            <label>
              Server name
              <input
                name="id"
                required
                pattern="[A-Za-z0-9_-]+"
                defaultValue={rename}
              />
            </label>
            <button className="button primary">Save name</button>
          </form>
        </Modal>
      )}
    </>
  );
}
