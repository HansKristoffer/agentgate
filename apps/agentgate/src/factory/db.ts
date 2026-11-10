import {
  stageNames,
  type FactoryReport,
  type ItemPhase,
  type NeedsYou,
  type RunKind,
  type RunState,
  type StageName,
} from "@agentgate/protocol";
import { z } from "zod";
import { trimSessionUsage } from "../llm/sessions.ts";
import type { Store } from "../store.ts";

/** The factory's node-local tables. Never synced: only the machine that runs the factory drives the items and runs in
 * its tables, and a machine the factory left keeps its open ones frozen. */

export interface FactoryItem {
  id: string;
  source: string; // source id, or "manual"
  externalId: string; // "owner/repo#123" | "ENG-42" | a UUID for webhook and manual items; unique
  key: string; // "api-123" | "eng-42" | "desk-1a2b3c" | "m-1a2b3c"; unique, and used in branch names
  repo: string;
  title: string;
  url?: string;
  snapshot: unknown; // the source item at intake; untrusted
  phase: ItemPhase;
  needsYou?: NeedsYou;
  prUrl?: string;
  prCommit?: string;
  configCommit: string; // keeps <agentgate home>/factory/<commit>/ alive while the item is open
  /** The sum of its runs' tokens, derived when read. */
  tokens: number;
  /** A webhook or scout item's dedupe key, which agentgate chose; kept out of the untrusted snapshot. */
  dedupe?: string;
  /** Its PR as last read once the item finished (records.ts). */
  outcome?: unknown;
  /** Things a person did to the item (approve, reject, retry, answer, add), for the human-touches metric. */
  touches: number;
  /** When the item entered its phase. */
  phaseAt: number;
  createdAt: number;
  updatedAt: number;
  /** When it reached shipped or closed; the 7-, 14- and 90-day windows count from it. */
  finishedAt?: number;
}

/** What the factory recorded about a run as it went: the PR an implement run opened and its nudges, a review round,
 * a scout's source and what it filed. Stored as JSON in `checked`. */
export const runDataSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("implement"),
    pr: z.string(),
    head: z.string(),
    /** When the factory first saw this head. */
    headAt: z.number(),
    /** The problems the factory last nudged the thread about (`problemsOf` keys), and when. */
    nudged: z.string().optional(),
    nudgedAt: z.number().optional(),
    /** GitHub's time of the newest comment or review a nudge quoted: newer trusted ones are what the thread has not seen. */
    quotedUntil: z.string().optional(),
    /** The `updatedAt` of the thread when the factory found it stopped in T3 Code; a later stop is a new one. */
    stopSeen: z.number().optional(),
    /** What the thread did with each review conversation, by id, and whether the factory has replied on GitHub. */
    conversations: z
      .record(
        z.string(),
        z.object({
          outcome: z.enum(["fixed", "declined"]),
          commit: z.string(), // the PR's head when the thread reported
          note: z.string().optional(),
          seen: z.string(), // GitHub's time of the conversation's newest comment then; a newer trusted one reopens it
        }),
      )
      .optional(),
  }),
  z.object({
    kind: z.literal("review"),
    head: z.string(),
    round: z.number(),
    /** The PR moved on before the report came, so it was discarded. */
    stale: z.boolean().optional(),
    /** The item goes to `ready` with this round; retried until marking the PR ready works. */
    final: z.boolean().optional(),
  }),
  /** Set when queued; `filed` (item keys) and `skipped` (finding keys) once the report is accepted. */
  z.object({
    kind: z.literal("scout"),
    source: z.string(),
    filed: z.array(z.string()).optional(),
    skipped: z.array(z.string()).optional(),
  }),
]);
export type RunData = z.infer<typeof runDataSchema>;
export type RunDataOf<K extends RunData["kind"]> = Extract<RunData, { kind: K }>;

export interface FactoryRun {
  id: string; // also T3's clientRequestId
  item?: string; // absent for scout runs
  kind: RunKind;
  attempt: number;
  state: RunState;
  node?: string; // the machine whose T3 Code holds the thread: the one that launched it
  threadId?: string;
  threadLink?: string;
  report?: FactoryReport;
  checked?: RunData;
  nudges: number;
  error?: string;
  configCommit: string;
  /** The T3 MCP session a launch was sent under: T3 dedupes `clientRequestId` within one session only. */
  launchSession?: string;
  /** Launches of this run that failed, so a restart neither forgets an item stuck on them nor starts the count over. */
  failedLaunches?: number;
  /** A scout run's source, so its schedule finds its runs without reading every scout run. */
  source?: string;
  /** The branch an implement run was given at its launch (implement.ts), which its PR must come from. */
  branch?: string;
  /** What agentgate's proxies counted for the run's provider sessions, and how many sessions T3 named; they only grow. */
  tokens: number;
  sessions: number;
  /** When its tokens were last measured; never while unset. */
  measuredAt?: number;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
}

export function ensureFactoryTables(s: Store) {
  s.transaction(() => {
    s.db.run(`create table if not exists factory_items (
      id text primary key, source text not null, external_id text not null, key text not null, repo text not null,
      title text not null, url text, snapshot text not null, phase text not null, needs_you text, pr_url text,
      pr_commit text, config_commit text not null, dedupe text, outcome text,
      touches integer not null default 0, phase_at integer not null, created_at integer not null,
      updated_at integer not null, finished_at integer)`);
    s.db.run("create unique index if not exists factory_items_external on factory_items(external_id)");
    s.db.run("create unique index if not exists factory_items_key on factory_items(key)");
    // A webhook delivery or a scout finding looks for its dedupe key among the source's recent items.
    s.db.run("create index if not exists factory_items_dedupe on factory_items(source, dedupe, created_at)");
    s.db.run(`create table if not exists factory_runs (
      id text primary key, item text, kind text not null, attempt integer not null default 1, state text not null,
      node text, thread_id text, thread_link text, report text, checked text, nudges integer not null default 0,
      error text, config_commit text not null, launch_session text, failed_launches integer, source text,
      branch text, tokens integer not null default 0, sessions integer not null default 0, measured_at integer,
      queued_at integer not null, started_at integer, ended_at integer)`);
    s.db.run("create index if not exists factory_runs_item on factory_runs(item)");
    // Dispatch, the follow loop and the board ask for runs by state every few seconds.
    s.db.run("create index if not exists factory_runs_state on factory_runs(state)");
    s.db.run("create index if not exists factory_runs_kind on factory_runs(kind, source, queued_at)");
    // The MCP gateway finds a session's run by its thread on every tool call.
    s.db.run("create index if not exists factory_runs_thread on factory_runs(thread_id)");
    s.db.run(`create table if not exists factory_events (
      seq integer primary key autoincrement, at integer not null, item text, run text, kind text not null,
      text text not null)`);
    s.db.run("create index if not exists factory_events_item on factory_events(item, kind)");
    // The outbox: every write to GitHub or Linear whose outcome can be uncertain, claimed with its body before it is
    // sent (outbox.ts). `refusals` counts the times the service said no, `claimed` is when it was claimed and `at`
    // when it was last sent. Its own table: the event log is trimmed.
    s.db.run(`create table if not exists factory_writebacks (
      item text not null, moment text not null, ref text not null, status text not null, body text not null,
      what text not null, refusals integer not null default 0, claimed integer not null, at integer not null,
      primary key (item, moment, ref))`);
  });
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** prefix + "_" + a ULID: 48 bits of milliseconds, then 80 random bits, so ids sort by creation time. */
export function newId(prefix: "it" | "run") {
  let time = "";
  for (let t = Date.now(), i = 0; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
  // 256 is a multiple of 32, so every character is equally likely.
  const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => CROCKFORD[b % 32]).join("");
  return `${prefix}_${time}${random}`;
}

const FINISHED: readonly ItemPhase[] = ["shipped", "closed"];
export const isOpenPhase = (phase: ItemPhase) => !FINISHED.includes(phase);
/** Runs that have not ended. */
export const ACTIVE: readonly RunState[] = ["queued", "starting", "running", "waiting"];
export const isStage = (kind: string): kind is StageName => (stageNames as readonly string[]).includes(kind);

type Row = Record<string, string | number | null>;
const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);
const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : undefined);
const encode = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

const itemColumns = {
  source: "source",
  externalId: "external_id",
  key: "key",
  repo: "repo",
  title: "title",
  url: "url",
  snapshot: "snapshot",
  phase: "phase",
  needsYou: "needs_you",
  prUrl: "pr_url",
  prCommit: "pr_commit",
  configCommit: "config_commit",
  dedupe: "dedupe",
  outcome: "outcome",
  touches: "touches",
  phaseAt: "phase_at",
  createdAt: "created_at",
  updatedAt: "updated_at",
  finishedAt: "finished_at",
} as const;
const itemJson = new Set(["snapshot", "needsYou", "outcome"]);

const runColumns = {
  item: "item",
  kind: "kind",
  attempt: "attempt",
  state: "state",
  node: "node",
  threadId: "thread_id",
  threadLink: "thread_link",
  report: "report",
  checked: "checked",
  nudges: "nudges",
  error: "error",
  configCommit: "config_commit",
  launchSession: "launch_session",
  failedLaunches: "failed_launches",
  source: "source",
  branch: "branch",
  tokens: "tokens",
  sessions: "sessions",
  measuredAt: "measured_at",
  queuedAt: "queued_at",
  startedAt: "started_at",
  endedAt: "ended_at",
} as const;
const runJson = new Set(["report", "checked"]);

/** The columns a patch names and their values; undefined clears a nullable column. */
function columnsOf(patch: object, columns: Record<string, string>, jsonFields: Set<string>) {
  const fields = Object.entries(patch).filter(([k]) => k in columns);
  return {
    names: fields.map(([k]) => columns[k]!),
    values: fields.map(([k, v]) => (jsonFields.has(k) ? encode(v) : ((v ?? null) as string | number | null))),
  };
}
const whereSql = (clauses: unknown[]) => (clauses.length ? `where ${clauses.join(" and ")}` : "");
const insertSql = (table: string, names: string[]) =>
  `insert into ${table} (id,${names.join(",")}) values (?${",?".repeat(names.length)})`;
const updateSql = (table: string, names: string[]) =>
  `update ${table} set ${names.map((n) => `${n}=?`).join(",")} where id=?`;

const toItem = (r: Row): FactoryItem => ({
  id: r.id as string,
  source: r.source as string,
  externalId: r.external_id as string,
  key: r.key as string,
  repo: r.repo as string,
  title: r.title as string,
  url: opt(r.url as string | null),
  snapshot: json(r.snapshot),
  phase: r.phase as ItemPhase,
  needsYou: json(r.needs_you),
  prUrl: opt(r.pr_url as string | null),
  prCommit: opt(r.pr_commit as string | null),
  configCommit: r.config_commit as string,
  tokens: r.tokens as number,
  dedupe: opt(r.dedupe as string | null),
  outcome: json(r.outcome),
  touches: r.touches as number,
  phaseAt: r.phase_at as number,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
  finishedAt: opt(r.finished_at as number | null),
});
/** Items with their tokens, the sum of their runs'. */
const ITEMS = `select i.*, (select coalesce(sum(r.tokens), 0) from factory_runs r where r.item = i.id) as tokens
  from factory_items i`;

/** What a run's `checked` holds, or nothing for a value no kind reads. */
const runData = (v: unknown): RunData | undefined => {
  const parsed = runDataSchema.safeParse(json(v));
  return parsed.success ? parsed.data : undefined;
};

const toRun = (r: Row): FactoryRun => ({
  id: r.id as string,
  item: opt(r.item as string | null),
  kind: r.kind as RunKind,
  attempt: r.attempt as number,
  state: r.state as RunState,
  node: opt(r.node as string | null),
  threadId: opt(r.thread_id as string | null),
  threadLink: opt(r.thread_link as string | null),
  report: json(r.report),
  checked: runData(r.checked),
  nudges: r.nudges as number,
  error: opt(r.error as string | null),
  configCommit: r.config_commit as string,
  launchSession: opt(r.launch_session as string | null),
  failedLaunches: opt(r.failed_launches as number | null),
  source: opt(r.source as string | null),
  branch: opt(r.branch as string | null),
  tokens: r.tokens as number,
  sessions: r.sessions as number,
  measuredAt: opt(r.measured_at as number | null),
  queuedAt: r.queued_at as number,
  startedAt: opt(r.started_at as number | null),
  endedAt: opt(r.ended_at as number | null),
});

/** The run data of a kind, or undefined when the run holds another kind's or none. */
export function dataOf<K extends RunData["kind"]>(run: FactoryRun | undefined, kind: K): RunDataOf<K> | undefined {
  return run?.checked?.kind === kind ? (run.checked as RunDataOf<K>) : undefined;
}

export const items = {
  get: (s: Store, id: string) => {
    const r = s.db.query(`${ITEMS} where i.id=?`).get(id) as Row | null;
    return r ? toItem(r) : undefined;
  },
  byKey: (s: Store, key: string) => {
    const r = s.db.query(`${ITEMS} where i.key=?`).get(key) as Row | null;
    return r ? toItem(r) : undefined;
  },
  /** The item of a tracker issue (`owner/repo#123`, `ENG-42`), whichever source took it in. */
  byExternal: (s: Store, externalId: string) => {
    const r = s.db.query(`${ITEMS} where i.external_id=?`).get(externalId) as Row | null;
    return r ? toItem(r) : undefined;
  },
  /** open: only open items, or only finished ones when false. finishedSince drops items that finished before it. */
  list: (s: Store, filter: { open?: boolean; finishedSince?: number } = {}) => {
    const where = [
      filter.open === true && `i.finished_at is null`,
      filter.open === false && `i.finished_at is not null`,
      filter.finishedSince !== undefined && `(i.finished_at is null or i.finished_at >= ?)`,
    ].filter(Boolean);
    const args = filter.finishedSince === undefined ? [] : [filter.finishedSince];
    return (s.db.query(`${ITEMS} ${whereSql(where)} order by i.created_at`).all(...args) as Row[]).map(toItem);
  },
  /** Whether the source has an item with this dedupe key that is open, or finished since `at`. */
  hasDedupe: (s: Store, source: string, dedupe: string, at: number) =>
    !!s.db
      .query("select 1 from factory_items where source=? and dedupe=? and (finished_at is null or finished_at>=?)")
      .get(source, dedupe, at),
  /** How many of the source's items wait for approval. */
  heldCount: (s: Store, source: string) =>
    (s.db.query("select count(*) as n from factory_items where source=? and phase='held'").get(source) as { n: number })
      .n,
  /** Every key in use, so a new item can take one no other item has. */
  keyTaken: (s: Store, key: string) => !!s.db.query("select 1 from factory_items where key=?").get(key),
  insert: (
    s: Store,
    item: Omit<FactoryItem, "createdAt" | "updatedAt" | "phaseAt" | "touches" | "tokens" | "finishedAt">,
  ) => {
    const at = s.now();
    const full: FactoryItem = {
      ...item,
      tokens: 0,
      touches: 0,
      phaseAt: at,
      createdAt: at,
      updatedAt: at,
      finishedAt: isOpenPhase(item.phase) ? undefined : at,
    };
    const { names, values } = columnsOf(full, itemColumns, itemJson);
    s.db.run(insertSql("factory_items", names), [item.id, ...values]);
    return full;
  },
  /** A phase in the patch sets or clears when the item finished. */
  update: (s: Store, id: string, patch: Partial<Omit<FactoryItem, "id" | "createdAt" | "tokens" | "finishedAt">>) => {
    const finished = patch.phase && { finishedAt: isOpenPhase(patch.phase) ? undefined : s.now() };
    const { names, values } = columnsOf({ updatedAt: s.now(), ...patch, ...finished }, itemColumns, itemJson);
    if (!s.db.run(updateSql("factory_items", names), [...values, id]).changes) throw new Error(`no factory item ${id}`);
    return items.get(s, id)!;
  },
};

/** A run as the dispatch loop and the board's thread list need it. */
export interface RunHead {
  id: string;
  item?: string;
  kind: RunKind;
  state: RunState;
  threadId?: string;
  threadLink?: string;
}
const toHead = (r: Row): RunHead => ({
  id: r.id as string,
  item: opt(r.item as string | null),
  kind: r.kind as RunKind,
  state: r.state as RunState,
  threadId: opt(r.thread_id as string | null),
  threadLink: opt(r.thread_link as string | null),
});
const HEAD = "id, item, kind, state, thread_id, thread_link";

export const runs = {
  get: (s: Store, id: string) => {
    const r = s.db.query("select * from factory_runs where id=?").get(id) as Row | null;
    return r ? toRun(r) : undefined;
  },
  forItem: (s: Store, item: string) =>
    (s.db.query("select * from factory_runs where item=? order by queued_at").all(item) as Row[]).map(toRun),
  list: (
    s: Store,
    filter: { states?: readonly RunState[]; kinds?: RunKind[]; source?: string; endedSince?: number } = {},
  ) => {
    const where: string[] = [],
      args: (string | number)[] = [];
    for (const [column, values] of [
      ["state", filter.states],
      ["kind", filter.kinds],
    ] as const)
      if (values) {
        where.push(`${column} in (${values.map(() => "?").join(",") || "null"})`);
        args.push(...values);
      }
    if (filter.source !== undefined) {
      where.push("source = ?");
      args.push(filter.source);
    }
    if (filter.endedSince !== undefined) {
      where.push("ended_at >= ?");
      args.push(filter.endedSince);
    }
    return (s.db.query(`select * from factory_runs ${whereSql(where)} order by queued_at`).all(...args) as Row[]).map(
      toRun,
    );
  },
  /** Runs in these states that belong to an open item or to none: the ones whose threads can still be working. */
  heads: (s: Store, states: readonly RunState[]) =>
    (
      s.db
        .query(
          `select ${HEAD} from factory_runs where state in (${states.map(() => "?").join(",")}) and (item is null or item in (select id from factory_items where finished_at is null))`,
        )
        .all(...states) as Row[]
    ).map(toHead),
  /** The runs whose threads these are. */
  byThreads: (s: Store, threads: string[]) =>
    threads.length
      ? (
          s.db
            .query(`select ${HEAD} from factory_runs where thread_id in (select value from json_each(?))`)
            .all(JSON.stringify(threads)) as Row[]
        ).map(toHead)
      : [],
  insert: (s: Store, run: Omit<FactoryRun, "queuedAt" | "tokens" | "sessions"> & { queuedAt?: number }) => {
    const full: FactoryRun = { ...run, tokens: 0, sessions: 0, queuedAt: run.queuedAt ?? s.now() };
    const { names, values } = columnsOf(full, runColumns, runJson);
    s.db.run(insertSql("factory_runs", names), [run.id, ...values]);
    return full;
  },
  update: (s: Store, id: string, patch: Partial<Omit<FactoryRun, "id" | "tokens" | "sessions" | "measuredAt">>) => {
    const { names, values } = columnsOf(patch, runColumns, runJson);
    if (names.length) s.db.run(updateSql("factory_runs", names), [...values, id]);
    const run = runs.get(s, id);
    if (!run) throw new Error(`no factory run ${id}`);
    return run;
  },
  /** Records a measurement. Tokens and sessions only grow: a subagent thread T3 dropped, or a machine that cannot be
   * reached, does not lower them. */
  measured: (s: Store, id: string, tokens: number, sessions: number) =>
    s.db.run("update factory_runs set tokens=max(tokens, ?), sessions=max(sessions, ?), measured_at=? where id=?", [
      tokens,
      sessions,
      s.now(),
      id,
    ]),
};

/** Whether the outbox (outbox.ts) still has a write to send, or one in flight. */
export const hasUnsentWrites = (s: Store) =>
  !!s.db.query("select 1 from factory_writebacks where status in ('pending', 'sending', 'unreachable')").get();

const KEEP_MS = 90 * 24 * 3600_000;

/** Items, their runs and everything recorded about them 90 days after the item finished; runs without an item 90
 * days after they ended; events by the request log's row limit. */
export function trimFactory(s: Store) {
  const before = s.now() - KEEP_MS;
  s.transaction(() => {
    s.db.run("delete from factory_runs where item in (select id from factory_items where finished_at < ?)", [before]);
    s.db.run("delete from factory_items where finished_at < ?", [before]);
    s.db.run("delete from factory_runs where item is null and ended_at < ?", [before]);
    s.db.run("delete from factory_writebacks where item not in (select id from factory_items)");
    s.db.run("delete from factory_events where seq <= (select max(seq) from factory_events) - ?", [
      s.settings().logRetention,
    ]);
  });
  trimSessionUsage(s);
}
