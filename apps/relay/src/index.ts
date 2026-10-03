import { DurableObject } from "cloudflare:workers";
import { relayApp } from "./app.ts";
import { AdmissionCore, GroupCore, config, type GroupRequest, type Sql, type SqlValue } from "./group.ts";
import { EndpointCore } from "./remote.ts";

export interface Env {
  GROUPS: DurableObjectNamespace<RelayGroup>;
  ADMISSION: DurableObjectNamespace<RelayAdmission>;
  ENDPOINTS: DurableObjectNamespace<RemoteEndpoint>;
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
      relayKey: env.RELAY_KEY || undefined,
      ipLimit: env.IP_LIMITER ? async (key) => (await env.IP_LIMITER!.limit({ key })).success : undefined,
    }).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
