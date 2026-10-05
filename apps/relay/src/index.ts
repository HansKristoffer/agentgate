import { DurableObject } from "cloudflare:workers";
import { relayApp } from "./app.ts";
import { AdmissionCore, GroupCore, config, type GroupRequest, type Sql, type SqlValue } from "./group.ts";
import { EndpointCore } from "./remote.ts";
import { ChannelCore, type ChannelSocket } from "./channel.ts";

export interface Env {
  GROUPS: DurableObjectNamespace<RelayGroup>;
  ADMISSION: DurableObjectNamespace<RelayAdmission>;
  ENDPOINTS: DurableObjectNamespace<RemoteEndpoint>;
  CHANNELS: DurableObjectNamespace<RelayChannel>;
  IP_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  RELAY_KEY?: string;
  [setting: string]: unknown;
}

function doSql(storage: DurableObjectStorage): Sql {
  return {
    all: <T>(query: string, ...params: SqlValue[]) => storage.sql.exec(query, ...params).toArray() as T[],
    run: (query, ...params) => { storage.sql.exec(query, ...params); },
    tx: (fn) => storage.transactionSync(fn),
  };
}

export class RelayGroup extends DurableObject<Env> {
  private core: GroupCore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const admission = () => env.ADMISSION.get(env.ADMISSION.idFromName("global"));
    this.core = new GroupCore(doSql(ctx.storage), {
      admission: { reserve: (id, ip) => admission().reserve(id, ip), release: (id) => admission().release(id) },
      config: config(env),
      setAlarm: (at) => ctx.storage.setAlarm(at),
      deleteAll: async () => { await ctx.storage.deleteAlarm(); await ctx.storage.deleteAll(); },
    });
  }
  handle(req: GroupRequest) { return this.core.handle(req); }
  override alarm() { return this.core.alarm(); }
}

const positive = (value: unknown, fallback: number) => Number(value) > 0 ? Number(value) : fallback;

export class RemoteEndpoint extends DurableObject<Env> {
  private core: EndpointCore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const admission = () => env.ADMISSION.get(env.ADMISSION.idFromName("global"));
    this.core = new EndpointCore(ctx, {
      config: config(env),
      admission: { reserve: (id, ip, limits) => admission().reserve(id, ip, limits), release: (id) => admission().release(id) },
      limits: {
        max: positive(env.RELAY_MAX_ENDPOINTS, 5000),
        perIpPerDay: positive(env.RELAY_ENDPOINTS_PER_IP_PER_DAY, 20),
        requestsPerMinute: positive(env.RELAY_ENDPOINT_REQUESTS_PER_MINUTE, 600),
      },
    });
  }
  override fetch(req: Request) { return this.core.fetch(req); }
  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) { this.core.webSocketMessage(ws, message); }
  override webSocketClose(ws: WebSocket) { this.core.webSocketClose(ws); }
  override webSocketError(ws: WebSocket) { this.core.webSocketError(ws); }
  override alarm() { return this.core.alarm(); }
}

interface ChannelAttachment { node: string; since: number }

/** A group's node channel: the sockets its members keep open, as hibernatable WebSockets tagged with the node. */
export class RelayChannel extends DurableObject<Env> {
  private core: ChannelCore;
  private groupId = "";
  private sockets = new WeakMap<WebSocket, ChannelSocket>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalives never wake a hibernated channel.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.core = new ChannelCore({
      sockets: () => ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN).map((ws) => this.wrap(ws)).filter((s): s is ChannelSocket => !!s),
      // Any authenticated read proves group membership; the answer is remembered in memory.
      checkAuth: async (authHash, ipHash) => {
        const group = env.GROUPS.get(env.GROUPS.idFromName(this.groupId));
        // The RPC stub types `Reply.body: unknown` as never; only the status is read.
        const reply = await group.handle({ op: "nodes", groupId: this.groupId, authHash, ipHash }) as unknown as { status: number };
        return reply.status === 200;
      },
      limits: {
        requestsPerMinute: positive(env.RELAY_CHANNEL_REQUESTS_PER_MINUTE, 1200),
        mibPerMinute: positive(env.RELAY_CHANNEL_MIB_PER_MINUTE, 256),
        failedAuthPerMinute: config(env).failedAuthPerMinute,
      },
    });
  }
  private wrap(ws: WebSocket): ChannelSocket | undefined {
    let s = this.sockets.get(ws);
    if (s) return s;
    const a = ws.deserializeAttachment() as ChannelAttachment | null;
    if (!a) return undefined;
    s = { node: a.node, since: a.since, send: (text) => ws.send(text), close: (code, reason) => ws.close(code, reason) };
    this.sockets.set(ws, s);
    return s;
  }
  override async fetch(req: Request): Promise<Response> {
    this.groupId = req.headers.get("x-agentgate-group") ?? "";
    const node = req.headers.get("x-agentgate-node") ?? "";
    const refused = await this.core.authorize(req.headers.get("x-agentgate-auth") ?? "", req.headers.get("x-agentgate-ip") ?? "");
    if (refused) return refused;
    if (req.headers.get("x-agentgate-op") === "call") return this.core.call(req, node);
    if (req.headers.get("upgrade") !== "websocket") return Response.json({ error: "expected a WebSocket upgrade" }, { status: 426 });
    const bad = this.core.connect(node);
    if (bad) return bad;
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [node]);
    server.serializeAttachment({ node, since: Date.now() } satisfies ChannelAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }
  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const s = this.wrap(ws);
    if (!s || typeof message !== "string" || !this.core.message(s, message)) ws.close(1008, "invalid frame");
  }
  override webSocketClose(ws: WebSocket) { const s = this.wrap(ws); if (s) this.core.closed(s); }
  override webSocketError(ws: WebSocket) { const s = this.wrap(ws); if (s) this.core.closed(s); }
}

export class RelayAdmission extends DurableObject<Env> {
  private core: AdmissionCore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new AdmissionCore(doSql(ctx.storage), config(env));
  }
  reserve(groupId: string, ipHash: string, limits?: { max: number; perIpPerDay: number }) { return this.core.reserve(groupId, ipHash, limits); }
  release(groupId: string) { return this.core.release(groupId); }
  count() { return this.core.count(); }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return relayApp({
      group: (id) => env.GROUPS.get(env.GROUPS.idFromName(id)),
      endpoint: (key) => env.ENDPOINTS.getByName(key),
      channel: (groupId) => env.CHANNELS.getByName(groupId),
      relayKey: env.RELAY_KEY || undefined,
      ipLimit: env.IP_LIMITER ? async (key) => (await env.IP_LIMITER!.limit({ key })).success : undefined,
    }).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
