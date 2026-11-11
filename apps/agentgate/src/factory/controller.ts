import { existsSync } from "node:fs";
import {
  factoryReportSchema,
  waitsForYou,
  type BoardAction,
  type FactoryBoard,
  type FactoryModel,
  type FactoryReport,
  type ItemPhase,
  type ItemWaiting,
  type Moment,
  type NeedsYou,
  type NeedsYouCause,
  type Outcome,
  type RunKind,
  type RunState,
  type StageName,
} from "@agentgate/protocol";
import { z } from "zod";
import { run as git } from "../handoff/code.ts";
import { cloneProject, findProject } from "../handoff/destination.ts";
import type { SessionScope } from "../mcp/gateway.ts";
import type { ProviderName } from "../llm/provider.ts";
import { candidates, earliestReset } from "../llm/routing.ts";
import { renderBrief, TRIAGE_BRIEF } from "./briefs.ts";
import { currentFolder, DEFAULT_LIMITS, durationMs, folderFor, type LoadedFolder } from "./config.ts";
import {
  ACTIVE,
  isOpenPhase,
  isStage,
  items,
  newId,
  runs,
  type FactoryItem,
  type FactoryRun,
  type ItemPr,
  type RunData,
} from "./db.ts";
import type { HumanAct } from "./events.ts";
import { isWorkingStatus, mirrorOf, type MirrorThread } from "./mirror.ts";
import { CAUSES, needsYouLines, POSTS } from "./needs-you.ts";
import { adapterOf, questionRef, writeBack } from "./outbox.ts";
import {
  Backoff,
  later,
  logError,
  noWords,
  operation,
  shortError,
  withItem,
  type Caller,
  type FactoryRuntime,
  type IncomingItem,
  type LaunchSpec,
  type StageLaunch,
} from "./runtime.ts";
import { pendingRequests, T3McpError, t3Mcp } from "./t3-mcp.ts";

/**
 * The factory's controller: a state machine per item, driven by fixed code. Intake (intake.ts) adds items, the
 * dispatch loop starts queued runs as T3 Code threads within the limits, the mirror tells when a thread waits on a
 * person or ends without reporting, and `factory_report` moves the item on. Each change to an item runs as one step
 * under its lock (`withItem`), so a report, a loop and a person's action never interleave. Prompts judge; this file
 * guarantees. It tells what happened only by events (events.ts); the features that care subscribe to them.
 */

export class ReportError extends Error {
  override name = "ReportError";
}

const HOUR = 3600_000;
/** Launches of one run that failed in a row before its item counts as stuck. */
const STUCK_LAUNCHES = 3;
const PAUSED = "factory:paused";

interface Memory {
  watching: boolean;
  /** Runs whose thread was seen working since the factory last sent it a message. */
  seen: Set<string>;
  /** Threads the factory interrupted, to settle once T3 shows their turn stopped. */
  stopping: Set<string>;
  /** Per run, when its next launch may start after one failed, rather than every 5 seconds; the count of failures is
   * on the run. */
  launches: Backoff;
  quota?: { waitingUntil?: number };
  /** Why each item that needs nobody waits (`waitFor`), by item; `run` is the queued run a dispatch wait is about. */
  waits: Map<string, ItemWaiting & { run?: string }>;
  projects: Map<string, { projectId: string; root: string; branch?: string }>;
  /** When each queued run last read its item's issue as open, so a run that waits (red CI) reads it every 2 minutes,
   * not every pass; every new run reads it before it starts. */
  openAt: Map<string, number>;
}
const memory = (f: FactoryRuntime) =>
  f.memory("controller", (): Memory => ({
    watching: false,
    seen: new Set(),
    stopping: new Set(),
    launches: new Backoff(f.s, { baseMs: 30_000, maxMs: 15 * 60_000 }),
    projects: new Map(),
    openAt: new Map(),
    waits: new Map(),
  }));

/** How long dispatch waits for quota now, for the board; undefined while it waits for none. */
export const quotaWait = (f: FactoryRuntime) => memory(f).quota;

export const limitsOf = (f: FactoryRuntime) => currentFolder(f)?.config.limits ?? DEFAULT_LIMITS;

/** `agentgate factory pause`: on the factory machine, no intake, no launches and no nudges until `resume`. */
export const isPaused = (f: FactoryRuntime) => f.s.local(PAUSED) === "1";

/** The repository's settings in the folder the item started under. */
export function repositoryOf(f: FactoryRuntime, item: Pick<FactoryItem, "repo" | "configCommit">) {
  const repos = folderFor(f, item.configCommit)?.config.repositories ?? {};
  const name = Object.keys(repos).find((r) => r.toLowerCase() === item.repo.toLowerCase());
  return name ? repos[name] : undefined;
}

// ---- phases

/**
 * What the controller does the same for every phase. A phase with `done` is a stage, named like its run kind: entering
 * it queues that run (`moveOn`), and the run's report with the outcome done needs a result of this shape (`takeReport`).
 * In a phase with `pr` the PR follower (pr.ts) follows the item's PR.
 */
export const PHASES: Record<ItemPhase, { done?: string; pr?: true }> = {
  held: {},
  triage: { done: '{ kind: "triage", route, reproduction }' },
  spec: { done: '{ kind: "spec", spec, review, approved, feedback? }' },
  implement: { done: '{ kind: "implement", prUrl, commit, claims, notChecked, decisions }' },
  pr: { pr: true },
  review: { done: '{ kind: "review", prUrl, commit, findings, testsFailWithoutFix, risk? }', pr: true },
  ready: { pr: true },
  shipped: {},
  closed: {},
};

/** Whether the PR follower follows the item's PR now. */
export const followsPr = (item: FactoryItem | undefined): item is FactoryItem & { pr: ItemPr } =>
  !!item?.pr && !!PHASES[item.phase].pr;

/** Whether the run's thread owns its item's PR while the item is open: such a thread is not settled, can still work,
 * and is the one the PR follower nudges. */
function ownsPr(f: FactoryRuntime, run: Pick<FactoryRun, "id" | "item">) {
  const item = run.item ? items.get(f.s, run.item) : undefined;
  return !!item?.pr && item.pr.run === run.id && isOpenPhase(item.phase);
}

/** A stage run's branch: `factory/<key>-<kind>-<n>` for its item's n-th run of the kind, so a retry never meets the
 * worktree of the one before it. */
function stageBranch(f: FactoryRuntime, run: FactoryRun, item: FactoryItem) {
  const n = runs.forItem(f.s, item.id).filter((r) => r.kind === run.kind && r.queuedAt <= run.queuedAt).length;
  // The run's own tail too: an item taken in again for the same issue counts from 1 again, and the branch an earlier
  // item's run left in T3 Code's clone would stop the new worktree.
  return `factory/${item.key}-${run.kind}-${n}-${run.id.slice(-6).toLowerCase()}`;
}

/** The part of a stage run's launch every stage shares: the item's repository, a title naming the stage and the item,
 * the default branch to start from, a branch of its own, and its stage file's model. */
async function stageLaunch(
  f: FactoryRuntime,
  run: FactoryRun,
  item: FactoryItem,
  own: StageLaunch,
  model: FactoryModel | undefined,
): Promise<LaunchSpec> {
  return {
    repo: item.repo,
    title: own.title ?? `${run.kind[0]!.toUpperCase()}${run.kind.slice(1)} ${item.key}: ${item.title}`,
    brief: own.brief,
    baseRef: await defaultBranch(f, item.repo),
    branch: own.branch ?? stageBranch(f, run, item),
    ...(model && { model }),
  };
}

/**
 * How a stage's result moves the item on: it enters `to`, the run of that phase's stage is queued, and the issue hears
 * `moment`, when given. `approved` and `clearWait` are `enqueueRun`'s and `moveItem`'s.
 */
export function moveOn(
  f: FactoryRuntime,
  item: FactoryItem,
  to: ItemPhase,
  options: {
    moment?: Moment;
    comment?: Parameters<typeof writeBack>[3];
    approved?: boolean;
    clearWait?: boolean;
  } = {},
): FactoryItem {
  const moved = moveItem(f, item.id, to, options.clearWait);
  if (isStage(to)) enqueueRun(f, { kind: to, item: item.id, ...(options.approved && { approved: true }) });
  if (options.moment) writeBack(f, moved, options.moment, options.comment);
  return moved;
}

// ---- items and runs

/** `approved`: a person started this stage, so `start: manual` does not hold it again. */
export function enqueueRun(
  f: FactoryRuntime,
  input: {
    kind: RunKind;
    item?: string;
    configCommit?: string;
    attempt?: number;
    checked?: RunData;
    approved?: boolean;
  },
): FactoryRun {
  const item = input.item ? items.get(f.s, input.item) : undefined;
  const configCommit = input.configCommit ?? item?.configCommit ?? currentFolder(f)?.commit;
  if (!configCommit) throw new Error("The factory's folder has not loaded yet; see agentgate factory status");
  // `start: manual` holds the item before the stage, not every round of it: a retry, a spec round the maintainer asked
  // for or a re-review goes on. Dispatch leaves the run queued while the item waits for the maintainer.
  const holds =
    item &&
    !input.approved &&
    isStage(input.kind) &&
    folderFor(f, configCommit)?.stages[input.kind]?.file.start === "manual" &&
    !runs.forItem(f.s, item.id).some((r) => r.kind === input.kind);
  const run = runs.insert(f.s, {
    id: newId("run"),
    ...(input.item && { item: input.item }),
    ...(input.checked?.kind === "scout" && { source: input.checked.source }),
    kind: input.kind,
    attempt: input.attempt ?? 1,
    state: "queued",
    ...(input.checked !== undefined && { checked: input.checked }),
    nudges: 0,
    configCommit,
  });
  const what = item ? `${input.kind} for ${item.key}` : input.kind;
  f.events.emit({ kind: "run.queued", run: run.id, ...(input.item && { item: input.item }), text: `Queued ${what}` });
  if (holds) ask(f, item, { cause: "held", question: `Start ${input.kind}?`, run });
  return run;
}

/** The key, or the key with the first free suffix (`-2`, `-3`…) when another item has it: keys name branches. */
function freeKey(f: FactoryRuntime, key: string) {
  let candidate = key;
  for (let n = 2; items.keyTaken(f.s, candidate); n++) candidate = `${key}-${n}`;
  return candidate;
}

/** One item per issue, whichever source took it in. A new item is held, or enters triage with a queued triage run, and
 * its issue hears that the factory took it. */
export function addItem(
  f: FactoryRuntime,
  input: { source: string; repo: string; incoming: IncomingItem; hold?: boolean },
): FactoryItem {
  const { s } = f;
  const { incoming } = input;
  const existing = items.byExternal(s, incoming.externalId);
  if (existing) return existing;
  const folder = currentFolder(f);
  if (!folder) throw new Error("The factory's folder has not loaded yet; see agentgate factory status");
  const held = !!input.hold || folder.stages.triage?.file.start === "manual";
  const key = freeKey(f, incoming.key);
  const item = items.insert(s, {
    id: newId("it"),
    source: input.source,
    externalId: incoming.externalId,
    key,
    repo: input.repo,
    title: incoming.title,
    ...(incoming.url && { url: incoming.url }),
    snapshot: incoming.snapshot,
    phase: held ? "held" : "triage",
    configCommit: folder.commit,
    ...(incoming.dedupe && { dedupe: incoming.dedupe }),
  });
  f.events.emit({
    kind: "item.created",
    item: item.id,
    text: `${item.key} entered from ${item.source}${held ? " and waits for approval" : ""}: ${item.title}`,
  });
  writeBack(f, item, "taken", held ? { text: "It starts once the maintainer approves it." } : {});
  if (!held) enqueueRun(f, { kind: "triage", item: item.id });
  return held ? ask(f, item, { cause: "held", question: "Start triage?" }) : item;
}

/** `clearWait` also ends what the item waits for the person to do. */
export function moveItem(f: FactoryRuntime, item: string, to: ItemPhase, clearWait = false): FactoryItem {
  const before = items.get(f.s, item);
  if (!before) throw new Error(`no factory item ${item}`);
  const after = items.update(f.s, item, {
    phase: to,
    ...(before.phase !== to && { phaseAt: f.s.now() }),
    ...(clearWait && { needsYou: undefined }),
  });
  if (before.phase !== to) {
    f.events.emit({
      kind: "item.phase",
      item,
      from: before.phase,
      to,
      text: `${before.key} moved from ${before.phase} to ${to}`,
    });
    if (!isOpenPhase(to)) stopWaiting(f, item);
  }
  return after;
}

/** What an item waits for the person to do, past its cause; the cause decides the kind (`CAUSES`). */
export interface Ask {
  cause: NeedsYouCause;
  question: string;
  detail?: string;
  recommendation?: string;
  options?: string[];
  link?: string;
  /** The run that asks, which the answer goes back to. */
  run?: FactoryRun;
  /** A thread's question card: T3's pending request. */
  request?: string;
  /** The stage's report, for the comment's marker and summary. */
  report?: FactoryReport;
}

/**
 * The one way an item starts waiting for the person: it sets the wait, records the event the board, notify.ts and the
 * webhooks hear, and claims the `waiting` comment when the kind posts one (`POSTS`), once per run and question. The
 * comment and the CLI render the same block (`needsYouLines`), with the actions the daemon takes now.
 */
export function ask(f: FactoryRuntime, item: FactoryItem, input: Ask): FactoryItem {
  const { kind, title } = CAUSES[input.cause];
  const needsYou: NeedsYou = {
    kind,
    cause: input.cause,
    title,
    question: input.question,
    ...(input.detail && { detail: input.detail }),
    ...(input.recommendation && { recommendation: input.recommendation }),
    ...(input.options?.length && { options: input.options }),
    ...(input.link && { link: input.link }),
    since: f.s.now(),
    ...(input.run && { run: input.run.id }),
    ...(input.request !== undefined && { request: input.request }),
  };
  const after = items.update(f.s, item.id, { needsYou });
  f.events.emit({
    kind: "item.needs-you",
    item: item.id,
    cause: input.cause,
    text: `${after.key} needs you (${title}): ${input.question}`,
  });
  if (POSTS[kind])
    writeBack(f, after, "waiting", {
      text: needsYouLines(after.key, needsYou, actionsOf(f, after)).join("\n"),
      ref: questionRef(input.run?.id ?? input.cause, input.question),
      ...(input.report && { report: input.report }),
    });
  return after;
}

/** Ends what the item waits for, without an event: whoever answered already caused one. */
export const stopAsking = (f: FactoryRuntime, item: string) => items.update(f.s, item, { needsYou: undefined });

/** Whether the item waits on this run's question card in T3 Code. */
const asksInT3 = (item: FactoryItem | undefined, run: FactoryRun) =>
  item?.needsYou?.request !== undefined && item.needsYou.run === run.id;

/** Records something a person did to the item, for the human-touches metric. */
export function touched(f: FactoryRuntime, item: FactoryItem, act: HumanAct, text: string) {
  const current = items.get(f.s, item.id);
  if (current) items.update(f.s, item.id, { touches: current.touches + 1 });
  f.events.emit({ kind: "human", item: item.id, act, text: `${item.key}: ${text}` });
}

/** The person answered the thread's question in T3 Code, so the item no longer waits for them, and T3 showing that
 * request again does not ask again. */
function answeredInT3(f: FactoryRuntime, item: FactoryItem, run: FactoryRun) {
  runs.update(f.s, run.id, { answered: item.needsYou?.request });
  stopAsking(f, item.id);
  touched(f, item, "answer", "answered in T3 Code");
}

/** How events name a run: by its item's key where it has one, which is what a person knows it by. */
const runName = (f: FactoryRuntime, run: FactoryRun) => {
  const item = run.item ? items.get(f.s, run.item) : undefined;
  return item ? `${item.key}'s ${run.kind}` : `${run.kind} run ${run.id}`;
};

/** Ends a run; records.ts reads its tokens when it hears `run.ended`. The event names `patch.error`, when given, as why
 * the run ended. */
export function endRun(f: FactoryRuntime, run: FactoryRun, state: RunState, patch: Partial<FactoryRun> = {}) {
  const ended = runs.update(f.s, run.id, { ...patch, state, endedAt: f.s.now() });
  memory(f).seen.delete(run.id);
  memory(f).openAt.delete(run.id);
  f.events.emit({
    kind: "run.ended",
    run: run.id,
    ...(run.item && { item: run.item }),
    state,
    text: `${runName(f, run)} ended: ${patch.error ?? state}`,
  });
  return ended;
}

/** For a run kind's `launch` that will never start the run: it ends cancelled, and says why. */
export function cancelLaunch(f: FactoryRuntime, run: FactoryRun, why: string) {
  endRun(f, run, "cancelled", { error: why });
  return { cancelled: true } as const;
}

/**
 * The one way an item ends, shipped or closed. Its queued runs are cancelled, and with `interrupt` its threads are
 * stopped and settled; a report that closes the item comes from a thread mid-turn, which settles once it ends instead.
 * `comment` is what the issue hears, `note` what the event list does. Its `item.phase` event has records.ts read the
 * threads' tokens again, since a thread can work on after its run reported.
 */
export async function finishItem(
  f: FactoryRuntime,
  item: FactoryItem,
  to: "shipped" | "closed",
  options: {
    interrupt: boolean;
    reason: string;
    comment?: { text: string; report?: FactoryReport; commit?: string };
    note?: boolean;
  },
) {
  if (options.note) f.events.emit({ kind: "note", item: item.id, text: options.reason });
  if (options.interrupt) await interruptItem(f, item.id, options.reason);
  else for (const run of runs.forItem(f.s, item.id)) if (run.state === "queued") endRun(f, run, "cancelled");
  // The item as it was, so the marker names the stage it ended in. Claimed before the move, so the comment is sent
  // before the steps the move's event queues, such as reading the threads' tokens again.
  if (options.comment) writeBack(f, item, to, options.comment);
  moveItem(f, item.id, to, true);
}

/** An item that ends at a report or a rejection: no thread of it is working, or the one reporting settles itself. */
export const closeItem = (f: FactoryRuntime, item: FactoryItem, reason: string, report?: FactoryReport) =>
  finishItem(f, item, "closed", { interrupt: false, reason, comment: { text: reason, ...(report && { report }) } });

// ---- T3

/** This machine's T3 project for the repository, cloned and registered when it has none. */
async function project(f: FactoryRuntime, repo: string): Promise<{ projectId: string; root: string; branch?: string }> {
  const m = memory(f);
  const known = m.projects.get(repo.toLowerCase());
  if (known && existsSync(known.root)) return known;
  const url = `https://github.com/${repo}.git`;
  const found = await findProject(f.ctx.handoffs, url);
  const resolved = found
    ? { projectId: found.id, root: found.workspaceRoot }
    : await cloneProject(f.ctx.handoffs, url).then((c) => ({ projectId: c.projectId, root: c.main }));
  m.projects.set(repo.toLowerCase(), resolved);
  return resolved;
}

/** The repository's default branch, read from its T3 project's checkout. */
export async function defaultBranch(f: FactoryRuntime, repo: string) {
  const p = await project(f, repo);
  if (p.branch) return p.branch;
  const local = await git(p.root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  let branch = local.ok ? local.out.replace(/^origin\//, "") : undefined;
  if (!branch) {
    const remote = await git(p.root, ["ls-remote", "--symref", "origin", "HEAD"]);
    branch = remote.out.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1];
  }
  if (!branch) throw new Error(`git cannot read the default branch of ${repo} in ${p.root}`);
  p.branch = branch;
  return branch;
}

/** The branches origin has under `prefix`, asked of origin itself: the checkout's own copy of them can be stale. */
export async function originBranches(f: FactoryRuntime, repo: string, prefix: string): Promise<string[]> {
  const { root } = await project(f, repo);
  const listed = await git(root, ["ls-remote", "--heads", "origin", `refs/heads/${prefix}*`]);
  if (!listed.ok) throw new Error(`git cannot list the branches of ${repo} in ${root}`);
  return listed.out.split("\n").flatMap((line) => line.match(/\trefs\/heads\/(.+)$/)?.[1] ?? []);
}

type ThreadAction = { action: "send"; text: string } | { action: "interrupt"; text: string } | { action: "settle" };

/** Acts on the run's thread through T3's MCP. A run's thread is always this machine's: a handoff detaches it. */
async function actOnThread(f: FactoryRuntime, run: FactoryRun, action: ThreadAction): Promise<void> {
  if (!run.threadId) throw new Error(`run ${run.id} has no thread yet`);
  const threadId = run.threadId;
  const mcp = t3Mcp(f);
  if (action.action === "send") await mcp.call("t3_thread_send", { threadId, message: action.text, mode: "queue" });
  else if (action.action === "interrupt") await mcp.call("t3_thread_interrupt", { threadId, reason: action.text });
  else await mcp.call("t3_thread_organize", { threadId, action: "settle" });
}

/** For actions whose caller goes on regardless: the failure is the run's error and a note. */
const threadFailed = (f: FactoryRuntime, run: FactoryRun, what: string) => (e: unknown) => {
  const text = `${what} the thread of ${runName(f, run)} failed: ${shortError(e)}`;
  runs.update(f.s, run.id, { error: text });
  f.events.emit({ kind: "note", run: run.id, ...(run.item && { item: run.item }), text });
};

export async function sendToThread(f: FactoryRuntime, run: FactoryRun, text: string): Promise<void> {
  await actOnThread(f, run, { action: "send", text });
}

/** A reported run goes on once its thread got the message that resumes it. T3 can show the new turn before the send
 * answers, while the run was not running yet, so a thread at work now counts as seen. */
export function resumeRun(f: FactoryRuntime, run: FactoryRun) {
  runs.update(f.s, run.id, { state: "running", endedAt: undefined });
  if (working(f, run.threadId ? mirrorOf(f).thread(run.threadId) : undefined)) memory(f).seen.add(run.id);
}

/** Interrupts the item's running threads, settles every thread it used, and cancels its runs that have not ended. */
export async function interruptItem(f: FactoryRuntime, item: string, reason: string): Promise<void> {
  const mirror = mirrorOf(f);
  const all = runs.forItem(f.s, item);
  // Cancelled first, all at once, so the mirror does not take an interrupted thread for a silent end, and no report
  // arriving meanwhile finds a run that still takes one.
  const active = new Set(all.filter((run) => ACTIVE.includes(run.state)).map((run) => run.id));
  for (const run of all) if (active.has(run.id)) endRun(f, run, "cancelled");
  for (const run of all) {
    if (!run.threadId) continue;
    const thread = mirror.thread(run.threadId);
    // A reported run's thread can still work: the implement thread owns its PR until the item ships.
    if (active.has(run.id) || working(f, thread)) {
      // T3 settles a thread only once its turn stopped, which the mirror shows a moment after the interrupt.
      const turn = !thread || isWorkingStatus(thread.status);
      if (turn) memory(f).stopping.add(run.threadId);
      await actOnThread(f, run, { action: "interrupt", text: reason.slice(0, 2000) }).catch(
        threadFailed(f, run, "Interrupting"),
      );
      if (turn) continue;
    }
    // The mirror shows this machine's threads only; settling a settled thread on another machine changes nothing.
    if (!thread?.settled) await actOnThread(f, run, { action: "settle" }).catch(threadFailed(f, run, "Settling"));
  }
}

const launchAnswer = z.object({ threadId: z.string().min(1), link: z.string().optional() });

/** A run cancelled while its launch was in flight ended without a thread to stop. Its new thread is interrupted and
 * settled, so it spends nothing; true when the run ended. */
async function endedWhileStarting(f: FactoryRuntime, id: string) {
  const run = runs.get(f.s, id)!;
  if (run.state === "starting") return false;
  // Settled once the mirror shows the turn stopped (`settleFinished`).
  memory(f).stopping.add(run.threadId!);
  await actOnThread(f, run, { action: "interrupt", text: `The factory ${run.state} this run as it started.` }).catch(
    threadFailed(f, run, "Interrupting"),
  );
  return true;
}

/** True when the run's thread started. */
async function start(f: FactoryRuntime, run: FactoryRun, item: FactoryItem | undefined, spec: LaunchSpec) {
  const { s } = f;
  const { projectId } = await project(f, spec.repo);
  const mcp = t3Mcp(f);
  // T3 finds the thread of a retried launch by `clientRequestId` within one MCP session only, so the session is noted
  // first: a launch whose answer was lost is sent again only under it. A drop meanwhile ended the run: nothing starts.
  const launchSession = await mcp.sessionId();
  const current = runs.get(s, run.id);
  if (current?.state !== "queued" && current?.state !== "starting") return false;
  runs.update(s, run.id, { state: "starting", launchSession });
  const answer = launchAnswer.safeParse(
    await mcp.call(
      "t3_thread_launch",
      {
        projectId,
        clientRequestId: run.id,
        title: spec.title.slice(0, 200),
        runtimeMode: "full-access",
        workspaceStrategy: {
          type: "worktree",
          baseRef: spec.baseRef,
          branch: spec.branch,
          startFromOrigin: true,
        },
        ...(spec.model && { modelSelection: spec.model }),
        message: spec.brief,
      },
      { session: launchSession },
    ),
  );
  if (!answer.success) throw new Error("T3 Code's t3_thread_launch answered without a thread id");
  const { threadId, link } = answer.data;
  runs.update(s, run.id, { threadId, ...(link && { threadLink: link }), node: s.nodeId });
  if (await endedWhileStarting(f, run.id)) return false;
  runs.update(s, run.id, { state: "running", startedAt: s.now(), error: undefined });
  if (run.item) stopWaiting(f, run.item);
  // T3 may show the turn running before the launch answers, when the run did not know its thread yet. A launch sent
  // again after a restart can find its turn already over, which the watcher saw before the run knew its thread.
  const thread = mirrorOf(f).thread(threadId);
  if (working(f, thread)) memory(f).seen.add(run.id);
  else if (thread && thread.status !== "idle")
    later(f, run.item ?? run.id, `Checking ${run.id}'s finished turn`, () => threadChanged(f, run.id, true));
  f.events.emit({
    kind: "run.started",
    run: run.id,
    ...(item && { item: item.id }),
    text: `Started ${run.kind}${item ? ` for ${item.key}` : ""} in T3 Code`,
  });
  return true;
}

/** A launch whose answer never came, sent under a T3 MCP session that has since ended. T3 would not find its thread
 * again, so sending it once more could start a second thread on the same item: it is not sent, and a person looks. */
function launchUncertain(f: FactoryRuntime, run: FactoryRun, item: FactoryItem | undefined) {
  endRun(f, run, "failed", { error: "its launch may have started a thread before T3 Code's sign-in changed" });
  if (item)
    ask(f, item, {
      cause: "stuck",
      question: `A launch of ${item.key}'s ${run.kind} stage may have started a thread before T3 Code's sign-in changed. Look for it in T3 Code before you retry it.`,
      run,
    });
}

// ---- limits and dispatch

/** A thread whose turn goes on: a T3 run that has not finished (`waiting` counts: the turn waits on background work or
 * a subagent), or a subagent thread under it that works. A thread that waits for a person does not count. */
function working(f: FactoryRuntime, t: MirrorThread | undefined, visited = new Set<string>()): boolean {
  // The parent links are T3's: two threads that name each other must not recurse forever.
  if (!t || t.needsYou || visited.has(t.id)) return false;
  visited.add(t.id);
  if (isWorkingStatus(t.status)) return true;
  return mirrorOf(f)
    .threads()
    .some((child) => child.parentThreadId === t.id && working(f, child, visited));
}

/** Working runs: stage runs, and scout runs. A starting run counts; a thread that waits for a person, or sits idle
 * owning a PR, does not; a running one T3 has not shown yet does. */
function workingCounts(f: FactoryRuntime) {
  const mirror = mirrorOf(f);
  const counts = { stage: 0, scout: 0 };
  for (const run of runs.heads(f.s, ["starting", "running", "waiting", "reported"])) {
    const thread = run.threadId ? mirror.thread(run.threadId) : undefined;
    const busy =
      run.state === "starting" || (!!run.threadId && (thread ? working(f, thread) : run.state === "running"));
    if (busy) counts[isStage(run.kind) ? "stage" : "scout"]++;
  }
  return counts;
}

export function workingCount(f: FactoryRuntime): number {
  const { stage, scout } = workingCounts(f);
  return stage + scout;
}

/** The pool this model draws on. T3 names providers by its instance ids, such as `claudeAgent`. */
function providerOf(model: FactoryModel | undefined): ProviderName | undefined {
  const name = (model?.provider ?? "claude").toLowerCase();
  return (["claude", "codex", "cursor"] as const).find((p) => name.includes(p));
}

/** The waits dispatch tells the event list of; a free thread or a PR's checks are waited for too often to note. */
const NOTED: readonly ItemWaiting["on"][] = ["quota", "default-branch", "launch"];

/** Records why an item that needs nobody waits, for the board: on what, since when, and a sentence for a person.
 * `run` names a queued run, whose start ends the wait. */
export function waitFor(f: FactoryRuntime, item: string, on: ItemWaiting["on"], text: string, run?: FactoryRun) {
  const waits = memory(f).waits;
  const before = waits.get(item);
  if (before?.on === on && before.text === text) return;
  waits.set(item, { on, text, since: before?.on === on ? before.since : f.s.now(), ...(run && { run: run.id }) });
  if (run && NOTED.includes(on))
    f.events.emit({
      kind: "note",
      run: run.id,
      item,
      text: `${runName(f, run)} ${text[0]!.toLowerCase()}${text.slice(1)}`,
    });
}

/** Ends the item's wait, or only a wait on one of `on`. */
export function stopWaiting(f: FactoryRuntime, item: string, on?: readonly ItemWaiting["on"][]) {
  const waits = memory(f).waits;
  const wait = waits.get(item);
  if (wait && (!on || on.includes(wait.on))) waits.delete(item);
}

/** What the board shows the item waits for: nothing while it needs the person, or once the run it waited to start
 * has started or ended. */
export function waitingOf(f: FactoryRuntime, item: FactoryItem): ItemWaiting | undefined {
  const wait = memory(f).waits.get(item.id);
  if (!wait || item.needsYou || !isOpenPhase(item.phase)) return undefined;
  const run = wait.run ? runs.get(f.s, wait.run) : undefined;
  if (wait.run && run?.state !== "queued" && run?.state !== "starting") return undefined;
  return { on: wait.on, since: wait.since, text: wait.text };
}

/** Stage runs first, then scout runs, each oldest first. */
const byPriority = (a: FactoryRun, b: FactoryRun) =>
  Number(!isStage(a.kind)) - Number(!isStage(b.kind)) || a.queuedAt - b.queuedAt;

async function dispatch(f: FactoryRuntime) {
  const { s } = f;
  if (!f.pointer()) return;
  watch(f);
  detachHandedOff(f);
  if (isPaused(f)) return;
  const m = memory(f);
  const limits = limitsOf(f);
  const counts = workingCounts(f);
  let quota: Memory["quota"];
  // A run left `starting` was cut off by a restart; launching it again finds the same thread.
  for (const queued of runs.list(s, { states: ["queued", "starting"] }).toSorted(byPriority)) {
    if (!f.runKinds.has(queued.kind)) continue;
    if (!m.launches.due(queued.id)) continue;
    const stage = isStage(queued.kind);
    if (counts.stage + counts.scout >= limits.threads) {
      if (queued.item)
        waitFor(f, queued.item, "thread", `Waits for a free thread; all ${limits.threads} are working`, queued);
      continue;
    }
    // Scout runs leave a slot for the items' work.
    if (!stage && counts.scout >= Math.max(1, limits.threads - 1)) continue;
    const outcome = await launchRun(f, queued);
    if (outcome.quota) quota = outcome.quota;
    if (outcome.started) counts[stage ? "stage" : "scout"]++;
  }
  m.quota = quota;
}

type Launch = { started?: true; quota?: Memory["quota"] };

/** What a queued run starts with, decided as a step of its item, which may have changed while the step waited: the
 * launch spec, or why it does not start now. */
async function prepareLaunch(
  f: FactoryRuntime,
  id: string,
): Promise<Launch | { run: FactoryRun; item?: FactoryItem; spec: LaunchSpec }> {
  const { s } = f;
  const run = runs.get(s, id);
  if (!run || (run.state !== "queued" && run.state !== "starting")) return {};
  const definition = f.runKinds.get(run.kind)!;
  const item = run.item ? items.get(s, run.item) : undefined;
  if (run.item && (!item || !isOpenPhase(item.phase))) {
    endRun(f, run, "cancelled");
    return {};
  }
  // An item that waits for the maintainer starts nothing until they answer.
  if (item?.needsYou) return {};
  if (run.launchSession && run.launchSession !== t3Mcp(f).session()) {
    launchUncertain(f, run, item);
    return {};
  }
  // Quota first: building the launch reads GitHub and renders the brief, which must not repeat every pass.
  const model = isStage(run.kind)
    ? folderFor(f, run.configCommit)?.stages[run.kind]?.file.model
    : definition.model?.(run);
  const provider = providerOf(model);
  // Only a pool that can serve can be waited for: without signed-in accounts here, T3 runs on its own logins.
  const pooled =
    provider &&
    s.list("account").some((a) => {
      const credential = s.get("credential", a.id);
      return a.provider === provider && a.enabled && credential && !credential.needsLogin;
    });
  if (limitsOf(f).waitForQuota && pooled && !candidates(s, provider).length) {
    const until = earliestReset(s, provider);
    if (run.item)
      waitFor(
        f,
        run.item,
        "quota",
        `Waits for quota: no ${provider} account has room${until ? ` until ${time(until)}` : ""}`,
        run,
      );
    return { quota: { ...(until !== undefined && { waitingUntil: until }) } };
  }
  const openAt = memory(f).openAt;
  if (item && s.now() - (openAt.get(run.id) ?? 0) >= 2 * 60_000) {
    if (await issueOpen(f, item)) openAt.set(run.id, s.now());
    else if (!item.pr) {
      // The source closed it, so the item closes without a comment: the issue already says so. Once the item has a
      // PR, the PR decides instead: "Fixes #N" closes the issue as the PR merges, and the merge ships it.
      await finishItem(f, item, "closed", {
        interrupt: true,
        reason: `${item.key} was closed at its source`,
        note: true,
      });
      return {};
    }
  }
  const launch = await definition.launch(run, item);
  if ("cancelled" in launch) return {};
  if ("wait" in launch) {
    if (run.item) waitFor(f, run.item, launch.wait, launch.text, run);
    return {};
  }
  if ("repo" in launch) return { run, ...(item && { item }), spec: launch };
  if (!item) throw new Error(`the ${run.kind} run ${run.id} has no item`);
  return { run, item, spec: await stageLaunch(f, run, item, launch, model) };
}

/** Starts one queued run. The launch itself is outside the item's step, since creating a worktree can take minutes:
 * a drop meanwhile ends the run, and the thread T3 then starts is stopped (`endedWhileStarting`). */
async function launchRun(f: FactoryRuntime, queued: FactoryRun): Promise<Launch> {
  const { s } = f;
  const m = memory(f);
  try {
    const ready = await (queued.item
      ? withItem(f, queued.item, () => prepareLaunch(f, queued.id))
      : prepareLaunch(f, queued.id));
    if (!("spec" in ready)) return ready;
    if (!(await start(f, ready.run, ready.item, ready.spec))) return {};
    m.launches.ok(queued.id);
    if (runs.get(s, queued.id)?.failedLaunches) runs.update(s, queued.id, { failedLaunches: undefined });
    return { started: true };
  } catch (e) {
    const run = queued;
    const failures = (runs.get(s, run.id)?.failedLaunches ?? 0) + 1;
    const retryAt = m.launches.failed(run.id, failures);
    const current = runs.get(s, run.id) ? runs.update(s, run.id, { failedLaunches: failures }) : undefined;
    // A run without an item has nobody to wait for: after as many failed launches as make an item stuck, it ends, and
    // its schedule (a scout's) queues a fresh one.
    if (current && !current.item && ACTIVE.includes(current.state) && failures >= STUCK_LAUNCHES) {
      m.launches.ok(run.id);
      endRun(f, current, "failed", { error: `starting it failed ${failures} times: ${shortError(e)}` });
      return {};
    }
    if (current && ACTIVE.includes(current.state)) {
      // T3 answered this first send with an error, so no thread exists: the next launch may go under any session.
      // After a send whose answer was lost, the thread may exist: only that session can find it again.
      const answered = e instanceof T3McpError && e.answered && !queued.launchSession;
      const error = `starting it failed: ${shortError(e)}`;
      runs.update(s, run.id, {
        ...(current.state === "starting" && { state: "queued" as const }),
        ...(answered && { launchSession: undefined }),
        error,
      });
      if (current.item) waitFor(f, current.item, "launch", `Waits to try again at ${time(retryAt)}: ${error}`, current);
      else if (current.error !== error)
        f.events.emit({ kind: "note", run: run.id, text: `${runName(f, run)}: ${error}` });
    }
    return {};
  }
}

/** Whether the item's issue is still open at its source. An item without an issue always is. */
async function issueOpen(f: FactoryRuntime, item: FactoryItem) {
  const check = adapterOf(f, item)?.check;
  return !check || (await check(item)).open;
}

// ---- watching threads

function watch(f: FactoryRuntime) {
  const m = memory(f);
  if (m.watching) return;
  m.watching = true;
  const mirror = mirrorOf(f);
  mirror.onChange((thread, previous) => {
    onThread(f, thread, previous).catch((e) =>
      console.error(`factory: watching thread ${thread.id} failed: ${logError(e)}`),
    );
  });
  mirror.onRemove((thread) => {
    for (const run of runs.byThreads(f.s, [thread.id]))
      if (ACTIVE.includes(run.state) || ownsPr(f, run))
        later(f, run.item ?? run.id, `Ending ${run.id} after its thread was deleted`, () => threadDeleted(f, run.id));
  });
}

const reminder = (run: FactoryRun) =>
  `Your turn ended without a report to the factory. Finish the ${run.kind} stage and call the AgentGate MCP tool \`factory_report\` with \`run: "${run.id}"\`. If you cannot finish, report \`blocked\` with what is missing, or \`needs-decision\` with one question and your recommendation.`;

/** The thread a run would own: the top of the subagent chain. It runs on every thread change, so a cycle in T3's
 * parent links ends the walk rather than freezing the daemon. */
function rootOf(f: FactoryRuntime, thread: MirrorThread) {
  const mirror = mirrorOf(f);
  const visited = new Set([thread.id]);
  let root = thread;
  for (let parent = root.parentThreadId; parent && !visited.has(parent); parent = root.parentThreadId) {
    const next = mirror.thread(parent);
    if (!next) break;
    visited.add(parent);
    root = next;
  }
  return root;
}

/** The run a thread works for, its own or, for a T3 subagent thread, its root thread's: a run that is active, or the
 * one whose thread owns its item's PR. */
function runOfThread(f: FactoryRuntime, thread: string) {
  const known = mirrorOf(f).thread(thread);
  const ids = known ? [...new Set([thread, rootOf(f, known).id])] : [thread];
  return runs
    .byThreads(f.s, ids)
    .filter((r) => ACTIVE.includes(r.state) || ownsPr(f, r))
    .at(-1);
}

/**
 * What the MCP gateway lets the sessions of a T3 Code thread use (R8): a stage run's thread, and the T3 subagent
 * threads under it, get agentgate's tools and the servers its stage file names in `mcp`, and a scout's thread those
 * its source names. Every other session gets every server its project maps, but not the tools made for a run's own
 * thread. The thread id is a label its shim sends, so this narrows a default and is no boundary.
 */
export function threadScope(f: FactoryRuntime, thread: string | undefined): SessionScope {
  const head = thread ? runOfThread(f, thread) : undefined;
  const run = head && runs.get(f.s, head.id);
  if (!run) return { hidden: [...f.operations.values()].flatMap((op) => (op.tool?.forRuns ? [op.tool.name] : [])) };
  const folder = folderFor(f, run.configCommit);
  const { checked } = run;
  const scout = checked?.kind === "scout" ? folder?.config.sources.find((x) => x.id === checked.source) : undefined;
  const servers = isStage(run.kind)
    ? folder?.stages[run.kind]?.file.mcp
    : scout?.type === "scout"
      ? scout.mcp
      : undefined;
  return { servers: servers ?? [] };
}

async function onThread(f: FactoryRuntime, changed: MirrorThread, previous: MirrorThread | undefined) {
  // A subagent's change can end its parent's turn: the run belongs to the parent.
  const thread = rootOf(f, changed);
  const run = runs.list(f.s, { states: ["running", "waiting"] }).find((r) => r.threadId === thread.id);
  if (!run) return settleFinished(f, thread);
  // Seen working now, not when the item's step runs: a short turn can end while the item is busy, such as with the
  // reminder that started it, and by then the mirror shows only its end, which would not count as one.
  if (working(f, thread)) memory(f).seen.add(run.id);
  // A turn that ended while this daemon was not watching shows first as a finished status.
  const endedUnseen = thread === changed && !previous && thread.status !== "idle";
  await withItem(f, run.item ?? run.id, () => threadChanged(f, run.id, endedUnseen));
}

async function threadChanged(f: FactoryRuntime, id: string, endedUnseen: boolean) {
  const { s } = f;
  const run = runs.get(s, id);
  const thread = run?.threadId ? mirrorOf(f).thread(run.threadId) : undefined;
  if (!run || !thread || (run.state !== "running" && run.state !== "waiting")) return;
  // A thread being handed to another machine stops here: that is its move, not a silent end, and the run leaves it.
  const handoff = handoffOfThread(f, thread.id);
  if (handoff) return detach(f, run.id, handoff.target);
  const m = memory(f);
  if (thread.needsYou) {
    if (run.state === "running") runs.update(s, run.id, { state: "waiting" });
    // Once per T3 request: one answered, or already asked, is not asked again when T3 shows it again.
    const request = thread.request ?? "";
    if (run.item && run.answered !== request && items.get(s, run.item)?.needsYou?.request !== request)
      later(f, run.item, `Reading what ${run.id}'s thread asks`, () => askThreadQuestion(f, run.id, request));
    return;
  }
  if (run.state === "waiting") {
    runs.update(s, run.id, { state: "running" });
    const item = run.item ? items.get(s, run.item) : undefined;
    if (asksInT3(item, run)) answeredInT3(f, item!, run);
  }
  if (working(f, thread)) {
    m.seen.add(run.id);
    return;
  }
  if (!m.seen.delete(run.id) && !endedUnseen) return;
  // T3 resumes a turn its own restart cut, so `interrupted` means someone stopped the thread: a reminder would start it
  // again behind their back.
  if (thread.status === "interrupted") return stopped(f, runs.get(s, run.id)!);
  // A thread that failed before T3 Code made its worktree never started: a reminder would only queue behind it.
  const unstarted = thread.status === "failed" && !thread.worktreePath;
  await silentEnd(f, runs.get(s, run.id)!, { remind: !unstarted });
}

/** A waiting thread's question, read from T3 Code into its item's wait, so the app, the CLI, Grok and the issue show it
 * and can answer it without T3: the first line as the question, the rest, such as a spec, as `detail`, and the card's
 * options. When T3 cannot be read, the wait says the thread asks in T3 Code. */
async function askThreadQuestion(f: FactoryRuntime, id: string, request: string) {
  const asking = () => {
    const run = runs.get(f.s, id);
    const item = run?.item ? items.get(f.s, run.item) : undefined;
    const fresh = run?.state === "waiting" && run.answered !== request && item?.needsYou?.request !== request;
    return fresh ? { run, item: item! } : undefined;
  };
  const before = asking();
  if (!before?.run.threadId) return;
  const requests = await pendingRequests(t3Mcp(f), before.run.threadId).catch(() => []);
  const now = asking();
  if (!now) return;
  const { run, item } = now;
  const questions = (
    requests.some((r) => r.requestId === request) ? requests.filter((r) => r.requestId === request) : requests
  ).flatMap((r) => r.questions);
  const text = questions
    .map((q) => q.question.trim())
    .filter(Boolean)
    .join("\n\n");
  const [first = `The ${run.kind} thread asks you something in T3 Code`, ...rest] = text ? text.split("\n") : [];
  const detail = rest.join("\n").trim();
  ask(f, item, {
    cause: "question",
    question: first.slice(0, 500),
    ...(detail && { detail: detail.slice(0, 20_000) }),
    options: questions.flatMap((q) => q.options.map((o) => o.label)).slice(0, 10),
    ...(run.threadLink && { link: run.threadLink }),
    run,
    request,
  });
}

/** Someone stopped a run's thread in T3 Code. The run ends, and its item waits for the maintainer to retry or drop it. */
function stopped(f: FactoryRuntime, run: FactoryRun) {
  endRun(f, run, "cancelled", { error: "stopped in T3 Code" });
  const item = run.item ? items.get(f.s, run.item) : undefined;
  if (item && isOpenPhase(item.phase)) markStopped(f, item, run);
}

export function markStopped(f: FactoryRuntime, item: FactoryItem, run: FactoryRun) {
  ask(f, item, {
    cause: "stopped",
    question: `Someone stopped ${item.key}'s ${run.kind} thread in T3 Code, so the factory leaves it alone.`,
    ...(run.threadLink && { link: run.threadLink }),
    run,
  });
}

/**
 * A run's thread was deleted in T3 Code, so nothing can report for the run any more: it ends failed. Its item waits for
 * the maintainer to retry or drop it. A run without an item, such as a scout's, has nobody to wait for, and its schedule
 * queues the next one. A deleted thread that owned its item's PR leaves the PR with nobody to nudge: the item waits the
 * same way, and `retry` starts an implement run that takes the PR over.
 */
async function threadDeleted(f: FactoryRuntime, id: string) {
  const run = runs.get(f.s, id);
  // The step may have waited behind another of its item, and the mirror may have learned of the thread meanwhile.
  if (!run?.threadId || mirrorOf(f).thread(run.threadId)) return;
  const active = run.state === "running" || run.state === "waiting";
  // A handed-off thread leaves its machine: that is `detach`'s, not a deletion.
  const owner = !active && ownsPr(f, run) && !handoffOfThread(f, run.threadId);
  if (!active && !owner) return;
  if (active) endRun(f, run, "failed", { error: "its thread was deleted in T3 Code" });
  const item = run.item ? items.get(f.s, run.item) : undefined;
  if (!item || !isOpenPhase(item.phase)) return;
  // The stuck loop finds a gone PR thread on every pass: the item is asked once.
  if (owner && item.needsYou?.cause === "deleted" && item.needsYou.run === run.id) return;
  ask(f, item, {
    cause: "deleted",
    question: owner
      ? `${item.key}'s implement thread, which owned its PR, was deleted in T3 Code, so nothing works on the PR.`
      : `${item.key}'s ${run.kind} thread was deleted in T3 Code, so its ${run.kind} stage ended.`,
    ...(owner && { link: item.pr!.url }),
    run,
  });
}

// ---- handoffs

/** The handoff that is moving, or moved, this machine's thread, unless it failed and the thread stayed. */
const handoffOfThread = (f: FactoryRuntime, thread: string) =>
  f.ctx.handoffs.list("source").find((job) => job.thread === thread && job.step !== "failed");

/**
 * A stage thread a person handed to another machine leaves the factory: its run ends, and the item waits for the
 * maintainer, who continues the thread there and then retries here, or drops the item. Its PR is still followed to its
 * merge or close. Following a thread across machines (its reports, reminders and tokens) cost more than it gave.
 */
function detach(f: FactoryRuntime, id: string, to: string) {
  const run = runs.get(f.s, id);
  if (!run) return;
  if (ACTIVE.includes(run.state)) endRun(f, run, "cancelled", { error: `handed off to ${to}` });
  const item = run.item ? items.get(f.s, run.item) : undefined;
  if (!item || !isOpenPhase(item.phase) || item.needsYou?.cause === "handed-off") return;
  ask(f, item, {
    cause: "handed-off",
    question: `${item.key}'s ${run.kind} thread was handed to ${to} and no longer works for the factory. Continue it there before you retry it here.`,
    ...(run.threadLink && { link: run.threadLink }),
    run,
  });
}

/** Handoffs of the threads that work for the factory: an active run's, or the one that owns an open item's PR. The
 * watcher catches most as the thread stops; this catches one it missed, such as across a restart. */
function detachHandedOff(f: FactoryRuntime) {
  for (const job of f.ctx.handoffs.list("source")) {
    if (job.step === "failed") continue;
    for (const head of runs.byThreads(f.s, [job.thread])) {
      const run = runs.get(f.s, head.id);
      if (!run) continue;
      const item = run.item ? items.get(f.s, run.item) : undefined;
      const owner = ownsPr(f, run);
      if (!ACTIVE.includes(run.state) && !(owner && item?.needsYou?.cause !== "handed-off")) continue;
      later(f, run.item ?? run.id, `Detaching ${run.id} from its handed-off thread`, async () =>
        detach(f, run.id, job.target),
      );
    }
  }
}

/** One reminder in the same thread; then attempt 2 in a new thread; a silent attempt 2 makes the item wait. */
async function silentEnd(f: FactoryRuntime, run: FactoryRun, { remind = true } = {}) {
  const { s } = f;
  if (remind && run.attempt === 1 && run.nudges === 0) {
    runs.update(s, run.id, { nudges: 1 });
    f.events.emit({
      kind: "note",
      run: run.id,
      ...(run.item && { item: run.item }),
      text: `Reminded ${runName(f, run)} thread to report`,
    });
    await sendToThread(f, run, reminder(run));
    return;
  }
  endRun(f, run, "silent");
  if (run.attempt < 2) {
    // What the factory gave or found for attempt 1, such as a scout run's source, holds for attempt 2 as well.
    enqueueRun(f, {
      kind: run.kind,
      ...(run.item && { item: run.item }),
      configCommit: run.configCommit,
      attempt: 2,
      ...(run.checked !== undefined && { checked: run.checked }),
    });
    return;
  }
  const item = run.item ? items.get(s, run.item) : undefined;
  if (!item || !isOpenPhase(item.phase)) return;
  ask(f, item, {
    cause: "failed",
    question: `The ${run.kind} stage ended twice without a report, and so did its retry. Read the thread before you retry it.`,
    ...(run.threadLink && { link: run.threadLink }),
    run,
  });
}

// ---- reports

const REQUIRED: Partial<Record<Outcome, { key: keyof FactoryReport; name: string }>> = {
  blocked: { key: "blocked", name: "blocked.missing" },
  "needs-decision": { key: "decision", name: "decision (question and recommendation)" },
  duplicate: { key: "duplicateOf", name: "duplicateOf" },
};
const CLOSING: Partial<Record<Outcome, (r: FactoryReport) => string>> = {
  "not-a-bug": () => "Triage found nothing here for the factory to fix.",
  duplicate: (r) => `This duplicates ${r.duplicateOf}.`,
  "already-fixed": () => "The default branch already fixes this.",
};

/** The run a call from a T3 thread names, when that thread is the run's own; with `subagents`, also a T3 subagent
 * thread under it, which may read the run's item but never report for it. Routing, not security (D35). */
export function ownRun(f: FactoryRuntime, id: string, caller: Caller, options: { subagents?: boolean } = {}) {
  const run = runs.get(f.s, id);
  if (!run) throw new ReportError(`${f.s.nodeId} has no factory run ${id}`);
  if (!caller.thread)
    throw new ReportError(
      `This call names no T3 Code thread, so it cannot be matched to run ${id}; make it from the run's thread`,
    );
  const thread = mirrorOf(f).thread(caller.thread);
  const own = caller.thread === run.threadId;
  const under = !!options.subagents && !!thread && rootOf(f, thread).id === run.threadId;
  if ((!own && !under) || caller.node !== run.node)
    throw new ReportError(`Run ${id} belongs to another T3 Code thread; report only on your own run`);
  return run;
}

/** A report, taken as one step of its item. It answers once the item has moved; what GitHub or Linear hears, and
 * settling the thread, follow in later steps. */
async function acceptReport(f: FactoryRuntime, report: FactoryReport, caller: Caller): Promise<{ accepted: true }> {
  const owner = runs.get(f.s, report.run)?.item ?? report.run;
  return withItem(f, owner, () => takeReport(f, report, caller));
}

async function takeReport(f: FactoryRuntime, report: FactoryReport, caller: Caller): Promise<{ accepted: true }> {
  const { s } = f;
  const run = ownRun(f, report.run, caller);
  const takes = (r: FactoryRun | undefined) => r?.state === "running" || r?.state === "waiting";
  if (!takes(run)) throw new ReportError(`Run ${run.id} is ${run.state} and takes no report`);
  const required = REQUIRED[report.outcome];
  if (required && report[required.key] === undefined)
    throw new ReportError(`The outcome ${report.outcome} needs ${required.name}`);
  const definition = f.runKinds.get(run.kind);
  if (!definition) throw new ReportError(`This machine has no ${run.kind} stage`);
  const item = run.item ? items.get(s, run.item) : undefined;
  if (isStage(run.kind) && !item) throw new ReportError(`Run ${run.id} has no item`);
  const { result } = report;
  if (result && result.kind !== run.kind)
    throw new ReportError(`A ${run.kind} run reports a ${run.kind} result, not ${result.kind}`);
  const done = isStage(run.kind) && PHASES[run.kind].done;
  if (done && report.outcome === "done" && !result) throw new ReportError(`The outcome done needs result: ${done}`);
  const problem = await definition.validate?.(report, run, item);
  if (problem) throw new ReportError(problem);
  if (!takes(runs.get(s, run.id))) throw new ReportError(`Run ${run.id} already ended`);

  const reported = endRun(f, run, "reported", { report });
  // The thread could only go on to report once the person answered it.
  if (asksInT3(item, run)) answeredInT3(f, item!, run);
  const asks = report.outcome === "blocked" || report.outcome === "needs-decision";
  const closing = CLOSING[report.outcome];
  if (item && closing) await closeItem(f, item, closing(report), report);
  else if (item && asks)
    ask(f, items.get(s, item.id)!, {
      cause: report.outcome === "blocked" ? "blocked" : "decision",
      question: report.blocked?.missing ?? report.decision!.question,
      ...(report.decision && {
        recommendation: report.decision.recommendation,
        options: report.decision.options,
      }),
      ...(run.threadLink && { link: run.threadLink }),
      run: reported,
      report,
    });
  else if (!closing && !asks) await definition.accept(report, reported, item);
  // The thread settles once the turn that reported ends (`settleFinished`).
  return { accepted: true };
}

/** A finished stage's thread is settled; one that asked keeps waiting for the answer, and one that owns its item's PR
 * keeps it until the item finishes. */
const settlesAfterReport = (f: FactoryRuntime, run: FactoryRun) =>
  run.state === "reported" &&
  !!run.report &&
  run.report.outcome !== "blocked" &&
  run.report.outcome !== "needs-decision" &&
  !ownsPr(f, run);

/** Settles a thread once its turn ended, since T3 refuses to settle a running thread: a finished stage's, whose report
 * came from that turn, and one the factory interrupted. */
async function settleFinished(f: FactoryRuntime, thread: MirrorThread) {
  if (thread.settled || working(f, thread)) return;
  const head = runs.byThreads(f.s, [thread.id]).at(-1);
  const run = head && runs.get(f.s, head.id);
  const stopped = memory(f).stopping.delete(thread.id);
  if (!run || (!stopped && !settlesAfterReport(f, run))) return;
  await withItem(f, run.item ?? run.id, () =>
    actOnThread(f, run, { action: "settle" }).catch(threadFailed(f, run, "Settling")),
  );
}

// ---- capacity

/** Items that wait for the maintainer: a question, or a PR ready for their review. */
export const waitingForYou = (f: FactoryRuntime) => items.list(f.s, { open: true }).filter(waitsForYou).length;

/** Off, too, while the factory waits to move (`factory move`): its machine takes nothing new and finishes what is open. */
export function intakeState(f: FactoryRuntime): FactoryBoard["capacity"]["intake"] {
  if (!f.isFactoryNode() || f.pointer()?.moveTo || !currentFolder(f) || isPaused(f)) return "off";
  return waitingForYou(f) >= limitsOf(f).waitingForYou ? "paused-for-you" : "on";
}
// ---- items and runs nobody moves

const stalledWindow = (f: FactoryRuntime, configCommit: string) =>
  4 * durationMs((folderFor(f, configCommit)?.config.limits ?? DEFAULT_LIMITS).stalledAfter);

/**
 * Progress, not states. An open item that does not wait for the maintainer (`ready` does) must have an active run (a
 * launch that keeps failing does not count; waiting for a thread or quota does), its PR's thread at work, or a change
 * within four times `stalledAfter`: a run queued, started or ended, the PR's head moving, a nudge, or a person's act.
 * Otherwise it waits as `stuck`. And a running run whose thread has sat idle and unchanged that long ended a turn the
 * watcher missed (a restart, a gap while polling): it takes the silent-end path. A run that started that long ago and
 * whose thread T3 Code no longer has, deleted while nothing watched (the daemon was down), ends the way a run does when
 * the mirror sees its thread deleted.
 */
function findStuck(f: FactoryRuntime) {
  const { s } = f;
  const mirror = mirrorOf(f);
  // Asked again in the item's step: the step that held the item meanwhile, such as a report, may have moved it.
  for (const item of items.list(s, { open: true }))
    if (stalledFor(f, item.id))
      later(f, item.id, `Checking whether ${item.key} is stuck`, async () => {
        const stalled = stalledFor(f, item.id);
        if (!stalled) return;
        const hours = Math.round(stalled.ms / HOUR);
        ask(f, stalled.item, {
          cause: "stuck",
          question: `Nothing moved ${item.key} in ${stalled.item.phase} for ${hours} hour${hours === 1 ? "" : "s"}. Read its history before you retry it.`,
        });
      });
  // Only a mirror that has read T3 Code's threads can tell that one is gone: at start-up, and while T3 Code cannot be
  // read, it knows none of them, or old ones.
  const loaded = mirror.status().stream !== "down";
  if (loaded)
    for (const item of items.list(s, { open: true }))
      if (followsPr(item) && !mirror.thread(item.pr.thread))
        later(f, item.id, `Checking ${item.key}'s PR thread, which is gone`, () => threadDeleted(f, item.pr.run));
  for (const run of runs.list(s, { states: ["running", "waiting"] })) {
    if (!run.threadId) continue;
    const thread = mirror.thread(run.threadId);
    const window = stalledWindow(f, run.configCommit);
    if (!thread) {
      // The window also covers a thread just launched, which the mirror may not have heard of yet.
      if (loaded && s.now() - (run.startedAt ?? run.queuedAt) >= window)
        later(f, run.item ?? run.id, `Ending ${run.id}, whose thread is gone`, () => threadDeleted(f, run.id));
      continue;
    }
    if (run.state !== "running" || thread.needsYou || working(f, thread)) continue;
    if (s.now() - Math.max(thread.updatedAt, run.startedAt ?? 0) < window) continue;
    later(f, run.item ?? run.id, `Ending ${run.id}'s missed turn`, () => threadChanged(f, run.id, true));
  }
}

/** The open item and how long nothing moved it, when that long makes it stuck. */
function stalledFor(f: FactoryRuntime, id: string) {
  const { s } = f;
  const mirror = mirrorOf(f);
  // The mirror forgets its threads while T3 Code cannot be read, so a PR's thread at work would read idle.
  if (mirror.status().stream === "down") return;
  const item = items.get(s, id);
  if (!item || item.finishedAt !== undefined) return;
  if (item.needsYou || item.phase === "ready" || item.phase === "held") return;
  const itemRuns = runs.forItem(s, item.id);
  const failing = (r: FactoryRun) => (r.failedLaunches ?? 0) >= STUCK_LAUNCHES;
  if (itemRuns.some((r) => ACTIVE.includes(r.state) && !failing(r))) return;
  const { pr } = item;
  if (pr && working(f, mirror.thread(pr.thread))) return;
  const last = Math.max(
    item.phaseAt,
    item.updatedAt,
    pr?.headAt ?? 0,
    pr?.nudgedAt ?? 0,
    ...itemRuns.map((r) => Math.max(r.queuedAt, r.startedAt ?? 0, r.endedAt ?? 0)),
  );
  const ms = s.now() - last;
  return ms < stalledWindow(f, item.configCommit) ? undefined : { item, ms };
}

// ---- what a person can do to an item (actions.ts takes the actions)

/** The folder the factory machine runs on, for an operation that changes items; it says why there is none. */
export function requireFolder(f: FactoryRuntime): LoadedFolder {
  const pointer = f.pointer();
  if (!pointer) throw new Error("The factory is off; turn it on with agentgate factory use <owner/repo>");
  if (!f.isFactoryNode()) throw new Error(`The factory runs on ${pointer.node}`);
  const folder = currentFolder(f);
  if (!folder) throw new Error("The factory's folder has not loaded yet; see agentgate factory status");
  return folder;
}

/** What `retry` does for an item that stopped: go on with its PR when it has one, or start a stage again in a new
 * thread: an implement run that takes the PR over when the PR's thread was deleted, otherwise the stage it stopped in. */
export function retryTarget(f: FactoryRuntime, item: FactoryItem): { pr: true } | { kind: StageName } {
  if (followsPr(item)) {
    const deleted = item.needsYou?.cause === "deleted" && item.needsYou.run === item.pr.run;
    return deleted ? { kind: "implement" } : { pr: true };
  }
  const kind =
    runs
      .forItem(f.s, item.id)
      .map((r) => r.kind)
      .findLast(isStage) ?? "triage";
  return { kind };
}

/** The approve and reject an item's wait takes: a start, the card a thread asks (when its run kind can answer it
 * here), or what a stage reported it needs decided or unblocked. */
function answersOf(f: FactoryRuntime, item: FactoryItem): BoardAction[] {
  const wait = item.needsYou;
  const run = wait?.run ? runs.get(f.s, wait.run) : undefined;
  if (wait?.kind === "start") {
    const stage = item.phase === "held" ? "triage" : (run?.kind ?? item.phase);
    return [
      { name: "approve", label: "Approve", effect: `Start ${stage}`, takesText: false },
      { name: "reject", label: "Reject", effect: `Close it without starting ${stage}`, takesText: false },
    ];
  }
  if (wait?.kind !== "answer" || !run?.threadId) return [];
  if (wait.request !== undefined)
    return run.state === "waiting" && f.runKinds.get(run.kind)?.answer
      ? [
          { name: "approve", label: "Approve", effect: "Approve what the thread asks", takesText: false },
          {
            name: "reject",
            label: "Ask for changes…",
            effect: "Ask the thread for changes, with your feedback",
            takesText: true,
          },
        ]
      : [];
  if (run.state !== "reported") return [];
  if (!wait.recommendation)
    return [
      { name: "approve", label: "Unblock…", effect: "Tell the thread what changed, and it goes on", takesText: true },
    ];
  return [
    { name: "approve", label: "Take the recommendation", effect: "Go with the recommendation", takesText: false },
    { name: "approve", label: "Answer…", effect: "Send your answer to the thread, and it goes on", takesText: true },
    { name: "reject", label: "Reject", effect: "Refuse the recommendation, and the thread goes on", takesText: false },
  ];
}

/** The actions `act` takes for the item now, with what each does, so the CLI, the app and the issue comment offer the
 * same choices and none the daemon refuses. */
export function actionsOf(f: FactoryRuntime, item: FactoryItem): BoardAction[] {
  if (!isOpenPhase(item.phase))
    return item.phase === "closed" && !frozenHere(f)
      ? [{ name: "retry", label: "Retry", effect: "Take it in again from triage", takesText: false }]
      : [];
  if (frozenHere(f))
    return [{ name: "drop", label: "Drop…", effect: "Close it here, without a comment", takesText: true }];
  const target = item.needsYou?.kind === "stopped" ? retryTarget(f, item) : undefined;
  return [
    ...answersOf(f, item),
    ...(target
      ? [
          {
            name: "retry" as const,
            label: "Retry",
            effect:
              "pr" in target
                ? "Go on with its PR"
                : item.pr
                  ? "Start a new implement thread that takes its PR over"
                  : `Start ${target.kind} again in a new thread`,
            takesText: false,
          },
        ]
      : []),
    {
      name: "drop",
      label: "Drop…",
      effect: "Stop its threads and close it, with your reason on the issue; its PR stays open",
      takesText: true,
    },
  ];
}

/**
 * Whether this machine's open items are frozen: another machine runs the factory, so no loop here moves them, starts
 * their threads or follows their PRs, as after `factory off`. They go on when the factory moves back, and `drop` on
 * this machine closes one.
 */
export function frozenHere(f: FactoryRuntime) {
  return !!f.pointer() && !f.isFactoryNode();
}

/** Whether an item operation's input names an item frozen here, which only this machine can answer for. By its id
 * alone: a key or an issue names the factory machine's item, which may be a new item of the same issue. */
export function namesFrozen(f: FactoryRuntime, ref: string) {
  const item = frozenHere(f) ? items.get(f.s, ref) : undefined;
  return !!item && isOpenPhase(item.phase);
}

/** UTC, and says so: the text can be made on another machine, or read by a remote agent, in another time zone. */
export const time = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

const triage = (f: FactoryRuntime) => ({
  kind: "triage" as const,
  async launch(run: FactoryRun, item: FactoryItem): Promise<StageLaunch> {
    return { brief: renderBrief(f, { kind: "triage", run, item, builtIn: TRIAGE_BRIEF }) };
  },
  async accept(report: FactoryReport, _run: FactoryRun, item: FactoryItem) {
    if (report.result?.kind !== "triage") return closeItem(f, item, "There is nothing to do.", report);
    moveOn(f, item, report.result.route, { moment: "triaged", comment: { report } });
  },
});

export function setup(f: FactoryRuntime): void {
  f.sources.set("manual", { type: "manual" });
  f.runKinds.set("triage", triage(f));

  f.loops.push({ name: "factory-dispatch", everyMs: 5000, where: "factory-node", run: () => dispatch(f) });
  f.loops.push({ name: "factory-stuck", everyMs: 5 * 60_000, where: "factory-node", run: async () => findStuck(f) });

  // The gateway asks `threadScope` again: a run that starts, resumes or ends changes what its thread's sessions get,
  // and a finished item's implement thread, kept while its PR is open, loses its stage's servers.
  const toolsChanged = () => f.ctx.gateway.toolsChanged();
  for (const kind of ["run.started", "run.resumed", "run.ended"] as const) f.events.on(kind, toolsChanged);
  f.events.on("item.phase", (event) => {
    if (!isOpenPhase(event.to)) toolsChanged();
  });

  const setPaused = (paused: boolean) => {
    requireFolder(f);
    if (paused !== isPaused(f)) {
      f.s.setLocal(PAUSED, paused ? "1" : undefined);
      f.events.emit({
        kind: "note",
        text: paused ? "The factory was paused: no intake, new threads or nudges" : "The factory resumed",
      });
    }
    return {
      message: paused
        ? "Paused: no intake, new threads or nudges until agentgate factory resume. Running threads finish."
        : "Resumed.",
    };
  };
  const said = { parse: noWords, print: ({ message }: { message: string }) => [message] };
  operation(f, {
    name: "pause",
    summary: "stop intake, new threads and nudges until resume",
    input: z.object({}),
    run: async () => setPaused(true),
    terminal: { usage: "pause", ...said },
    remote: {
      description:
        "Pause the factory: no intake, new threads or nudges until resume. Running threads finish their turn.",
      result: ({ message }) => message,
    },
  });
  operation(f, {
    name: "resume",
    summary: "take in items, start threads and nudge again",
    input: z.object({}),
    run: async () => setPaused(false),
    terminal: { usage: "resume", ...said },
    remote: { description: "Resume a paused factory.", result: ({ message }) => message },
  });

  // What a stage's own thread calls. `ownRun` matches the calling thread to the run it names.
  operation(f, {
    name: "report",
    summary: "a stage thread's outcome, once",
    input: factoryReportSchema,
    run: (report, caller) => acceptReport(f, report, caller),
    tool: {
      name: "factory_report",
      forRuns: true,
      description:
        "Report the outcome of your factory stage, once, from the stage's own T3 Code thread. Returns { accepted: true }, or an error naming what to fix.",
    },
  });
}
