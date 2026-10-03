import { Database } from "bun:sqlite";
import { relayApp } from "../src/app.ts";
import { AdmissionCore, GroupCore, defaults, type Config, type Sql } from "../src/group.ts";

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
  const app = relayApp({ group, relayKey: overrides.relayKey });
  const fetch = (input: string, init?: RequestInit) => app.fetch(new Request(input, init));
  return { app, fetch, groups, admission, config: cfg };
}
