import { useMemo, useState } from "react";
import { ArrowRight, Boxes, Plus } from "lucide-react";
import { slugify, type Connection, type Preset, type ServerSummary } from "@agentgate/protocol";
import type { ControlOps } from "@agentgate/protocol/control";
import { Button, Input, TextField, toast } from "@heroui/react";
import {
  Badge,
  Check,
  Choice,
  Disclosure,
  Empty,
  Field,
  Modal,
  Panel,
  HeaderActions,
  NumberInput,
  RowMenu,
  Working,
  usePending,
} from "../components/ui.tsx";
import { AssignProjects, ServerProjectChecks } from "../components/Assignments.tsx";
import type { Perform, ViewProps } from "../types.ts";
import { control, openExternal, request } from "../api.ts";
import { useDaemon } from "../useDaemon.ts";
import { ago, field, idPath, confirmDelete } from "./utils.ts";

// The preset select's "no preset" entry; a list item cannot have an empty id.
const custom = "__custom";
const SIGN_IN = "Complete the sign-in in your browser. The server connects on its own afterwards.";

export function Servers({ data, connection, perform }: ViewProps) {
  const pending = usePending();
  const [add, setAdd] = useState(false);
  const [preset, setPreset] = useState("");
  const [mode, setMode] = useState("http");
  const [tools, setTools] = useState<ControlOps["mcp test"]["result"]>();
  const [rename, setRename] = useState<ServerSummary>();
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  /** The server whose projects are being chosen. */
  const [assign, setAssign] = useState<string>();
  const assigning = data.servers.find((s) => s.id === assign);
  // Presets are static for a daemon build: fetch only when opening the Add modal, and cache for the connection.
  const presetsRead = useDaemon(add && (() => request<Preset[]>(connection, "/presets")), {
    topics: [],
    key: "presets",
    every: 300_000,
    staleTime: 300_000,
  });
  const presets = presetsRead.data ?? [];
  const startLogin = async (id: string) => {
    const result = await request<{ url?: string }>(connection, `/servers/${idPath(id)}/login`, "POST");
    if (result.url) await openExternal(result.url);
  };
  const signIn = (id: string) => perform(() => startLogin(id), SIGN_IN, `login:${id}`);
  const projectNamesByServer = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of data.projects) {
      const label = p.id === "*" ? "Global defaults" : p.id;
      for (const id of Object.values(p.mcp)) {
        const list = map.get(id);
        if (list) {
          if (!list.includes(label)) list.push(label);
        } else {
          map.set(id, [label]);
        }
      }
    }
    return map;
  }, [data.projects]);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? data.servers.filter((s) => `${s.label ?? ""} ${s.id} ${s.endpoint}`.toLowerCase().includes(needle))
    : data.servers;
  const selectedPreset = preset ? presets.find((p) => p.id === preset) : undefined;
  return (
    <>
      <HeaderActions>
        <Button
          size="sm"
          onPress={() => {
            setName("");
            setPreset("");
            setMode("http");
            setAdd(true);
          }}
        >
          <Plus size={15} />
          Connect server
        </Button>
      </HeaderActions>
      <Panel>
        {data.servers.length > 6 && (
          <div className="item">
            <TextField aria-label="Search servers" value={query} onChange={setQuery} className="field grow">
              <Input type="search" placeholder={`Search ${data.servers.length} servers`} />
            </TextField>
          </div>
        )}
        {!data.servers.length && (
          <Empty>
            <Boxes size={22} />
            <strong>Connect your first MCP server</strong>
            <p>Use a hosted server, a preset, or a local command.</p>
          </Empty>
        )}
        {needle && !shown.length && <Empty>Nothing matches "{query}".</Empty>}
        {shown.map((server) => {
          const used = projectNamesByServer.get(server.id) ?? [];
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
                        () => control(connection, "mcp test", { id: server.id }).catch(() => {}),
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
                    label: "Tools and limits",
                    onAction: () =>
                      void perform(
                        async () => setTools(await control(connection, "mcp test", { id: server.id })),
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
                        void perform(() => control(connection, "mcp rm", { id: server.id }), "Server deleted");
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
                const added = await control(connection, "mcp add", {
                  name,
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
            <Choice
              label="Preset"
              value={preset || custom}
              onChange={(key) => {
                const next = key === custom ? "" : String(key);
                const prevLabel = selectedPreset?.label;
                const nextPreset = presets.find((p) => p.id === next);
                if (!name.trim() || name === prevLabel) setName(nextPreset?.label ?? "");
                setPreset(next);
              }}
              options={[{ id: custom, label: "Custom server" }, ...presets.map((p) => ({ id: p.id, label: p.label }))]}
            />
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
            {preset ? (
              <p className="note">{selectedPreset?.note ?? selectedPreset?.url ?? "Runs a local MCP command."}</p>
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
            {(preset ? !!selectedPreset?.url : mode === "http") && (
              <Disclosure summary="Extra headers" detail="Optional HTTP headers sent with every request">
                <Field
                  multiline
                  label="Headers"
                  name="headers"
                  placeholder={"Authorization: Bearer …\nx-project-id: …"}
                />
              </Disclosure>
            )}
            <Button type="submit" size="sm">
              Connect server
              <ArrowRight size={15} />
            </Button>
          </form>
        </Modal>
      )}
      {tools && (
        <ToolSettings preview={tools} connection={connection} perform={perform} close={() => setTools(undefined)} />
      )}
      {assigning && (
        <AssignProjects
          title={`Where ${assigning.label ?? assigning.id} is used`}
          close={() => setAssign(undefined)}
          save={(change) =>
            void perform(async () => {
              await control(connection, "mcp projects", { id: assigning.id, ...change });
              setAssign(undefined);
            }, "Saved. Running sessions pick up the change.")
          }
        >
          <ServerProjectChecks data={data} server={assigning} />
        </AssignProjects>
      )}
      {rename && (
        <Modal title="Rename server" close={() => setRename(undefined)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const label = field(f, "label"),
                prefix = field(f, "prefix");
              void perform(async () => {
                if (label !== (rename.label ?? rename.id))
                  await control(connection, "mcp label", { id: rename.id, label });
                if (prefix !== rename.id) await control(connection, "mcp rename", { id: rename.id, to: prefix });
                setRename(undefined);
              }, "Server renamed");
            }}
          >
            <Field
              label="Name"
              name="label"
              isRequired
              defaultValue={rename.label ?? rename.id}
              description="The name shown here."
            />
            <Field
              label="Tool prefix"
              name="prefix"
              isRequired
              defaultValue={rename.id}
              description="Agents see its tools as prefix__…. Changing it changes it in every project that uses the server."
            />
            <Button type="submit" size="sm">
              Save
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}

const sameSet = (a: string[] | undefined, b: string[] | undefined) =>
  JSON.stringify(a && [...a].sort()) === JSON.stringify(b && [...b].sort());

function parseDefaults(json: string, tool: string) {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {}
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${tool}: default arguments are a JSON object, such as {"limit": 30}`);
  return Object.fromEntries(Object.entries(value));
}

/** A server's tools and how agents are offered them. State is held in React so searching never drops edits to hidden
 * tools. Saving sends each changed setting through its own operation (`mcp tools|instructions|limit|defaults`). */
function ToolSettings({
  preview: { tools, tuning },
  connection,
  perform,
  close,
}: {
  preview: ControlOps["mcp test"]["result"];
  connection: Connection;
  perform: Perform;
  close: () => void;
}) {
  const id = tuning.id;
  const [query, setQuery] = useState("");
  const [offered, setOffered] = useState<Set<string>>(
    () =>
      new Set(
        tuning.tools
          ? tools.filter((t) => tuning.tools!.includes(t.name)).map((t) => t.name)
          : tools.map((t) => t.name),
      ),
  );
  const [toolLimits, setToolLimits] = useState<Record<string, number | undefined>>(() =>
    Object.fromEntries(tools.map((t) => [t.name, tuning.toolOptions?.[t.name]?.maxResultChars])),
  );
  const [toolDefaults, setToolDefaults] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      tools.map((t) => [
        t.name,
        tuning.toolOptions?.[t.name]?.defaults ? JSON.stringify(tuning.toolOptions[t.name]!.defaults) : "",
      ]),
    ),
  );
  const [instructions, setInstructions] = useState(
    tuning.instructions === undefined ? "own" : tuning.instructions ? "replace" : "hide",
  );
  const [serverLimit, setServerLimit] = useState<number | undefined>(tuning.maxResultChars);
  const needle = query.trim().toLowerCase();
  const shown = needle ? tools.filter((t) => `${t.name} ${t.description ?? ""}`.toLowerCase().includes(needle)) : tools;

  const toggleTool = (name: string, on: boolean) =>
    setOffered((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  const save = (f: FormData) =>
    perform(async () => {
      const list = [...offered];
      if (!list.length) throw new Error("Offer agents at least one tool");
      const filter = list.length === tools.length ? undefined : list;
      if (!sameSet(filter, tuning.tools)) await control(connection, "mcp tools", { id, tools: filter });
      const text = instructions === "own" ? undefined : instructions === "hide" ? "" : field(f, "instructions");
      if (text !== tuning.instructions) await control(connection, "mcp instructions", { id, instructions: text });
      const chars = Number.isFinite(serverLimit) ? serverLimit : undefined;
      if (chars !== tuning.maxResultChars) await control(connection, "mcp limit", { id, chars });
      for (const t of tools) {
        const o = tuning.toolOptions?.[t.name];
        const rawLimit = toolLimits[t.name];
        const toolChars = typeof rawLimit === "number" && Number.isFinite(rawLimit) ? rawLimit : undefined;
        if (toolChars !== o?.maxResultChars)
          await control(connection, "mcp limit", { id, tool: t.name, chars: toolChars });
        const json = (toolDefaults[t.name] ?? "").trim();
        const defaults = json ? parseDefaults(json, t.name) : undefined;
        if (JSON.stringify(defaults) !== JSON.stringify(o?.defaults))
          await control(connection, "mcp defaults", { id, tool: t.name, defaults });
      }
      close();
    }, "Saved. Running sessions pick up the change.");

  return (
    <Modal title={`${id} · ${tools.length} tools`} size="lg" close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(new FormData(e.currentTarget));
        }}
      >
        <div className="tool-toolbar">
          <small>
            {offered.size} of {tools.length} offered
          </small>
          <div className="row">
            <Button
              size="sm"
              variant="ghost"
              isDisabled={offered.size === tools.length}
              onPress={() => setOffered(new Set(tools.map((t) => t.name)))}
            >
              Select all
            </Button>
            <Button size="sm" variant="ghost" isDisabled={offered.size === 0} onPress={() => setOffered(new Set())}>
              None
            </Button>
          </div>
        </div>
        {tools.length > 8 && (
          <TextField aria-label="Search tools" value={query} onChange={setQuery} className="field">
            <Input type="search" placeholder={`Search ${tools.length} tools`} />
          </TextField>
        )}
        <div className="tool-list">
          {shown.map((t) => {
            const o = tuning.toolOptions?.[t.name];
            const hasOverride = o?.maxResultChars !== undefined || !!o?.defaults;
            return (
              <div key={t.name}>
                <Check isSelected={offered.has(t.name)} onChange={(on) => toggleTool(t.name, on)}>
                  <code>{t.name}</code>
                </Check>
                {t.description && <p>{t.description}</p>}
                <Disclosure summary="Limit and default arguments" defaultOpen={hasOverride}>
                  <NumberInput
                    label="Cut results past"
                    minValue={0}
                    value={toolLimits[t.name] ?? Number.NaN}
                    onChange={(v) => setToolLimits((prev) => ({ ...prev, [t.name]: Number.isNaN(v) ? undefined : v }))}
                    description="Characters. Empty: the server's limit. 0: never cut."
                  />
                  <Field
                    label="Default arguments"
                    value={toolDefaults[t.name] ?? ""}
                    onChange={(v) => setToolDefaults((prev) => ({ ...prev, [t.name]: v }))}
                    placeholder='{"limit": 30}'
                    description="JSON a call gets unless the agent passes them."
                  />
                </Disclosure>
              </div>
            );
          })}
          {!shown.length && <Empty>Nothing matches "{query}".</Empty>}
        </div>
        <Choice
          label="Instructions to agents"
          value={instructions}
          onChange={(key) => setInstructions(String(key))}
          options={[
            { id: "own", label: "The server's own" },
            { id: "replace", label: "Replace them" },
            { id: "hide", label: "Hide them" },
          ]}
        />
        {instructions === "replace" && (
          <Field multiline label="Instructions" name="instructions" isRequired defaultValue={tuning.instructions} />
        )}
        <NumberInput
          label="Cut results past"
          minValue={0}
          value={serverLimit ?? Number.NaN}
          onChange={(v) => setServerLimit(Number.isNaN(v) ? undefined : v)}
          description="Characters. Empty: 20,000. 0: never cut."
        />
        <Button type="submit" size="sm">
          Save
        </Button>
      </form>
    </Modal>
  );
}
