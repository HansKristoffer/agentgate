import type { FactoryBoard } from "@agentgate/protocol";
import { z } from "zod";
import { projection, t3Client } from "../handoff/t3.ts";
import { sessionUsage } from "../llm/sessions.ts";
import { currentFolder, DEFAULT_LIMITS } from "./config.ts";
import { ask, interruptItem } from "./controller.ts";
import { isOpenPhase, items, runs, type FactoryItem, type FactoryRun } from "./db.ts";
import { isRevertOf, prState, prView, revertsSince } from "./gh.ts";
import { mirrorOf } from "./mirror.ts";
import { shortError, withItem, type FactoryRuntime } from "./runtime.ts";

/**
 * What each run cost and how each item turned out. A run's tokens are the `session_usage` rows of the provider sessions
 * behind its T3 thread and the subagent threads under it, counted by the proxy of every machine that served them.
 * Outcomes come from the item's PR on GitHub.
 */

const MINUTE = 60_000;
const HOUR = 3600_000;
const DAY = 86_400_000;
const SESSION_ID = /^[\w-]{1,128}$/;

// ---- a thread's sessions

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

/** Each provider thread's native session id, read from T3's projections: a subagent thread has its own session. It
 * works on any machine connected to T3 Code, unlike the factory's T3 MCP sign-in. */
async function threadSessions(f: FactoryRuntime, thread: string): Promise<string[]> {
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
  return [...new Set(sessions)];
}

const usageSchema = z.array(
  z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() }),
);
/** Every token the provider counted, cache reads included, so a budget follows what the subscriptions spend. */
const total = (rows: z.infer<typeof usageSchema>) =>
  rows.reduce((sum, r) => sum + r.input + r.output + r.cacheRead + r.cacheWrite, 0);

/** Tokens and the provider sessions found of a run's thread, which is always this machine's: a handoff detaches it. */
async function measure(f: FactoryRuntime, run: FactoryRun) {
  if (!run.threadId) return undefined;
  const sessions = await threadSessions(f, run.threadId);
  return { tokens: total(sessionUsage(f.s, sessions)), sessions };
}

/** The run's tokens now, read from T3 and the proxies' counts. */
export async function runTokens(f: FactoryRuntime, run: FactoryRun): Promise<number> {
  return (await measure(f, run))?.tokens ?? 0;
}

// ---- recording runs

/** Records the run's measurement; the item, whose tokens are its runs' sum, when it has one. */
function saveTokens(f: FactoryRuntime, run: FactoryRun, tokens: number, sessions: number) {
  runs.measured(f.s, run.id, tokens, sessions);
  return run.item ? items.get(f.s, run.item) : undefined;
}

/** An item over `limits.itemTokens` has its threads stopped and waits for the maintainer, in the phase it reached:
 * its PR, when it has one, is still followed to its merge. Raising the budget and `retry` go on. The budget is read
 * from the current folder, so raising it applies to items started before. */
async function enforceBudget(f: FactoryRuntime, id: string) {
  const item = items.get(f.s, id);
  const budget = (currentFolder(f)?.config.limits ?? DEFAULT_LIMITS).itemTokens;
  if (!item || item.tokens <= budget || !isOpenPhase(item.phase) || item.needsYou?.cause === "budget") return;
  // Set before the first await, so a report that arrives meanwhile finds the item waiting.
  ask(f, item, {
    cause: "budget",
    question: `${item.key} used ${item.tokens.toLocaleString("en-US")} tokens, over the budget of ${budget.toLocaleString("en-US")}. Raise limits.itemTokens before you retry it.`,
  });
  await interruptItem(f, item.id, `The item went over the factory's token budget of ${budget}`);
}

/** Stores the run's tokens. */
async function record(f: FactoryRuntime, run: FactoryRun) {
  const measured = await measure(f, run);
  if (!measured) return;
  const item = saveTokens(f, run, measured.tokens, measured.sessions.length);
  // A step of its own, queued behind whatever the item is doing; never from inside one (a finished item has no budget).
  if (item && isOpenPhase(item.phase)) await withItem(f, item.id, () => enforceBudget(f, item.id));
}

/** A run that just ended: its tokens. */
export const recordRun = (f: FactoryRuntime, run: FactoryRun) => record(f, run);

/** An item that just finished: its threads may have kept working after their runs reported (an implement thread owns
 * its PR), so their tokens are read again. */
export async function recordItemEnd(f: FactoryRuntime, item: FactoryItem) {
  for (const run of runs.forItem(f.s, item.id))
    if (run.threadId && run.state === "reported")
      await record(f, run).catch((e) =>
        f.events.emit({
          kind: "note",
          run: run.id,
          item: item.id,
          text: `Reading the tokens of ${run.id} failed: ${shortError(e)}`,
        }),
      );
}

interface Measuring {
  /** Per run, its thread and subagent threads when its sessions were read, and those sessions. */
  sessions: Map<string, { threads: string; sessions: string[] }>;
  /** Per run, the failure the event list last heard. */
  failed: Map<string, string>;
}
const measuring = new WeakMap<FactoryRuntime, Measuring>();
function measuringOf(f: FactoryRuntime) {
  let m = measuring.get(f);
  if (!m) measuring.set(f, (m = { sessions: new Map(), failed: new Map() }));
  return m;
}

/** The run's tokens now. Its provider sessions are read from T3 (a projection carries every message) only when its
 * set of threads changed, as when a subagent starts, and again when the run ends; the proxies' counts for them, which
 * are cheap, every time. */
async function currentTokens(f: FactoryRuntime, run: FactoryRun) {
  const { sessions: memory } = measuringOf(f);
  const threads = [run.threadId!, ...subagents(f, run.threadId!)].sort().join(",");
  const known = memory.get(run.id);
  if (known?.threads !== threads) {
    const measured = await measure(f, run);
    if (!measured) return undefined;
    memory.set(run.id, { threads, sessions: measured.sessions });
    return measured;
  }
  return { tokens: total(sessionUsage(f.s, known.sessions)), sessions: known.sessions };
}

/** Threads keep working after their run reports (an implement thread owns its PR), so the runs of open items are
 * measured every minute. An item that waits for the maintainer is left alone: its threads are stopped or wait for an
 * answer. A failure is noted once per run; the board shows the tokens as unknown while a working run goes unmeasured. */
async function measureOpen(f: FactoryRuntime) {
  const m = measuringOf(f);
  const measured = new Set<string>();
  const budget = (currentFolder(f)?.config.limits ?? DEFAULT_LIMITS).itemTokens;
  for (const item of items.list(f.s, { open: true })) {
    if (item.needsYou) continue;
    for (const run of runs.forItem(f.s, item.id)) {
      if (!run.threadId) continue;
      measured.add(run.id);
      try {
        const now = await currentTokens(f, run);
        if (!now) continue;
        m.failed.delete(run.id);
        const after = saveTokens(f, run, now.tokens, now.sessions.length);
        // A step of the item only when it went over: under budget, nothing waits behind its other steps.
        if (after && isOpenPhase(after.phase) && after.tokens > budget)
          await withItem(f, after.id, () => enforceBudget(f, after.id));
      } catch (e) {
        m.sessions.delete(run.id);
        const text = `Measuring the tokens of ${run.id} failed: ${shortError(e)}`;
        if (m.failed.get(run.id) !== text) f.events.emit({ kind: "note", item: item.id, run: run.id, text });
        m.failed.set(run.id, text);
      }
    }
  }
  // Runs of items that finished or wait are measured again from scratch if they come back.
  for (const id of m.sessions.keys()) if (!measured.has(id)) m.sessions.delete(id);
  for (const id of m.failed.keys()) if (!measured.has(id)) m.failed.delete(id);
}

// ---- outcomes

const prOutcomeSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  mergedAt: z.string().optional(),
  reverted: z.boolean(),
});
type PrOutcome = z.infer<typeof prOutcomeSchema>;

function storedPr(item: FactoryItem) {
  const parsed = prOutcomeSchema.safeParse(item.outcome);
  return parsed.success ? parsed.data : undefined;
}

/** The item's outcome: its PR as last read from GitHub, with human touches and tokens as they are now. Hours to merge
 * run from the item entering the factory. Commits on GitHub carry the maintainer's login whether a person or an agent
 * made them, so they are not human touches. */
export function itemOutcome(item: FactoryItem) {
  const pr = storedPr(item);
  const merged = pr?.mergedAt ? Date.parse(pr.mergedAt) : undefined;
  return {
    ...(pr && { pr }),
    humanTouches: item.touches,
    ...(merged !== undefined && { hoursToMerge: (merged - item.createdAt) / HOUR }),
    tokens: item.tokens,
  };
}

async function readPr(url: string): Promise<PrOutcome> {
  const view = await prView(url);
  return {
    number: view.number,
    title: view.title,
    state: view.state,
    ...(view.mergedAt && { mergedAt: view.mergedAt }),
    reverted: false, // the revert pass sets it
  };
}

/** The PR is read in full once its item finished, and again once an open one changes state: `drop` leaves it open. */
async function refreshPr(item: FactoryItem, url: string, known: PrOutcome | undefined) {
  if (known && (known.state !== "OPEN" || (await prState(item.repo, known.number)) === "OPEN")) return known;
  return readPr(url);
}

const noted = new WeakMap<FactoryRuntime, Map<string, string>>();

/** Items that finished in the last 14 days, the window a revert counts in. Merged PRs are checked for a revert with one
 * search per repository. */
async function refreshOutcomes(f: FactoryRuntime) {
  const { s } = f;
  let errors = noted.get(f);
  if (!errors) noted.set(f, (errors = new Map()));
  const note = (key: string, text: string, item?: string) => {
    if (errors.get(key) !== text) f.events.emit({ kind: "note", ...(item && { item }), text });
    errors.set(key, text);
  };
  const watching: { item: FactoryItem; pr: PrOutcome & { mergedAt: string } }[] = [];
  for (const item of items.list(s, { open: false, finishedSince: s.now() - 14 * DAY })) {
    if (!item.pr) continue;
    const known = storedPr(item);
    let pr = known;
    try {
      pr = await refreshPr(item, item.pr.url, known);
      errors.delete(item.id);
    } catch (e) {
      note(item.id, `Reading the outcome of ${item.key}'s PR failed: ${shortError(e)}`, item.id);
    }
    if (pr && JSON.stringify(pr) !== JSON.stringify(known)) items.update(s, item.id, { outcome: pr });
    if (pr?.mergedAt && !pr.reverted && s.now() - Date.parse(pr.mergedAt) <= 14 * DAY + HOUR)
      watching.push({ item, pr: { ...pr, mergedAt: pr.mergedAt } });
  }
  for (const repo of new Set(watching.map((w) => w.item.repo))) {
    const mine = watching.filter((w) => w.item.repo === repo);
    try {
      const reverts = await revertsSince(repo, Math.min(...mine.map((w) => Date.parse(w.pr.mergedAt))));
      errors.delete(repo);
      for (const { item, pr } of mine)
        if (isRevertOf(reverts, pr)) items.update(s, item.id, { outcome: { ...pr, reverted: true } });
    } catch (e) {
      note(repo, `Searching ${repo} for reverts failed: ${shortError(e)}`);
    }
  }
}

const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** The board's outcome metrics over the items that finished in the last 7 days; reverts over the last 14. */
function metrics(f: FactoryRuntime): FactoryBoard["metrics"] {
  const { s } = f;
  const finished = (days: number) =>
    items.list(s, { open: false, finishedSince: s.now() - days * DAY }).map((item) => itemOutcome(item));
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
  f.loops.push({ name: "factory-tokens", everyMs: MINUTE, where: "factory-node", run: () => measureOpen(f) });
  f.loops.push({
    name: "factory-outcomes",
    everyMs: HOUR,
    where: "factory-node",
    run: () => refreshOutcomes(f),
  });
  f.boardParts.push(async () => ({ metrics: metrics(f) }));
}
