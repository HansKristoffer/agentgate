import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ToolListChangedNotificationSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { McpInstance, Store } from "../store.ts";
import { InstanceAuth } from "./oauth.ts";
import { resolve } from "./templates.ts";

export const VERSION = "0.1.0";
const IDLE_CLOSE = 10 * 60_000;
const MAX_TOOL_NAME = 64; // Codex's limit

/** `<alias>__<tool>`, shortened with a 4-character hash when it would pass 64 characters. */
export function toolName(alias: string, tool: string): string {
  const full = alias ? `${alias}__${tool}` : tool;
  if (full.length <= MAX_TOOL_NAME) return full;
  const hash = new Bun.CryptoHasher("sha1").update(full).digest("hex").slice(0, 4);
  return `${full.slice(0, MAX_TOOL_NAME - 5)}_${hash}`;
}

/** alias → instance id for a repo: the `*` defaults (unless turned off), overridden by the repo's own. */
export function aliasesFor(s: Store, project: string): Record<string, string> {
  const p = project !== "*" ? s.get("project", project) : undefined;
  const defaults = !p || p.inheritDefaults ? (s.get("project", "*")?.mcp ?? {}) : {};
  return { ...defaults, ...(p?.mcp ?? {}) };
}

/** Parse `git remote get-url origin` output into `owner/repo`. */
export function parseRemote(url: string): string | undefined {
  const m = url.trim().match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?[^:/]+(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i);
  const path = m?.[1]?.replace(/^\/+/, "");
  const parts = path?.split("/");
  return parts && parts.length >= 2 ? parts.slice(-2).join("/") : undefined;
}

/** Pass the store to use the instance's OAuth login (refreshing it when needed). */
export async function connect(inst: McpInstance, cwd?: string, s?: Store): Promise<Client> {
  const r = resolve(inst);
  const client = new Client({ name: "agentgate", version: VERSION });
  if (r.transport === "http") {
    if (!r.url) throw new Error(`${inst.id}: no url`);
    const authProvider = s && inst.oauth ? new InstanceAuth(s, inst.id) : undefined;
    await client.connect(new StreamableHTTPClientTransport(new URL(r.url), { requestInit: { headers: r.headers }, authProvider }));
  } else {
    if (!r.command) throw new Error(`${inst.id}: no command`);
    if (!Bun.which(r.command)) throw new Error(`${inst.id}: '${r.command}' is not installed on this machine (install its runtime, e.g. Node for npx or uv for uvx)`);
    const env = { ...(process.env as Record<string, string>), ...r.env };
    await client.connect(new StdioClientTransport({ command: r.command, args: r.args, env, cwd, stderr: "ignore" }));
  }
  return client;
}

export async function listAllTools(c: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await c.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

export interface Source {
  alias: string; // '' passes tool names through unchanged
  client: Client;
}

export function mergeInstructions(sources: Source[]): string {
  return sources
    .map((src) => {
      const text = src.client.getInstructions()?.trim();
      return text ? (src.alias ? `## ${src.alias}\n${text}` : text) : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/** One MCP server in front of many: the tools of every source under their aliases. */
export function mergedServer(instructions: string, sources: () => Promise<Source[]>, onError: (alias: string, e: unknown) => void = () => {}): Server {
  const server = new Server({ name: "agentgate", version: VERSION }, { capabilities: { tools: { listChanged: true } }, instructions });
  let routes = new Map<string, { client: Client; tool: string }>();

  async function list(): Promise<Tool[]> {
    const next = new Map<string, { client: Client; tool: string }>();
    const all: Tool[] = [];
    await Promise.all(
      (await sources()).map(async (src) => {
        try {
          for (const t of await listAllTools(src.client)) {
            const name = toolName(src.alias, t.name);
            next.set(name, { client: src.client, tool: t.name });
            all.push({ ...t, name });
          }
        } catch (e) {
          onError(src.alias, e);
        }
      }),
    );
    routes = next;
    return all.sort((a, b) => a.name.localeCompare(b.name));
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await list() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (!routes.has(req.params.name)) await list();
    const route = routes.get(req.params.name);
    if (!route) return { isError: true, content: [{ type: "text", text: `agentgate: unknown tool ${req.params.name}` }] };
    return route.client.callTool({ ...req.params, name: route.tool });
  });
  return server;
}

interface Upstream {
  client?: Client;
  connecting?: Promise<Client>;
  config: string;
  lastUsed: number;
  error?: string;
}

/** The daemon side: shared upstream connections, and one merged server per shim session. */
export class Gateway {
  upstreams = new Map<string, Upstream>();
  private sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; server: Server; project: string }>();
  private timer = setInterval(() => this.closeIdle(), 60_000);

  constructor(private s: Store) {}

  /** One connection per shared instance, opened on first use and reopened when its config changes. */
  async shared(inst: McpInstance): Promise<Client> {
    const { oauth, ...rest } = inst; // token refreshes must not reopen the connection
    const config = JSON.stringify({ ...rest, loggedIn: !!oauth?.tokens });
    let u = this.upstreams.get(inst.id);
    if (u && u.config !== config) {
      await u.client?.close().catch(() => {});
      u = undefined;
    }
    if (!u) this.upstreams.set(inst.id, (u = { config, lastUsed: Date.now() }));
    u.lastUsed = Date.now();
    if (u.client) return u.client;
    const entry = u;
    entry.connecting ??= connect(inst, undefined, this.s).then(
      (c) => {
        entry.client = c;
        entry.error = undefined;
        entry.connecting = undefined;
        c.setNotificationHandler(ToolListChangedNotificationSchema, () => this.toolsChanged());
        c.onclose = () => {
          if (entry.client === c) entry.client = undefined;
        };
        return c;
      },
      (e) => {
        entry.error = String(e?.message ?? e);
        entry.connecting = undefined;
        throw e;
      },
    );
    return entry.connecting;
  }

  status(id: string): "running" | "idle" | "error" | "needs login" {
    const u = this.upstreams.get(id);
    if (u?.error) return needsLogin(u.error) ? "needs login" : "error";
    return u?.client ? "running" : "idle";
  }

  private async sources(project: string): Promise<Source[]> {
    const out: Source[] = [];
    await Promise.all(
      Object.entries(aliasesFor(this.s, project)).map(async ([alias, id]) => {
        const inst = this.s.get("mcp", id);
        if (!inst || inst.mode !== "shared") return;
        try {
          out.push({ alias, client: await this.shared(inst) });
        } catch (e) {
          this.s.log("mcp", id, "", 0, 0, `connect failed: ${e}`);
        }
      }),
    );
    return out;
  }

  /** Streamable HTTP endpoint for shims: `/mcp?project=owner/repo`. */
  async handle(req: Request): Promise<Response> {
    const sid = req.headers.get("mcp-session-id");
    if (sid) {
      const sess = this.sessions.get(sid);
      return sess ? sess.transport.handleRequest(req) : Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "session not found" }, id: null }, { status: 404 });
    }
    const project = new URL(req.url).searchParams.get("project") || "*";
    this.seen(project);
    const instructions = mergeInstructions(await this.sources(project));
    const server = mergedServer(instructions, () => this.sources(project), (alias, e) => this.s.log("mcp", alias, "", 0, 0, `${project}: ${e}`));
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => void this.sessions.set(id, { transport, server, project }),
      onsessionclosed: (id) => void this.sessions.delete(id),
    });
    transport.onclose = () => transport.sessionId && this.sessions.delete(transport.sessionId);
    await server.connect(transport);
    return transport.handleRequest(req);
  }

  /** Tell every running session to re-list its tools (a mapping or instance changed). */
  toolsChanged() {
    for (const { server } of this.sessions.values()) server.sendToolListChanged().catch(() => {});
  }

  /** Auto-discovered repos for the UI; written at most every 5 minutes per repo to keep sync quiet. */
  private seen(project: string) {
    if (project === "*") return;
    const p = this.s.get("project", project);
    if (p?.seenAt && this.s.now() - p.seenAt < 5 * 60_000 && p.seenOn === this.s.nodeId) return;
    this.s.put("project", project, { ...(p ?? { id: project }), seenAt: this.s.now(), seenOn: this.s.nodeId });
  }

  private closeIdle() {
    for (const [id, u] of this.upstreams)
      if (Date.now() - u.lastUsed > IDLE_CLOSE) {
        u.client?.close().catch(() => {});
        this.upstreams.delete(id);
      }
  }

  async close() {
    clearInterval(this.timer);
    for (const u of this.upstreams.values()) await u.client?.close().catch(() => {});
    for (const { transport } of this.sessions.values()) await transport.close().catch(() => {});
  }
}

/** A connect error that a login would fix. */
export const needsLogin = (e: unknown) =>
  (e as { code?: number })?.code === 401 || /\b401\b|unauthori[sz]ed|invalid_token|needs a login|login requested/i.test(String((e as Error)?.message ?? e));

/** Rename an MCP instance and every repo mapping that points at it. */
export function renameInstance(s: Store, from: string, to: string) {
  const inst = s.get("mcp", from);
  if (!inst) throw new Error(`no MCP server ${from}`);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(to)) throw new Error("name: letters, digits, - and _ (it becomes the tool prefix)");
  if (to === from) return;
  if (s.get("mcp", to)) throw new Error(`${to} already exists`);
  s.put("mcp", to, { ...inst, id: to });
  for (const p of s.list("project")) {
    if (!Object.values(p.mcp).includes(from)) continue;
    // An alias that was just the old name follows the rename, so the tool prefix changes too.
    const mcp = Object.fromEntries(Object.entries(p.mcp).map(([a, i]) => (i === from ? [a === from ? to : a, to] : [a, i])));
    s.put("project", p.id, { ...p, mcp });
  }
  s.del("mcp", from);
}

/** Git repos directly inside `dir` whose origin parses as owner/repo. */
export function scanRepos(dir: string): { repo: string; path: string }[] {
  let names: string[];
  try {
    names = readdirSync(dir).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
  const out: { repo: string; path: string }[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const git = join(path, ".git");
    if (name.startsWith(".") || !existsSync(git)) continue;
    let remote: string | undefined;
    if (statSync(git).isDirectory()) {
      // Reading the config beats spawning git once per folder.
      if (!existsSync(join(git, "config"))) continue;
      const cfg = readFileSync(join(git, "config"), "utf8");
      remote = cfg.match(/\[remote "origin"\][^[]*?\burl\s*=\s*(.+)/)?.[1];
    } else {
      const r = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: path, stderr: "ignore" });
      if (r.exitCode === 0) remote = r.stdout.toString();
    }
    const repo = remote && parseRemote(remote);
    if (repo) out.push({ repo, path });
  }
  return out;
}
