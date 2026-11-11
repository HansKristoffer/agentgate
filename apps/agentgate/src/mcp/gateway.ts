import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
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
import { z } from "zod";
import { NeedsLogin } from "../credentials.ts";
import { defineLocal } from "../local-state.ts";
import { infisicalMcpEnv } from "../logins.ts";
import { fetchHeaders, sleep, Unavailable } from "../runtime.ts";
import type { McpInstance, Store } from "../store.ts";
import { CALL_LIMIT, authenticatedFetch, headerWait } from "./oauth.ts";
import { skillsSource } from "./skills.ts";
import { resolve } from "./templates.ts";

export const VERSION = "0.1.0";
/** The tool prefix of agentgate's own tools in local sessions (thread handoff); reserved in project mappings. */
export const BUILTIN_ALIAS = "agentgate";
/** The tool prefix of the factory's tools on a virtual project's endpoint (`factoryTools`); reserved there. */
export const FACTORY_ALIAS = "factory";
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

/** Whether this node last reached the server, from Test or a gateway connection. Node-local: a local command or a
 * network path can work on one machine and not another. Holds no error text, so it can never carry a secret. */
const health = defineLocal(
  "mcpHealth:",
  z.object({ ok: z.boolean(), needsLogin: z.boolean().optional(), at: z.number() }),
);
export const serverHealth = (s: Store, id: string) => health.get(s, id);
/** Every check moves `at`; only a change of outcome is news for the app. */
export function recordHealth(s: Store, id: string, outcome: { ok: boolean; needsLogin?: boolean } | undefined) {
  const before = health.get(s, id);
  health.set(s, id, outcome && { ...outcome, at: s.now() });
  if (before?.ok !== outcome?.ok || before?.needsLogin !== outcome?.needsLogin) s.bump("status");
}

/**
 * Why a connect failed. Only `auth` asks for a login, and only a typed signal sets it: the OAuth flow's `NeedsLogin`
 * or a 401/403 from an HTTP transport. A server's own text, such as a stdio server printing "Unauthorized", never does.
 */
type ConnectFailure = "auth" | "unreachable" | "failed";

/** A failed connect. Its message is capped, has no HTTP body, and is redacted (`secretValues`), so it may be logged
 * and shown to a local agent. */
class ConnectError extends Error {
  constructor(
    readonly kind: ConnectFailure,
    message: string,
  ) {
    super(message);
  }
}

/** The error and its causes: the SDK wraps a failed version probe's error, which holds the signal. */
function causes(e: unknown): unknown[] {
  const chain = [e];
  for (let c = e; c instanceof Error && c.cause !== undefined && chain.length < 5; c = c.cause) chain.push(c.cause);
  return chain;
}

function failureKind(e: unknown): ConnectFailure {
  if (e instanceof ConnectError) return e.kind;
  for (const c of causes(e)) {
    if (c instanceof NeedsLogin) return "auth";
    if (c instanceof SdkHttpError) return c.status === 401 || c.status === 403 ? "auth" : "failed";
    if (c instanceof Unavailable || (c instanceof SdkError && c.code === SdkErrorCode.RequestTimeout))
      return "unreachable";
  }
  return "failed";
}

/** A connect error that a login would fix. */
export const needsLogin = (e: unknown) => failureKind(e) === "auth";

/** The instance resolved for connecting: templates filled in, and Infisical's login for its template. */
function resolved(inst: McpInstance, s?: Store) {
  const r = resolve(inst);
  if (inst.template === "infisical" && s) r.env = { ...infisicalMcpEnv(s), ...r.env };
  return r;
}

/** Values an error's text must not show: the daemon's env, and the server's env, headers, secrets, arguments, URL
 * and OAuth tokens. */
function secretValues(inst: McpInstance, s?: Store): string[] {
  const r = resolved(inst, s);
  const credential = s?.get("mcpCredential", inst.id);
  const url = r.url ? URL.parse(r.url) : null;
  return [
    ...Object.values({ ...process.env, ...r.env, ...r.headers, ...inst.secrets }),
    ...r.args,
    ...(url ? [r.url, url.username, url.password, ...url.searchParams.values()] : []),
    credential?.tokens?.access_token,
    credential?.tokens?.refresh_token,
    credential?.client?.client_secret,
  ]
    .filter((v): v is string => !!v && v.length >= 4)
    .sort((a, b) => b.length - a.length);
}

const redact = (text: string, secrets: string[]) => secrets.reduce((t, v) => t.replaceAll(v, "[redacted]"), text);

/** An error's text for a log line: an HTTP status instead of the response body, redacted and capped. */
const errorText = (e: unknown, secrets: string[]) =>
  redact(e instanceof SdkHttpError ? `HTTP ${e.status}` : getErrorMessage(e), secrets).slice(0, 300);

/** Connect to an instance; with a store, record the outcome as its health and use the instance's OAuth login
 * (refreshing it when needed). Fails with a `ConnectError`. */
export async function connect(inst: McpInstance, cwd?: string, s?: Store): Promise<Client> {
  try {
    const client = await open(inst, cwd, s);
    if (s) recordHealth(s, inst.id, { ok: true });
    return client;
  } catch (e) {
    if (s) recordHealth(s, inst.id, { ok: false, needsLogin: needsLogin(e) });
    throw e;
  }
}

async function open(inst: McpInstance, cwd?: string, s?: Store): Promise<Client> {
  const r = resolved(inst, s);
  const client = new Client({ name: "agentgate", version: VERSION });
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  let stderr = "";
  if (r.transport === "http") {
    if (!r.url) throw new ConnectError("failed", `${inst.id}: no url`);
    transport = new StreamableHTTPClientTransport(new URL(r.url), {
      requestInit: { headers: r.headers },
      fetch: s
        ? authenticatedFetch(s, inst.id)
        : (url, init) => fetchHeaders(url, init, headerWait(init?.method, 10000)),
    });
  } else {
    if (!r.command) throw new ConnectError("failed", `${inst.id}: no command`);
    if (!Bun.which(r.command))
      throw new ConnectError(
        "failed",
        `${inst.id}: '${r.command}' is not installed (install Node for npx or uv for uvx)`,
      );
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
    let kind = failureKind(e);
    // On an HTTP transport, a root cause that is neither the SDK's nor the server's error is fetch failing to reach it.
    const root = causes(e).at(-1);
    if (kind === "failed" && r.transport === "http" && !(root instanceof SdkError || root instanceof ProtocolError))
      kind = "unreachable";
    const secrets = secretValues(inst, s);
    const tail = stderr.trim() && `; stderr: ${redact(stderr.trim(), secrets).slice(-500)}`;
    throw new ConnectError(kind, `${inst.id}: ${errorText(e, secrets)}${tail}`);
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

/** A source's tools as the session sees them: past its allowlist and the session's scope, under their full names. */
function offer(src: Source, tools: Tool[], allowed: ((alias: string, tool: string) => boolean) | undefined) {
  const offered = src.instance?.tools && new Set(src.instance.tools);
  return tools.flatMap(({ outputSchema: _, ...t }) => {
    if (offered && !offered.has(t.name)) return [];
    if (allowed && !allowed(src.alias, t.name)) return [];
    const name = toolName(src.alias, t.name);
    // No output schema: results pass through unchecked, so a client must not check them against one either.
    return [{ name, tool: t.name, listed: { ...t, name } }];
  });
}

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
    callError,
    allow,
    activity,
    signal,
    onCall,
  }: {
    onError?: (alias: string, e: unknown) => void;
    /** Finds a call's source without listing every source again. */
    resolveSource?: (alias: string) => Promise<Source | undefined>;
    /** What a failed call throws to the client instead of the source's error; the error passes through without it. */
    callError?: (alias: string, e: unknown) => Error;
    /** Whether the session may list and call a source's tool now: asked once per listing and once per call, and
     * answers for every tool of that listing or call. */
    allow?: () => (alias: string, tool: string) => boolean;
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
    const allowed = allow?.();
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
    for (const { src, tools } of pages)
      for (const t of offer(src, tools, allowed)) {
        if (next.has(t.name)) throw new Error(`duplicate MCP tool name ${t.name}`);
        next.set(t.name, { alias: src.alias, tool: t.tool });
        all.push(t.listed);
      }
    routes = next;
    return all.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Routes a call by its name's alias prefix, listing only that source. A remote endpoint builds a server per request,
   * so without this every call would connect and list every mapped server first. A hash-shortened name keeps its
   * alias, so it resolves here too; only an alias holding `__` falls through to the full listing.
   */
  async function routeOne(name: string) {
    const at = name.indexOf("__");
    if (!resolveSource || at <= 0) return;
    const alias = name.slice(0, at);
    try {
      const src = await resolveSource(alias);
      if (!src) return;
      const tools = await listAllTools(src.client, { fresh: !src.keepTools });
      const found = offer(src, tools, allow?.()).find((t) => t.name === name);
      if (found) routes.set(name, { alias, tool: found.tool });
    } catch (e) {
      throw callError ? callError(alias, e) : e;
    }
  }

  server.setRequestHandler("tools/list", async () => ({ tools: await list() }));
  server.setRequestHandler("tools/call", async (req, ctx) => {
    if (!routes.has(req.params.name)) await routeOne(req.params.name);
    if (!routes.has(req.params.name)) await list();
    // A kept list can miss a tool a server added without saying so; ask again once before giving up.
    if (!routes.has(req.params.name)) await list({ fresh: true });
    const route = routes.get(req.params.name);
    if (!route || (allow && !allow()(route.alias, route.tool)))
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
      throw callError ? callError(route.alias, e) : e;
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

/** One shared connection. A closed one leaves the map, and a changed config replaces it with a new entry. */
interface Upstream {
  state:
    | { kind: "connecting"; connecting: Promise<Client>; failures: number }
    | { kind: "connected"; client: Client }
    /** `failures` connects failed in a row; the next may be tried at `retryAt`. */
    | { kind: "backoff"; failures: number; retryAt: number }
    /** Replaced or idle; its client closes once its last call ends. */
    | { kind: "retired"; client?: Client };
  /** What the connection depends on (`connectionKey`). */
  config: string;
  lastUsed: number;
  calls: number;
}

/** The fields a connection depends on: a new label, tool filter or result limit keeps the connection. */
const connectionKey = (s: Store, inst: McpInstance) => {
  const { template, transport, url, headers, command, args, env } = resolve(inst);
  const loggedIn = !!s.get("mcpCredential", inst.id)?.tokens;
  return JSON.stringify({ template, transport, url, headers, command, args, env, loggedIn });
};

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
  /** The software factory's tools for a virtual project's endpoint that offers them, set by the daemon. */
  factoryTools?: (project: string) => Promise<Source>;
  /** A session's scope from the T3 Code thread its shim names, if any; set by the daemon. Without it, or without a
   * scope, a session uses every server its project maps. */
  scope?: (thread: string | undefined) => SessionScope | undefined;

  constructor(private s: Store) {
    this.timer.unref();
  }

  /** One connection per shared instance, opened on first use and reopened when its config changes. */
  async shared(inst: McpInstance): Promise<Client> {
    if (this.closed) throw new Error("MCP gateway is closed");
    const config = connectionKey(this.s, inst);
    let u = this.upstreams.get(inst.id);
    if (u && u.config !== config) {
      this.upstreams.delete(inst.id);
      await this.retire(u);
      u = undefined;
    }
    const now = this.s.now();
    if (u) u.lastUsed = now;
    if (u?.state.kind === "connected") return u.state.client;
    if (u?.state.kind === "connecting") return u.state.connecting;
    let failures = 0;
    if (u?.state.kind === "backoff") {
      // A Test that reached the server since (app or CLI) ends the wait.
      if (now < u.state.retryAt && !serverHealth(this.s, inst.id)?.ok)
        throw new Backoff(`${inst.id}: unavailable, next try in ${Math.ceil((u.state.retryAt - now) / 1000)} s`);
      failures = u.state.failures;
    }
    const connecting = connect(inst, undefined, this.s).then(
      async (c) => {
        if (this.closed || entry.state.kind !== "connecting" || this.upstreams.get(inst.id) !== entry) {
          await c.close();
          throw new Error("MCP configuration changed during connection");
        }
        entry.state = { kind: "connected", client: c };
        watchTools(c, () => this.toolsChanged(inst.id));
        // Listed while the session that asked for the connection is still starting, so its tools/list is ready.
        void listAllTools(c).catch(() => {});
        c.onclose = () => {
          if (entry.state.kind !== "connected" || entry.state.client !== c) return;
          entry.state = { kind: "retired" };
          if (this.upstreams.get(inst.id) === entry) this.upstreams.delete(inst.id);
        };
        return c;
      },
      (e) => {
        if (entry.state.kind === "connecting")
          entry.state = { kind: "backoff", failures: failures + 1, retryAt: this.s.now() + retryDelay(failures + 1) };
        throw e;
      },
    );
    const state = { kind: "connecting" as const, connecting, failures };
    const entry: Upstream = u ?? { config, lastUsed: now, calls: 0, state };
    entry.state = state;
    this.upstreams.set(inst.id, entry);
    return connecting;
  }

  /** Takes an upstream out of use; its client closes now, or when its last call ends. */
  private async retire(u: Upstream) {
    const client = "client" in u.state ? u.state.client : undefined;
    u.state = { kind: "retired", client };
    if (u.calls) this.retired.add(u);
    else await client?.close().catch(() => {});
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
          if (entry.state.kind === "retired" && !entry.calls) {
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
      onError: (alias, e) => this.s.log("mcp", alias, "", 0, 0, this.failure(project, alias, e)),
      resolveSource: async (alias) => {
        if (alias === BUILTIN_ALIAS && this.builtin) return this.builtinTools();
        return inScope(scope(), alias) ? this.source(project, alias) : undefined;
      },
      allow: () => {
        const now = scope();
        return (alias, tool) => inScope(now, alias, tool);
      },
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
   * transport per POST, shared instances plus the built-in skill tools, and the factory's tools when the project offers
   * them. Never reachable through an HTTP listener.
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
    // Read once per request, like the skills: a switch turned off stops the next request.
    const factory =
      this.s.get("project", project)?.factoryTools && this.factoryTools ? await this.factoryTools(project) : undefined;
    const builtins = [skills, ...(factory ? [factory] : [])];
    const builtin = (alias: string) => builtins.find((src) => src.alias === alias);
    const sources = async (): Promise<Source[]> => {
      const out = await Promise.all(
        Object.keys(aliasesFor(this.s, project))
          .filter((alias) => !builtin(alias))
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
      return [...out.filter(isTruthy), ...builtins];
    };
    // Instructions only matter to `initialize`; skip connecting every upstream twice for other requests.
    const instructions =
      (message as { method?: unknown })?.method === "initialize" ? mergeInstructions(await sources()) : "";
    const server = mergedServer(instructions, sources, {
      onError: (alias, e) => {
        failed.add(alias);
        this.s.log("mcp", alias, "", 0, 0, this.failure(project, alias, e));
      },
      resolveSource: async (alias) => builtin(alias) ?? this.source(project, alias),
      // The endpoint is public: a connect error carries the server's stderr and local details, and a server's own
      // error text is the server's to share. Both are logged here; the client learns only which server failed.
      callError: (alias, e) => {
        const connecting = e instanceof ConnectError || e instanceof Backoff;
        if (connecting) failed.add(alias);
        if (!(e instanceof Backoff))
          this.s.log(
            "mcp",
            alias,
            "",
            0,
            0,
            connecting ? `${project}: connect failed: ${e.message}` : this.failure(project, alias, e),
          );
        return new Error(`${alias} failed`);
      },
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
      for (const src of builtins) await src.client.close().catch(() => {});
    }
  }

  /** A source's error for the log: without an HTTP body, redacted with its server's values. */
  private failure(project: string, alias: string, e: unknown) {
    const inst = this.s.get("mcp", aliasesFor(this.s, project)[alias] ?? "");
    return `${project}: ${errorText(e, inst ? secretValues(inst, this.s) : [])}`;
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

  /**
   * A repo's first session creates its project, so the app can list it. Later sessions write nothing: every put raises
   * the synced revision, which would let a busy machine outrank another machine's offline edit.
   */
  private seen(project: string) {
    if (project === "*") return;
    project = canonicalProject(this.s, project);
    if (!this.s.get("project", project)) this.s.put("project", project, { id: project });
  }

  async closeIdle() {
    const tasks: Promise<unknown>[] = [];
    for (const [id, u] of this.upstreams)
      if (!u.calls && u.state.kind !== "connecting" && this.s.now() - u.lastUsed > IDLE_CLOSE) {
        this.upstreams.delete(id);
        tasks.push(this.retire(u));
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
      if (u.state.kind === "connecting") tasks.push(u.state.connecting.catch(() => {}));
      const client = "client" in u.state ? u.state.client : undefined;
      u.state = { kind: "retired" };
      if (client) tasks.push(client.close());
    }
    for (const { server } of this.sessions.values()) tasks.push(server.close());
    if (this.builtinSource) tasks.push(this.builtinSource.then((src) => src.client.close()));
    await Promise.allSettled(tasks);
    this.upstreams.clear();
    this.retired.clear();
    this.sessions.clear();
  }
}

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
      const r = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: path, stderr: "ignore", timeout: 5000 });
      if (r.exitCode === 0) remote = r.stdout.toString();
    }
    const repo = remote && parseRemote(remote);
    if (repo) out.push({ repo, path });
  }
  return out;
}
