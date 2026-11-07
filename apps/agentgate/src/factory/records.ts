import type { FactoryBoard } from "@agentgate/protocol";
import { z } from "zod";
import { peerCall } from "../handoff/jobs.ts";
import { projection, t3Client } from "../handoff/t3.ts";
import { sessionUsage } from "../llm/sessions.ts";
import { currentFolder, DEFAULT_LIMITS } from "./config.ts";
import { elsewhere, interruptItem, setNeedsYou, writeBack } from "./controller.ts";
import { isOpenPhase, items, runs, transcripts, type FactoryItem, type FactoryRun } from "./db.ts";
import { COLLABORATORS, mergedRevertOf, prView } from "./gh.ts";
import { parseMarkers } from "./markers.ts";
import { mirrorOf } from "./mirror.ts";
import { MOVING } from "./follow.ts";
import { shortError, withItem, type FactoryRuntime } from "./runtime.ts";

/**
 * What each run cost and how each item turned out. A run's tokens are the `session_usage` rows of the provider sessions
 * behind its T3 thread and the subagent threads under it, counted by the proxy of every machine that served them.
 * Outcomes come from the item's PR on GitHub. A run's own verdict comes only from what judged that run: a judge, or a
 * check such as a person retrying an issue its triage closed.
 */

const MINUTE = 60_000;
const HOUR = 3600_000;
const DAY = 86_400_000;
const TRANSCRIPT_BYTES = 256 * 1024;
/** The start of a transcript holds the brief and the first steps, which judges and the learning thread read too. */
const HEAD_BYTES = 64 * 1024;
const SESSION_ID = /^[\w-]{1,128}$/;
/** A run on another machine is measured at most this often: this machine's mirror does not show its thread. */
const REMOTE_EVERY = 10 * MINUTE;

// ---- a thread's sessions and transcript, read on the machine whose T3 holds it

/** The first 64 KiB and the newest of the rest, at most 256 KiB in all. */
export function capped(text: string) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= TRANSCRIPT_BYTES) return text;
  const decode = (part: Uint8Array) => new TextDecoder().decode(part).replace(/^�+|�+$/g, "");
  const cut = `\n\n[${bytes.length - TRANSCRIPT_BYTES} bytes of this transcript were cut here.]\n\n`;
  const head = decode(bytes.subarray(0, HEAD_BYTES));
  const tail = decode(bytes.subarray(bytes.length - (TRANSCRIPT_BYTES - HEAD_BYTES - cut.length)));
  return head + cut + tail;
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
 * sign-in. */
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

/** Tokens, the number of provider sessions found and, when asked, the transcript of a run's thread. A run handed to
 * another machine keeps its session ids (the handoff resumes the same session there), so the rows this machine's proxy
 * counted before the move add to that machine's. */
async function measure(f: FactoryRuntime, run: FactoryRun, withTranscript: boolean) {
  const { s } = f;
  const thread = run.threadId;
  if (!thread || thread.startsWith(MOVING)) return undefined;
  if (!elsewhere(f, run)) {
    const record = await threadRecord(f, thread, withTranscript);
    return {
      tokens: total(sessionUsage(s, record.sessions)),
      sessions: record.sessions,
      transcript: record.transcript,
    };
  }
  const { node } = run;
  const record = threadRecordSchema.parse(
    await peerCall(s, node, `/factory/threads/${encodeURIComponent(thread)}${withTranscript ? "?transcript=1" : ""}`),
  );
  const there = record.sessions.length
    ? usageSchema.parse(await peerCall(s, node, `/factory/usage?sessions=${record.sessions.join(",")}`))
    : [];
  return {
    tokens: total(sessionUsage(s, record.sessions)) + total(there),
    sessions: record.sessions,
    transcript: record.transcript,
  };
}

/** The run's tokens now, read from T3 and the proxies' counts. */
export async function runTokens(f: FactoryRuntime, run: FactoryRun): Promise<number> {
  return (await measure(f, run, false))?.tokens ?? 0;
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
  if (!item || item.tokens <= budget || !isOpenPhase(item.phase) || item.needsYou?.reason === "budget") return;
  const question = `${item.key} used ${item.tokens.toLocaleString("en-US")} tokens, over the budget of ${budget.toLocaleString("en-US")}. Raise limits.itemTokens and run agentgate factory retry ${item.key}, or drop it.`;
  // Set before the first await, so a report that arrives meanwhile finds the item waiting.
  const after = setNeedsYou(f, item.id, { reason: "budget", question });
  await interruptItem(f, item.id, `The item went over the factory's token budget of ${budget}`);
  writeBack(f, after, "waiting", { text: question, ref: `budget:${budget}` });
}

/** Stores the run's tokens, and its transcript once it ended; `transcript` reads it again even when it has one. */
async function record(f: FactoryRuntime, run: FactoryRun, options: { transcript?: boolean } = {}) {
  const ended = run.endedAt !== undefined;
  const withTranscript = options.transcript ?? (ended && transcripts.get(f.s, run.id) === undefined);
  const measured = await measure(f, run, withTranscript);
  if (!measured) return;
  if (measured.transcript !== undefined) transcripts.put(f.s, run.id, measured.transcript);
  const item = saveTokens(f, run, measured.tokens, measured.sessions.length);
  // A step of its own, queued behind whatever the item is doing; never from inside one (a finished item has no budget).
  if (item && isOpenPhase(item.phase)) await withItem(f, item.id, () => enforceBudget(f, item.id));
}

/** A run that just ended: its tokens and transcript. */
export const recordRun = (f: FactoryRuntime, run: FactoryRun) => record(f, run);

/** An item that just finished: its threads may have kept working after their runs reported (an implement thread owns
 * its PR), so their transcripts are read again. */
export async function recordItemEnd(f: FactoryRuntime, item: FactoryItem) {
  for (const run of runs.forItem(f.s, item.id))
    if (run.threadId && run.state === "reported")
      await record(f, run, { transcript: true }).catch((e) =>
        f.events.emit({
          kind: "note",
          run: run.id,
          item: item.id,
          text: `Reading the transcript of ${run.id} failed: ${shortError(e)}`,
        }),
      );
}

/** Per run, its provider sessions as T3 last listed them, and when its thread had changed then. */
const sessionMemory = new WeakMap<FactoryRuntime, Map<string, { changed: number; sessions: string[] }>>();

/** When the run's thread last changed: its own thread's or a subagent's update in this machine's mirror, or, for a
 * thread on another machine, the clock in steps of 10 minutes. */
function changedAt(f: FactoryRuntime, run: FactoryRun) {
  if (elsewhere(f, run)) return Math.floor(f.s.now() / REMOTE_EVERY);
  const mirror = mirrorOf(f);
  const ids = [run.threadId!, ...subagents(f, run.threadId!)];
  return Math.max(0, ...ids.map((id) => mirror.thread(id)?.updatedAt ?? 0));
}

/** The run's tokens now: its sessions are read from T3 only when its thread changed, and the proxies' counts for
 * them, which are cheap, every time. */
async function currentTokens(f: FactoryRuntime, run: FactoryRun) {
  let memory = sessionMemory.get(f);
  if (!memory) sessionMemory.set(f, (memory = new Map()));
  const changed = changedAt(f, run);
  const known = memory.get(run.id);
  if (known?.changed !== changed) {
    const measured = await measure(f, run, false);
    if (!measured) return undefined;
    memory.set(run.id, { changed, sessions: measured.sessions });
    return measured;
  }
  const { sessions } = known;
  const here = total(sessionUsage(f.s, sessions));
  const there =
    elsewhere(f, run) && sessions.length
      ? total(usageSchema.parse(await peerCall(f.s, run.node, `/factory/usage?sessions=${sessions.join(",")}`)))
      : 0;
  return { tokens: here + there, sessions };
}

/** Threads keep working after their run reports (an implement thread owns its PR), so the runs of open items are
 * measured every minute, reading T3 only for threads that changed. An item that waits for the maintainer is left
 * alone: its threads are stopped or wait for an answer. Failures wait for the next round: the run's end already noted
 * them. */
async function measureOpen(f: FactoryRuntime) {
  for (const item of items.list(f.s, { open: true })) {
    if (item.needsYou) continue;
    for (const run of runs.forItem(f.s, item.id)) {
      if (!run.threadId || run.threadId.startsWith(MOVING)) continue;
      try {
        const measured = await currentTokens(f, run);
        if (!measured) continue;
        const after = saveTokens(f, run, measured.tokens, measured.sessions.length);
        if (after && isOpenPhase(after.phase)) await withItem(f, after.id, () => enforceBudget(f, after.id));
      } catch {
        sessionMemory.get(f)?.delete(run.id);
      }
    }
  }
}

// ---- outcomes and verdicts

const prOutcomeSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  mergedAt: z.string().optional(),
  reverted: z.boolean(),
  /** Comments and review bodies from the repository's people without a factory marker: all GitHub text carries the
   * maintainer's login (D42), and bots and outsiders are not the people whose reviews the factory learns from. */
  peopleComments: z.number(),
  /** Reviews people submitted on the PR, approvals without a body included. The factory posts none: its rounds are
   * its review runs. */
  peopleReviews: z.number(),
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

async function readPr(item: FactoryItem & { prUrl: string }): Promise<PrOutcome> {
  const view = await prView(item.prUrl);
  const text = [
    ...view.comments.map((c) => ({ body: c.body, by: c.authorAssociation })),
    ...view.reviews.filter((r) => r.body.trim()).map((r) => ({ body: r.body, by: r.authorAssociation })),
  ];
  return {
    number: view.number,
    title: view.title,
    state: view.state,
    ...(view.mergedAt && { mergedAt: view.mergedAt }),
    reverted: view.mergedAt ? await mergedRevertOf(item.repo, { ...view, mergedAt: view.mergedAt }) : false,
    peopleComments: text.filter((c) => COLLABORATORS.includes(c.by) && !parseMarkers(c.body).length).length,
    peopleReviews: view.reviews.length,
  };
}

/** The PR is read once its item finished; a merged one is checked for a revert until 14 days passed. */
async function refreshPr(f: FactoryRuntime, item: FactoryItem) {
  if (!item.prUrl) return;
  const known = storedPr(item);
  let pr = known;
  if (!pr || pr.state === "OPEN") pr = await readPr({ ...item, prUrl: item.prUrl });
  else if (pr.mergedAt && !pr.reverted && f.s.now() - Date.parse(pr.mergedAt) <= 14 * DAY + HOUR)
    pr = { ...pr, reverted: await mergedRevertOf(item.repo, { ...pr, mergedAt: pr.mergedAt }) };
  if (JSON.stringify(pr) !== JSON.stringify(known)) items.update(f.s, item.id, { outcome: pr });
}

const noted = new WeakMap<FactoryRuntime, Map<string, string>>();

/** Items that finished in the last 14 days, the window a revert counts in. */
async function refreshOutcomes(f: FactoryRuntime) {
  const { s } = f;
  let errors = noted.get(f);
  if (!errors) noted.set(f, (errors = new Map()));
  for (const item of items.list(s, { open: false, finishedSince: s.now() - 14 * DAY })) {
    try {
      await refreshPr(f, item);
      errors.delete(item.id);
    } catch (e) {
      const text = `Reading the outcome of ${item.key}'s PR failed: ${shortError(e)}`;
      if (errors.get(item.id) !== text) f.events.emit({ kind: "note", item: item.id, text });
      errors.set(item.id, text);
    }
  }
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
  // Every machine measures the runs in its own tables, like it dispatches them.
  f.loops.push({ name: "factory-tokens", everyMs: MINUTE, where: "every-node", run: () => measureOpen(f) });
  f.loops.push({
    name: "factory-outcomes",
    everyMs: 15 * MINUTE,
    where: "factory-node",
    run: () => refreshOutcomes(f),
  });
  // Metrics merge key by key; scorers.ts adds the judges' pass rates.
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
      return c.json({ error: shortError(e) }, 502);
    }
  });
}
