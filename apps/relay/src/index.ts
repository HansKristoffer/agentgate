import { DurableObject } from "cloudflare:workers";
import { relayApp } from "./app.ts";
import { AdmissionCore, GroupCore, config, type GroupRequest, type Sql, type SqlValue } from "./group.ts";

export interface Env {
  GROUPS: DurableObjectNamespace<RelayGroup>;
  ADMISSION: DurableObjectNamespace<RelayAdmission>;
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

export class RelayAdmission extends DurableObject<Env> {
  private core: AdmissionCore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new AdmissionCore(doSql(ctx.storage), config(env));
  }
  reserve(groupId: string, ipHash: string) { return this.core.reserve(groupId, ipHash); }
  release(groupId: string) { return this.core.release(groupId); }
  count() { return this.core.count(); }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return relayApp({
      group: (id) => env.GROUPS.get(env.GROUPS.idFromName(id)),
      relayKey: env.RELAY_KEY || undefined,
      ipLimit: env.IP_LIMITER ? async (key) => (await env.IP_LIMITER!.limit({ key })).success : undefined,
    }).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
