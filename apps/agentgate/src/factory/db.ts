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
import type { Store } from "../store.ts";

/** The factory's node-local tables. Never synced: the machine that runs the factory holds its items and runs. */

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
  tokens: number;
  /** Things a person did to the item (approve, reject, retry, answer, add), for the human-touches metric. */
  touches: number;
  /** When the item entered its phase. */
  phaseAt: number;
  createdAt: number;
  updatedAt: number;
}

/** What the factory recorded about a run as it went: the PR an implement run opened and its nudges, a review round,
 * the run a judge grades, a learning PR's check. Stored as JSON in `checked`. */
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
    /** What the thread did with each review conversation, by id, and whether the factory has replied on GitHub. */
    conversations: z
      .record(
        z.string(),
        z.object({
          outcome: z.enum(["fixed", "declined"]),
          commit: z.string(), // the PR's head when the thread reported
          note: z.string().optional(),
          seen: z.string(), // GitHub's time of the conversation's newest comment then; a newer trusted one reopens it
          replied: z.boolean(),
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
  z.object({ kind: z.literal("judge"), run: z.string(), scorer: z.string() }),
  z.object({ kind: z.literal("learn"), pr: z.string(), head: z.string(), problems: z.array(z.string()) }),
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
  item?: string; // absent for judge and learn runs
  kind: RunKind;
  attempt: number;
  state: RunState;
  node?: string; // machine whose T3 holds the thread; changes on handoff
  threadId?: string;
  threadLink?: string;
  commitSha?: string; // the commit the result applies to
  report?: FactoryReport;
  checked?: RunData;
  verdict?: "success" | "flawed";
  nudges: number;
  error?: string;
  configCommit: string;
  /** The T3 MCP session a launch was sent under: T3 dedupes `clientRequestId` within one session only. */
  launchSession?: string;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
}

export interface FactoryScore {
  run: string;
  scorer: string;
  label: string;
  score: number;
  passed: boolean;
  reasoning: string;
  judgeRun: string;
  at: number;
}

export function ensureFactoryTables(s: Store) {
  s.transaction(() => {
    s.db.run(`create table if not exists factory_items (
      id text primary key, source text not null, external_id text not null, key text not null, repo text not null,
      title text not null, url text, snapshot text not null, phase text not null, needs_you text, pr_url text,
      pr_commit text, config_commit text not null, tokens integer not null default 0,
      touches integer not null default 0, phase_at integer not null, created_at integer not null,
      updated_at integer not null)`);
    s.db.run("create unique index if not exists factory_items_external on factory_items(external_id)");
    s.db.run("create unique index if not exists factory_items_key on factory_items(key)");
    s.db.run(`create table if not exists factory_runs (
      id text primary key, item text, kind text not null, attempt integer not null default 1, state text not null,
      node text, thread_id text, thread_link text, commit_sha text, report text, checked text, verdict text,
      nudges integer not null default 0, error text, config_commit text not null, launch_session text,
      queued_at integer not null, started_at integer, ended_at integer)`);
    s.db.run("create index if not exists factory_runs_item on factory_runs(item)");
    // The MCP gateway finds a session's run by its thread on every tool call.
    s.db.run("create index if not exists factory_runs_thread on factory_runs(thread_id)");
    // Kept apart from the runs, which the dispatch loop and the board read often: a transcript is up to 256 KiB.
    s.db.run(
      "create table if not exists factory_transcripts (run text primary key, text text not null, at integer not null)",
    );
    s.db.run(`create table if not exists factory_scores (
      run text not null, scorer text not null, label text not null, score real not null, passed integer not null,
      reasoning text not null, judge_run text not null, at integer not null, primary key (run, scorer))`);
    s.db.run(`create table if not exists factory_events (
      seq integer primary key autoincrement, at integer not null, item text, run text, kind text not null,
      text text not null)`);
    s.db.run("create index if not exists factory_events_item on factory_events(item, kind)");
    // At most one post per item, moment and `ref` (the asking run and question for `waiting`), claimed before it is
    // sent, so an uncertain post is never repeated. Its own table: the event log is trimmed while items stay open.
    s.db.run(`create table if not exists factory_writebacks (
      item text not null, moment text not null, ref text not null, status text not null, at integer not null,
      primary key (item, moment, ref))`);
    // `sessions`: how many provider sessions the run's threads named; 0 after a while means the tokens are unknown.
    s.db.run(`create table if not exists factory_run_tokens (
      run text primary key, item text, tokens integer not null, sessions integer not null default 0,
      at integer not null)`);
    s.db.run(
      "create table if not exists factory_outcomes (item text primary key, pr text not null, at integer not null)",
    );
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
const finishedList = FINISHED.map((p) => `'${p}'`).join(",");

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
  tokens: "tokens",
  touches: "touches",
  phaseAt: "phase_at",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const;
const itemJson = new Set(["snapshot", "needsYou"]);

const runColumns = {
  item: "item",
  kind: "kind",
  attempt: "attempt",
  state: "state",
  node: "node",
  threadId: "thread_id",
  threadLink: "thread_link",
  commitSha: "commit_sha",
  report: "report",
  checked: "checked",
  verdict: "verdict",
  nudges: "nudges",
  error: "error",
  configCommit: "config_commit",
  launchSession: "launch_session",
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
  touches: r.touches as number,
  phaseAt: r.phase_at as number,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
});

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
  commitSha: opt(r.commit_sha as string | null),
  report: json(r.report),
  checked: runData(r.checked),
  verdict: opt(r.verdict as FactoryRun["verdict"] | null),
  nudges: r.nudges as number,
  error: opt(r.error as string | null),
  configCommit: r.config_commit as string,
  launchSession: opt(r.launch_session as string | null),
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
    const r = s.db.query("select * from factory_items where id=?").get(id) as Row | null;
    return r ? toItem(r) : undefined;
  },
  byKey: (s: Store, key: string) => {
    const r = s.db.query("select * from factory_items where key=?").get(key) as Row | null;
    return r ? toItem(r) : undefined;
  },
  /** The item of a tracker issue (`owner/repo#123`, `ENG-42`), whichever source took it in. */
  byExternal: (s: Store, externalId: string) => {
    const r = s.db.query("select * from factory_items where external_id=?").get(externalId) as Row | null;
    return r ? toItem(r) : undefined;
  },
  /** open: only open items, or only finished ones when false. finishedSince drops items that finished before it. */
  list: (s: Store, filter: { open?: boolean; finishedSince?: number } = {}) => {
    const where = [
      filter.open === true && `phase not in (${finishedList})`,
      filter.open === false && `phase in (${finishedList})`,
      filter.finishedSince !== undefined && `(phase not in (${finishedList}) or updated_at >= ?)`,
    ].filter(Boolean);
    const args = filter.finishedSince === undefined ? [] : [filter.finishedSince];
    return (s.db.query(`select * from factory_items ${whereSql(where)} order by created_at`).all(...args) as Row[]).map(
      toItem,
    );
  },
  /** Every key in use, so a new item can take one no other item has. */
  keyTaken: (s: Store, key: string) => !!s.db.query("select 1 from factory_items where key=?").get(key),
  insert: (s: Store, item: Omit<FactoryItem, "createdAt" | "updatedAt" | "phaseAt" | "touches">) => {
    const at = s.now();
    const full: FactoryItem = { ...item, touches: 0, phaseAt: at, createdAt: at, updatedAt: at };
    const { names, values } = columnsOf(full, itemColumns, itemJson);
    s.db.run(insertSql("factory_items", names), [item.id, ...values]);
    return full;
  },
  update: (s: Store, id: string, patch: Partial<Omit<FactoryItem, "id" | "createdAt">>) => {
    const { names, values } = columnsOf({ updatedAt: s.now(), ...patch }, itemColumns, itemJson);
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
  list: (s: Store, filter: { states?: readonly RunState[]; kinds?: RunKind[]; endedSince?: number } = {}) => {
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
          `select ${HEAD} from factory_runs where state in (${states.map(() => "?").join(",")}) and (item is null or item in (select id from factory_items where phase not in (${finishedList})))`,
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
  insert: (s: Store, run: Omit<FactoryRun, "queuedAt"> & { queuedAt?: number }) => {
    const full: FactoryRun = { ...run, queuedAt: run.queuedAt ?? s.now() };
    const { names, values } = columnsOf(full, runColumns, runJson);
    s.db.run(insertSql("factory_runs", names), [run.id, ...values]);
    return full;
  },
  update: (s: Store, id: string, patch: Partial<Omit<FactoryRun, "id">>) => {
    const { names, values } = columnsOf(patch, runColumns, runJson);
    if (names.length) s.db.run(updateSql("factory_runs", names), [...values, id]);
    const run = runs.get(s, id);
    if (!run) throw new Error(`no factory run ${id}`);
    return run;
  },
};

/** A run's transcript, read only by judges and the learning thread. */
export const transcripts = {
  get: (s: Store, run: string) =>
    (s.db.query("select text from factory_transcripts where run=?").get(run) as { text: string } | null)?.text,
  put: (s: Store, run: string, text: string) =>
    s.db.run("insert or replace into factory_transcripts (run, text, at) values (?, ?, ?)", [run, text, s.now()]),
};

const toScore = (r: Row): FactoryScore => ({
  run: r.run as string,
  scorer: r.scorer as string,
  label: r.label as string,
  score: r.score as number,
  passed: r.passed === 1,
  reasoning: r.reasoning as string,
  judgeRun: r.judge_run as string,
  at: r.at as number,
});

export const scores = {
  put: (s: Store, x: FactoryScore) => {
    s.db.run("insert or replace into factory_scores values (?, ?, ?, ?, ?, ?, ?, ?)", [
      x.run,
      x.scorer,
      x.label,
      x.score,
      x.passed ? 1 : 0,
      x.reasoning,
      x.judgeRun,
      x.at,
    ]);
  },
  forRun: (s: Store, run: string) =>
    (s.db.query("select * from factory_scores where run=? order by scorer").all(run) as Row[]).map(toScore),
  since: (s: Store, at: number) =>
    (s.db.query("select * from factory_scores where at >= ? order by at").all(at) as Row[]).map(toScore),
};

const KEEP_MS = 90 * 24 * 3600_000;

/** Items, their runs and everything recorded about them 90 days after the item finished; runs without an item 90
 * days after they ended; events by the request log's row limit. */
export function trimFactory(s: Store) {
  const before = s.now() - KEEP_MS;
  s.transaction(() => {
    s.db.run(
      `delete from factory_runs where item in (select id from factory_items where phase in (${finishedList}) and updated_at < ?)`,
      [before],
    );
    s.db.run(`delete from factory_items where phase in (${finishedList}) and updated_at < ?`, [before]);
    s.db.run("delete from factory_runs where item is null and ended_at < ?", [before]);
    for (const table of ["factory_scores", "factory_transcripts", "factory_run_tokens"])
      s.db.run(`delete from ${table} where run not in (select id from factory_runs)`);
    for (const table of ["factory_writebacks", "factory_outcomes"])
      s.db.run(`delete from ${table} where item not in (select id from factory_items)`);
    s.db.run("delete from factory_events where seq <= (select max(seq) from factory_events) - ?", [
      s.settings().logRetention,
    ]);
  });
}
