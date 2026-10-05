import { Database } from "bun:sqlite";
import { relayApp } from "../src/app.ts";
import { AdmissionCore, GroupCore, defaults, type Config, type Sql } from "../src/group.ts";
import { ChannelCore, type ChannelSocket } from "../src/channel.ts";

/** The same SQL on bun:sqlite, so the relay can run in-process in Bun tests. */
export function memorySql(db = new Database(":memory:")): Sql & { db: Database } {
  return {
    db,
    all: <T>(query: string, ...params: (string | number | null)[]) => db.query(query).all(...params) as T[],
    run: (query, ...params) => { db.query(query).run(...params); },
    tx: (fn) => db.transaction(fn)(),
  };
}

/** An in-process relay: one GroupCore per group, alarms recorded instead of scheduled. */
export function memoryRelay(overrides: Partial<Config> & { relayKey?: string; now?: () => number } = {}) {
  const cfg = { ...defaults, ...overrides };
  const now = overrides.now ?? Date.now;
  const admission = new AdmissionCore(memorySql(), cfg, now);
  const groups = new Map<string, { core: GroupCore; sql: ReturnType<typeof memorySql>; alarm?: number }>();
  const group = (id: string) => {
    let g = groups.get(id);
    if (!g) {
      const sql = memorySql();
      const entry: { core: GroupCore; sql: ReturnType<typeof memorySql>; alarm?: number } = { sql } as never;
      entry.core = new GroupCore(sql, {
        admission, config: cfg, now,
        setAlarm: (at) => { entry.alarm = at; },
        // Storage recreation: drop every table, as deleteAll() does in a Durable Object.
        deleteAll: () => {
          for (const { name } of sql.db.query("select name from sqlite_master where type = 'table'").all() as { name: string }[]) sql.db.run(`drop table "${name}"`);
          entry.alarm = undefined;
        },
      });
      groups.set(id, g = entry);
    }
    return g.core;
  };
  // Node channels: the same core as the Durable Object, with sockets kept in a set.
  const channels = new Map<string, { core: ChannelCore; sockets: Set<ChannelSocket> }>();
  const channelOf = (groupId: string) => {
    let c = channels.get(groupId);
    if (!c) {
      const sockets = new Set<ChannelSocket>();
      const core = new ChannelCore({
        sockets: () => [...sockets],
        checkAuth: async (authHash, ipHash) => (await group(groupId).handle({ op: "nodes", groupId, authHash, ipHash })).status === 200,
        limits: { requestsPerMinute: 100_000, mibPerMinute: 100_000, failedAuthPerMinute: cfg.failedAuthPerMinute },
        now,
      });
      channels.set(groupId, c = { core, sockets });
    }
    return c;
  };
  const channel = (groupId: string) => ({
    async fetch(req: Request) {
      const c = channelOf(groupId);
      const refused = await c.core.authorize(req.headers.get("x-agentgate-auth") ?? "", req.headers.get("x-agentgate-ip") ?? "");
      if (refused) return refused;
      if (req.headers.get("x-agentgate-op") === "call") return c.core.call(req, req.headers.get("x-agentgate-node") ?? "");
      // A connect that passed the checks: serve() performs the upgrade.
      return c.core.connect(req.headers.get("x-agentgate-node") ?? "") ?? new Response(null, { status: 204, headers: { "x-agentgate-upgrade": "1" } });
    },
  });
  const app = relayApp({ group, channel, relayKey: overrides.relayKey });
  const fetch = (input: string, init?: RequestInit) => app.fetch(new Request(input, init));
  return { app, fetch, groups, admission, config: cfg, channels, channelOf };
}

type Data = { groupId: string; node: string; socket?: ChannelSocket };
/** The in-process relay over real HTTP and WebSockets. `before` may answer a request itself (to fail it on purpose). */
export function serveRelay(r: ReturnType<typeof memoryRelay>, before?: (req: Request) => Response | undefined | Promise<Response | undefined>) {
  return Bun.serve<Data>({
    port: 0, idleTimeout: 0,
    async fetch(req, server) {
      const early = await before?.(req);
      if (early) return early;
      const res = await r.app.fetch(req);
      const m = new URL(req.url).pathname.match(/^\/g\/([0-9a-f]{32})\/n\/([^/]+)\/connect$/);
      if (m && res.headers.get("x-agentgate-upgrade")) {
        const ok = server.upgrade(req, { data: { groupId: m[1]!, node: decodeURIComponent(m[2]!) } });
        return ok ? undefined : new Response("upgrade failed", { status: 400 });
      }
      return res;
    },
    websocket: {
      open(ws) {
        const socket: ChannelSocket = { node: ws.data.node, since: Date.now(), send: (text) => { ws.send(text); }, close: (code, reason) => ws.close(code, reason) };
        ws.data.socket = socket;
        r.channelOf(ws.data.groupId).sockets.add(socket);
      },
      message(ws, message) {
        if (message === "ping") return void ws.send("pong");
        if (!r.channelOf(ws.data.groupId).core.message(ws.data.socket!, String(message))) ws.close(1008, "invalid frame");
      },
      close(ws) {
        const c = r.channelOf(ws.data.groupId);
        c.sockets.delete(ws.data.socket!);
        c.core.closed(ws.data.socket!);
      },
    },
  });
}
