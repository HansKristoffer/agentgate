import { connect, listAllTools, needsLogin, serverHealth } from "../mcp/gateway.ts";
import { startLogin } from "../mcp/oauth.ts";
import { presets, readableEndpoint } from "../mcp/templates.ts";
import {
  createInstance,
  deleteInstance,
  labelInstance,
  renameInstance,
  setServerProjects,
  tuneInstance,
  tuneTool,
} from "../operations.ts";
import { LOCAL_URL, store, type McpInstance } from "../store.ts";
import { die, initialized, showHelp, stringOption, type Run } from "./common.ts";

/** How a server is offered to agents, where it differs from the default. */
const tuning = (i: McpInstance) => {
  const notes = [
    i.tools && `${i.tools.length} tools offered`,
    i.instructions !== undefined && `instructions ${i.instructions ? "replaced" : "hidden"}`,
    i.maxResultChars !== undefined && `limit ${i.maxResultChars || "off"}`,
    i.toolOptions && `${Object.keys(i.toolOptions).length} tool settings`,
  ].filter(Boolean);
  return notes.length ? `  (${notes.join(", ")})` : "";
};

/** `mcp <sub>`; the shim (`mcp` alone) starts in cli.ts. */
export const run: Run = async (_cmd, [sub, ...rest], opts) => {
  const s = initialized(store());
  const str = stringOption(opts);
  const mcpLogin = async (id: string) => {
    const url = await startLogin(s, id, `${LOCAL_URL}/oauth/callback`);
    if (!url) return console.log(`${id}: logged in`);
    console.log(`Open this to log in (the daemon must be running to receive the callback):\n\n  ${url.href}\n`);
    if (process.platform === "darwin") Bun.spawn(["open", url.href]);
  };
  if (sub === "presets") {
    for (const p of presets)
      console.log(
        `${p.id.padEnd(12)} ${p.url ?? [p.command, ...(p.args ?? [])].join(" ")}${p.note ? `  (${p.note})` : ""}`,
      );
    return;
  }
  if (sub === "ls") {
    for (const i of s.list("mcp")) {
      const h = serverHealth(s, i.id),
        state = !h ? "" : h.ok ? "  available" : h.needsLogin ? "  NEEDS LOGIN" : "  UNREACHABLE";
      console.log(
        `${i.id.padEnd(20)} ${i.label ? `${i.label}  ` : ""}${(i.url ? readableEndpoint(i.url) : [i.command, ...(i.args ?? [])].join(" ")).padEnd(48)} ${i.mode}${s.get("mcpCredential", i.id)?.tokens ? "  logged in" : ""}${state}${tuning(i)}`,
      );
    }
    return;
  }
  if (sub === "add") {
    const [name, target] = rest;
    if (!name || (!target && !str("command")))
      die('mcp add <name> <url|preset> [--header "Name: value"] | mcp add <name> --command "npx …" [--per-session]');
    const inst = createInstance(s, {
      name: name!,
      target,
      command: str("command"),
      perSession: !!opts["per-session"],
      headers: opts.header as string[] | undefined,
    });
    const id = inst.id;
    const ok =
      !inst.url ||
      (await connect(inst, process.cwd(), s).then(
        (c) => c.close().then(() => true),
        (e) => (needsLogin(e) ? false : die(`${id}: ${e}`)),
      ));
    console.log(`added ${id}`);
    // A server that needs a login goes straight on to it, as in the app.
    if (!ok) await mcpLogin(id);
    return console.log(`use it with: agentgate mcp projects ${id} <owner/repo|*>`);
  }
  if (sub === "login") return mcpLogin(rest[0] ?? die("mcp login <name>"));
  if (sub === "test") {
    const inst = s.get("mcp", rest[0] ?? "") ?? die(`no instance ${rest[0]}`);
    const client = await connect(inst, process.cwd(), s).catch((e) =>
      die(needsLogin(e) ? `${inst.id} needs a login: agentgate mcp login ${inst.id}` : String(e)),
    );
    let tools;
    try {
      tools = await listAllTools(client);
    } finally {
      await client.close();
    }
    console.log(`${inst.id}: ${tools.length} tools${tuning(inst)}`);
    for (const t of tools) {
      const o = inst.toolOptions?.[t.name];
      const notes = [
        inst.tools && !inst.tools.includes(t.name) && "not offered",
        o?.maxResultChars !== undefined && `limit ${o.maxResultChars || "off"}`,
        o?.defaults && `defaults ${JSON.stringify(o.defaults)}`,
      ].filter(Boolean);
      console.log(`  ${t.name}${notes.length ? `  (${notes.join(", ")})` : ""}`);
    }
    return;
  }
  if (sub === "tools") {
    const [id, ...tools] = rest;
    if (!id) die("mcp tools <name> [<tool> ...]");
    tuneInstance(s, id!, { tools: tools.length ? tools : undefined });
    return console.log(tools.length ? `${id} offers agents ${tools.join(", ")}` : `${id} offers agents every tool`);
  }
  if (sub === "instructions") {
    const [id, text] = rest;
    if (!id) die("mcp instructions <name> [<text>] [--hide]");
    const instructions = opts.hide ? "" : text;
    tuneInstance(s, id!, { instructions });
    return console.log(
      instructions === undefined
        ? `${id} gives agents its own instructions`
        : `${id}'s instructions are ${instructions ? "replaced" : "hidden"}`,
    );
  }
  if (sub === "limit") {
    const [id, value] = rest;
    if (!id || !value) die("mcp limit <name> <chars|off|default> [--tool <tool>]");
    const chars = value === "default" ? undefined : value === "off" ? 0 : Number(value);
    if (chars !== undefined && (!Number.isInteger(chars) || chars < 0))
      die("limit: a number of characters, off, or default");
    const tool = str("tool");
    if (tool) tuneTool(s, id!, tool, { maxResultChars: chars });
    else tuneInstance(s, id!, { maxResultChars: chars });
    return console.log(
      `${tool ? `${id} ${tool}` : id}: ${chars === undefined ? "default limit" : chars ? `results cut past ${chars} characters` : "results never cut"}`,
    );
  }
  if (sub === "defaults") {
    const [id, tool, json] = rest;
    if (!id || !tool) die("mcp defaults <name> <tool> [<json>]");
    let defaults: Record<string, unknown> | undefined;
    if (json) {
      try {
        defaults = JSON.parse(json);
      } catch {}
      if (!defaults || typeof defaults !== "object" || Array.isArray(defaults))
        die("defaults: a JSON object, such as '{\"limit\": 30}'");
    }
    tuneTool(s, id!, tool!, { defaults });
    return console.log(
      defaults ? `${id} ${tool} defaults to ${JSON.stringify(defaults)}` : `${id} ${tool}: no defaults`,
    );
  }
  if (sub === "label") {
    const [id, label] = rest;
    if (!id || !label) die("mcp label <id> <name>");
    labelInstance(s, id!, label!);
    return console.log(`${id} is shown as ${label}`);
  }
  if (sub === "rename") {
    const [from, to] = rest;
    if (!from || !to) die("mcp rename <name> <new-name>");
    renameInstance(s, from!, to!);
    return console.log(`renamed ${from} to ${to}`);
  }
  if (sub === "projects") {
    const id = rest[0] ?? die("mcp projects <name> [<owner/repo|*> ...]");
    setServerProjects(s, id, rest.slice(1));
    const used = s.list("project").filter((p) => Object.values(p.mcp).includes(id));
    return console.log(used.length ? `${id} is used in ${used.map((p) => p.id).join(", ")}` : `${id} is in no project`);
  }
  if (sub === "rm") return deleteInstance(s, rest[0] ?? die("mcp rm <id>"));
  return showHelp();
};
