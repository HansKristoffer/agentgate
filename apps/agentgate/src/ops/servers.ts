import { isVirtual, projectChangeSchema, projectIdSchema, slugify, type ProjectChange } from "@agentgate/protocol";
import type { ControlOps } from "@agentgate/protocol/control";
import { getUniqueValues } from "hanzio";
import { z } from "zod";
import type { Ctx } from "../daemon.ts";
import { canonicalProject, listAllTools, needsLogin, serverTools } from "../mcp/gateway.ts";
import { fromPreset, newInstance, parseHeaders, preset, validId } from "../mcp/templates.ts";
import { saveProject } from "../operations.ts";
import { sent, type Data, type McpInstance, type Project, type Store, type Stored } from "../store.ts";
import { asUserError, controlOp, parseWords, plainMessage, UserError } from "./registry.ts";

/** The MCP servers family's control operations. None is loopback-only: a remote node's servers are managed from the
 * app as its own are. */

const serverId = z.string().min(1).max(200);
const toolId = z.string().min(1).max(200);

/** The server, or a UserError naming the id. */
function server(s: Store, name: string) {
  const inst = s.get("mcp", name);
  if (!inst) throw new UserError(`No MCP server ${name}`);
  return inst;
}

/** Parse quoted arguments without invoking a shell or expanding variables. */
function parseCommand(text: string): string[] {
  const args: string[] = [];
  let current = "",
    quote = "",
    escaped = false,
    started = false;
  for (const char of text.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }
  if (quote || escaped) throw new Error("unfinished quote or escape in command");
  if (started) args.push(current);
  if (!args[0]) throw new Error("a command is required");
  return args;
}

/** `name` is whatever the user typed; its slug becomes the id and tool prefix, and the name itself is kept for display. */
export function createInstance(
  s: Store,
  input: { name: string; target?: string; command?: string; perSession?: boolean; headers?: string | string[] },
): McpInstance {
  const name = input.name.trim(),
    id = slugify(name);
  if (!id) throw new Error("name: use at least one letter or digit");
  if (name.length > 100) throw new Error("name: 100 characters at most");
  if (s.get("mcp", id)) throw new Error(`${id} already exists; choose another name`);
  const p = input.target ? preset(input.target) : undefined;
  const command = input.command ? parseCommand(input.command) : undefined;
  const inst = p
    ? fromPreset(p, id)
    : command
      ? newInstance({
          id,
          command: command[0],
          args: command.slice(1),
          mode: input.perSession ? "perSession" : "shared",
        })
      : newInstance({ id, url: input.target });
  inst.headers = { ...inst.headers, ...parseHeaders(input.headers) };
  if (name !== id) inst.label = name;
  return s.put("mcp", id, inst);
}
/** Changes only the name shown in the app; the id and tool prefix stay, so project mappings keep working. */
export function labelInstance(s: Store, id: string, label: string) {
  const inst = s.get("mcp", id);
  if (!inst) throw new Error(`no MCP server ${id}`);
  const name = label.trim();
  if (!name || name.length > 100) throw new Error("name: 1 to 100 characters");
  s.put("mcp", id, { ...inst, label: name === id ? undefined : name });
}
/** How a server is offered to agents; a key set to `undefined` goes back to the default. */
function tuneInstance(
  s: Store,
  id: string,
  change: Partial<Pick<McpInstance, "tools" | "instructions" | "maxResultChars">>,
) {
  const inst = s.get("mcp", id);
  if (!inst) throw new Error(`no MCP server ${id}`);
  s.put("mcp", id, { ...inst, ...change });
}
/** One tool's result limit or default arguments; a key set to `undefined` goes back to the server's. */
function tuneTool(s: Store, id: string, tool: string, change: NonNullable<McpInstance["toolOptions"]>[string]) {
  const inst = s.get("mcp", id);
  if (!inst) throw new Error(`no MCP server ${id}`);
  const options = { ...inst.toolOptions, [tool]: { ...inst.toolOptions?.[tool], ...change } };
  for (const [name, o] of Object.entries(options))
    if (o.maxResultChars === undefined && o.defaults === undefined) delete options[name];
  s.put("mcp", id, { ...inst, toolOptions: Object.keys(options).length ? options : undefined });
}
const unmap = (s: Store, p: Project, id: string) =>
  s.put("project", p.id, { ...p, mcp: Object.fromEntries(Object.entries(p.mcp).filter(([, v]) => v !== id)) });
export function deleteInstance(s: Store, id: string) {
  s.transaction(() => {
    s.del("mcp", id);
    s.del("mcpCredential", id);
    s.del("refreshRequest", `mcpCredential:${id}`);
    s.setLocal(`refreshError:mcpCredential:${id}`, undefined);
    for (const p of s.list("project")) if (Object.values(p.mcp).includes(id)) unmap(s, p, id);
  });
}
/** Maps a server into exactly these projects (`*` is Global defaults), or into its current ones with `change`'s
 * additions and removals applied, so a form opened before another machine's change does not undo it. A project that
 * already has it keeps its tool prefix; a new mapping uses the server's id. */
export function changeServerProjects(s: Store, id: string, change: ProjectChange) {
  s.transaction(() => {
    const inst = s.get("mcp", id);
    if (!inst) throw new Error(`no MCP server ${id}`);
    const mapped = s.list("project").filter((p) => Object.values(p.mcp).includes(id));
    const remove = new Set("remove" in change ? change.remove.map((p) => canonicalProject(s, p)) : []);
    const projects =
      "projects" in change
        ? change.projects
        : [...mapped.map((p) => p.id).filter((p) => !remove.has(p)), ...change.add];
    const targets = getUniqueValues(projects.map((p) => canonicalProject(s, projectIdSchema.parse(p))));
    for (const p of mapped) if (!targets.includes(p.id)) unmap(s, p, id);
    for (const target of targets) {
      const p = s.get("project", target);
      if (p && Object.values(p.mcp).includes(id)) continue;
      if (isVirtual(target) && inst.mode === "perSession")
        throw new Error(`${id} starts in each session's worktree, which ${target} does not have`);
      const taken = p?.mcp[id];
      if (taken) throw new Error(`${target} already uses the tool prefix ${id} for ${taken}`);
      saveProject(s, target, { mcp: { ...p?.mcp, [id]: id } });
    }
  });
}
export function renameInstance(s: Store, from: string, to: string) {
  s.transaction(() => {
    const inst = s.get("mcp", from);
    if (!inst) throw new Error(`no MCP server ${from}`);
    if (!validId(to)) throw new Error("name: letters, digits, - and _");
    if (from === to) return;
    if (s.get("mcp", to)) throw new Error(`${to} already exists`);
    s.put("mcp", to, { ...inst, id: to });
    const credentials = s.get("mcpCredential", from);
    if (credentials) s.put("mcpCredential", to, { ...credentials, instanceId: to, loginId: undefined });
    for (const p of s.list("project"))
      if (Object.values(p.mcp).includes(from)) {
        const mappings: Record<string, string> = {};
        for (const [alias, target] of Object.entries(p.mcp)) {
          const name = target === from && alias === from ? to : alias;
          if (name in mappings) throw new Error(`rename conflicts with alias ${name} in ${p.id}`);
          mappings[name] = target === from ? to : target;
        }
        s.put("project", p.id, { ...p, mcp: mappings });
      }
    s.del("mcp", from);
    s.del("mcpCredential", from);
    s.del("refreshRequest", `mcpCredential:${from}`);
  });
}

type ServerTuning = ControlOps["mcp test"]["result"]["tuning"];

const tuningOf = (inst: McpInstance): ServerTuning => {
  const { id, tools, instructions, maxResultChars, toolOptions } = sent<Data<"mcp">>(inst);
  return { id, tools, instructions, maxResultChars, toolOptions };
};

/** How a server is offered to agents, where it differs from the default, for `mcp ls` and `mcp test`. */
export function tuningNotes(t: Stored<ServerTuning>) {
  const notes = [
    t.tools && `${t.tools.length} tools offered`,
    t.instructions !== undefined && `instructions ${t.instructions ? "replaced" : "hidden"}`,
    t.maxResultChars !== undefined && `limit ${t.maxResultChars || "off"}`,
    t.toolOptions && `${Object.keys(t.toolOptions).length} tool settings`,
  ].filter(Boolean);
  return notes.length ? `  (${notes.join(", ")})` : "";
}

/** A shared server's tools over the gateway's connection, the one sessions use, so a local command is never started a
 * second time for a preview. A per-session server has no shared connection and connects once. While the gateway
 * waits out a failed connect, the preview connects now: a Test is how the user says the server works again, and its
 * success ends the wait. */
export async function toolList(ctx: Ctx, inst: McpInstance) {
  if (inst.mode === "perSession" || ctx.gateway.upstreams.get(inst.id)?.state.kind === "backoff")
    return serverTools(ctx.s, inst);
  return listAllTools(await ctx.gateway.shared(inst));
}

controlOp({
  name: "mcp add",
  summary: "connect an MCP server: any name, whose slug is its id and tool prefix",
  input: z
    .object({
      name: z.string().min(1).max(200),
      target: z.string().max(4096).optional(),
      command: z
        .string()
        .max(16 * 1024)
        .optional(),
      perSession: z.boolean().optional(),
      headers: z
        .string()
        .max(16 * 1024)
        .optional(),
    })
    .strict(),
  needs: "store",
  async run(input, { s }) {
    if (!input.target && !input.command) throw new UserError("Give a URL, a preset or a command");
    const inst = asUserError(
      () => createInstance(s, input),
      // A TypeError from `URL` or `Headers` can quote a URL with its credentials.
      (e) => plainMessage(e) ?? (e instanceof TypeError ? "Check the server's URL and headers" : undefined),
    );
    // Connecting a hosted server right away shows it as available, or says it needs a login.
    const login = inst.url ? await serverTools(s, inst).then(() => false, needsLogin) : false;
    return { id: inst.id, needsLogin: login };
  },
  terminal: {
    usage: 'mcp add <name> <url|preset> [--header "Name: value" ...] | --command "npx …" [--per-session]',
    parse(args) {
      const { values, positionals } = parseWords(args, {
        header: { type: "string", multiple: true },
        command: { type: "string" },
        "per-session": { type: "boolean" },
      });
      const [name, target, ...extra] = positionals;
      if (!name || extra.length || (!target && !values.command)) throw new UserError();
      return {
        input: {
          name,
          target,
          command: values.command,
          perSession: values["per-session"],
          headers: values.header?.join("\n"),
        },
      };
    },
    print({ id, needsLogin }) {
      return [
        `added ${id}`,
        ...(needsLogin ? [`${id} needs a login: agentgate mcp login ${id}`] : []),
        `use it with: agentgate mcp projects ${id} <owner/repo|*>`,
      ];
    },
  },
});

controlOp({
  name: "mcp rm",
  summary: "remove an MCP server from every project and machine",
  input: z.object({ id: serverId }).strict(),
  needs: "store",
  run(input, { s }) {
    server(s, input.id);
    deleteInstance(s, input.id);
    return { id: input.id };
  },
  terminal: {
    usage: "mcp rm <name>",
    parse(args) {
      const [name, ...extra] = parseWords(args, {}).positionals;
      if (!name || extra.length) throw new UserError();
      return { input: { id: name } };
    },
    print: ({ id }) => [`removed ${id}`],
  },
});

controlOp({
  name: "mcp label",
  summary: "change the name shown in the app; the tool prefix stays",
  input: z.object({ id: serverId, label: z.string().max(200) }).strict(),
  needs: "store",
  run(input, { s }) {
    server(s, input.id);
    asUserError(() => labelInstance(s, input.id, input.label));
    return { id: input.id };
  },
  terminal: {
    usage: "mcp label <name> <label>",
    parse(args) {
      const [name, label, ...extra] = parseWords(args, {}).positionals;
      if (!name || !label || extra.length) throw new UserError();
      return { input: { id: name, label } };
    },
    print: (_, { input }) => [`${input.id} is shown as ${input.label}`],
  },
});

controlOp({
  name: "mcp rename",
  summary: "change a server's id and tool prefix, in every project that uses it",
  input: z.object({ id: serverId, to: serverId }).strict(),
  needs: "store",
  run(input, { s }) {
    server(s, input.id);
    asUserError(() => renameInstance(s, input.id, input.to));
    return { id: input.to };
  },
  terminal: {
    usage: "mcp rename <name> <new-name>",
    parse(args) {
      const [name, to, ...extra] = parseWords(args, {}).positionals;
      if (!name || !to || extra.length) throw new UserError();
      return { input: { id: name, to } };
    },
    print: (_, { input }) => [`renamed ${input.id} to ${input.to}`],
  },
});

controlOp({
  name: "mcp projects",
  summary: "the projects that use a server (* is Global defaults)",
  input: z.union([
    projectChangeSchema.options[0].extend({ id: serverId }),
    projectChangeSchema.options[1].extend({ id: serverId }),
  ]),
  needs: "store",
  run({ id: name, ...change }, { s }) {
    server(s, name);
    asUserError(() => changeServerProjects(s, name, change));
    return { projects: s.list("project").flatMap((p) => (Object.values(p.mcp).includes(name) ? [p.id] : [])) };
  },
  terminal: {
    usage: "mcp projects <name> [<owner/repo|*> ...]",
    parse(args) {
      const [name, ...projects] = parseWords(args, {}).positionals;
      if (!name) throw new UserError();
      return { input: { id: name, projects } };
    },
    print: ({ projects }, { input }) => [
      projects.length ? `${input.id} is used in ${projects.join(", ")}` : `${input.id} is in no project`,
    ],
  },
});

controlOp({
  name: "mcp tools",
  summary: "offer agents only these tools (none listed: every tool)",
  input: z.object({ id: serverId, tools: z.array(toolId).min(1).max(1000).optional() }).strict(),
  needs: "store",
  run(input, { s }) {
    server(s, input.id);
    tuneInstance(s, input.id, { tools: input.tools });
    return tuningOf(server(s, input.id));
  },
  terminal: {
    usage: "mcp tools <name> [<tool> ...]",
    parse(args) {
      const [name, ...tools] = parseWords(args, {}).positionals;
      if (!name) throw new UserError();
      return { input: { id: name, tools: tools.length ? tools : undefined } };
    },
    print: ({ id, tools }) => [tools ? `${id} offers agents ${tools.join(", ")}` : `${id} offers agents every tool`],
  },
});

controlOp({
  name: "mcp instructions",
  summary: "replace a server's instructions to agents, or hide them (none given: its own)",
  input: z.object({ id: serverId, instructions: z.string().max(4000).optional() }).strict(),
  needs: "store",
  run(input, { s }) {
    server(s, input.id);
    tuneInstance(s, input.id, { instructions: input.instructions });
    return tuningOf(server(s, input.id));
  },
  terminal: {
    usage: "mcp instructions <name> [<text>] [--hide]",
    parse(args) {
      const { values, positionals } = parseWords(args, { hide: { type: "boolean" } });
      const [name, text, ...extra] = positionals;
      if (!name || extra.length || (values.hide && text !== undefined)) throw new UserError();
      return { input: { id: name, instructions: values.hide ? "" : text } };
    },
    print: ({ id, instructions }) => [
      instructions === undefined
        ? `${id} gives agents its own instructions`
        : `${id}'s instructions are ${instructions ? "replaced" : "hidden"}`,
    ],
  },
});

controlOp({
  name: "mcp limit",
  summary: "cut results past this many characters, for a server or one tool (default 20000)",
  input: z.object({ id: serverId, tool: toolId.optional(), chars: z.number().int().nonnegative().optional() }).strict(),
  needs: "store",
  run({ id: name, tool, chars }, { s }) {
    server(s, name);
    if (tool) tuneTool(s, name, tool, { maxResultChars: chars });
    else tuneInstance(s, name, { maxResultChars: chars });
    return tuningOf(server(s, name));
  },
  terminal: {
    usage: "mcp limit <name> <chars|off|default> [--tool <tool>]",
    parse(args) {
      const { values, positionals } = parseWords(args, { tool: { type: "string" } });
      const [name, value, ...extra] = positionals;
      if (!name || !value || extra.length) throw new UserError();
      const chars = value === "default" ? undefined : value === "off" ? 0 : Number(value);
      if (chars !== undefined && (!Number.isInteger(chars) || chars < 0))
        throw new UserError("limit: a number of characters, off, or default");
      return { input: { id: name, tool: values.tool, chars } };
    },
    print: (_, { input: { id, tool, chars } }) => [
      `${tool ? `${id} ${tool}` : id}: ${chars === undefined ? "default limit" : chars ? `results cut past ${chars} characters` : "results never cut"}`,
    ],
  },
});

controlOp({
  name: "mcp defaults",
  summary: "arguments a tool call gets unless the agent passes them (no json: none)",
  input: z.object({ id: serverId, tool: toolId, defaults: z.record(z.string(), z.unknown()).optional() }).strict(),
  needs: "store",
  run({ id: name, tool, defaults }, { s }) {
    server(s, name);
    tuneTool(s, name, tool, { defaults });
    return tuningOf(server(s, name));
  },
  terminal: {
    usage: "mcp defaults <name> <tool> [<json>]",
    parse(args) {
      const [name, tool, json, ...extra] = parseWords(args, {}).positionals;
      if (!name || !tool || extra.length) throw new UserError();
      if (json === undefined) return { input: { id: name, tool } };
      let defaults: unknown;
      try {
        defaults = JSON.parse(json);
      } catch {}
      if (!defaults || typeof defaults !== "object" || Array.isArray(defaults))
        throw new UserError("defaults: a JSON object, such as '{\"limit\": 30}'");
      return { input: { id: name, tool, defaults } };
    },
    print: (_, { input: { id, tool, defaults } }) => [
      defaults ? `${id} ${tool} defaults to ${JSON.stringify(defaults)}` : `${id} ${tool}: no defaults`,
    ],
  },
});

controlOp({
  name: "mcp test",
  summary: "connect to a server and list its tools, with how each is offered",
  input: z.object({ id: serverId }).strict(),
  needs: "daemon",
  async run(input, { s, daemon }) {
    const inst = server(s, input.id);
    const tools = await toolList(daemon!, inst).catch((e) => {
      throw new UserError(
        needsLogin(e)
          ? `${inst.id} needs a login. Sign in from the app or with agentgate mcp login ${inst.id}.`
          : `Could not connect to ${inst.id}. Check its URL or command and the daemon's service logs.`,
      );
    });
    return {
      tools: tools.map((t) => ({ name: t.name, description: t.description })),
      tuning: tuningOf(inst),
    };
  },
  terminal: {
    usage: "mcp test <name>",
    parse(args) {
      const [name, ...extra] = parseWords(args, {}).positionals;
      if (!name || extra.length) throw new UserError();
      return { input: { id: name } };
    },
    print({ tools, tuning }) {
      return [
        `${tuning.id}: ${tools.length} tools${tuningNotes(tuning)}`,
        ...tools.map((t) => {
          const o = tuning.toolOptions?.[t.name];
          const notes = [
            tuning.tools && !tuning.tools.includes(t.name) && "not offered",
            o?.maxResultChars !== undefined && `limit ${o.maxResultChars || "off"}`,
            o?.defaults && `defaults ${JSON.stringify(o.defaults)}`,
          ].filter(Boolean);
          return `  ${t.name}${notes.length ? `  (${notes.join(", ")})` : ""}`;
        }),
      ];
    },
  },
});
