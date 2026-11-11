import { projectChangeSchema } from "@agentgate/protocol";
import type { ControlOps } from "@agentgate/protocol/control";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { z } from "zod";
import type { Ctx } from "../daemon.ts";
import { listAllTools, needsLogin, serverTools } from "../mcp/gateway.ts";
import {
  changeServerProjects,
  createInstance,
  deleteInstance,
  labelInstance,
  renameInstance,
  tuneInstance,
  tuneTool,
} from "../operations.ts";
import type { McpInstance, Store } from "../store.ts";
import { controlOp, UserError } from "./registry.ts";

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

/** operations.ts throws a plain `Error` for input it refuses, with a message written for the user. `invalid` replaces
 * the text of a TypeError from `URL` or `Headers`, which can quote a URL with its credentials. */
function refused<T>(fn: () => T, invalid?: string): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Error && e.constructor === Error) throw new UserError(e.message);
    if (invalid && e instanceof TypeError) throw new UserError(invalid);
    throw e;
  }
}

/** The words after the operation's name, with only the given options. A word it cannot read prints the usage. */
function words<O extends ParseArgsOptionsConfig>(args: string[], options: O) {
  try {
    return parseArgs<{ args: string[]; options: O; allowPositionals: true; strict: true }>({
      args,
      options,
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    throw new UserError(e instanceof Error ? e.message : "");
  }
}

type ServerTuning = ControlOps["mcp test"]["result"]["tuning"];

const tuningOf = ({ id, tools, instructions, maxResultChars, toolOptions }: McpInstance): ServerTuning => ({
  id,
  tools,
  instructions,
  maxResultChars,
  toolOptions,
});

/** How a server is offered to agents, where it differs from the default, for `mcp ls` and `mcp test`. */
export function tuningNotes(t: ServerTuning) {
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
    const inst = refused(() => createInstance(s, input), "Check the server's URL and headers");
    // Connecting a hosted server right away shows it as available, or says it needs a login.
    const login = inst.url ? await serverTools(s, inst).then(() => false, needsLogin) : false;
    return { id: inst.id, needsLogin: login };
  },
  terminal: {
    usage: 'mcp add <name> <url|preset> [--header "Name: value" ...] | --command "npx …" [--per-session]',
    parse(args) {
      const { values, positionals } = words(args, {
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
      const [name, ...extra] = words(args, {}).positionals;
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
    refused(() => labelInstance(s, input.id, input.label));
    return { id: input.id };
  },
  terminal: {
    usage: "mcp label <name> <label>",
    parse(args) {
      const [name, label, ...extra] = words(args, {}).positionals;
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
    refused(() => renameInstance(s, input.id, input.to));
    return { id: input.to };
  },
  terminal: {
    usage: "mcp rename <name> <new-name>",
    parse(args) {
      const [name, to, ...extra] = words(args, {}).positionals;
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
    refused(() => changeServerProjects(s, name, change));
    return { projects: s.list("project").flatMap((p) => (Object.values(p.mcp).includes(name) ? [p.id] : [])) };
  },
  terminal: {
    usage: "mcp projects <name> [<owner/repo|*> ...]",
    parse(args) {
      const [name, ...projects] = words(args, {}).positionals;
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
      const [name, ...tools] = words(args, {}).positionals;
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
      const { values, positionals } = words(args, { hide: { type: "boolean" } });
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
      const { values, positionals } = words(args, { tool: { type: "string" } });
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
      const [name, tool, json, ...extra] = words(args, {}).positionals;
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
      const [name, ...extra] = words(args, {}).positionals;
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
