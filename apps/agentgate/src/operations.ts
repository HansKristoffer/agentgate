import { fromPreset, newInstance, parseHeaders, preset, validId } from "./mcp/templates.ts";
import type { Account, Credential, McpInstance, Project, Store } from "./store.ts";
import { isVirtual, projectIdSchema } from "@agentgate/protocol";
import { canonicalProject } from "./mcp/gateway.ts";
import { resetCooldown } from "./llm/policy.ts";
import { resetRouting } from "./llm/routing.ts";

/** Parse quoted arguments without invoking a shell or expanding variables. */
export function parseCommand(text: string): string[] {
  const args: string[] = [];
  let current = "", quote = "", escaped = false, started = false;
  for (const char of text.trim()) {
    if (escaped) { current += char; escaped = false; started = true; }
    else if (char === "\\" && quote !== "'") { escaped = true; started = true; }
    else if (quote) { if (char === quote) quote = ""; else current += char; }
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { args.push(current); current = ""; started = false; } }
    else { current += char; started = true; }
  }
  if (quote || escaped) throw new Error("unfinished quote or escape in command");
  if (started) args.push(current);
  if (!args[0]) throw new Error("a command is required");
  return args;
}

export function saveAccount(s: Store, account: Account, credential: Credential) {
  return s.transaction(() => {
    s.put("account", account.id, account);
    s.put("credential", account.id, credential);
    s.del("usage", account.id);
    s.del("refreshRequest", `credential:${account.id}`);
    s.setLocal(`refreshError:credential:${account.id}`, undefined);
    for (const key of ["models", "modelError", "quotaHealth"]) s.setLocal(`${key}:${account.id}`, undefined);
    resetCooldown(s, account.id); resetRouting(s, account.id);
    return account.id;
  });
}
export function setAccount(s: Store, id: string, patch: Partial<Account>) {
  return s.transaction(() => {
    const account = s.get("account", id);
    if (!account) throw new Error(`no account ${id}`);
    if (patch.pinned) for (const a of s.list("account")) if (a.pinned && a.provider === account.provider && a.id !== id) s.put("account", a.id, { ...a, pinned: false });
    return s.put("account", id, { ...account, ...patch, id });
  });
}
export function deleteAccount(s: Store, id: string) {
  s.transaction(() => {
    const provider = s.get("account", id)?.provider;
    for (const kind of ["account", "credential", "usage"] as const) s.del(kind, id);
    s.del("refreshRequest", `credential:${id}`);
    s.setLocal(`refreshError:credential:${id}`, undefined);
    for (const key of ["models", "modelError", "quotaHealth"]) s.setLocal(`${key}:${id}`, undefined);
    resetCooldown(s, id); resetRouting(s, id);
    if (provider && s.local(`active:${provider}`) === id) s.setLocal(`active:${provider}`, undefined);
  });
}

export function createInstance(s: Store, input: { id: string; target?: string; command?: string; perSession?: boolean; headers?: string | string[] }): McpInstance {
  if (s.get("mcp", input.id)) throw new Error(`${input.id} already exists`);
  const p = input.target ? preset(input.target) : undefined;
  const command = input.command ? parseCommand(input.command) : undefined;
  const inst = p ? fromPreset(p, input.id) : command
    ? newInstance({ id: input.id, command: command[0], args: command.slice(1), mode: input.perSession ? "perSession" : "shared" })
    : newInstance({ id: input.id, url: input.target });
  inst.headers = { ...inst.headers, ...parseHeaders(input.headers) };
  return s.put("mcp", input.id, inst);
}
export function deleteInstance(s: Store, id: string) {
  s.transaction(() => {
    s.del("mcp", id); s.del("mcpCredential", id); s.del("refreshRequest", `mcpCredential:${id}`);
    s.setLocal(`refreshError:mcpCredential:${id}`, undefined);
    for (const p of s.list("project")) if (Object.values(p.mcp).includes(id))
      s.put("project", p.id, { ...p, mcp: Object.fromEntries(Object.entries(p.mcp).filter(([, v]) => v !== id)) });
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
    for (const p of s.list("project")) if (Object.values(p.mcp).includes(from)) {
      const mappings: Record<string, string> = {};
      for (const [alias, target] of Object.entries(p.mcp)) {
        const name = target === from && alias === from ? to : alias;
        if (name in mappings) throw new Error(`rename conflicts with alias ${name} in ${p.id}`);
        mappings[name] = target === from ? to : target;
      }
      s.put("project", p.id, { ...p, mcp: mappings });
    }
    s.del("mcp", from); s.del("mcpCredential", from); s.del("refreshRequest", `mcpCredential:${from}`);
  });
}
export function saveProject(s: Store, id: string, patch: Partial<Project>) {
  id = canonicalProject(s, projectIdSchema.parse(id));
  const virtual = isVirtual(id);
  const prev = s.get("project", id) ?? { id, mcp: {}, skills: [], inheritDefaults: !virtual };
  for (const [alias, target] of Object.entries(patch.mcp ?? {})) {
    if (!validId(alias)) throw new Error(`invalid tool prefix ${alias}`);
    if (virtual && alias === "skills") throw new Error("the prefix skills is reserved for the built-in skill tools");
    if (!s.get("mcp", target)) throw new Error(`no MCP instance ${target}`);
  }
  for (const skill of patch.skills ?? []) if (!s.get("skill", skill)) throw new Error(`no skill ${skill}`);
  // Virtual projects list their servers explicitly; `*` defaults never leak into a public endpoint.
  return s.put("project", id, { ...prev, ...patch, ...(patch.skills && { skills: [...new Set(patch.skills)] }), ...(virtual && { inheritDefaults: false }), id });
}
