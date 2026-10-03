import { accountSchema, projectSchema, nodeSchema, settingsSchema, skillSchema, quotaWindowSchema, MAX_RECORD } from "@agentgate/protocol";
export { SKILL_ID, safePath } from "@agentgate/protocol";
import { OAuthClientInformationSchema, OAuthTokensSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const CONFIG_DIR = process.env.AGENTGATE_HOME ?? join(homedir(), ".config", "agentgate");
export const PORT = Number(process.env.AGENTGATE_PORT ?? 7878);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("AGENTGATE_PORT must be an integer between 1 and 65535");
export const LOCAL_URL = `http://127.0.0.1:${PORT}`;

const id = z.string().min(1).max(512);
const timestamp = z.number().int().nonnegative();
const Window = quotaWindowSchema;
const OAuth = z.object({ redirectUri: z.string().optional(), client: OAuthClientInformationSchema.passthrough().optional(), tokens: OAuthTokensSchema.passthrough().optional() });

export const schemas = {
  account: accountSchema,
  credential: z.object({
    accountId: z.string(),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresAt: timestamp,
    accountUuid: z.string().optional(),
    chatgptAccountId: z.string().optional(),
    holder: z.string(),
    needsLogin: z.boolean().optional(),
  }),
  mcpCredential: OAuth.extend({
    instanceId: id, holder: id, expiresAt: timestamp.optional(), needsLogin: z.boolean().optional(), loginId: id.optional(),
  }),
  refreshRequest: z.object({
    targetKind: z.enum(["credential", "mcpCredential"]), targetId: id, tokenHash: id, requestedAt: timestamp,
  }),
  usage: z.object({
    accountId: z.string(),
    observedAt: timestamp,
    observedBy: z.string(),
    windows: z.array(Window),
    status: z.enum(["ok", "limited", "exhausted"]),
    exhaustedUntil: timestamp.optional(),
    source: z.enum(["headers", "poll", "manual"]).optional(),
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
    oauth: OAuth.optional(), // accepted only to migrate pre-v1 databases/backups
  }),
  skill: skillSchema,
  project: projectSchema,
  node: nodeSchema,
  setting: settingsSchema,
};

export type Kind = keyof typeof schemas;
export type Data<K extends Kind> = z.infer<(typeof schemas)[K]>;
export type Account = Data<"account">;
export type Credential = Data<"credential">;
export type Usage = Data<"usage">;
export type McpInstance = Data<"mcp">;
export type Project = Data<"project">;
export type Settings = Data<"setting">;
export type McpCredential = Data<"mcpCredential">;
export type Skill = Data<"skill">;

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

export const recordSchema = z.object({
  kind: z.enum(Object.keys(schemas) as [Kind, ...Kind[]]), id,
  rev: z.number().int().nonnegative(), node: id, updated_at: timestamp,
  deleted: z.union([z.literal(0), z.literal(1)]), data: z.string().max(MAX_RECORD), seq: timestamp.optional(),
});

export function parseData<K extends Kind>(kind: K, key: string, input: unknown): Data<K> {
  id.parse(key);
  const parsed = schemas[kind].parse(input) as Data<K>;
  const value = parsed as Record<string, unknown>;
  const payloadId = value.id ?? value.accountId ?? value.instanceId;
  if (payloadId !== undefined && payloadId !== key) throw new Error(`${kind}: record ID does not match its data`);
  if (kind === "setting" && key !== "settings") throw new Error("invalid settings ID");
  if (kind === "refreshRequest" && key !== `${value.targetKind}:${value.targetId}`) throw new Error("invalid refresh request ID");
  return parsed;
}

export function parseRecord(input: unknown): Rec {
  const r = recordSchema.parse(input);
  if (Buffer.byteLength(r.data) > MAX_RECORD) throw new Error("record exceeds 4 MiB");
  if (!r.deleted) r.data = JSON.stringify(parseData(r.kind, r.id, JSON.parse(r.data)));
  else r.data = "{}";
  return r;
}

export class Store {
  db: Database;
  closed = false;
  /** Overridable clock, so tests can fake time. */
  now = () => Date.now();

  constructor(path = join(CONFIG_DIR, "agentgate.db")) {
    if (path !== ":memory:") {
      const dir = dirname(path);
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
    this.db.transaction(() => {
      if (!this.db.query("select 1 from local_seq").get()) this.db.run("insert into local_seq values (0)");
    }).immediate();
    this.db.run("create table if not exists peers (node text primary key, url text, token text, cursor integer default 0, last_seen integer)");
    this.db.run("create table if not exists request_log (at integer, provider text, account text, model text, status integer, ms integer, note text)");
    // Node-local settings that are never synced (node name, admin token, pairing code, active account).
    this.db.run("create table if not exists local (key text primary key, value text)");
    this.migrate();
  }

  transaction<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  close() { this.closed = true; this.db.close(); }

  private migrate() {
    this.transaction(() => {
      const version = (this.db.query("pragma user_version").get() as { user_version: number }).user_version;
      if (version > 2) throw new Error("database was created by a newer agentgate version");
      if (version === 0) {
        for (const row of this.db.query("select * from records where kind = 'mcp' and deleted = 0").all() as Rec[]) {
          const inst = parseData("mcp", row.id, JSON.parse(row.data));
          if (inst.oauth) {
            this.put("mcpCredential", inst.id, { ...inst.oauth, instanceId: inst.id, holder: row.node });
            const { oauth, ...config } = inst;
            this.put("mcp", inst.id, config);
          }
        }
        this.db.run("pragma user_version = 1");
      }
      if (version < 2) {
        this.db.run("create table if not exists proxy_requests (seq integer primary key autoincrement, id text unique not null, at integer not null, provider text not null, account text not null, model text not null, outcome text not null, failure text, bytes integer not null, data text not null)");
        this.db.run("create table if not exists proxy_attempts (id text primary key, request_id text not null, number integer not null, bytes integer not null, data text not null)");
        this.db.run("create index if not exists proxy_requests_time on proxy_requests(at)");
        this.db.run("create index if not exists proxy_attempts_request on proxy_attempts(request_id)");
        // Re-publish existing relay records in the versioned encrypted payload format.
        for (const [key] of this.localPrefixed("relay:")) if (key.endsWith(":pushed") || key === "relay:pushed") this.setLocal(key, undefined);
        if (this.db.query("select name from sqlite_master where type='table' and name='relay_pending'").get()) this.db.run("delete from relay_pending");
        this.db.run("pragma user_version = 2");
      }
    });
  }

  get nodeId(): string {
    return this.local("node") ?? "unnamed";
  }

  local(key: string): string | undefined {
    return (this.db.query("select value from local where key = ?").get(key) as { value: string } | null)?.value;
  }

  localPrefixed(prefix: string): [string, string][] {
    const like = `${prefix.replace(/[\\%_]/g, "\\$&")}%`;
    return (this.db.query("select key, value from local where key like ? escape '\\' order by key").all(like) as { key: string; value: string }[]).map((r) => [r.key, r.value]);
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

  put<K extends Kind>(kind: K, id: string, data: z.input<(typeof schemas)[K]> | Data<K>): Data<K> {
    const parsed = parseData(kind, id, data);
    this.write(kind, id, JSON.stringify(parsed), 0);
    return parsed;
  }

  del(kind: Kind, id: string) {
    if (this.record(kind, id)) this.write(kind, id, "{}", 1);
  }

  private write(kind: Kind, id: string, data: string, deleted: number) {
    if (Buffer.byteLength(data) > MAX_RECORD) throw new Error("record exceeds 4 MiB");
    this.db.transaction(() => {
      const prev = this.record(kind, id);
      this.db.run("insert or replace into records values (?, ?, ?, ?, ?, ?, ?, ?)", [
        kind, id, (prev?.rev ?? 0) + 1, this.nodeId, this.now(), deleted, data, this.nextSeq(),
      ]);
    }).immediate();
  }

  settings(): Settings {
    return this.get("setting", "settings") ?? schemas.setting.parse({});
  }

  /** Change feed for peers: every record (secrets and tombstones included) newer than `since`. */
  changes(since: number): { records: Rec[]; seq: number } {
    timestamp.parse(since);
    return this.db.transaction(() => {
      const seq = this.seq(); // establish the read snapshot before reading its records
      const records = this.db.query("select * from records where seq > ? and seq <= ? order by seq").all(since, seq) as Rec[];
      return { records, seq };
    })();
  }

  /** A peer cursor acknowledges only records actually present in this byte-bounded page. */
  changePage(since: number, maxBytes = 8 * 1024 * 1024): { records: Rec[]; seq: number; more: boolean } {
    timestamp.parse(since);
    return this.db.transaction(() => {
      const high = this.seq(), records: Rec[] = [];
      let bytes = 0;
      const statement = this.db.prepare("select * from records where seq > ? and seq <= ? order by seq");
      try {
        for (const row of statement.iterate(since, high) as Iterable<Rec>) {
          const size = Buffer.byteLength(JSON.stringify(row)) + 1;
          if (bytes + size > maxBytes) {
            if (!records.length) throw new Error("one record exceeds the sync page limit");
            return { records, seq: records.at(-1)!.seq!, more: true };
          }
          records.push(row); bytes += size;
        }
      } finally { statement.finalize(); }
      return { records, seq: high, more: false };
    })();
  }

  /** Last-writer-wins by (rev, updated_at, node). Returns true when the incoming record was taken. */
  merge(r: Rec): boolean {
    r = parseRecord(r);
    return this.db.transaction(() => {
      const cur = this.record(r.kind, r.id);
      if (cur && !newer(r, cur)) return false;
      this.db.run("insert or replace into records values (?, ?, ?, ?, ?, ?, ?, ?)", [
        r.kind, r.id, r.rev, r.node, r.updated_at, r.deleted, r.data, this.nextSeq(),
      ]);
      return true;
    }).immediate();
  }

  purgeTombstones() {
    // Keep deletion history: an offline node can return after any amount of time.
  }

  /** A lease shared by CLI and daemon processes using this database. */
  acquireLease(key: string, owner: string, ttl = 60_000): boolean {
    return this.transaction(() => {
      const raw = this.local(key);
      const lease = raw ? JSON.parse(raw) as { owner: string; expires: number } : undefined;
      if (lease && lease.owner !== owner && lease.expires > this.now()) return false;
      this.setLocal(key, JSON.stringify({ owner, expires: this.now() + ttl }));
      return true;
    });
  }
  releaseLease(key: string, owner: string) {
    this.transaction(() => {
      const raw = this.local(key);
      if (raw && JSON.parse(raw).owner === owner) this.setLocal(key, undefined);
    });
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

let shared: Store | undefined;
export const store = () => (shared ??= new Store());

/** A public inventory deliberately omits all arbitrary strings that may carry credentials. */
function publicMcp(inst: McpInstance) {
  return {
    id: inst.id, template: inst.template, transport: inst.transport, mode: inst.mode, secrets: {}, fields: {},
    ...(inst.transport === "http" ? { url: "https://configure.invalid/mcp", headers: {} } : { command: "configure-command", args: [], env: {} })
  };
}

export function exportBackup(s: Store, secrets = true) {
  const rows = s.db.query("select kind, id, data from records where deleted = 0 order by kind, id").all() as { kind: Kind; id: string; data: string }[];
  const records = rows
    .filter((r) => secrets || !["credential", "mcpCredential", "refreshRequest"].includes(r.kind))
    .map((r) => {
      const data = JSON.parse(r.data);
      if (!secrets && r.kind === "project") delete data.remote; // endpoint keys are credentials
      return { kind: r.kind, id: r.id, data: !secrets && r.kind === "mcp" ? publicMcp(data) : data };
    });
  return { agentgate: 4, secrets, exportedAt: new Date(s.now()).toISOString(), from: s.nodeId, records };
}

export function importBackup(s: Store, input: unknown) {
  const backup = z.object({ agentgate: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), records: z.array(z.object({ kind: recordSchema.shape.kind, id, data: z.unknown() })).max(100000) }).parse(input);
  const records = backup.records.map(r => ({ ...r, data: parseData(r.kind, r.id, r.data) }));
  return s.transaction(() => {
    for (const r of records) {
      if (r.kind === "mcp") {
        const { oauth, ...config } = r.data as McpInstance;
        s.put("mcp", r.id, config);
        if (oauth) s.put("mcpCredential", r.id, { ...oauth, instanceId: r.id, holder: s.nodeId });
      } else s.put(r.kind, r.id, r.data);
    }
    return records.length;
  });
}
