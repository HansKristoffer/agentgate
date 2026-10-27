import { useEffect, useState } from "react";
import { ArrowRight, Boxes, Plus } from "lucide-react";
import { slugify, type Preset, type ServerSummary, type ToolPreview } from "@agentgate/protocol";
import { Button, toast } from "@heroui/react";
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
  Working,
  usePending,
} from "../components/ui.tsx";
import { ServerProjectChecks } from "../components/Assignments.tsx";
import type { ViewProps } from "../types.ts";
import { openExternal, request } from "../api.ts";
import { ago, field, idPath, confirmDelete } from "./utils.ts";

// The preset select's "no preset" entry; a list item cannot have an empty id.
const custom = "__custom";
const SIGN_IN = "Complete the sign-in in your browser. The server connects on its own afterwards.";

export function Servers({ data, connection, perform }: ViewProps) {
  const pending = usePending();
  const [add, setAdd] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [preset, setPreset] = useState("");
  const [mode, setMode] = useState("http");
  const [tools, setTools] = useState<{ id: string; tools: ToolPreview[] }>();
  const [rename, setRename] = useState<ServerSummary>();
  const [name, setName] = useState("");
  /** The server whose projects are being chosen. */
  const [assign, setAssign] = useState<string>();
  const assigning = data.servers.find((s) => s.id === assign);
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
  const startLogin = async (id: string) => {
    const result = await request<{ url?: string }>(connection, `/servers/${idPath(id)}/login`, "POST");
    if (result.url) await openExternal(result.url);
  };
  const signIn = (id: string) => perform(() => startLogin(id), SIGN_IN, `login:${id}`);
  const projectNames = (id: string) =>
    data.projects
      .filter((p) => Object.values(p.mcp).includes(id))
      .map((p) => (p.id === "*" ? "Global defaults" : p.id));
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
          const used = projectNames(server.id);
          const checked = server.checkedAt ? ` · checked ${ago(server.checkedAt)}` : "";
          const health =
            server.available === undefined
              ? "Not checked yet. Click to test."
              : `${server.available ? "Available" : server.needsLogin ? "Needs a login" : "Couldn't connect"}${checked}. Click to test again.`;
          return (
            <div className="item" key={server.id}>
              <div className="machine-icon">
                <Boxes size={16} />
              </div>
              <div className="grow">
                <div className="row">
                  <button
                    type="button"
                    className="dot-button"
                    title={health}
                    aria-label={health}
                    // The test records the result whether or not it connects; the next status poll recolors the dot.
                    onClick={() =>
                      void perform(
                        () =>
                          request(connection, `/servers/${idPath(server.id)}/test`, "POST").then(
                            () => {},
                            () => {},
                          ),
                        undefined,
                        `test:${server.id}`,
                      )
                    }
                  >
                    <span
                      className={`dot ${server.available === true ? "online" : server.available === false ? "offline" : ""}`}
                    />
                  </button>
                  <strong>{server.label ?? server.id}</strong>
                  <Badge good={server.loggedIn}>
                    {server.mode === "perSession"
                      ? "Per session"
                      : server.loggedIn
                        ? "Signed in"
                        : server.transport === "http"
                          ? "HTTP"
                          : "Local"}
                  </Badge>
                  {pending.has(`test:${server.id}`) && <Working>Testing</Working>}
                  {pending.has(`login:${server.id}`) && <Working>Starting sign-in</Working>}
                </div>
                <small>{server.label ? `Tool prefix ${server.id} · ${server.endpoint}` : server.endpoint}</small>
                <small className={server.refreshError ? "danger" : ""}>
                  {server.refreshError ?? (used.length ? `Used in ${used.join(", ")}` : "Not used in a project yet")}
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
                  { label: "Choose projects", onAction: () => setAssign(server.id) },
                  {
                    label: "Test",
                    onAction: () =>
                      void perform(
                        async () => {
                          const result = await request<{ tools: ToolPreview[] }>(
                            connection,
                            `/servers/${idPath(server.id)}/test`,
                            "POST",
                          );
                          setTools({ id: server.id, tools: result.tools });
                        },
                        undefined,
                        `test:${server.id}`,
                      ),
                  },
                  server.transport === "http" &&
                    !server.needsLogin && { label: "Sign in", onAction: () => void signIn(server.id) },
                  { label: "Rename", onAction: () => setRename(server) },
                  {
                    label: "Delete",
                    danger: true,
                    onAction: async () => {
                      if (await confirmDelete(server.id))
                        void perform(
                          () => request(connection, `/servers/${idPath(server.id)}`, "DELETE"),
                          "Server deleted",
                        );
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
                // The daemon turns the name into the id and tool prefix, and connects to a hosted server right away.
                const added = await request<{ id: string; needsLogin?: boolean }>(connection, "/servers", "POST", {
                  id: name,
                  target: preset || (mode === "http" ? field(f, "url") : undefined),
                  command: !preset && mode === "stdio" ? field(f, "command") : undefined,
                  perSession: f.get("perSession") === "on",
                  headers: field(f, "headers"),
                });
                setAdd(false);
                setAssign(added.id);
                if (added.needsLogin) {
                  await startLogin(added.id);
                  toast(SIGN_IN);
                } else toast("Server added. Choose where to use it.");
              });
            }}
          >
            <Field
              label="Name"
              isRequired
              value={name}
              onChange={setName}
              placeholder="e.g. PostHog Work"
              description={
                slugify(name)
                  ? `Agents see its tools as ${slugify(name)}__…`
                  : "Any name. Agents see a short tool prefix made from it."
              }
            />
            <Choice
              label="Preset"
              value={preset || custom}
              onChange={(key) => setPreset(key === custom ? "" : String(key))}
              options={[{ id: custom, label: "Custom server" }, ...presets.map((p) => ({ id: p.id, label: p.label }))]}
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
                  <Field label="Server URL" name="url" type="url" isRequired placeholder="https://example.com/mcp" />
                ) : (
                  <>
                    <Field
                      label="Command"
                      name="command"
                      isRequired
                      placeholder="npx -y @modelcontextprotocol/server-filesystem"
                    />
                    <Check name="perSession">Start separately in each session's worktree</Check>
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
        <Modal title={`${tools.id} · ${tools.tools.length} tools`} close={() => setTools(undefined)}>
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
      {assigning && (
        <Modal title={`Where ${assigning.label ?? assigning.id} is used`} close={() => setAssign(undefined)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const projects = new FormData(e.currentTarget).getAll("project") as string[];
              void perform(async () => {
                await request(connection, `/servers/${idPath(assigning.id)}/projects`, "PUT", { projects });
                setAssign(undefined);
              }, "Saved. Running sessions pick up the change.");
            }}
          >
            <ServerProjectChecks data={data} server={assigning} />
            <p className="note">
              Repositories appear here once a session starts in them, or after you add or scan them in Projects.
            </p>
            <Button type="submit" size="sm">
              Save
            </Button>
          </form>
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
