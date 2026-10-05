import { useEffect, useState } from "react";
import { ArrowRight, Boxes, Plus } from "lucide-react";
import { slugify, type Preset, type ServerSummary, type ToolPreview } from "@agentgate/protocol";
import { Button } from "@heroui/react";
import {
  Badge,
  Check,
  Choice,
  Empty,
  Field,
  Modal,
  Panel,
  HeaderActions,
  RowMenu,
} from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { openExternal, request } from "../api.ts";
import { field, idPath, confirmDelete } from "./utils.ts";

// The preset select's "no preset" entry; a list item cannot have an empty id.
const custom = "__custom";

export function Servers({ data, connection, perform }: ViewProps) {
  const [add, setAdd] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [preset, setPreset] = useState("");
  const [mode, setMode] = useState("http");
  const [tools, setTools] = useState<{ id: string; tools: ToolPreview[] }>();
  const [rename, setRename] = useState<ServerSummary>();
  const [name, setName] = useState("");
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
      <HeaderActions>
        <Button
          size="sm"
          onPress={() => {
            setName("");
            setAdd(true);
          }}
        >
          <Plus size={15} />
          Connect server
        </Button>
      </HeaderActions>
      <Panel>
        {!data.servers.length && (
          <Empty>
            <Boxes size={22} />
            <strong>Connect your first MCP server.</strong>
            <p>Use a hosted server, a preset, or a local command.</p>
          </Empty>
        )}
        {data.servers.map((server) => {
          const mappings = data.projects.filter((p) =>
            Object.values(p.mcp).includes(server.id),
          ).length;
          return (
            <div className="item" key={server.id}>
              <div className="machine-icon">
                <Boxes size={16} />
              </div>
              <div className="grow">
                <div className="row">
                  <strong>{server.label ?? server.id}</strong>
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
                </div>
                <small>{server.label ? `Tool prefix ${server.id} · ${server.endpoint}` : server.endpoint}</small>
                <small className={server.refreshError ? "danger" : ""}>
                  {server.refreshError ??
                    `${mappings} ${mappings === 1 ? "project" : "projects"}`}
                </small>
              </div>
              {server.needsLogin && server.transport === "http" && (
                <Button size="sm" variant="tertiary" onPress={() => void signIn(server.id)}>
                  Sign in
                </Button>
              )}
              <RowMenu
                label={`More for ${server.id}`}
                items={[
                  {
                    label: "Test",
                    onAction: () =>
                      void perform(async () => {
                        const result = await request<{ tools: ToolPreview[] }>(connection, `/servers/${idPath(server.id)}/test`, "POST");
                        setTools({ id: server.id, tools: result.tools });
                      }),
                  },
                  server.transport === "http" && !server.needsLogin && { label: "Sign in", onAction: () => void signIn(server.id) },
                  { label: "Rename", onAction: () => setRename(server) },
                  {
                    label: "Delete",
                    danger: true,
                    onAction: async () => {
                      if (await confirmDelete(server.id))
                        void perform(() => request(connection, `/servers/${idPath(server.id)}`, "DELETE"), "Server deleted");
                    },
                  },
                ]}
              />
            </div>
          );
        })}
      </Panel>
      {add && (
        <Modal title="Connect an MCP server" close={() => setAdd(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void perform(async () => {
                // The daemon turns the name into the id and tool prefix.
                await request(connection, "/servers", "POST", {
                  id: name,
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
            <Field
              label="Name"
              isRequired
              value={name}
              onChange={setName}
              placeholder="e.g. PostHog Work"
              description={slugify(name) ? `Agents see its tools as ${slugify(name)}__…` : "Any name. Agents see a short tool prefix made from it."}
            />
            <Choice
              label="Preset"
              value={preset || custom}
              onChange={(key) => setPreset(key === custom ? "" : String(key))}
              options={[
                { id: custom, label: "Custom server" },
                ...presets.map((p) => ({ id: p.id, label: p.label })),
              ]}
            />
            {preset ? (
              <p className="note">
                {presets.find((p) => p.id === preset)?.note ??
                  presets.find((p) => p.id === preset)?.url ??
                  "Runs a local MCP command."}
              </p>
            ) : (
              <>
                <Choice
                  label="Connection type"
                  value={mode}
                  onChange={(key) => setMode(String(key))}
                  options={[
                    { id: "http", label: "HTTP server" },
                    { id: "stdio", label: "Local command" },
                  ]}
                />
                {mode === "http" ? (
                  <Field
                    label="Server URL"
                    name="url"
                    type="url"
                    isRequired
                    placeholder="https://example.com/mcp"
                  />
                ) : (
                  <>
                    <Field
                      label="Command"
                      name="command"
                      isRequired
                      placeholder="npx -y @modelcontextprotocol/server-filesystem"
                    />
                    <Check name="perSession">
                      Start separately in each session's worktree
                    </Check>
                  </>
                )}
              </>
            )}
            <Field
              multiline
              label="Extra headers"
              name="headers"
              placeholder={"Authorization: Bearer …\nx-project-id: …"}
            />
            <Button type="submit" size="sm">
              Connect server
              <ArrowRight size={15} />
            </Button>
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
                await request(connection, `/servers/${idPath(rename.id)}`, "PATCH", { label: field(f, "label") });
                setRename(undefined);
              }, "Server renamed");
            }}
          >
            <Field
              label="Name"
              name="label"
              isRequired
              defaultValue={rename.label ?? rename.id}
              description={`Only the name changes. Agents keep seeing its tools as ${rename.id}__…`}
            />
            <Button type="submit" size="sm">
              Save name
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
