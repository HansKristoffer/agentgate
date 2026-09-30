import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const CONFIG_DIR = process.env.AGENTGATE_HOME ?? join(homedir(), ".config", "agentgate");
export const PORT = Number(process.env.AGENTGATE_PORT ?? 7878);
export const LOCAL_URL = `http://127.0.0.1:${PORT}`;

const Window = z.object({ name: z.string(), usedPct: z.number(), resetsAt: z.number().optional() });

export const schemas = {
  account: z.object({
    id: z.string(),
    provider: z.enum(["claude", "codex"]),
    label: z.string(),
    email: z.string().optional(),
    plan: z.string().optional(),
    enabled: z.boolean().default(true),
    priority: z.number().default(0),
    pinned: z.boolean().optional(),
  }),
  credential: z.object({
    accountId: z.string(),
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresAt: z.number(),
    accountUuid: z.string().optional(),
    chatgptAccountId: z.string().optional(),
    holder: z.string(),
    needsLogin: z.boolean().optional(),
  }),
  usage: z.object({
    accountId: z.string(),
    observedAt: z.number(),
    observedBy: z.string(),
    windows: z.array(Window),
    status: z.enum(["ok", "limited", "exhausted"]),
    exhaustedUntil: z.number().optional(),
  }),
  mcp: z.object({
    id: z.string(),
    template: z.string(),
    transport: z.enum(["http", "stdio"]),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    secrets: z.record(z.string(), z.string()).default({}),
    fields: z.record(z.string(), z.string()).default({}),
    mode: z.enum(["shared", "perSession"]).default("shared"),
    /** MCP OAuth state from the SDK (client registration and tokens), set once a login was started. */
    oauth: z.object({ redirectUri: z.string().optional(), client: z.any().optional(), tokens: z.any().optional() }).optional(),
  }),
  project: z.object({
    id: z.string(),
    mcp: z.record(z.string(), z.string()).default({}),
    inheritDefaults: z.boolean().default(true),
    seenAt: z.number().optional(),
    seenOn: z.string().optional(),
  }),
  node: z.object({ id: z.string(), url: z.string().optional(), alwaysOn: z.boolean().default(false) }),
  setting: z.object({
    threshold: z.number().default(98),
    whenExhausted: z.enum(["fail", "wait"]).default("fail"),
    retryLimit: z.number().default(3),
    logRetention: z.number().default(5000),
  }),
};

export type Kind = keyof typeof schemas;
export type Data<K extends Kind> = z.infer<(typeof schemas)[K]>;
export type Account = Data<"account">;
export type Credential = Data<"credential">;
export type Usage = Data<"usage">;
export type McpInstance = Data<"mcp">;
export type Project = Data<"project">;
export type Settings = Data<"setting">;

export interface Rec {
  kind: Kind;
  id: string;
  rev: number;
  node: string;
  updated_at: number;
  deleted: number;
  data: string;
  seq?: number;
}

const TOMBSTONE_TTL = 30 * 24 * 3600_000;

export class Store {
  db: Database;
  /** Overridable clock, so tests can fake time. */
  now = () => Date.now();

  constructor(path = join(CONFIG_DIR, "agentgate.db")) {
    if (path !== ":memory:") {
      const dir = path.slice(0, path.lastIndexOf("/"));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    this.db = new Database(path, { create: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.run("pragma journal_mode = wal");
    this.db.run("pragma busy_timeout = 5000");
    this.db.run(`create table if not exists records (
      kind text not null, id text not null, rev integer not null, node text not null,
      updated_at integer not null, deleted integer not null default 0, data text not null,
      seq integer not null, primary key (kind, id))`);
    this.db.run("create index if not exists records_seq on records(seq)");
    this.db.run("create table if not exists local_seq (value integer not null)");
    if (!this.db.query("select 1 from local_seq").get()) this.db.run("insert into local_seq values (0)");
    this.db.run("create table if not exists peers (node text primary key, url text, token text, cursor integer default 0, last_seen integer)");
    this.db.run("create table if not exists request_log (at integer, provider text, account text, model text, status integer, ms integer, note text)");
    // Node-local settings that are never synced (node name, admin token, pairing code, active account).
    this.db.run("create table if not exists local (key text primary key, value text)");
  }

  get nodeId(): string {
    return this.local("node") ?? "unnamed";
  }

  local(key: string): string | undefined {
    return (this.db.query("select value from local where key = ?").get(key) as { value: string } | null)?.value;
  }

  setLocal(key: string, value: string | undefined) {
    if (value === undefined) this.db.run("delete from local where key = ?", [key]);
    else this.db.run("insert or replace into local values (?, ?)", [key, value]);
  }

  seq(): number {
    return (this.db.query("select value from local_seq").get() as { value: number }).value;
  }

  private nextSeq(): number {
    return (this.db.query("update local_seq set value = value + 1 returning value").get() as { value: number }).value;
  }

  record(kind: Kind, id: string): Rec | undefined {
    return (this.db.query("select * from records where kind = ? and id = ?").get(kind, id) as Rec | null) ?? undefined;
  }

  get<K extends Kind>(kind: K, id: string): Data<K> | undefined {
    const r = this.record(kind, id);
    return r && !r.deleted ? (schemas[kind].parse(JSON.parse(r.data)) as Data<K>) : undefined;
  }

  list<K extends Kind>(kind: K): Data<K>[] {
    const rows = this.db.query("select data from records where kind = ? and deleted = 0 order by id").all(kind) as { data: string }[];
    return rows.map((r) => schemas[kind].parse(JSON.parse(r.data)) as Data<K>);
  }

  put<K extends Kind>(kind: K, id: string, data: z.input<(typeof schemas)[K]>): Data<K> {
    const parsed = schemas[kind].parse(data) as Data<K>;
    this.write(kind, id, JSON.stringify(parsed), 0);
    return parsed;
  }

  del(kind: Kind, id: string) {
    if (this.record(kind, id)) this.write(kind, id, "{}", 1);
  }

  private write(kind: Kind, id: string, data: string, deleted: number) {
    this.db.transaction(() => {
      const prev = this.record(kind, id);
      this.db.run("insert or replace into records values (?, ?, ?, ?, ?, ?, ?, ?)", [
        kind, id, (prev?.rev ?? 0) + 1, this.nodeId, this.now(), deleted, data, this.nextSeq(),
      ]);
    })();
  }

  settings(): Settings {
    return this.get("setting", "settings") ?? schemas.setting.parse({});
  }

  /** Change feed for peers: every record (secrets and tombstones included) newer than `since`. */
  changes(since: number): { records: Rec[]; seq: number } {
    const records = this.db.query("select * from records where seq > ? order by seq").all(since) as Rec[];
    return { records, seq: this.seq() };
  }

  /** Last-writer-wins by (rev, updated_at, node). Returns true when the incoming record was taken. */
  merge(r: Rec): boolean {
    if (!(r.kind in schemas)) return false;
    return this.db.transaction(() => {
      const cur = this.record(r.kind, r.id);
      if (cur && !newer(r, cur)) return false;
      this.db.run("insert or replace into records values (?, ?, ?, ?, ?, ?, ?, ?)", [
        r.kind, r.id, r.rev, r.node, r.updated_at, r.deleted, r.data, this.nextSeq(),
      ]);
      return true;
    })();
  }

  purgeTombstones() {
    this.db.run("delete from records where deleted = 1 and updated_at < ?", [this.now() - TOMBSTONE_TTL]);
  }

  log(provider: string, account: string, model: string, status: number, ms: number, note = "") {
    this.db.run("insert into request_log values (?, ?, ?, ?, ?, ?, ?)", [this.now(), provider, account, model, status, ms, note]);
  }

  trimLog() {
    this.db.run("delete from request_log where rowid <= (select max(rowid) from request_log) - ?", [this.settings().logRetention]);
  }
}

function newer(a: Rec, b: Rec): boolean {
  if (a.rev !== b.rev) return a.rev > b.rev;
  if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at;
  return a.node > b.node;
}

/** Secrets shown in API responses and the UI. */
export const mask = (s?: string) => (s ? `••••${s.slice(-4)}` : "");

let shared: Store | undefined;
export const store = () => (shared ??= new Store());

/** `agentgate export`: every live record. Without secrets it drops credentials and masks MCP secrets. */
export function exportBackup(s: Store, secrets = true) {
  const rows = s.db.query("select kind, id, data from records where deleted = 0 order by kind, id").all() as { kind: Kind; id: string; data: string }[];
  const records = rows
    .filter((r) => secrets || r.kind !== "credential")
    .map((r) => {
      const data = JSON.parse(r.data);
      if (!secrets && r.kind === "mcp") data.secrets = Object.fromEntries(Object.keys(data.secrets ?? {}).map((k) => [k, ""]));
      return { kind: r.kind, id: r.id, data };
    });
  return { agentgate: 1, exportedAt: new Date(s.now()).toISOString(), from: s.nodeId, records };
}

export function importBackup(s: Store, backup: { records: { kind: Kind; id: string; data: unknown }[] }) {
  let n = 0;
  for (const r of backup.records) {
    if (!(r.kind in schemas)) continue;
    s.put(r.kind, r.id, r.data as any);
    n++;
  }
  return n;
}
