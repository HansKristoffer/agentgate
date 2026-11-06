import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolRequest,
  type CallToolResult,
  type Implementation,
  type RequestOptions,
  type Tool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { anySignal, getErrorMessage, isTruthy } from "hanzio";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isVirtual, projectIdSchema } from "@agentgate/protocol";
import { REMOTE_LIMITS } from "@agentgate/protocol/remote";
import { NeedsLogin } from "../credentials.ts";
import { infisicalMcpEnv } from "../logins.ts";
import { fetchHeaders, sleep } from "../runtime.ts";
import type { McpInstance, Store } from "../store.ts";
import { CALL_LIMIT, authenticatedFetch, headerWait } from "./oauth.ts";
import { skillsSource } from "./skills.ts";
import { resolve } from "./templates.ts";

export const VERSION = "0.1.0";
/** The tool prefix of agentgate's own tools in local sessions (thread handoff); reserved in project mappings. */
export const BUILTIN_ALIAS = "agentgate";
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
  return s.list("project").find((p) => p.id.toLowerCase() === lower)?.id ?? project;
}

/** alias → instance id for a repo: the `*` defaults (unless turned off), overridden by the repo's own. */
export function aliasesFor(s: Store, project: string): Record<string, string> {
  const p = project !== "*" ? s.get("project", canonicalProject(s, project)) : undefined;
  if (isVirtual(project)) return { ...(p?.mcp ?? {}) };
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
/** Whether this node last reached the server, from Test or a gateway connection. Node-local: a local command or a
 * network path can work on one machine and not another. Holds no error text, so it can never carry a secret. */
export function serverHealth(s: Store, id: string): { ok: boolean; needsLogin?: boolean; at: number } | undefined {
  const raw = s.local(`mcpHealth:${id}`);
  return raw ? JSON.parse(raw) : undefined;
}

/** Connect to an instance; with a store, record the outcome as its health. */
export async function connect(inst: McpInstance, cwd?: string, s?: Store): Promise<Client> {
  try {
    const client = await open(inst, cwd, s);
    s?.setLocal(`mcpHealth:${inst.id}`, JSON.stringify({ ok: true, at: s.now() }));
    return client;
  } catch (e) {
    s?.setLocal(`mcpHealth:${inst.id}`, JSON.stringify({ ok: false, needsLogin: needsLogin(e), at: s.now() }));
    throw e;
  }
}

async function open(inst: McpInstance, cwd?: string, s?: Store): Promise<Client> {
  const r = resolve(inst);
  if (inst.template === "infisical" && s) r.env = { ...infisicalMcpEnv(s), ...r.env };
  const client = new Client({ name: "agentgate", version: VERSION });
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  let stderr = "";
  if (r.transport === "http") {
    if (!r.url) throw new Error(`${inst.id}: no url`);
    transport = new StreamableHTTPClientTransport(new URL(r.url), {
      requestInit: { headers: r.headers },
      fetch: s
        ? authenticatedFetch(s, inst.id)
        : (url, init) => fetchHeaders(url, init, headerWait(init?.method, 10000)),
    });
  } else {
    if (!r.command) throw new Error(`${inst.id}: no command`);
    if (!Bun.which(r.command))
      throw new Error(`${inst.id}: '${r.command}' is not installed (install Node for npx or uv for uvx)`);
    transport = new StdioClientTransport({
      command: r.command,
      args: r.args,
      env: { ...(process.env as Record<string, string>), ...r.env },
      cwd,
      stderr: "pipe",
    });
  }
  try {
    const pending = client.connect(transport, { timeout: 10000 });
    if (transport instanceof StdioClientTransport)
      transport.stderr?.on("data", (chunk) => {
        stderr = (stderr + String(chunk)).slice(-2048);
      });
    await pending;
    const close = client.close.bind(client);
    client.close = async () => {
      try {
        if (transport instanceof StreamableHTTPClientTransport && transport.sessionId)
          await transport.terminateSession();
      } catch {
        /* disconnected or server does not support DELETE */
      } finally {
        await close();
      }
    };
    return client;
  } catch (e) {
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
    let error = `${e}${stderr ? `; stderr: ${stderr.trim()}` : ""}`;
    for (const value of Object.values({ ...process.env, ...r.env, ...r.headers, ...inst.secrets }))
      if (value && value.length >= 4) error = error.replaceAll(value, "[redacted]");
    throw new Error(`${inst.id}: ${error}`);
  }
}

/** Connects, lists the tools and disconnects, recording the outcome as the server's health. */
export async function serverTools(s: Store, inst: McpInstance): Promise<Tool[]> {
  const client = await connect(inst, process.cwd(), s);
  try {
    return await listAllTools(client);
  } finally {
    await client.close();
  }
}

/** Each connection's tool list, asked for once. A failed listing is not kept. */
const toolLists = new WeakMap<Client, Promise<Tool[]>>();

/**
 * Every page: the SDK walks them (at most 64) and caches the list it validates tool results against. The list is
 * kept per connection, so a session's tools/list and its first calls don't ask every server again; asking every
 * upstream on each listing cost 650–800 ms, bound by the slowest server. `fresh` asks again.
 */
export function listAllTools(c: Client, options: { fresh?: boolean } = {}): Promise<Tool[]> {
  const kept = options.fresh ? undefined : toolLists.get(c);
  if (kept) return kept;
  const listing = c.listTools().then(({ tools }) => {
    if (tools.length > 10000) throw new Error("MCP tool list exceeds 10000 tools");
    return tools;
  });
  toolLists.set(c, listing);
  listing.catch(() => {
    if (toolLists.get(c) === listing) toolLists.delete(c);
  });
  return listing;
}

/** Forgets the connection's tool list when its server says the tools changed, then runs `then`. */
function watchTools(c: Client, then: () => void) {
  c.setNotificationHandler("notifications/tools/list_changed", () => {
    toolLists.delete(c);
    then();
  });
}

/** The `_meta` key that names the client calling through agentgate, such as Claude Code, for the server's history. */
const CALLER_META_KEY = "dev.agentgate/client";

/** The shim's own name toward the daemon: a caller through it is named by the shim, never as the shim. */
export const SHIM_CLIENT_NAME = "agentgate-shim";

export interface Source {
  alias: string; // '' passes tool names through unchanged
  client: Client;
  /** The server's settings: its tool allowlist, instructions, result limits and default arguments. */
  instance?: McpInstance;
  invoke?: (params: CallToolRequest["params"], options: RequestOptions) => Promise<CallToolResult>;
  /**
   * Answer listings from the connection's kept tool list. Only the daemon's shared upstream connections keep theirs:
   * they are the remote servers whose listing is slow, and they say when their tools change. Local sources (the
   * shim's daemon, per-session children, the built-in tools) are asked every time, since their lists can change
   * without a notice and a listing is how the shim notices a restarted daemon.
   */
  keepTools?: boolean;
}

/**
 * What one shim session may use, from the T3 Code thread its shim names (`/mcp?thread=`). The daemon narrows the
 * sessions of factory threads with it (`threadScope` in factory/controller.ts). The thread id is a label the shim
 * sends, so a scope narrows a default and is no boundary.
 */
export interface SessionScope {
  /** The project's servers the session may use, by alias; every mapped one when absent. */
  servers?: readonly string[];
  /** agentgate's own tools the session does not see. */
  hidden?: readonly string[];
}

/** Whether a session with this scope may use the source `alias`, or its tool `tool`. */
export function inScope(scope: SessionScope | undefined, alias: string, tool?: string): boolean {
  if (alias === BUILTIN_ALIAS) return tool === undefined || !scope?.hidden?.includes(tool);
  return !scope?.servers || scope.servers.includes(alias);
}

/** Claude Code keeps the first 4,096 characters of a server's instructions and drops the rest. */
export const INSTRUCTIONS_BUDGET = 4000;
const INSTRUCTIONS_CUT = "\n[… agentgate cut the rest to fit the instructions limit]";

/**
 * Every source's instructions under its alias, within `budget`. Each source gets an equal share, and a short one
 * leaves the rest of its share to the others, so a long one loses its tail rather than every later server losing all.
 */
export function mergeInstructions(
  sources: Source[],
  onTrim?: (aliases: string[]) => void,
  budget = INSTRUCTIONS_BUDGET,
): string {
  const parts = sources.flatMap((src) => {
    const text = (src.instance?.instructions ?? src.client.getInstructions())?.trim();
    return text ? [{ alias: src.alias, head: src.alias ? `## ${src.alias}\n` : "", text }] : [];
  });
  let left = budget - parts.reduce((n, p) => n + p.head.length + 2, 0);
  const trimmed: string[] = [];
  [...parts]
    .sort((a, b) => a.text.length - b.text.length)
    .forEach((p, i, all) => {
      const share = Math.max(0, Math.floor(left / (all.length - i)));
      if (p.text.length > share) {
        const room = share - INSTRUCTIONS_CUT.length;
        const line = p.text.lastIndexOf("\n", room);
        p.text = room > 0 ? p.text.slice(0, line > room / 2 ? line : room).trimEnd() + INSTRUCTIONS_CUT : "";
        trimmed.push(p.alias);
      }
      left -= p.text.length;
    });
  if (trimmed.length) onTrim?.(trimmed);
  return parts.map((p) => p.head + p.text).join("\n\n");
}

/**
 * Results past this many characters are cut unless the server or tool sets its own limit. Railway logs, PostHog SQL
 * and Cloudflare docs returned 20–50K characters per call, which agents paid for in tokens and rarely read.
 */
export const MAX_RESULT_CHARS = 20_000;

const resultLimit = (inst: McpInstance | undefined, tool: string) =>
  inst ? (inst.toolOptions?.[tool]?.maxResultChars ?? inst.maxResultChars ?? MAX_RESULT_CHARS) : 0;

const textLength = (result: CallToolResult) =>
  result.content.reduce((n, c) => n + (c.type === "text" ? c.text.length : 0), 0);

/** The result's text cut to `max` characters, with a note telling the agent how to ask for less. Structured content
 * goes too: it repeats the text, and agentgate offers no output schema that would require it. */
export function capResult(result: CallToolResult, max: number): CallToolResult {
  const total = textLength(result);
  if (total <= max) return result;
  let left = max;
  const content: CallToolResult["content"] = [];
  for (const c of result.content) {
    if (c.type !== "text") content.push(c);
    else if (left > 0) {
      content.push({ ...c, text: c.text.slice(0, left) });
      left -= c.text.length;
    }
  }
  content.push({
    type: "text",
    text: `\n\n[agentgate cut this result at ${max} of ${total} characters. Ask for less: a smaller limit, a filter, a shorter time range, or an offset.]`,
  });
  const { structuredContent: _, ...rest } = result;
  return { ...rest, content };
}

/**
 * A tool call without the SDK's output-schema check. A proxy passes the server's result on as it came: the check
 * failed valid Railway results over one extra property, and the agent lost them.
 */
const callTool = (client: Client, params: CallToolRequest["params"], options: RequestOptions) =>
  client.request({ method: "tools/call", params }, options) as Promise<CallToolResult>;

/** One forwarded tool call, for the log. Never the arguments or the result. */
export interface CallRecord {
  alias: string;
  tool: string;
  ms: number;
  chars: number;
  cut?: number;
  failed?: boolean;
}

/** One MCP server in front of many: the tools of every source under their aliases. */
export function mergedServer(
  instructions: string,
  sources: () => Promise<Source[]>,
  {
    onError = () => {},
    resolveSource,
    allow,
    activity,
    signal,
    onCall,
  }: {
    onError?: (alias: string, e: unknown) => void;
    /** Finds a call's source without listing every source again. */
    resolveSource?: (alias: string) => Promise<Source | undefined>;
    /** Whether the session may list and call a source's tool now; asked again on every call. */
    allow?: (alias: string, tool: string) => boolean;
    activity?: (change: number) => void;
    signal?: AbortSignal;
    onCall?: (call: CallRecord) => void;
  } = {},
): Server {
  const server = new Server(
    { name: "agentgate", version: VERSION },
    { capabilities: { tools: { listChanged: true } }, instructions },
  );
  let routes = new Map<string, { alias: string; tool: string }>();
  let listing: Promise<Tool[]> | undefined;

  /** One listing at a time: parallel first calls of a session share it instead of each listing every server. */
  function list(options: { fresh?: boolean } = {}): Promise<Tool[]> {
    if (listing && !options.fresh) return listing;
    const current = listSources(options).finally(() => {
      if (listing === current) listing = undefined;
    });
    listing = current;
    return current;
  }

  async function listSources(options: { fresh?: boolean }): Promise<Tool[]> {
    const next = new Map<string, { alias: string; tool: string }>();
    const all: Tool[] = [];
    const pages = await Promise.all(
      (await sources()).map(async (src) => {
        try {
          const fresh = options.fresh || !src.keepTools;
          return { src, tools: await listAllTools(src.client, { fresh }) };
        } catch (e) {
          onError(src.alias, e);
          return { src, tools: [] };
        }
      }),
    );
    for (const { src, tools } of pages) {
      const offered = src.instance?.tools && new Set(src.instance.tools);
      // No output schema: results pass through unchecked, so a client must not check them against one either.
      for (const { outputSchema: _, ...t } of tools) {
        if (offered && !offered.has(t.name)) continue;
        if (allow && !allow(src.alias, t.name)) continue;
        const name = toolName(src.alias, t.name);
        if (next.has(name)) throw new Error(`duplicate MCP tool name ${name}`);
        next.set(name, { alias: src.alias, tool: t.name });
        all.push({ ...t, name });
      }
    }
    routes = next;
    return all.sort((a, b) => a.name.localeCompare(b.name));
  }

  server.setRequestHandler("tools/list", async () => ({ tools: await list() }));
  server.setRequestHandler("tools/call", async (req, ctx) => {
    if (!routes.has(req.params.name)) await list();
    // A kept list can miss a tool a server added without saying so; ask again once before giving up.
    if (!routes.has(req.params.name)) await list({ fresh: true });
    const route = routes.get(req.params.name);
    if (!route || (allow && !allow(route.alias, route.tool)))
      return { isError: true, content: [{ type: "text", text: `agentgate: unavailable tool ${req.params.name}` }] };
    activity?.(1);
    const started = performance.now();
    const call: CallRecord = { alias: route.alias, tool: route.tool, ms: 0, chars: 0 };
    try {
      const source = resolveSource
        ? await resolveSource(route.alias)
        : (await sources()).find((s) => s.alias === route.alias);
      if (!source) {
        call.failed = true;
        return { isError: true, content: [{ type: "text", text: `agentgate: unavailable tool ${req.params.name}` }] };
      }
      const progressToken = req.params._meta?.progressToken;
      const options: RequestOptions = {
        // The SDK does not abort handlers when the HTTP request goes away, so the request's own signal and a
        // caller-owned one are combined in: a client that dropped the call cancels it upstream.
        signal: anySignal(ctx.mcpReq.signal, ctx.http?.req?.signal, signal),
        timeout: 5 * 60_000,
        maxTotalTimeout: CALL_LIMIT,
        resetTimeoutOnProgress: true,
        onprogress:
          progressToken === undefined
            ? undefined
            : (p) => {
                void ctx.mcpReq
                  .notify({ method: "notifications/progress", params: { ...p, progressToken } })
                  .catch(() => {});
              },
      };
      const defaults = source.instance?.toolOptions?.[route.tool]?.defaults;
      const params = {
        ...req.params,
        name: route.tool,
        ...(defaults && { arguments: { ...defaults, ...req.params.arguments } }),
        _meta: withCaller(req.params._meta, server.getClientVersion()),
      };
      const result = await (source.invoke ? source.invoke(params, options) : callTool(source.client, params, options));
      call.chars = textLength(result);
      const max = resultLimit(source.instance, route.tool);
      if (!max || call.chars <= max) return result;
      call.cut = max;
      return capResult(result, max);
    } catch (e) {
      call.failed = true;
      throw e;
    } finally {
      activity?.(-1);
      call.ms = Math.round(performance.now() - started);
      onCall?.(call);
    }
  });

  return server;
}

/**
 * The request's `_meta` with the calling client named under `CALLER_META_KEY`, so the server behind agentgate can
 * tell Claude Code from Codex. A name already there, which the shim set, stays; the shim itself is never the name.
 */
function withCaller(meta: Record<string, unknown> | undefined, caller: Implementation | undefined) {
  if (!caller || caller.name === SHIM_CLIENT_NAME || meta?.[CALLER_META_KEY]) return meta;
  const { name, title, version } = caller;
  return { ...meta, [CALLER_META_KEY]: { name, version, ...(title && { title }) } };
}

interface Upstream {
  client?: Client;
  connecting?: Promise<Client>;
  config: string;
  lastUsed: number;
  calls: number;
  retired?: boolean;
  /** Connects that failed in a row, and when the next may be tried. A changed config starts a new entry. */
  failures?: number;
  retryAt?: number;
}

/** A server that failed to connect is tried again after 30 s, doubling to 5 minutes, not on every listing. */
const retryDelay = (failures: number) => Math.min(5 * 60_000, 30_000 * 2 ** (failures - 1));

/** A connect skipped because the server failed recently; already logged when it failed. */
class Backoff extends Error {}

/** The daemon side: shared upstream connections, and one merged server per shim session. */
export class Gateway {
  upstreams = new Map<string, Upstream>();
  private sessions = new Map<
    string,
    {
      transport: WebStandardStreamableHTTPServerTransport;
      server: Server;
      project: string;
      lastUsed: number;
      calls: number;
      /** The T3 Code thread the session's shim named, which decides its scope. */
      thread?: string;
      /** What the session's tool list depends on (`toolsKey`), as of its last notice. */
      tools: string;
    }
  >();
  private trimmed = new Set<string>();
  private timer = setInterval(() => {
    void this.closeIdle();
  }, 60_000);
  private closed = false;
  private retired = new Set<Upstream>();
  /** agentgate's own tools for local sessions, set by the daemon. Never offered on a virtual project's public endpoint. */
  builtin?: () => Promise<Source>;
  private builtinSource?: Promise<Source>;
  /** A session's scope from the T3 Code thread its shim names, if any; set by the daemon. Without it, or without a
   * scope, a session uses every server its project maps. */
  scope?: (thread: string | undefined) => SessionScope | undefined;

  constructor(private s: Store) {
    this.timer.unref();
  }

  /** One connection per shared instance, opened on first use and reopened when its config changes. */
  async shared(inst: McpInstance): Promise<Client> {
    if (this.closed) throw new Error("MCP gateway is closed");
    const config = JSON.stringify({ ...inst, loggedIn: !!this.s.get("mcpCredential", inst.id)?.tokens });
    let u = this.upstreams.get(inst.id);
    if (u && u.config !== config) {
      u.retired = true;
      this.retired.add(u);
      if (!u.calls) {
        await u.client?.close().catch(() => {});
        this.retired.delete(u);
      }
      u = undefined;
    }
    if (!u) this.upstreams.set(inst.id, (u = { config, lastUsed: this.s.now(), calls: 0 }));
    u.lastUsed = this.s.now();
    if (u.client) return u.client;
    // A Test that reached the server since (app or CLI) ends the wait.
    if (!u.connecting && u.retryAt && this.s.now() < u.retryAt && !serverHealth(this.s, inst.id)?.ok)
      throw new Backoff(`${inst.id}: unavailable, next try in ${Math.ceil((u.retryAt - this.s.now()) / 1000)} s`);
    const entry = u;
    entry.connecting ??= connect(inst, undefined, this.s).then(
      async (c) => {
        if (this.closed || entry.retired || this.upstreams.get(inst.id) !== entry) {
          await c.close();
          throw new Error("MCP configuration changed during connection");
        }
        entry.client = c;
        entry.connecting = undefined;
        entry.failures = entry.retryAt = undefined;
        watchTools(c, () => this.toolsChanged(inst.id));
        // Listed while the session that asked for the connection is still starting, so its tools/list is ready.
        void listAllTools(c).catch(() => {});
        c.onclose = () => {
          if (entry.client === c) entry.client = undefined;
        };
        return c;
      },
      (e) => {
        entry.connecting = undefined;
        entry.failures = (entry.failures ?? 0) + 1;
        entry.retryAt = this.s.now() + retryDelay(entry.failures);
        throw e;
      },
    );
    return entry.connecting;
  }

  private async source(project: string, alias: string): Promise<Source | undefined> {
    const id = aliasesFor(this.s, project)[alias];
    const inst = id && this.s.get("mcp", id);
    if (!inst || inst.mode !== "shared") return;
    const client = await this.shared(inst);
    return {
      alias,
      client,
      instance: inst,
      keepTools: true,
      invoke: async (params, options) => {
        // Recheck immediately before sending. A notification is not an authorization check.
        const currentId = aliasesFor(this.s, project)[alias];
        if (currentId !== inst.id) throw new Error("project mapping changed; list tools again");
        const current = this.s.get("mcp", currentId);
        if (!current || current.mode !== "shared") throw new Error("MCP server removed");
        const active = await this.shared(current);
        const entry = this.upstreams.get(currentId)!;
        entry.calls++;
        entry.lastUsed = this.s.now();
        try {
          return await callTool(active, params, options);
        } finally {
          entry.calls--;
          entry.lastUsed = this.s.now();
          if (entry.retired && !entry.calls) {
            await active.close().catch(() => {});
            this.retired.delete(entry);
          }
        }
      },
    };
  }
  /** With `wait`, the sources that connected within it; the others keep connecting for the next listing. A server
   * outside the scope is not connected for the session. */
  private async sources(project: string, wait?: number, scope?: SessionScope): Promise<Source[]> {
    const out = await Promise.all(
      Object.keys(aliasesFor(this.s, project))
        .filter((alias) => inScope(scope, alias))
        .map((alias) => {
          const source = this.source(project, alias).catch((e) => {
            if (!(e instanceof Backoff)) this.s.log("mcp", alias, "", 0, 0, `connect failed: ${e}`);
            return undefined;
          });
          return wait === undefined ? source : Promise.race([source, sleep(wait).then(() => undefined)]);
        }),
    );
    return out.filter(isTruthy);
  }

  private builtinTools(): Promise<Source | undefined> {
    if (!this.builtin || this.closed) return Promise.resolve(undefined);
    return (this.builtinSource ??= this.builtin().catch((e) => {
      this.builtinSource = undefined;
      throw e;
    }));
  }
  private async localSources(project: string, wait?: number, scope?: SessionScope): Promise<Source[]> {
    const builtin = await this.builtinTools().catch(() => undefined);
    const out = await this.sources(project, wait, scope);
    return builtin ? [...out.filter((src) => src.alias !== BUILTIN_ALIAS), builtin] : out;
  }

  /** Streamable HTTP endpoint for shims: `/mcp?project=owner/repo`. */
  async handle(req: Request): Promise<Response> {
    const sid = req.headers.get("mcp-session-id");
    if (sid) {
      const sess = this.sessions.get(sid);
      if (sess) {
        sess.lastUsed = this.s.now();
        const active = req.method !== "GET";
        if (active) sess.calls++;
        try {
          return await sess.transport.handleRequest(req);
        } finally {
          if (active) sess.calls--;
          sess.lastUsed = this.s.now();
        }
      }
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32001, message: "session not found" }, id: null },
        { status: 404 },
      );
    }
    if (this.closed) return new Response("gateway stopped", { status: 503 });
    if (this.sessions.size >= 256) return new Response("too many MCP sessions", { status: 503 });
    const params = new URL(req.url).searchParams;
    const project = params.get("project") || "*";
    if (project !== "*" && !projectIdSchema.safeParse(project).success)
      return new Response("invalid project", { status: 400 });
    const thread = params.get("thread") || undefined;
    if (thread && thread.length > 256) return new Response("invalid thread", { status: 400 });
    const scope = () => this.scope?.(thread);
    // The shim gives up on the handshake after 5 s: one slow or hung server must not cost the session every tool.
    const instructions = mergeInstructions(await this.localSources(project, 3000, scope()), (aliases) => {
      const key = `${project} ${aliases.join(" ")}`;
      if (this.trimmed.has(key)) return;
      this.trimmed.add(key);
      this.s.log("mcp", "", "", 0, 0, `${project}: instructions of ${aliases.join(", ")} cut to fit`);
    });
    const tools = this.toolsKey(project, thread);
    const usage = { lastUsed: this.s.now(), calls: 0 };
    const server = mergedServer(instructions, () => this.localSources(project, undefined, scope()), {
      onError: (alias, e) => this.s.log("mcp", alias, "", 0, 0, `${project}: ${String(e).slice(0, 300)}`),
      resolveSource: async (alias) =>
        alias === BUILTIN_ALIAS && this.builtin ? this.builtinTools() : this.source(project, alias),
      allow: (alias, tool) => inScope(scope(), alias, tool),
      activity: (delta) => {
        usage.calls += delta;
        usage.lastUsed = this.s.now();
      },
      onCall: (c) =>
        this.s.log(
          "mcp",
          c.alias,
          c.tool,
          c.failed ? 502 : 200,
          c.ms,
          `${c.tool} ${c.ms} ms, ${c.chars} chars${c.cut ? `, cut to ${c.cut}` : ""}${c.failed ? ", failed" : ""}`,
        ),
    });
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        this.seen(project);
        this.sessions.set(id, {
          transport,
          server,
          project,
          ...(thread && { thread }),
          tools,
          get lastUsed() {
            return usage.lastUsed;
          },
          set lastUsed(value) {
            usage.lastUsed = value;
          },
          get calls() {
            return usage.calls;
          },
          set calls(value) {
            usage.calls = value;
          },
        });
      },
      onsessionclosed: (id) => void this.sessions.delete(id),
    });
    transport.onclose = () => transport.sessionId && this.sessions.delete(transport.sessionId);
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(req);
      if (response.status >= 400 && !transport.sessionId) await server.close();
      return response;
    } catch (e) {
      await server.close().catch(() => {});
      throw e;
    }
  }

  /**
   * The endpoint of a virtual project, for remote clients through the relay: stateless JSON, one server and
   * transport per POST, shared instances plus the built-in skill tools. Never reachable through an HTTP listener.
   */
  async handleRemote(
    project: string,
    body: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<{ response: Response; failed: string[] }> {
    const error = (status: number, code: number, message: string) => ({
      response: Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status }),
      failed: [],
    });
    if (this.closed) return error(503, -32000, "agentgate is stopping");
    // The relay frame allows webhook-sized bodies; MCP requests keep their own limit, whatever the relay enforces.
    if (Buffer.byteLength(body) > REMOTE_LIMITS.requestBytes) return error(413, -32000, "request too large");
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return error(400, -32700, "Parse error");
    }
    if (Array.isArray(message)) return error(400, -32600, "JSON-RPC batches are not supported");
    const failed = new Set<string>();
    const skills = await skillsSource(this.s, project);
    const sources = async (): Promise<Source[]> => {
      const out = await Promise.all(
        Object.keys(aliasesFor(this.s, project))
          .filter((alias) => alias !== skills.alias)
          .map(async (alias) => {
            try {
              return await this.source(project, alias);
            } catch (e) {
              failed.add(alias);
              if (!(e instanceof Backoff)) this.s.log("mcp", alias, "", 0, 0, `${project}: connect failed: ${e}`);
              return undefined;
            }
          }),
      );
      return [...out.filter(isTruthy), skills];
    };
    // A connect error carries the server's stderr and local details: logged here, never sent to the public client.
    const resolveSource = (alias: string) =>
      alias === skills.alias
        ? Promise.resolve(skills)
        : this.source(project, alias).catch((e) => {
            failed.add(alias);
            if (!(e instanceof Backoff)) this.s.log("mcp", alias, "", 0, 0, `${project}: connect failed: ${e}`);
            throw new Error(`${alias} is unavailable`);
          });
    // Instructions only matter to `initialize`; skip connecting every upstream twice for other requests.
    const instructions =
      (message as { method?: unknown })?.method === "initialize" ? mergeInstructions(await sources()) : "";
    const server = mergedServer(instructions, sources, {
      onError: (alias, e) => {
        failed.add(alias);
        this.s.log("mcp", alias, "", 0, 0, `${project}: ${String(e).slice(0, 300)}`);
      },
      resolveSource,
      signal,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      // We always answer with JSON, so a client that only accepts JSON is fine; the SDK insists on both types.
      const request = new Request("http://agentgate.invalid/mcp", {
        method: "POST",
        body,
        signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(headers["mcp-protocol-version"] && { "mcp-protocol-version": headers["mcp-protocol-version"] }),
        },
      });
      const aborted = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      aborted.catch(() => {});
      const response = await Promise.race([transport.handleRequest(request), aborted]);
      // Read the body before closing the server, which would cut a JSON response short.
      const text = await response.text();
      return {
        response: new Response(text || null, { status: response.status, headers: response.headers }),
        failed: [...failed],
      };
    } finally {
      await server.close().catch(() => {});
      await skills.client.close().catch(() => {});
    }
  }

  /** What a session's tool list depends on: its project's mapping, the mapped servers' settings, which are signed
   * in, and its thread's scope. */
  private toolsKey(project: string, thread: string | undefined): string {
    return JSON.stringify([
      Object.entries(aliasesFor(this.s, project)).map(([alias, id]) => [
        alias,
        this.s.get("mcp", id) ?? null,
        !!this.s.get("mcpCredential", id)?.tokens,
      ]),
      this.scope?.(thread) ?? null,
    ]);
  }

  /**
   * Tells the sessions whose tools may have changed to list them again: after a store change or a factory run's
   * change, those whose mapping, servers, sign-ins or scope differ; with `instance`, those using that server, which
   * said its tools changed. A client re-lists on every notice, and store changes that leave tools alone (a session
   * being recorded, a token refresh) are frequent.
   */
  toolsChanged(instance?: string) {
    for (const session of this.sessions.values()) {
      if (instance) {
        if (!Object.values(aliasesFor(this.s, session.project)).includes(instance)) continue;
      } else {
        const key = this.toolsKey(session.project, session.thread);
        if (key === session.tools) continue;
        session.tools = key;
      }
      session.server.sendToolListChanged().catch(() => {});
    }
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
    for (const [id, u] of this.upstreams)
      if (!u.calls && !u.connecting && this.s.now() - u.lastUsed > IDLE_CLOSE) {
        u.retired = true;
        this.upstreams.delete(id);
        if (u.client) tasks.push(u.client.close().catch(() => {}));
      }
    for (const [id, session] of this.sessions)
      if (!session.calls && this.s.now() - session.lastUsed > 30 * 60_000) {
        this.sessions.delete(id);
        tasks.push(session.server.close().catch(() => {}));
      }
    await Promise.allSettled(tasks);
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    const tasks: Promise<unknown>[] = [];
    for (const u of new Set([...this.upstreams.values(), ...this.retired])) {
      u.retired = true;
      if (u.client) tasks.push(u.client.close());
      if (u.connecting) tasks.push(u.connecting.catch(() => {}));
    }
    for (const { server } of this.sessions.values()) tasks.push(server.close());
    if (this.builtinSource) tasks.push(this.builtinSource.then((src) => src.client.close()));
    await Promise.allSettled(tasks);
    this.upstreams.clear();
    this.retired.clear();
    this.sessions.clear();
  }
}

/** A connect error that a login would fix. */
export const needsLogin = (e: unknown) =>
  e instanceof NeedsLogin ||
  (e as { code?: number })?.code === 401 ||
  /\b401\b|unauthori[sz]ed|invalid_token|needs a login|login requested/i.test(getErrorMessage(e));

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
