import { factoryConfigSchema, type FactoryBoard } from "@agentgate/protocol";
import { getErrorMessage } from "hanzio";
import { z } from "zod";
import { peerCall } from "../handoff/jobs.ts";
import { projection, t3Client } from "../handoff/t3.ts";
import { sessionUsage } from "../llm/sessions.ts";
import { currentFolder } from "./config.ts";
import { interruptItem, moveItem, writeBack } from "./controller.ts";
import { isOpenPhase, items, runs, scores, type FactoryItem, type FactoryRun } from "./db.ts";
import { mergedRevertOf, prView } from "./gh.ts";
import { parseMarkers } from "./markers.ts";
import { mirrorOf } from "./mirror.ts";
import type { FactoryRuntime } from "./runtime.ts";

/**
 * What each run cost and how each item turned out (D30, D31, D37). A run's tokens are the `session_usage` rows of
 * the provider sessions behind its T3 thread and the subagent threads under it, counted by the proxy of every machine
 * that served them. Outcomes come from the item's PR on GitHub, and every finished run gets the item's verdict.
 */

const MINUTE = 60_000;
const HOUR = 3600_000;
const DAY = 86_400_000;
const TRANSCRIPT_BYTES = 256 * 1024;
const CUT = "[The start of this transcript was cut to keep its newest 256 KiB.]\n\n";
const SESSION_ID = /^[\w-]{1,128}$/;
/** A run's `threadId` while its thread moves to another machine (follow.ts); it names no thread yet. */
const MOVING = "handoff:";
const DEFAULT_LIMITS = factoryConfigSchema.shape.limits.parse(undefined);
const short = (e: unknown) => {
  const text = getErrorMessage(e);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
};

// ---- a thread's sessions and transcript, read on the machine whose T3 holds it

/** The newest 256 KiB, so the end of the run survives the cap. */
function capped(text: string) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= TRANSCRIPT_BYTES) return text;
  const tail = bytes.subarray(bytes.length - (TRANSCRIPT_BYTES - CUT.length));
  // A character cut in half decodes as replacement characters.
  return CUT + new TextDecoder().decode(tail).replace(/^�+/, "");
}

/** The thread's subagents, and theirs, from this machine's mirror. */
function subagents(f: FactoryRuntime, thread: string) {
  const all = mirrorOf(f).threads();
  const found: string[] = [];
  for (let i = -1; i < found.length; i++) {
    const parent = i < 0 ? thread : found[i];
    for (const t of all) if (t.parentThreadId === parent && !found.includes(t.id)) found.push(t.id);
  }
  return found;
}

const threadRecordSchema = z.object({ sessions: z.array(z.string()), transcript: z.string().optional() });
type ThreadRecord = z.infer<typeof threadRecordSchema>;

/** One read of T3's projections gives both: each provider thread's native session id (a subagent thread has its own
 * session), and the thread's messages. It works on any machine connected to T3 Code, unlike the factory's T3 MCP
 * sign-in, which only the factory machine holds. */
async function threadRecord(f: FactoryRuntime, thread: string, withTranscript: boolean): Promise<ThreadRecord> {
  const ids = [thread, ...subagents(f, thread)];
  const projections = await t3Client(f.s).rpc((call) =>
    Promise.all(
      ids.map((id) =>
        // A subagent thread T3 no longer has is left out; the run's own thread must be there.
        projection(call, id).catch((e) => {
          if (id === thread) throw e;
          return undefined;
        }),
      ),
    ),
  );
  const sessions = projections
    .flatMap((p) => p?.providerThreads.map((pt) => pt.nativeThreadRef?.nativeId) ?? [])
    .filter((id): id is string => !!id && SESSION_ID.test(id));
  const record: ThreadRecord = { sessions: [...new Set(sessions)] };
  if (withTranscript) {
    const messages = projections[0]!.messages.map(
      (m) => `## ${typeof m.role === "string" ? m.role : "message"}\n\n${m.text}`,
    );
    record.transcript = capped(messages.join("\n\n"));
  }
  return record;
}

const usageSchema = z.array(
  z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() }),
);
/** Every token the provider counted, cache reads included, so a budget follows what the subscriptions spend. */
const total = (rows: z.infer<typeof usageSchema>) =>
  rows.reduce((sum, r) => sum + r.input + r.output + r.cacheRead + r.cacheWrite, 0);

/** Tokens and, when asked, the transcript of a run's thread. A run handed to another machine keeps its session ids
 * (the handoff resumes the same session there), so the rows this machine's proxy counted before the move add to that
 * machine's. A machine it passed through on the way is not asked. */
async function measure(f: FactoryRuntime, run: FactoryRun, withTranscript: boolean) {
  const { s } = f;
  const thread = run.threadId;
  if (!thread || thread.startsWith(MOVING)) return undefined;
  const node = run.node && run.node !== s.nodeId ? run.node : undefined;
  if (!node) {
    const record = await threadRecord(f, thread, withTranscript);
    return { tokens: total(sessionUsage(s, record.sessions)), transcript: record.transcript };
  }
  const record = threadRecordSchema.parse(
    await peerCall(s, node, `/factory/threads/${encodeURIComponent(thread)}${withTranscript ? "?transcript=1" : ""}`),
  );
  const there = record.sessions.length
    ? usageSchema.parse(await peerCall(s, node, `/factory/usage?sessions=${record.sessions.join(",")}`))
    : [];
  return { tokens: total(sessionUsage(s, record.sessions)) + total(there), transcript: record.transcript };
}

/** The run's tokens now, read from T3 and the proxies' counts. */
export async function runTokens(f: FactoryRuntime, run: FactoryRun): Promise<number> {
  return (await measure(f, run, false))?.tokens ?? 0;
}

// ---- recording runs

function ensureTables(f: FactoryRuntime) {
  f.s.db.run(`create table if not exists factory_run_tokens (
    run text primary key, item text, tokens integer not null, at integer not null)`);
  f.s.db.run(`create table if not exists factory_outcomes (
    item text primary key, pr text not null, at integer not null)`);
}

/** Tokens only grow: a subagent thread T3 dropped, or a machine that cannot be reached, does not lower the count. */
function saveTokens(f: FactoryRuntime, run: FactoryRun, tokens: number) {
  const { s } = f;
  s.db.run(
    `insert into factory_run_tokens (run, item, tokens, at) values (?, ?, ?, ?)
     on conflict(run) do update set tokens=max(tokens, excluded.tokens), at=excluded.at`,
    [run.id, run.item ?? null, tokens, s.now()],
  );
  if (!run.item) return undefined;
  const item = items.get(s, run.item);
  if (!item) return undefined;
  const sum = (
    s.db.query("select coalesce(sum(tokens), 0) as n from factory_run_tokens where item=?").get(item.id) as {
      n: number;
    }
  ).n;
  // Not a change of state: the item keeps its updatedAt, which tells when a finished item finished.
  return sum === item.tokens ? item : items.update(s, item.id, { tokens: sum, updatedAt: item.updatedAt });
}

/** D26: an item over `limits.itemTokens` has its threads stopped and waits for the maintainer. It moves to `failed`
 * so the factory leaves its PR and threads alone, and `retry` is the way back once the budget is raised. The budget
 * is read from the current folder, so raising it applies to items started before. */
async function enforceBudget(f: FactoryRuntime, item: FactoryItem) {
  const budget = (currentFolder(f)?.config.limits ?? DEFAULT_LIMITS).itemTokens;
  if (!budget || item.tokens <= budget || !isOpenPhase(item.phase)) return;
  const question = `${item.key} used ${item.tokens.toLocaleString("en-US")} tokens, over the budget of ${budget.toLocaleString("en-US")}. Raise limits.itemTokens and run agentgate factory retry ${item.key}, or drop it.`;
  // Moved before the first await, so a run the interrupt ends, or the next measurement, finds the item stopped.
  moveItem(f, item.id, "failed", { reason: "budget", question });
  await interruptItem(f, item.id, `The item went over the factory's token budget of ${budget}`);
  // The item as it was, so the marker names the stage it stopped in.
  await writeBack(f, item, "waiting", { text: question });
}

/** Stores the run's tokens, and its transcript once it ended. */
async function record(f: FactoryRuntime, run: FactoryRun) {
  const withTranscript = run.endedAt !== undefined && run.transcript === undefined;
  const measured = await measure(f, run, withTranscript);
  if (!measured) return;
  if (measured.transcript !== undefined) runs.update(f.s, run.id, { transcript: measured.transcript });
  const item = saveTokens(f, run, measured.tokens);
  if (item) await enforceBudget(f, item);
}

/** Threads keep working after their run reports (an implement thread owns its PR), so every run of an open item is
 * measured again; one whose transcript could not be read when it ended gets it now. Failures wait for the next
 * round: the run's end already noted them. */
async function measureOpen(f: FactoryRuntime) {
  for (const item of items.list(f.s, { open: true }))
    for (const run of runs.forItem(f.s, item.id)) await record(f, run).catch(() => {});
}

// ---- outcomes and verdicts

const prOutcomeSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  mergedAt: z.string().optional(),
  reverted: z.boolean(),
  /** Comments and review bodies without a factory marker: all GitHub text carries the maintainer's login (D42). */
  peopleComments: z.number(),
  /** Reviews submitted on the PR, the factory's and people's. */
  reviewRounds: z.number(),
});
type PrOutcome = z.infer<typeof prOutcomeSchema>;

function storedPr(f: FactoryRuntime, item: string) {
  const row = f.s.db.query("select pr from factory_outcomes where item=?").get(item) as { pr: string } | null;
  const parsed = row ? prOutcomeSchema.safeParse(JSON.parse(row.pr)) : undefined;
  return parsed?.success ? parsed.data : undefined;
}

/** What people did to the item, from the factory's `human` events: adding it by hand, approving or rejecting,
 * answering a thread and retrying. Commits on GitHub carry the maintainer's login whether a person or an agent made them, so they
 * cannot be told apart and are not counted. */
function humanTouches(f: FactoryRuntime, item: FactoryItem) {
  const query = f.s.db.query("select count(*) as n from factory_events where item=? and kind='human'");
  return (query.get(item.id) as { n: number }).n;
}

/** The item's outcome: its PR as last read from GitHub, with human touches and tokens as they are now. Hours to merge
 * run from the item entering the factory. */
export function itemOutcome(f: FactoryRuntime, item: FactoryItem) {
  const pr = storedPr(f, item.id);
  const merged = pr?.mergedAt ? Date.parse(pr.mergedAt) : undefined;
  return {
    ...(pr && { pr }),
    humanTouches: humanTouches(f, item),
    ...(merged !== undefined && { hoursToMerge: (merged - item.createdAt) / HOUR }),
    tokens: item.tokens,
  };
}

async function readPr(item: FactoryItem & { prUrl: string }): Promise<PrOutcome> {
  const view = await prView(item.prUrl);
  const text = [...view.comments.map((c) => c.body), ...view.reviews.map((r) => r.body).filter((b) => b.trim())];
  return {
    number: view.number,
    title: view.title,
    state: view.state,
    ...(view.mergedAt && { mergedAt: view.mergedAt }),
    reverted: view.mergedAt ? await mergedRevertOf(item.repo, { ...view, mergedAt: view.mergedAt }) : false,
    peopleComments: text.filter((body) => !parseMarkers(body).length).length,
    reviewRounds: view.reviews.length,
  };
}

/** The PR is read once its item finished; a merged one is checked for a revert until 14 days passed. */
async function refreshPr(f: FactoryRuntime, item: FactoryItem) {
  if (!item.prUrl) return;
  const known = storedPr(f, item.id);
  let pr = known;
  if (!pr || pr.state === "OPEN") pr = await readPr({ ...item, prUrl: item.prUrl });
  else if (pr.mergedAt && !pr.reverted && f.s.now() - Date.parse(pr.mergedAt) <= 14 * DAY + HOUR)
    pr = { ...pr, reverted: await mergedRevertOf(item.repo, { ...pr, mergedAt: pr.mergedAt }) };
  if (JSON.stringify(pr) !== JSON.stringify(known))
    f.s.db.run("insert or replace into factory_outcomes (item, pr, at) values (?, ?, ?)", [
      item.id,
      JSON.stringify(pr),
      f.s.now(),
    ]);
}

/** D31. A flawed verdict already on a run (implement.ts marks a PR merged before ready) makes the item flawed. A
 * finished item without a PR has no verdict unless a judge failed one of its runs. */
function verdictOf(f: FactoryRuntime, item: FactoryItem, itemRuns: FactoryRun[]): FactoryRun["verdict"] {
  const judgedFailed = itemRuns.some((r) => scores.forRun(f.s, r.id).some((x) => !x.passed));
  if (judgedFailed || itemRuns.some((r) => r.verdict === "flawed")) return "flawed";
  if (!item.prUrl) return undefined;
  const pr = storedPr(f, item.id);
  if (!pr) return undefined; // not read from GitHub yet
  return pr.state === "MERGED" && !pr.reverted ? "success" : "flawed";
}

const ENDED = new Set(["reported", "silent", "failed", "cancelled"]);

function setVerdicts(f: FactoryRuntime, item: FactoryItem) {
  const itemRuns = runs.forItem(f.s, item.id);
  const verdict = isOpenPhase(item.phase) ? undefined : verdictOf(f, item, itemRuns);
  for (const run of itemRuns)
    if (ENDED.has(run.state) && run.verdict !== verdict) runs.update(f.s, run.id, { verdict });
}

const noted = new WeakMap<FactoryRuntime, Map<string, string>>();

/** Items that finished in the last 14 days, the window a revert counts in; runs of open items have no verdict (a
 * retried item is open again). */
async function refreshOutcomes(f: FactoryRuntime) {
  const { s } = f;
  let errors = noted.get(f);
  if (!errors) noted.set(f, (errors = new Map()));
  for (const item of items.list(s, { open: false, finishedSince: s.now() - 14 * DAY })) {
    try {
      await refreshPr(f, item);
      errors.delete(item.id);
    } catch (e) {
      const text = `Reading the outcome of ${item.key}'s PR failed: ${short(e)}`;
      if (errors.get(item.id) !== text) f.events.emit({ kind: "note", item: item.id, text });
      errors.set(item.id, text);
    }
    setVerdicts(f, item);
  }
  for (const item of items.list(s, { open: true })) setVerdicts(f, item);
  // Rows of items and runs the hourly trim removed.
  s.db.run("delete from factory_outcomes where item not in (select id from factory_items)");
  s.db.run("delete from factory_run_tokens where run not in (select id from factory_runs)");
}

const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** The board's outcome metrics over the items that finished in the last 7 days; reverts over the last 14. */
function metrics(f: FactoryRuntime): Omit<FactoryBoard["metrics"], "scorers"> {
  const { s } = f;
  const finished = (days: number) =>
    items.list(s, { open: false, finishedSince: s.now() - days * DAY }).map((item) => itemOutcome(f, item));
  const week = finished(7);
  const withPr = week.filter((o) => o.pr);
  const merged = week.filter((o) => o.pr?.state === "MERGED");
  const tokens = week.reduce((sum, o) => sum + o.tokens, 0);
  return {
    merged: merged.length,
    mergeRate: withPr.length ? merged.length / withPr.length : 0,
    reverts14d: finished(14).filter((o) => o.pr?.reverted).length,
    ...(merged.length && { medianHoursToMerge: median(merged.map((o) => o.hoursToMerge!)) }),
    ...(week.length && { humanTouchesPerItem: week.reduce((sum, o) => sum + o.humanTouches, 0) / week.length }),
    ...(merged.length && { tokensPerMergedPr: Math.round(tokens / merged.length) }),
  };
}

// ---- setup

export function setup(f: FactoryRuntime): void {
  ensureTables(f);

  f.events.on("run.ended", async (event) => {
    const run = runs.get(f.s, event.run);
    if (!run) return;
    await record(f, run).catch((e) =>
      f.events.emit({
        kind: "note",
        run: run.id,
        ...(run.item && { item: run.item }),
        text: `Recording the transcript and tokens of ${run.id} failed: ${short(e)}`,
      }),
    );
  });

  // Every machine measures the runs in its own tables, like it dispatches them.
  f.loops.push({ name: "factory-tokens", everyMs: MINUTE, where: "every-node", run: () => measureOpen(f) });
  f.loops.push({
    name: "factory-outcomes",
    everyMs: 15 * MINUTE,
    where: "factory-node",
    run: () => refreshOutcomes(f),
  });
  // Metrics merge key by key; the scorers are the judges' (7.1).
  f.boardParts.push(async () => ({ metrics: metrics(f) }) as Partial<FactoryBoard>);

  // GET /peer/factory/usage?sessions=a,b -> SessionUsage[]: what this machine's proxy counted for those sessions.
  f.peer.get("/usage", (c) => {
    const sessions = (c.req.query("sessions") ?? "").split(",").filter(Boolean);
    if (sessions.length > 200 || !sessions.every((id) => SESSION_ID.test(id)))
      return c.json({ error: "sessions must be up to 200 session ids, separated by commas" }, 400);
    return c.json(sessionUsage(f.s, sessions));
  });
  // GET /peer/factory/threads/:id[?transcript=1] -> { sessions, transcript? } for a thread in this machine's T3 Code.
  f.peer.get("/threads/:id", async (c) => {
    try {
      return c.json(await threadRecord(f, c.req.param("id"), c.req.query("transcript") === "1"));
    } catch (e) {
      return c.json({ error: short(e) }, 502);
    }
  });
}
