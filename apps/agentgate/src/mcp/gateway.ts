import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ToolListChangedNotificationSchema, type CallToolRequest, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fetchHeaders } from "../runtime.ts";
import type { McpInstance, Store } from "../store.ts";
import { authenticatedFetch } from "./oauth.ts";
import { resolve } from "./templates.ts";
export { renameInstance } from "../operations.ts";

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

/** GitHub owner/repo names are case-insensitive: a clone of `geysier/Gey-Mono` is the stored `Geysier/gey-mono`. */
export function canonicalProject(s: Store, project: string): string {
  if (project === "*" || s.get("project", project)) return project;
  const lower = project.toLowerCase();
  return s.list("project").find(p => p.id.toLowerCase() === lower)?.id ?? project;
}

/** alias → instance id for a repo: the `*` defaults (unless turned off), overridden by the repo's own. */
export function aliasesFor(s: Store, project: string): Record<string, string> {
  const p = project !== "*" ? s.get("project", canonicalProject(s, project)) : undefined;
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
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  let stderr = "";
  if (r.transport === "http") {
    if (!r.url) throw new Error(`${inst.id}: no url`);
    transport = new StreamableHTTPClientTransport(new URL(r.url), {
      requestInit: { headers: r.headers },
      fetch: s ? authenticatedFetch(s, inst.id) : (url, init) => fetchHeaders(url, init, init?.method === "DELETE" ? 2000 : 10000),
    });
  } else {
    if (!r.command) throw new Error(`${inst.id}: no command`);
    if (!Bun.which(r.command)) throw new Error(`${inst.id}: '${r.command}' is not installed (install Node for npx or uv for uvx)`);
    transport = new StdioClientTransport({ command: r.command, args: r.args, env: { ...(process.env as Record<string, string>), ...r.env }, cwd, stderr: "pipe" });
  }
  try {
    const pending = client.connect(transport, { timeout: 10000 });
    if (transport instanceof StdioClientTransport) transport.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-2048); });
    await pending;
    const close = client.close.bind(client);
    client.close = async () => {
      try { if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) await transport.terminateSession(); }
      catch { /* disconnected or server does not support DELETE */ }
      finally { await close(); }
    };
    return client;
  } catch (e) {
    await transport.close().catch(() => { });
    await client.close().catch(() => { });
    let error = `${e}${stderr ? `; stderr: ${stderr.trim()}` : ""}`;
    for (const value of Object.values({ ...process.env, ...r.env, ...r.headers, ...inst.secrets })) if (value && value.length >= 4) error = error.replaceAll(value, "[redacted]");
    throw new Error(`${inst.id}: ${error}`);
  }
}

export async function listAllTools(c: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const page = await c.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error("MCP server repeated its pagination cursor");
    if (cursor) cursors.add(cursor);
    if (tools.length > 10000) throw new Error("MCP tool list exceeds 10000 tools");
  } while (cursor);
  return tools;
}

export interface Source {
  alias: string; // '' passes tool names through unchanged
  client: Client;
  invoke?: (params: CallToolRequest["params"], options: RequestOptions) => ReturnType<Client["callTool"]>;
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
export function mergedServer(instructions: string, sources: () => Promise<Source[]>, onError: (alias: string, e: unknown) => void = () => { }, resolveSource?: (alias: string) => Promise<Source | undefined>, activity?: (change: number) => void): Server {
  const server = new Server({ name: "agentgate", version: VERSION }, { capabilities: { tools: { listChanged: true } }, instructions });
  let routes = new Map<string, { alias: string; tool: string }>();

  async function list(): Promise<Tool[]> {
    const next = new Map<string, { alias: string; tool: string }>();
    const all: Tool[] = [];
    const pages = await Promise.all((await sources()).map(async src => {
      try { return { src, tools: await listAllTools(src.client) }; }
      catch (e) { onError(src.alias, e); return { src, tools: [] }; }
    }));
    for (const { src, tools } of pages) for (const t of tools) {
      const name = toolName(src.alias, t.name);
      if (next.has(name)) throw new Error(`duplicate MCP tool name ${name}`);
      next.set(name, { alias: src.alias, tool: t.name }); all.push({ ...t, name });
    }
    routes = next;
    return all.sort((a, b) => a.name.localeCompare(b.name));
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await list() }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    if (!routes.has(req.params.name)) await list();
    activity?.(1);
    try {
      const route = routes.get(req.params.name);
      const source = route && (resolveSource ? await resolveSource(route.alias) : (await sources()).find(s => s.alias === route.alias));
      if (!route || !source) return { isError: true, content: [{ type: "text", text: `agentgate: unavailable tool ${req.params.name}` }] };
      const progressToken = req.params._meta?.progressToken;
      const options: RequestOptions = {
        signal: extra.signal, timeout: 5 * 60_000, maxTotalTimeout: 30 * 60_000, resetTimeoutOnProgress: true,
        onprogress: progressToken === undefined ? undefined : p => { void extra.sendNotification({ method: "notifications/progress", params: { ...p, progressToken } }).catch(() => { }); },
      };
      const params = { ...req.params, name: route.tool };
      return await (source.invoke ? source.invoke(params, options) : source.client.callTool(params, undefined, options));
    } finally { activity?.(-1); }
  });

  return server;
}

interface Upstream {
  client?: Client;
  connecting?: Promise<Client>;
  config: string;
  lastUsed: number;
  error?: string;
  calls: number;
  retired?: boolean;
}

/** The daemon side: shared upstream connections, and one merged server per shim session. */
export class Gateway {
  upstreams = new Map<string, Upstream>();
  private sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; server: Server; project: string; lastUsed: number; calls: number }>();
  private timer = setInterval(() => { void this.closeIdle(); }, 60_000);
  private closed = false;
  private retired = new Set<Upstream>();

  constructor(private s: Store) { this.timer.unref(); }

  /** One connection per shared instance, opened on first use and reopened when its config changes. */
  async shared(inst: McpInstance): Promise<Client> {
    if (this.closed) throw new Error("MCP gateway is closed");
    const config = JSON.stringify({ ...inst, loggedIn: !!this.s.get("mcpCredential", inst.id)?.tokens });
    let u = this.upstreams.get(inst.id);
    if (u && u.config !== config) {
      u.retired = true; this.retired.add(u);
      if (!u.calls) { await u.client?.close().catch(() => { }); this.retired.delete(u); }
      u = undefined;
    }
    if (!u) this.upstreams.set(inst.id, (u = { config, lastUsed: this.s.now(), calls: 0 }));
    u.lastUsed = this.s.now();
    if (u.client) return u.client;
    const entry = u;
    entry.connecting ??= connect(inst, undefined, this.s).then(
      async (c) => {
        if (this.closed || entry.retired || this.upstreams.get(inst.id) !== entry) { await c.close(); throw new Error("MCP configuration changed during connection"); }
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

  private async source(project: string, alias: string): Promise<Source | undefined> {
    const id = aliasesFor(this.s, project)[alias];
    const inst = id && this.s.get("mcp", id);
    if (!inst || inst.mode !== "shared") return;
    const client = await this.shared(inst);
    return {
      alias, client, invoke: async (params, options) => {
        // Recheck immediately before sending. A notification is not an authorization check.
        const currentId = aliasesFor(this.s, project)[alias];
        if (currentId !== inst.id) throw new Error("project mapping changed; list tools again");
        const current = this.s.get("mcp", currentId);
        if (!current || current.mode !== "shared") throw new Error("MCP server removed");
        const active = await this.shared(current);
        const entry = this.upstreams.get(currentId)!;
        entry.calls++; entry.lastUsed = this.s.now();
        try { return await active.callTool(params, undefined, options); }
        finally { entry.calls--; entry.lastUsed = this.s.now(); if (entry.retired && !entry.calls) { await active.close().catch(() => { }); this.retired.delete(entry); } }
      }
    };
  }
  private async sources(project: string): Promise<Source[]> {
    const out = await Promise.all(Object.keys(aliasesFor(this.s, project)).map(async alias => {
      try { return await this.source(project, alias); }
      catch (e) { this.s.log("mcp", alias, "", 0, 0, `connect failed: ${e}`); return undefined; }
    }));
    return out.filter((source): source is Source => !!source);
  }

  /** Streamable HTTP endpoint for shims: `/mcp?project=owner/repo`. */
  async handle(req: Request): Promise<Response> {
    const sid = req.headers.get("mcp-session-id");
    if (sid) {
      const sess = this.sessions.get(sid);
      if (sess) {
        sess.lastUsed = this.s.now();
        const active = req.method !== "GET"; if (active) sess.calls++;
        try { return await sess.transport.handleRequest(req); } finally { if (active) sess.calls--; sess.lastUsed = this.s.now(); }
      }
      return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "session not found" }, id: null }, { status: 404 });
    }
    if (this.closed) return new Response("gateway stopped", { status: 503 });
    if (this.sessions.size >= 256) return new Response("too many MCP sessions", { status: 503 });
    const project = new URL(req.url).searchParams.get("project") || "*";
    this.seen(project);
    const instructions = mergeInstructions(await this.sources(project));
    const usage = { lastUsed: this.s.now(), calls: 0 };
    const server = mergedServer(instructions, () => this.sources(project), (alias, e) => this.s.log("mcp", alias, "", 0, 0, `${project}: ${e}`), alias => this.source(project, alias), delta => { usage.calls += delta; usage.lastUsed = this.s.now(); });
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => void this.sessions.set(id, { transport, server, project, get lastUsed() { return usage.lastUsed; }, set lastUsed(value) { usage.lastUsed = value; }, get calls() { return usage.calls; }, set calls(value) { usage.calls = value; } }),
      onsessionclosed: (id) => void this.sessions.delete(id),
    });
    transport.onclose = () => transport.sessionId && this.sessions.delete(transport.sessionId);
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(req);
      if (response.status >= 400 && !transport.sessionId) await server.close();
      return response;
    } catch (e) { await server.close().catch(() => { }); throw e; }
  }

  /** Tell every running session to re-list its tools (a mapping or instance changed). */
  toolsChanged() {
    for (const { server } of this.sessions.values()) server.sendToolListChanged().catch(() => { });
  }

  /** Auto-discovered repos for the native app; written at most every 5 minutes per repo to keep sync quiet. */
  private seen(project: string) {
    if (project === "*") return;
    project = canonicalProject(this.s, project);
    const p = this.s.get("project", project);
    if (p?.seenAt && this.s.now() - p.seenAt < 5 * 60_000 && p.seenOn === this.s.nodeId) return;
    this.s.put("project", project, { ...(p ?? { id: project }), seenAt: this.s.now(), seenOn: this.s.nodeId });
  }

  async closeIdle() {
    const tasks: Promise<unknown>[] = [];
    for (const [id, u] of this.upstreams) if (!u.calls && !u.connecting && this.s.now() - u.lastUsed > IDLE_CLOSE) {
      u.retired = true; this.upstreams.delete(id); if (u.client) tasks.push(u.client.close().catch(() => { }));
    }
    for (const [id, session] of this.sessions) if (!session.calls && this.s.now() - session.lastUsed > 30 * 60_000) {
      this.sessions.delete(id); tasks.push(session.server.close().catch(() => { }));
    }
    await Promise.allSettled(tasks);
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    const tasks: Promise<unknown>[] = [];
    for (const u of new Set([...this.upstreams.values(), ...this.retired])) { u.retired = true; if (u.client) tasks.push(u.client.close()); if (u.connecting) tasks.push(u.connecting.catch(() => { })); }
    for (const { server } of this.sessions.values()) tasks.push(server.close());
    await Promise.allSettled(tasks); this.upstreams.clear(); this.retired.clear(); this.sessions.clear();
  }

}

/** A connect error that a login would fix. */
export const needsLogin = (e: unknown) =>
  (e as { code?: number })?.code === 401 || /\b401\b|unauthori[sz]ed|invalid_token|needs a login|login requested/i.test(String((e as Error)?.message ?? e));

/** Git repos directly inside `dir` whose origin parses as owner/repo. */
export function scanRepos(dir: string): { repo: string; path: string }[] {
  const names = readdirSync(dir).sort((a, b) => a.localeCompare(b));
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
