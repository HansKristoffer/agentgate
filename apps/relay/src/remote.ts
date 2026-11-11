import { REMOTE_LIMITS, endpointUpdate, remoteResponseFrame, sha256Hex } from "@agentgate/protocol/remote";
import { safeEqual } from "hanzio/crypto";
import { relayNode } from "@agentgate/protocol/relay";
import type { EndpointOp } from "./app.ts";
import { readBounded } from "./body.ts";
import { Window, type Config } from "./group.ts";

/**
 * One remote endpoint: a public POST URL forwarded over the one hibernatable WebSocket its serving node keeps open.
 * An `mcp` endpoint (a virtual project, for clients like Grok) is served at `/mcp/:key` behind a bearer secret; a
 * `hook` endpoint receives webhooks at `/hook/:key` with no secret, and the node checks the sender's signature.
 * Unlike groups, the relay reads this traffic in the clear.
 */

export interface EndpointDeps {
  config: Config;
  admission: {
    reserve(
      id: string,
      ipHash: string,
      limits: { max: number; perIpPerDay: number },
    ): Promise<{ status: number; body: unknown; retryAfter?: number } | undefined>;
    release(id: string): Promise<void>;
  };
  limits: { max: number; perIpPerDay: number; requestsPerMinute: number };
}

interface Meta {
  key: string;
  tokenHash: string;
  secretHash: string;
  enabled: number;
  lastActive: number;
  admitted: number;
  /** Absent on endpoints created before webhooks, which are all MCP endpoints. */
  kind?: Kind;
}
type Kind = "mcp" | "hook";
type Fail = (status: number, message: string, headers?: Record<string, string>) => Response;
interface Pending {
  ws: WebSocket;
  resolve: (r: Response) => void;
  timer: ReturnType<typeof setTimeout>;
  fail: Fail;
}
interface Attachment {
  node: string;
  since: number;
}

const PENDING_MS = 10 * 60_000;
const SOCKET_MESSAGES_PER_MINUTE = 1200;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
const rpcError: Fail = (status, message, headers = {}) =>
  json(status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null }, headers);
const hookError: Fail = (status, message, headers = {}) => json(status, { error: message }, headers);
const bearer = (req: Request) => req.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];

export class EndpointCore {
  private pending = new Map<string, Pending>();
  private requests = new Window();
  private failures = new Window();
  private socketRates = new WeakMap<WebSocket, Window>();

  constructor(
    private ctx: DurableObjectState,
    private deps: EndpointDeps,
  ) {
    // Keepalives never wake a hibernated endpoint.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  private meta(): Meta | undefined {
    if (!this.sql.exec("select 1 from sqlite_master where type = 'table' and name = 'meta'").toArray().length)
      return undefined;
    const row = this.sql.exec("select * from meta").toArray()[0] as unknown as Meta | undefined;
    return row;
  }

  /** Only when the node changes the endpoint. Endpoints created before webhook URLs have no `kind`, which reads as
   * "mcp", so their table gets the column here. */
  private save(m: Meta) {
    this.sql.exec(
      "create table if not exists meta (key text, tokenHash text, secretHash text, enabled integer, lastActive integer, admitted integer, kind text)",
    );
    const columns = this.sql.exec("select name from pragma_table_info('meta')").toArray();
    if (!columns.some((c) => c.name === "kind")) this.sql.exec("alter table meta add column kind text");
    this.sql.exec("delete from meta");
    this.sql.exec(
      "insert into meta values (?, ?, ?, ?, ?, ?, ?)",
      m.key,
      m.tokenHash,
      m.secretHash,
      m.enabled,
      m.lastActive,
      m.admitted,
      m.kind ?? "mcp",
    );
  }

  /** On the request path: one column of the one row. */
  private touch(now: number) {
    this.sql.exec("update meta set lastActive = ?", now);
  }

  /** The newest open socket. Older ones are closed on connect, so a late close never affects the current one. */
  private socket(): WebSocket | undefined {
    let best: WebSocket | undefined,
      since = -1;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (ws.readyState === WebSocket.OPEN && a && a.since > since) {
        best = ws;
        since = a.since;
      }
    }
    return best;
  }

  async fetch(req: Request): Promise<Response> {
    const op = req.headers.get("x-agentgate-op") as EndpointOp;
    const key = req.headers.get("x-agentgate-key")!;
    const ipHash = req.headers.get("x-agentgate-ip") ?? "";
    if (op === "mcp") return this.mcp(req);
    if (op === "hook") return this.hook(req);
    // Node operations: the token is checked against the stored hash; the first PUT stores it.
    const token = bearer(req);
    if (!token) return json(401, { error: "unauthorized" });
    const tokenHash = await sha256Hex(token);
    if (op === "update") return this.update(req, key, tokenHash, ipHash);
    const m = this.meta();
    if (!m?.admitted) return json(404, { error: "no such endpoint" });
    if (!safeEqual(m.tokenHash, tokenHash)) return this.unauthorized(json(401, { error: "unauthorized" }));
    if (op === "delete") {
      await this.destroy(m.key);
      return json(200, { ok: true });
    }
    if (op === "connect") return this.connect(req);
    return json(400, { error: "unknown operation" });
  }

  private unauthorized(res: Response): Response {
    const limited = this.failures.hit(this.deps.config.failedAuthPerMinute, Date.now());
    return limited ? json(429, { error: "too many failed attempts" }, { "retry-after": String(limited) }) : res;
  }

  private async update(req: Request, key: string, tokenHash: string, ipHash: string): Promise<Response> {
    const bytes = await readBounded(req, 4096);
    let body: unknown;
    try {
      body = JSON.parse(bytes ? new TextDecoder().decode(bytes) : "");
    } catch {
      return json(400, { error: "invalid JSON" });
    }
    const parsed = endpointUpdate.safeParse(body);
    if (!parsed.success) return json(400, { error: "invalid endpoint update" });
    // Serialized: the admission call below awaits another object.
    return this.ctx.blockConcurrencyWhile(async () => {
      const m = this.meta(),
        now = Date.now();
      if (m?.admitted && !safeEqual(m.tokenHash, tokenHash))
        return this.unauthorized(json(401, { error: "unauthorized" }));
      // A published URL keeps its kind: a node that omits it must not turn a webhook URL into an MCP endpoint.
      if (m?.admitted && (m.kind ?? "mcp") !== parsed.data.kind)
        return json(409, {
          error: `this endpoint is a ${m.kind ?? "mcp"} endpoint; create a new URL to change its kind`,
        });
      if (!m?.admitted) {
        // Record, then reserve: the alarm deletes a create that stopped between the two.
        await this.ctx.storage.setAlarm(now + PENDING_MS);
        this.save({
          key,
          tokenHash,
          secretHash: parsed.data.secretHash,
          enabled: parsed.data.enabled ? 1 : 0,
          lastActive: now,
          admitted: 0,
          kind: parsed.data.kind,
        });
        const refused = await this.deps.admission.reserve(`e:${key}`, ipHash, this.deps.limits);
        if (refused) {
          await this.ctx.storage.deleteAll();
          return json(
            refused.status,
            refused.body,
            refused.retryAfter ? { "retry-after": String(refused.retryAfter) } : {},
          );
        }
      }
      this.save({
        key,
        tokenHash,
        secretHash: parsed.data.secretHash,
        enabled: parsed.data.enabled ? 1 : 0,
        lastActive: now,
        admitted: 1,
        kind: parsed.data.kind,
      });
      await this.ctx.storage.setAlarm(now + this.deps.config.retentionMs);
      return json(200, { ok: true });
    });
  }

  private connect(req: Request): Response {
    if (req.headers.get("upgrade") !== "websocket") return json(426, { error: "expected a WebSocket upgrade" });
    const node = relayNode.safeParse(req.headers.get("x-agentgate-node"));
    if (!node.success) return json(400, { error: "invalid node" });
    for (const ws of this.ctx.getWebSockets()) ws.close(4000, "replaced by a newer connection");
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ node: node.data, since: Date.now() } satisfies Attachment);
    this.touch(Date.now());
    return new Response(null, { status: 101, webSocket: client });
  }

  /** A public request reaches only an endpoint of its own kind: a hook URL never opens an MCP endpoint without its secret. */
  private admit(kind: Kind, fail: Fail): Meta | Response {
    const m = this.meta();
    if (!m?.admitted || (m.kind ?? "mcp") !== kind) return fail(404, "no such endpoint");
    const limited = this.requests.hit(this.deps.limits.requestsPerMinute, Date.now());
    if (limited) return fail(429, "too many requests", { "retry-after": String(limited) });
    return m;
  }

  /** The socket to forward on. Checked before the body is read. */
  private open(m: Meta, fail: Fail): WebSocket | Response {
    if (!m.enabled) return fail(403, "this endpoint is disabled");
    const ws = this.socket();
    if (!ws) return fail(503, "the machine serving this endpoint is offline", { "retry-after": "30" });
    if ([...this.pending.values()].filter((p) => p.ws === ws).length >= REMOTE_LIMITS.inFlight)
      return fail(503, "too many requests in flight", { "retry-after": "1" });
    return ws;
  }

  private async mcp(req: Request): Promise<Response> {
    const m = this.admit("mcp", rpcError);
    if (m instanceof Response) return m;
    // Authenticate before reading the body.
    const secret = bearer(req);
    if (!secret || !safeEqual(m.secretHash, await sha256Hex(secret)))
      return this.unauthorized(rpcError(401, "unauthorized"));
    const ws = this.open(m, rpcError);
    if (ws instanceof Response) return ws;
    const bytes = await readBounded(req, REMOTE_LIMITS.requestBytes);
    if (!bytes) return rpcError(413, "request too large");
    const body = new TextDecoder().decode(bytes);
    if (body.trimStart().startsWith("[")) return rpcError(400, "JSON-RPC batches are not supported");
    const headers: Record<string, string> = {};
    const version = req.headers.get("mcp-protocol-version");
    if (version) headers["mcp-protocol-version"] = version.slice(0, 64);
    return this.forward(req, ws, rpcError, { headers, body });
  }

  /** A webhook delivery: no secret here, because the node checks the sender's signature over the exact body and headers. */
  private async hook(req: Request): Promise<Response> {
    const m = this.admit("hook", hookError);
    if (m instanceof Response) return m;
    const ws = this.open(m, hookError);
    if (ws instanceof Response) return ws;
    // The Worker already dropped cookies and hop-by-hop headers; x-agentgate-* are its own.
    const headers: Record<string, string> = {};
    for (const [name, value] of req.headers) {
      if (name.startsWith("x-agentgate-")) continue;
      if (Math.max(name.length, value.length) > REMOTE_LIMITS.fieldChars)
        return hookError(431, "a request header is too large");
      headers[name] = value;
    }

    const query = new URL(req.url).search.slice(1);
    if (query.length > REMOTE_LIMITS.fieldChars) return hookError(414, "the query string is too long");

    const bytes = await readBounded(req, REMOTE_LIMITS.hookRequestBytes);
    if (!bytes) return hookError(413, "request too large");
    let body: string;
    try {
      // A signature covers the exact bytes, so a byte-order mark is kept and anything but UTF-8 is refused.
      body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return hookError(415, "the body must be UTF-8 text");
    }
    return this.forward(req, ws, hookError, { headers, body, ...(query && { query }) });
  }

  private forward(
    req: Request,
    ws: WebSocket,
    fail: Fail,
    frame: { headers: Record<string, string>; body: string; query?: string },
  ): Promise<Response> {
    const now = Date.now();
    const id = crypto.randomUUID();
    const response = new Promise<Response>((resolve) => {
      // No replay after a timeout or a dropped socket: the node may already have run a tool call.
      const timer = setTimeout(
        () => this.settle(id, fail(504, "the serving machine did not answer in time")),
        REMOTE_LIMITS.timeoutMs,
      );
      this.pending.set(id, { ws, resolve, timer, fail });
    });
    req.signal?.addEventListener("abort", () => {
      if (!this.pending.has(id)) return;
      try {
        ws.send(JSON.stringify({ t: "cancel", id }));
      } catch {
        /* socket already gone */
      }
      this.settle(id, fail(499, "client closed the request"));
    });
    try {
      ws.send(JSON.stringify({ t: "req", id, ...frame }));
    } catch {
      this.settle(id, fail(502, "the serving machine disconnected"));
    }
    this.touch(now);
    return response;
  }

  private settle(id: string, res: Response) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(res);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    let rate = this.socketRates.get(ws);
    if (!rate) this.socketRates.set(ws, (rate = new Window()));
    if (rate.hit(SOCKET_MESSAGES_PER_MINUTE, Date.now())) return ws.close(1008, "too many messages");
    if (typeof message !== "string" || message.length > REMOTE_LIMITS.frameBytes)
      return ws.close(1009, "frame too large");
    let frame;
    try {
      frame = remoteResponseFrame.parse(JSON.parse(message));
    } catch {
      return ws.close(1008, "invalid frame");
    }
    const p = this.pending.get(frame.id);
    if (!p || p.ws !== ws) return; // late, cancelled, or sent on another socket
    const headers: Record<string, string> = { "cache-control": "no-store" };
    if (frame.headers["content-type"]) headers["content-type"] = frame.headers["content-type"];
    if (frame.retry) headers["retry-after"] = "1";
    this.settle(frame.id, new Response(frame.body || null, { status: frame.status, headers }));
  }

  webSocketClose(ws: WebSocket) {
    this.failSocket(ws);
  }
  webSocketError(ws: WebSocket) {
    this.failSocket(ws);
  }

  private failSocket(ws: WebSocket) {
    for (const [id, p] of this.pending)
      if (p.ws === ws) this.settle(id, p.fail(502, "the serving machine disconnected"));
  }

  /** Retention counts from the last request or connection; a connected node keeps its endpoint alive. */
  async alarm() {
    const m = this.meta(),
      now = Date.now();
    if (!m) return;
    if (!m.admitted) return this.destroy(m.key);
    if (this.socket()) {
      this.touch(now);
      return void (await this.ctx.storage.setAlarm(now + this.deps.config.retentionMs));
    }
    const due = m.lastActive + this.deps.config.retentionMs;
    if (now >= due) return this.destroy(m.key);
    await this.ctx.storage.setAlarm(due);
  }

  private async destroy(key: string) {
    for (const ws of this.ctx.getWebSockets()) ws.close(4001, "endpoint deleted");
    for (const [id, p] of this.pending) this.settle(id, p.fail(404, "no such endpoint"));
    await this.deps.admission.release(`e:${key}`);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
