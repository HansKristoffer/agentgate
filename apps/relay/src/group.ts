import {
  RELAY_LIMITS, RELAY_PROTOCOL, changesResponse, createRequest, pushRequest, relayGeneration, relayNode,
  type ChangesResponse, type RelayEntry,
} from "@agentgate/protocol/relay";

/** The relay never decrypts anything: a group is an upsert-only mailbox of sealed entries. */

export type SqlValue = string | number | null;
export interface Sql {
  all<T = Record<string, SqlValue>>(query: string, ...params: SqlValue[]): T[];
  run(query: string, ...params: SqlValue[]): void;
  tx<T>(fn: () => T): T;
}

export interface Config {
  maxGroups: number;
  maxGroupBytes: number;
  retentionMs: number;
  groupsPerIpPerDay: number;
  groupRequestsPerMinute: number;
  failedAuthPerMinute: number;
  newGroupsDisabled: boolean;
}

export const defaults: Config = {
  maxGroups: 1000,
  maxGroupBytes: 50 * 1024 * 1024,
  retentionMs: 180 * 86_400_000,
  groupsPerIpPerDay: 5,
  groupRequestsPerMinute: 600,
  failedAuthPerMinute: 20,
  newGroupsDisabled: false,
};

export function config(env: Record<string, unknown>): Config {
  const num = (name: string, fallback: number) => {
    const n = Number(env[name]);
    return env[name] !== undefined && env[name] !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    maxGroups: num("RELAY_MAX_GROUPS", defaults.maxGroups),
    maxGroupBytes: num("RELAY_GROUP_MAX_BYTES", defaults.maxGroupBytes),
    retentionMs: num("RELAY_RETENTION_DAYS", 180) * 86_400_000,
    groupsPerIpPerDay: num("RELAY_GROUPS_PER_IP_PER_DAY", defaults.groupsPerIpPerDay),
    groupRequestsPerMinute: num("RELAY_GROUP_REQUESTS_PER_MINUTE", defaults.groupRequestsPerMinute),
    failedAuthPerMinute: num("RELAY_FAILED_AUTH_PER_MINUTE", defaults.failedAuthPerMinute),
    newGroupsDisabled: env.RELAY_DISABLE_NEW_GROUPS === "1" || env.RELAY_DISABLE_NEW_GROUPS === "true",
  };
}

export interface Reply { status: number; body: unknown; retryAfter?: number }
export type GroupOp = "create" | "push" | "changes" | "nodes" | "delete";
export interface GroupRequest {
  op: GroupOp;
  groupId: string;
  authHash: string;
  ipHash: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
}

export interface Admission {
  reserve(groupId: string, ipHash: string): Promise<Reply | undefined>;
  release(groupId: string): Promise<void>;
}

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Reply => ({ status, body: { error, ...extra } });
const ok = (body: unknown): Reply => ({ status: 200, body });
const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Constant-time comparison of two hex digests. */
export function sameHash(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class Window {
  private start = 0;
  private count = 0;
  hit(limit: number, now: number): number | undefined {
    if (now - this.start >= 60_000) { this.start = now; this.count = 0; }
    if (++this.count > limit) return Math.max(1, Math.ceil((this.start + 60_000 - now) / 1000));
    return undefined;
  }
}

interface Meta { groupId: string; authHash: string; generation: string; head: number; bytes: number; lastActive: number; alarmAt: number; deleting: number; admitted: number }

// Stored sizes include a fixed per-row overhead so tiny entries still count against the quota.
const entrySize = (node: string, key: string, blob: string) => node.length + key.length + blob.length + 64;
const nodeSize = (node: string) => node.length + 32;
// Room left for the response envelope and the seen map (64 nodes of at most 512 escaped characters).
const PAGE_BUDGET = RELAY_LIMITS.messageBytes - 512 * 1024;
const utf8 = new TextEncoder();
/** A create that stopped between storing its record and admission is deleted by its alarm after this. */
const PENDING_MS = 10 * 60_000;

export class GroupCore {
  private queue: Promise<unknown> = Promise.resolve();
  private requests = new Window();
  private failures = new Window();

  constructor(
    private sql: Sql,
    private deps: { admission: Admission; config: Config; now?: () => number; setAlarm: (at: number) => void | Promise<void>; deleteAll: () => void | Promise<void> },
  ) { }

  /** Tables exist only once a create starts: requests for unknown groups never write storage. */
  private init() {
    this.sql.run("create table if not exists meta (k text primary key, v)");
    this.sql.run("create table if not exists entries (node text not null, key text not null, seq integer not null, pusher_seq integer not null, blob text not null, size integer not null, primary key (node, key))");
    this.sql.run("create index if not exists entries_seq on entries(seq)");
    this.sql.run("create table if not exists nodes (node text primary key, last_seen integer not null)");
  }

  private now() { return (this.deps.now ?? Date.now)(); }

  private meta(): Meta | undefined {
    if (!this.sql.all("select 1 from sqlite_master where type = 'table' and name = 'meta'").length) return undefined;
    const rows = this.sql.all<{ k: string; v: SqlValue }>("select k, v from meta");
    if (!rows.length) return undefined;
    const m = Object.fromEntries(rows.map((r) => [r.k, r.v])) as Record<string, SqlValue>;
    return {
      groupId: String(m.groupId ?? ""), authHash: String(m.authHash ?? ""), generation: String(m.generation ?? ""),
      head: Number(m.head ?? 0), bytes: Number(m.bytes ?? 0), lastActive: Number(m.lastActive ?? 0), alarmAt: Number(m.alarmAt ?? 0), deleting: Number(m.deleting ?? 0), admitted: Number(m.admitted ?? 0),
    };
  }

  private set(values: Partial<Meta>) {
    for (const [k, v] of Object.entries(values)) this.sql.run("insert or replace into meta values (?, ?)", k, v as SqlValue);
  }

  /** Requests are handled one at a time, so awaits (admission, alarms) never interleave two mutations. */
  handle(req: GroupRequest): Promise<Reply> {
    const run = this.queue.then(() => this.process(req));
    this.queue = run.catch(() => { });
    return run;
  }

  alarm(): Promise<void> {
    const run = this.queue.then(async () => {
      const m = this.meta();
      if (!m) return;
      const until = m.lastActive + (m.admitted ? this.deps.config.retentionMs : PENDING_MS);
      if (m.deleting || this.now() >= until) await this.destroy(m.groupId);
      else { await this.deps.setAlarm(until); this.set({ alarmAt: until }); }
    });
    this.queue = run.catch(() => { });
    return run;
  }

  private async process(req: GroupRequest): Promise<Reply> {
    const now = this.now();
    const limited = this.requests.hit(this.deps.config.groupRequestsPerMinute, now);
    if (limited) return { ...fail(429, "too many requests for this group"), retryAfter: limited };
    let m = this.meta();
    if (m?.deleting) { await this.destroy(m.groupId); m = undefined; }

    if (req.op === "create") {
      if (!createRequest.safeParse(req.body).success) return fail(400, "unsupported relay protocol", { code: "protocol" });
      if (m && !sameHash(m.authHash, req.authHash)) return this.unauthorized(now);
      if (!m?.admitted) {
        // Record first, with an alarm, then reserve: a crash at any point leaves storage the alarm
        // deletes, releasing a slot the reservation may already hold. A retry resumes the record.
        await this.deps.setAlarm(now + PENDING_MS);
        this.init();
        this.sql.tx(() => this.set({ groupId: req.groupId, authHash: req.authHash, generation: m?.generation ?? randomHex(), head: 0, bytes: 0, lastActive: now, alarmAt: now + PENDING_MS, deleting: 0, admitted: 0 }));
        const refused = await this.deps.admission.reserve(req.groupId, req.ipHash);
        if (refused) { await this.deps.deleteAll(); return refused; }
        this.set({ admitted: 1, alarmAt: 0 }); // touch() below moves the alarm to retention
        m = this.meta()!;
      }
      await this.touch(m, now);
      return ok({ protocol: RELAY_PROTOCOL, generation: m.generation, headSeq: m.head });
    }

    if (!m?.admitted) return fail(404, "no such group", { code: "missing" });
    if (!sameHash(m.authHash, req.authHash)) return this.unauthorized(now);

    if (req.op === "delete") {
      await this.destroy(m.groupId);
      return ok({ ok: true });
    }
    let reply: Reply;
    if (req.op === "push") reply = this.push(m, req.body, now);
    else if (req.op === "changes") reply = this.changes(m, req.query ?? {}, now);
    else reply = ok({ protocol: RELAY_PROTOCOL, generation: m.generation, nodes: this.nodes() });
    if (reply.status < 400) await this.touch(m, now);
    return reply;
  }

  private unauthorized(now: number): Reply {
    const limited = this.failures.hit(this.deps.config.failedAuthPerMinute, now);
    return limited ? { ...fail(429, "too many failed attempts"), retryAfter: limited } : fail(401, "unauthorized");
  }

  /** Retention restarts on every authenticated request; the alarm is only moved once a day. */
  private async touch(m: Meta, now: number) {
    this.set({ lastActive: now });
    const due = now + this.deps.config.retentionMs;
    if (due - m.alarmAt > 86_400_000 || !m.alarmAt) { await this.deps.setAlarm(due); this.set({ alarmAt: due }); }
  }

  private reset(m: Meta, error: string): Reply {
    return fail(409, error, { code: "reset", resetRequired: true, generation: m.generation });
  }

  private nodes() {
    return this.sql.all<{ node: string; last_seen: number }>("select node, last_seen from nodes order by node").map((r) => ({ node: r.node, lastSeen: r.last_seen }));
  }

  /** Record a node identity; refuse a new one once the group is full. */
  private see(m: Meta, node: string, now: number): Reply | undefined {
    const known = this.sql.all("select 1 from nodes where node = ?", node).length > 0;
    if (!known) {
      if (this.sql.all<{ n: number }>("select count(*) as n from nodes")[0]!.n >= RELAY_LIMITS.nodes) return fail(409, `a group holds at most ${RELAY_LIMITS.nodes} machines`, { code: "tooManyNodes" });
      if (m.bytes + nodeSize(node) > this.deps.config.maxGroupBytes) return fail(507, "group storage quota exceeded", { code: "quota" });
      this.set({ bytes: m.bytes += nodeSize(node) });
    }
    this.sql.run("insert or replace into nodes values (?, ?)", node, now);
    return undefined;
  }

  private push(m: Meta, body: unknown, now: number): Reply {
    const parsed = pushRequest.safeParse(body);
    if (!parsed.success) return fail(400, "invalid push", { code: "shape" });
    const { generation, node, entries } = parsed.data;
    if (generation !== m.generation) return this.reset(m, "stale generation");
    if (new Set(entries.map((e) => e.key)).size !== entries.length) return fail(400, "duplicate keys in one push", { code: "shape" });
    try {
      return this.sql.tx(() => {
        const refused = this.see(m, node, now);
        if (refused) throw refused;
        let bytes = m.bytes, head = m.head;
        for (const e of entries) {
          const cur = this.sql.all<{ pusher_seq: number; blob: string; size: number }>("select pusher_seq, blob, size from entries where node = ? and key = ?", node, e.key)[0];
          if (cur) {
            if (e.pusherSeq === cur.pusher_seq && e.blob === cur.blob) continue; // retried push
            if (e.pusherSeq <= cur.pusher_seq) throw fail(409, "counter conflict", { code: "counter" });
          }
          const size = entrySize(node, e.key, e.blob);
          bytes += size - (cur?.size ?? 0);
          this.sql.run("insert or replace into entries values (?, ?, ?, ?, ?, ?)", node, e.key, ++head, e.pusherSeq, e.blob, size);
        }
        if (bytes > this.deps.config.maxGroupBytes) throw fail(507, "group storage quota exceeded", { code: "quota" });
        this.set({ bytes, head });
        m.bytes = bytes; m.head = head;
        return ok({ protocol: RELAY_PROTOCOL, generation: m.generation, headSeq: head });
      });
    } catch (e) {
      if (e && typeof e === "object" && "status" in e) return e as Reply;
      throw e;
    }
  }

  private changes(m: Meta, query: Record<string, string | undefined>, now: number): Reply {
    const since = Number(query.since ?? "0");
    const node = relayNode.safeParse(query.node);
    if (!Number.isSafeInteger(since) || since < 0 || !node.success) return fail(400, "invalid query", { code: "shape" });
    if (query.generation === undefined) { if (since !== 0) return this.reset(m, "generation required"); }
    else if (!relayGeneration.safeParse(query.generation).success) return fail(400, "invalid query", { code: "shape" });
    else if (query.generation !== m.generation) return this.reset(m, "stale generation");
    if (since > m.head) return this.reset(m, "cursor is ahead of the group");
    const includeSelf = query.includeSelf === "1";
    const refused = this.sql.tx(() => this.see(m, node.data, now));
    if (refused) return refused;
    // One synchronous read: nothing can write between these queries.
    const rows = this.sql.all<{ node: string; key: string; seq: number; pusher_seq: number; blob: string }>(
      `select node, key, seq, pusher_seq, blob from entries where seq > ? ${includeSelf ? "" : "and node != ?"} order by seq limit ?`,
      ...(includeSelf ? [since] : [since, node.data]), RELAY_LIMITS.pullEntries + 1,
    );
    const entries: RelayEntry[] = [];
    let size = 0, more = false;
    for (const r of rows) {
      const e = { node: r.node, key: r.key, seq: r.seq, pusherSeq: r.pusher_seq, blob: r.blob };
      const length = utf8.encode(JSON.stringify(e)).length + 1; // bytes: node names may be non-ASCII
      if (entries.length === RELAY_LIMITS.pullEntries || (entries.length && size + length > PAGE_BUDGET)) { more = true; break; }
      entries.push(e); size += length;
    }
    const seen = Object.fromEntries(this.nodes().map((n) => [n.node, n.lastSeen]));
    const page: ChangesResponse = { protocol: RELAY_PROTOCOL, generation: m.generation, nextCursor: more ? entries.at(-1)!.seq : m.head, headSeq: m.head, more, entries, seen };
    changesResponse.parse(page);
    return ok(page);
  }

  /** Data first, then the admission slot, then the remaining metadata. A failed release is retried by the alarm. */
  private async destroy(groupId: string) {
    this.sql.tx(() => {
      this.sql.run("delete from entries");
      this.sql.run("delete from nodes");
      this.set({ deleting: 1, bytes: 0 });
    });
    await this.deps.setAlarm(this.now() + 60_000);
    await this.deps.admission.release(groupId);
    await this.deps.deleteAll();
  }
}

/** One global instance: caps the number of live groups and new groups per source address. */
export class AdmissionCore {
  constructor(private sql: Sql, private config: Config, private now: () => number = Date.now) {
    sql.run("create table if not exists groups (id text primary key, created_at integer not null)");
    sql.run("create table if not exists ip_day (ip text not null, day integer not null, count integer not null, primary key (ip, day))");
  }

  /** `limits` lets remote endpoints keep their own caps in this same table, under `e:`-prefixed ids. */
  async reserve(groupId: string, ipHash: string, limits: { max: number; perIpPerDay: number } = { max: this.config.maxGroups, perIpPerDay: this.config.groupsPerIpPerDay }): Promise<Reply | undefined> {
    return this.sql.tx(() => {
      if (this.sql.all("select 1 from groups where id = ?", groupId).length) return undefined;
      if (this.config.newGroupsDisabled) return fail(503, "this relay is not accepting new groups", { code: "disabled" });
      const endpoint = groupId.startsWith("e:"), kind = endpoint ? "groups.id like 'e:%'" : "groups.id not like 'e:%'";
      const day = Math.floor(this.now() / 86_400_000);
      this.sql.run("delete from ip_day where day < ?", day - 1);
      const ip = endpoint ? `e:${ipHash}` : ipHash;
      const used = this.sql.all<{ count: number }>("select count from ip_day where ip = ? and day = ?", ip, day)[0]?.count ?? 0;
      if (used >= limits.perIpPerDay) return { ...fail(429, `too many new ${endpoint ? "endpoints" : "groups"} from this address today`, { code: "rate" }), retryAfter: 3600 };
      if (this.sql.all<{ n: number }>(`select count(*) as n from groups where ${kind}`)[0]!.n >= limits.max) return fail(507, "this relay is full", { code: "full" });
      this.sql.run("insert into groups values (?, ?)", groupId, this.now());
      this.sql.run("insert or replace into ip_day values (?, ?, ?)", ip, day, used + 1);
      return undefined;
    });
  }

  async release(groupId: string) {
    this.sql.run("delete from groups where id = ?", groupId);
  }

  count() { return this.sql.all<{ n: number }>("select count(*) as n from groups where id not like 'e:%'")[0]!.n; }
}
