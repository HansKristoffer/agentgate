import {
  factoryPrThreadsInputSchema,
  type FactoryPrThreadsInput,
  type MarkerPayload,
  type StageResult,
} from "@agentgate/protocol";
import { fenced } from "./briefs.ts";
import { durationMs, limits } from "./config.ts";
import {
  ask,
  enqueueRun,
  finishItem,
  followsPr,
  isPaused,
  markStopped,
  moveOn,
  ownRun,
  ReportError,
  repositoryOf,
  sendToThread,
  stopAsking,
  stopWaiting,
  waitFor,
} from "./controller.ts";
import {
  ACTIVE,
  dataOf,
  isOpenPhase,
  items,
  runs,
  type FactoryItem,
  type FactoryRun,
  type ItemPr,
  type RunDataOf,
} from "./db.ts";
import {
  COLLABORATORS,
  followedPrs,
  prAddReviewers,
  prFeedback,
  prOf,
  prReady,
  prSetBody,
  prView,
  resolveConversation,
  type FeedbackComment,
  type PrFeedback,
  type FollowedPr,
  type PrState,
  type PrView,
} from "./gh.ts";
import { defuse, MARKER_PREFIX, markerTag, parseMarkers } from "./markers.ts";
import { isWorkingStatus, mirrorOf } from "./mirror.ts";
import { claimWrite, fileIssue } from "./outbox.ts";
import { T3McpError } from "./t3-mcp.ts";
import { later, operation, SayOnce, shortError, withItem, type Caller, type FactoryRuntime } from "./runtime.ts";

/**
 * The PR follower: every 2 minutes, one step per open item with a PR. It ships or closes the item when its PR is merged
 * or closed, and in the PR phases (`PHASES`) it follows the PR's head, moves a green PR on to review or ready, takes the
 * review rounds, and wakes the implement thread when it sits idle on a problem. The item keeps its PR and the follower's state
 * in `item.pr`, which names the implement thread that owns the PR until the item finishes; only this follower wakes it,
 * with what the repository's own people and bots wrote. The thread says which review conversations it fixed or
 * declined with `factory_pr_threads`, and the follower answers them on GitHub.
 */

/** A PR without checks counts as green only once its head is this old: CI may not have registered its checks yet. */
const CHECKS_SETTLE = 10 * 60_000;
/** The most of collaborators' comments a nudge quotes. */
const COMMENTS_CHARS = 8000;

const noted = (f: FactoryRuntime) => f.memory("PR failures said", () => new SayOnce());
/** A failure the event list hears once while the item's PR is followed. */
function failed(f: FactoryRuntime, item: FactoryItem, text: string) {
  if (noted(f).fresh(item.id, text)) f.events.emit({ kind: "note", item: item.id, text });
}

/** The implement run whose thread owns the item's PR. */
export const prRun = (f: FactoryRuntime, item: FactoryItem) => (item.pr ? runs.get(f.s, item.pr.run) : undefined);

/** The follower's read of a PR without its reviews and conversations. */
type Followed = Omit<FollowedPr, "feedback">;

/** Checks pass, or there are none on a head old enough to have them, and nothing conflicts with the base branch. */
export function green(f: FactoryRuntime, view: Pick<Followed, "checks" | "mergeable">, headAt: number) {
  const checks = view.checks === "passing" || (view.checks === "none" && f.s.now() - headAt >= CHECKS_SETTLE);
  return checks && view.mergeable !== "CONFLICTING";
}

/** Checks still running, or none yet on a head too new to have them. */
const checksPending = (f: FactoryRuntime, view: Pick<Followed, "checks">, headAt: number) =>
  view.checks === "pending" || (view.checks === "none" && f.s.now() - headAt < CHECKS_SETTLE);

/** Marks the PR ready for review and requests the repository's reviewers; throws when GitHub refuses. */
async function markReady(f: FactoryRuntime, item: FactoryItem, view: PrState) {
  const reviewers = repositoryOf(f, item)?.reviewers ?? [];
  if (view.isDraft) await prReady(view.url);
  if (reviewers.length) await prAddReviewers(view.url, view.author, reviewers);
}

/** Marks the PR ready, requests the repository's reviewers and moves the item to `ready`, with the ready comment
 * listing what is still open. False when GitHub refused, so the next pass tries again. A `view` with its body was
 * read just now; without one, the body is read here. */
export async function toReady(
  f: FactoryRuntime,
  item: FactoryItem,
  view: PrState | PrView,
  open: string[],
  why: string,
): Promise<boolean> {
  try {
    await markReady(f, item, view);
  } catch (e) {
    failed(f, item, `Marking ${item.key}'s PR ready failed: ${shortError(e)}`);
    return false;
  }
  // Before the item moves, so a restart between the two writes it again: it replaces its own section. A body a person
  // edits meanwhile keeps their text, since it was read just before.
  await ("body" in view ? Promise.resolve(view.body) : prView(view.url).then((fresh) => fresh.body))
    .then((body) => prSetBody(view.url, withSummary(body, readySummary(f, item))))
    .catch((e) => failed(f, item, `Writing the summary on ${item.key}'s PR failed: ${shortError(e)}`));
  fileLeftovers(f, item, view.url);
  const text = open.length
    ? `${view.url}\n\n${why} These findings are still open:\n\n${open.map((o) => `- ${o}`).join("\n")}`
    : view.url;
  moveOn(f, item, "ready", {
    clearWait: item.needsYou?.cause === "stalled",
    moment: "ready",
    comment: { text, commit: view.headRefOid },
  });
  return true;
}

/**
 * Work the item turned up and leaves alone, each as an issue without a source's label: what the last review round saw
 * in code the PR did not cause, and the slices its spec left for later. Unfiled, they would end as a line in the PR body
 * that nobody acts on.
 */
function fileLeftovers(f: FactoryRuntime, item: FactoryItem, prUrl: string) {
  const last = lastRound(f, item);
  const seen = last?.result.findings.filter((x) => x.severity === "pre-existing") ?? [];
  seen.forEach((x, i) =>
    fileIssue(
      f,
      item.id,
      `seen:${last!.head}:${i}`,
      { repo: item.repo, title: x.title ?? x.text, body: `${x.text}\n\n\`${x.file}${x.line ? `:${x.line}` : ""}\`` },
      `The factory's review of ${prUrl} found this in code that pull request did not change, so it left it alone.`,
    ),
  );
  const spec = runs.forItem(f.s, item.id).findLast((r) => r.report?.result?.kind === "spec" && r.report.result.approved)
    ?.report?.result;
  const later = spec?.kind === "spec" ? (spec.later ?? []) : [];
  later.forEach((x, i) =>
    fileIssue(
      f,
      item.id,
      `later:${i}`,
      { repo: item.repo, ...x },
      `The spec for ${item.url ?? item.key} left this for later; ${prUrl} does the first part.`,
    ),
  );
}

const SUMMARY_OPEN = "<!-- agentgate-factory:summary -->";
const SUMMARY_CLOSE = "<!-- /agentgate-factory:summary -->";
const SUMMARY_MAX = 20_000;
const REACH = {
  local: "stays local",
  module: "reaches the module",
  app: "reaches the whole app",
  data: "reaches stored data",
};

const SURE = { low: 0, medium: 1, high: 2 };

/** Agents write each claim as a sentence; joined with ": " or "; " its own full stop would read ".:" or ".;". */
const clause = (text: string) => text.replace(/[\s.;:]+$/, "");

/** Lines joined within `max` characters; what does not fit becomes one "…and N more" line. */
function within(lines: string[], max: number) {
  let out = "";
  for (const [i, line] of lines.entries()) {
    if (out.length + line.length + 1 > max - 30) return `${out}…and ${lines.length - i} more\n`;
    out += `${line}\n`;
  }
  return out;
}

/** The factory's summary of an item going ready, from its runs: what its PR-owning implement run checked and did not
 * check, at the commit it reported, and what it decided where the item was silent, least sure first; the review
 * rounds, with the last counted round's head, open and pre-existing findings, and risk. Each piece defused, the whole
 * within 20,000 characters. Written once, at ready, so the blind reviewer never sees the implementer's claims or
 * decisions in the PR. */
export function readySummary(f: FactoryRuntime, item: FactoryItem): string {
  const lines = ["## What the factory checked", ""];
  const result = prRun(f, item)?.report?.result;
  if (result?.kind === "implement") {
    lines.push(`**The implementer checked** at \`${result.commit.slice(0, 12)}\`:`);
    for (const c of result.claims) lines.push(`- ${clause(defuse(c.claim, 1000))}: ${defuse(c.evidence, 2000)}`);
    const skipped = result.notChecked.map((n) => clause(defuse(n, 500))).join("; ");
    lines.push("", `**Not checked:** ${skipped || "nothing listed"}`, "");
    const decided = result.decisions.toSorted((a, b) => SURE[a.confidence] - SURE[b.confidence]);
    if (decided.length)
      lines.push(
        "**Decided where the item was silent**, least sure first:",
        ...decided.map((d) => `- ${d.confidence} confidence: ${defuse(d.decision, 1000)}`),
        "",
      );
    else lines.push("**Decided where the item was silent:** nothing listed", "");
  }
  const last = lastRound(f, item);
  if (limits(f, item).reviewRounds === 0) lines.push("**Review:** No review stage ran.");
  else if (!last) lines.push("**Review:** No review round finished.");
  else {
    const rounds = `${last.count} round${last.count === 1 ? "" : "s"}, the last at \`${last.head.slice(0, 12)}\``;
    const open = last.result.findings.filter((x) => x.severity !== "pre-existing");
    const seen = last.result.findings.filter((x) => x.severity === "pre-existing");
    if (open.length) lines.push(`**Review:** ${rounds}. Still open:`, ...open.map(summaryLine));
    else lines.push(`**Review:** ${rounds} found nothing to fix.`);
    if (seen.length) lines.push("Also seen, not this PR's to fix, each filed as an issue:", ...seen.map(summaryLine));
    const risk = last.result.risk;
    if (risk) {
      const focus = risk.focus.map((x) => defuse(x, 500)).join("; ") || "nothing named";
      const unrelated = risk.unrelated.map((x) => defuse(x, 500)).join("; ") || "none";
      lines.push(
        "",
        `**Risk:** ${risk.door} door, ${REACH[risk.reach]}. Look first at: ${focus}. Unrelated changes: ${unrelated}.`,
      );
    }
  }
  return within(lines, SUMMARY_MAX).trimEnd();
}

/** The PR body with `summary` as its one factory summary section: after the author's text and before the factory's
 * marker, or at the end without one. A section already there is replaced. */
export function withSummary(body: string, summary: string): string {
  const section = `${SUMMARY_OPEN}\n${summary}\n${SUMMARY_CLOSE}`;
  const rest = body.replace(/\s*<!-- agentgate-factory:summary -->[\s\S]*?<!-- \/agentgate-factory:summary -->/g, "");
  const at = rest.lastIndexOf(MARKER_PREFIX);
  const before = (at < 0 ? rest : rest.slice(0, at)).trimEnd();
  const after = at < 0 ? "" : `\n\n${rest.slice(at)}`;
  return `${before ? `${before}\n\n` : ""}${section}${after}`;
}

/** In `pr` with a green PR and every claim backed: a review run when review rounds are on, otherwise ready. */
async function advance(f: FactoryRuntime, item: FactoryItem, view: PrState) {
  if (limits(f, item).reviewRounds > 0) {
    moveOn(f, item, "review");
    return;
  }
  await toReady(f, item, view, [], "");
}

interface Problem {
  key: string;
  text: string;
}

/** A comment that may steer the thread: from the repository's people or a bot, and not the factory's own (D40). */
const trusted = (c: FeedbackComment) =>
  (c.bot || COLLABORATORS.includes(c.association)) && !parseMarkers(c.body).length;

const newest = (times: string[]) => times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));

/** Check names for a nudge: the first ten, then how many more. */
const listed = (names: string[]) =>
  names.length > 10 ? `${names.slice(0, 10).join(", ")} and ${names.length - 10} more` : names.join(", ");

/** Open review conversations with a trusted comment the thread has not answered: never reported, or with a trusted
 * comment newer than the newest one when it reported. Outdated ones count, since moved lines answer nothing. */
function openConversations(feedback: PrFeedback, pr: ItemPr) {
  return feedback.conversations.flatMap((c) => {
    const comments = c.comments.filter(trusted);
    if (c.resolved || !comments.length) return [];
    const handled = pr.conversations?.[c.id];
    if (handled && !comments.some((m) => Date.parse(m.at) > Date.parse(handled.seen))) return [];
    return [{ ...c, comments }];
  });
}

/** What the thread should fix: failing checks, a conflict, the PR comments of the repository's people and the reviews
 * of its people and bots that no nudge has quoted yet, and open review conversations. Times compare on GitHub's clock
 * only, so a comment made between a push and the follower's next pass is not lost. Plain PR comments from bots never
 * count: deploy previews and coverage reports ask for nothing. */
function problemsOf(view: Followed, feedback: PrFeedback, pr: ItemPr) {
  const problems: Problem[] = [];
  if (view.checks === "failing")
    problems.push({ key: `checks@${view.headRefOid}`, text: `its checks fail: ${listed(view.failing)}` });
  if (view.mergeable === "CONFLICTING")
    problems.push({ key: `conflict@${view.headRefOid}`, text: `it conflicts with ${view.baseRefName}` });
  const asked = [
    ...view.comments
      .map((c) => ({ body: c.body, association: c.authorAssociation, bot: false, at: c.createdAt }))
      .filter((c) => COLLABORATORS.includes(c.association)),
    ...feedback.reviews.filter((r) => r.body.trim() || r.state === "CHANGES_REQUESTED"),
  ].filter((c) => trusted(c) && (!pr.quotedUntil || Date.parse(c.at) > Date.parse(pr.quotedUntil)));
  if (asked.length) {
    problems.push({
      key: `comments@${newest(asked.map((c) => c.at))}`,
      text: `${asked.length} comment${asked.length > 1 ? "s" : ""} from the repository's people or bots that you have not seen`,
    });
  }
  const conversations = openConversations(feedback, pr);
  if (conversations.length) {
    const ids = conversations.map((c) => c.id).sort();
    problems.push({
      key: `conversations@${ids.join(",")}:${newest(conversations.flatMap((c) => c.comments.map((m) => m.at)))}`,
      text: `${conversations.length} review conversation${conversations.length > 1 ? "s wait" : " waits"} for an answer`,
    });
  }
  return { problems, comments: asked, conversations };
}

const by = (c: FeedbackComment) => (c.bot ? "a bot" : c.association.toLowerCase());

/** Wakes the PR's thread when it sits idle on a problem: at once for a new one, again after `stalledAfter` for one it
 * left alone. Past `nudges` nudges, the item waits for the maintainer as `stalled`. */
async function nudge(
  f: FactoryRuntime,
  item: FactoryItem & { pr: ItemPr },
  run: FactoryRun,
  view: Followed,
  feedback: PrFeedback,
) {
  const { s } = f;
  const { pr } = item;
  const { problems, comments, conversations } = problemsOf(view, feedback, pr);
  if (!problems.length) {
    if (item.needsYou?.cause === "stalled") stopAsking(f, item.id);
    return;
  }
  if (isPaused(f) || item.needsYou) return;
  const thread = mirrorOf(f).thread(pr.thread);
  const idle = !!thread && !thread.needsYou && !isWorkingStatus(thread.status);
  if (!idle) return;
  // Someone stopped the thread in T3 Code: waking it would undo that. The factory settles the threads it stops itself,
  // such as on a budget stop, and a retry after a person's stop lets the next nudge through.
  if (thread.status === "interrupted" && !thread.settled && pr.stopSeen !== thread.updatedAt) {
    items.update(s, item.id, { pr: { ...pr, stopSeen: thread.updatedAt } });
    markStopped(f, item, run);
    return;
  }
  const key = problems.map((p) => p.key).join(" ");
  const { stalledAfter, nudges } = limits(f, item);
  if (pr.nudged === key && s.now() - (pr.nudgedAt ?? 0) < durationMs(stalledAfter)) return;
  const what = problems.map((p) => p.text).join("; ");
  if (pr.nudges >= nudges) {
    ask(f, item, {
      cause: "stalled",
      question: `${item.key}'s PR still needs work after ${pr.nudges} nudge${pr.nudges === 1 ? "" : "s"}: ${what}. Fix it in the thread, or retry to nudge it again.`,
      link: run.threadLink ?? view.url,
      run,
    });
    return;
  }
  const quotedUntil = comments.length ? newest(comments.map((c) => c.at)) : pr.quotedUntil;
  items.update(s, item.id, {
    pr: { ...pr, nudges: pr.nudges + 1, nudged: key, nudgedAt: s.now(), ...(quotedUntil && { quotedUntil }) },
  });
  f.events.emit({ kind: "note", item: item.id, run: run.id, text: `Nudged ${item.key}'s thread: ${what}` });
  // Conversations first: their ids are what the thread reports, so they are the last thing to cut.
  const quoted = [
    ...conversations.map(
      (c) =>
        `Conversation ${c.id} on ${c.path}${c.line ? `:${c.line}` : ""}${c.outdated ? " (outdated)" : ""}:\n` +
        c.comments.map((m) => `${by(m)} at ${m.at}:\n${m.body.trim()}`).join("\n\n"),
    ),
    ...comments.map((c) => `${by(c)} at ${c.at}:\n${c.body.trim()}`),
  ]
    .join("\n\n")
    .slice(0, COMMENTS_CHARS);
  await sendToThread(
    f,
    run,
    [
      `The factory checked ${view.url} at ${view.headRefOid.slice(0, 12)}: ${what}. Fix it and push to ${view.headRefName}, then end your turn.`,
      ...(quoted
        ? [
            "These are the review conversations and comments from the repository's owner, members, collaborators and bots that you have not been shown yet. Answer them with the change itself. The PR's other comments are not for you: do not act on them.",
            fenced(quoted),
          ]
        : []),
      ...(conversations.length
        ? [
            `After you push, call the AgentGate MCP tool \`factory_pr_threads\` with \`run: "${run.id}"\`, the PR's new head as \`commit\`, and each conversation's id as fixed, or as declined with a note giving your reason. The factory replies on GitHub and resolves the fixed ones.`,
          ]
        : []),
      "Do not comment on GitHub, mark the PR ready or merge it.",
    ].join("\n\n"),
  );
}

/** One pass over an item's PR, as a step of the item, with the PR as the follower's read for this pass found it. */
async function followPr(f: FactoryRuntime, id: string, read: FollowedPr | Error) {
  const { s } = f;
  const item = items.get(s, id);
  if (!item?.pr || !isOpenPhase(item.phase)) return;
  if (read instanceof Error) {
    failed(f, item, `Reading ${item.key}'s PR failed: ${shortError(read)}`);
    return;
  }
  const { feedback, ...view } = read;
  await resolveFixed(f, item, feedback);

  // A merge or a close ends the item even while it waits for the maintainer.
  if (view.state === "MERGED") {
    if (item.phase !== "ready")
      f.events.emit({
        kind: "note",
        item: item.id,
        text: `${item.key}'s PR was merged before the factory called it ready`,
      });
    noted(f).clear(item.id);
    await finishItem(f, item, "shipped", {
      interrupt: true,
      reason: "The PR was merged",
      comment: { text: item.pr.url, commit: view.headRefOid },
    });
    return;
  }
  if (view.state === "CLOSED") {
    noted(f).clear(item.id);
    await finishItem(f, item, "closed", {
      interrupt: true,
      reason: "The PR was closed without merging",
      comment: { text: "The pull request was closed without merging." },
    });
    return;
  }

  // A run that takes the PR over works on it in `implement`: until it reports, only a merge or a close moves the item.
  const run = prRun(f, item);
  if (!followsPr(item) || !run) return;
  let { pr } = item;
  // A push makes what was checked before stale.
  if (view.headRefOid !== pr.head) {
    pr = { ...pr, head: view.headRefOid, headAt: s.now() };
    items.update(s, item.id, { pr });
  }
  // While the item waits for the maintainer, nothing else moves it; a stall clears itself when the problem goes.
  if (item.needsYou && item.needsYou.cause !== "stalled") return;
  // What it waits for on its PR is read again each pass.
  stopWaiting(f, item.id, ["checks", "review"]);
  const result = run.report?.result;
  const backed = result?.kind === "implement" && result.claims.every((c) => c.evidence.trim());
  if (item.phase === "pr" && green(f, view, pr.headAt) && backed) {
    await advance(f, item, view);
    return;
  }
  if (item.phase === "pr" && checksPending(f, view, pr.headAt))
    waitFor(f, item.id, "checks", "Waits for the PR's checks");
  if (item.phase === "review") await followReview(f, item, view, pr.headAt);
  const now = items.get(s, id);
  if (followsPr(now)) await nudge(f, now, run, view, feedback);
}

/** The factory's reply in a review conversation: the fix's commit, or why the thread left it. */
function replyBody(f: FactoryRuntime, item: FactoryItem, c: NonNullable<ItemPr["conversations"]>[string]) {
  const marker: MarkerPayload = {
    item: item.id,
    key: item.key,
    stage: "implement",
    outcome: null,
    route: null,
    commit: c.commit,
    factory: item.configCommit.slice(0, 7),
    node: f.s.nodeId,
    state: "open",
    pr: item.pr?.url ?? null,
  };
  const text =
    c.outcome === "fixed"
      ? `Fixed in ${c.commit.slice(0, 12)}.${c.note ? `\n\n${defuse(c.note)}` : ""}`
      : `Not changed: ${defuse(c.note ?? "")}`;
  return `**${item.key}**: ${text}\n\n${markerTag(marker)}`;
}

/** Resolves the fixed conversations GitHub still shows open, once their reply was posted. Resolving again is harmless,
 * so it needs no claim; the replies go through the outbox. */
async function resolveFixed(f: FactoryRuntime, item: FactoryItem, feedback: PrFeedback) {
  const owed = items.get(f.s, item.id)?.pr?.conversations ?? {};
  for (const [id, c] of Object.entries(owed)) {
    const live = feedback.conversations.find((x) => x.id === id);
    if (c.outcome !== "fixed" || !live || live.resolved) continue;
    const reply = f.s.db
      .query("select status from factory_writebacks where item=? and moment='reply' and ref=?")
      .get(item.id, `${id}@${c.commit}`) as { status: string } | null;
    if (reply && reply.status !== "posted") continue;
    if (!live.canResolve) {
      failed(f, item, `The factory may not resolve a review conversation on ${item.key}'s PR; it replied there`);
      continue;
    }
    await resolveConversation(id).catch((e) =>
      failed(f, item, `Resolving a review conversation on ${item.key}'s PR failed: ${shortError(e)}`),
    );
  }
}

/** `factory_pr_threads`: the thread's outcome for review conversations, taken as a step of its item once the factory
 * has seen on GitHub that the commit is the PR's head and each conversation is open with a trusted comment. */
async function acceptConversations(f: FactoryRuntime, input: FactoryPrThreadsInput, caller: Caller) {
  const owner = runs.get(f.s, input.run)?.item ?? input.run;
  return withItem(f, owner, async () => {
    const run = ownRun(f, input.run, caller);
    const item = run.item ? items.get(f.s, run.item) : undefined;
    if (!followsPr(item) || item.pr.run !== run.id)
      throw new ReportError(`Run ${run.id} has no open PR that the factory follows`);
    const { pr } = item;
    const silent = input.conversations.find((c) => c.outcome === "declined" && !c.note);
    if (silent)
      throw new ReportError(`Declining ${silent.id} needs a note with your reason; the factory replies with it`);
    const { repo, number } = prOf(pr.url);
    const read = (await followedPrs(repo, [number])).get(number)!;
    if (read instanceof Error)
      throw new ReportError(
        `The factory could not read ${pr.url} on GitHub (${shortError(read)}); try again in a minute`,
      );
    const { feedback, ...view } = read;
    if (!view.headRefOid.startsWith(input.commit))
      throw new ReportError(
        `${view.url}'s head is ${view.headRefOid}, not ${input.commit}. Push your fixes, then call factory_pr_threads again with the head`,
      );
    const open = new Map(
      feedback.conversations.filter((c) => !c.resolved && c.comments.some(trusted)).map((c) => [c.id, c]),
    );
    const unknown = input.conversations.find((c) => !open.has(c.id));
    if (unknown)
      throw new ReportError(
        `${unknown.id} is not an open review conversation from the repository's people or a bot on ${view.url}`,
      );
    const conversations = { ...pr.conversations };
    for (const c of input.conversations)
      conversations[c.id] = {
        outcome: c.outcome,
        commit: view.headRefOid,
        ...(c.note && { note: c.note }),
        seen: newest(open.get(c.id)!.comments.map((m) => m.at)),
      };
    items.update(f.s, item.id, { pr: { ...pr, conversations } });
    for (const c of input.conversations)
      claimWrite(
        f,
        item.id,
        "reply",
        `${c.id}@${view.headRefOid}`,
        replyBody(f, item, conversations[c.id]!),
        `The reply in review conversation ${c.id} on ${item.key}'s PR`,
      );
    const fixed = input.conversations.filter((c) => c.outcome === "fixed").length;
    f.events.emit({
      kind: "note",
      item: item.id,
      run: run.id,
      text: `${item.key}'s thread fixed ${fixed} and declined ${input.conversations.length - fixed} review conversation${input.conversations.length > 1 ? "s" : ""}`,
    });
    // After the replies' sends, which were queued first: the fixed conversations whose reply went out are resolved.
    later(f, item.id, `Resolving the fixed review conversations on ${item.key}'s PR`, async () =>
      resolveFixed(f, item, await prFeedback(pr.url)),
    );
    return { accepted: input.conversations.length };
  });
}

/** One read per repository of every open item's PR, then one step per item. */
async function followPrs(f: FactoryRuntime) {
  const followed = items.list(f.s, { open: true }).flatMap((item) => {
    if (!item.pr) return [];
    try {
      return [{ item, pr: prOf(item.pr.url) }];
    } catch (e) {
      failed(f, item, `Checking ${item.key}'s PR failed: ${shortError(e)}`);
      return [];
    }
  });
  for (const repo of new Set(followed.map((x) => x.pr.repo))) {
    const here = followed.filter((x) => x.pr.repo === repo);
    let reads: Map<number, FollowedPr | Error>;
    try {
      reads = await followedPrs(repo, [...new Set(here.map((x) => x.pr.number))]);
    } catch (e) {
      reads = new Map(here.map((x) => [x.pr.number, e as Error]));
    }
    for (const { item, pr } of here) {
      try {
        await withItem(f, item.id, () => followPr(f, item.id, reads.get(pr.number)!));
      } catch (e) {
        failed(f, item, `Checking ${item.key}'s PR failed: ${shortError(e)}`);
      }
    }
  }
}

// ---- review rounds: what a reported review means for the PR, and when the next round starts

type ReviewResult = Extract<StageResult, { kind: "review" }>;
type Finding = ReviewResult["findings"][number];
/** Pre-existing findings are not this PR's to fix: the summary shows them, but they never hold the PR back. */
const holds = (f: Finding) => f.severity !== "pre-existing";

export const reviewRuns = (f: FactoryRuntime, item: FactoryItem) =>
  runs.forItem(f.s, item.id).filter((r) => r.kind === "review");
export const findingsOf = (run: FactoryRun) =>
  run.report?.result?.kind === "review" ? run.report.result.findings : [];
/** Review rounds whose findings counted, oldest first. */
export const rounds = (f: FactoryRuntime, item: FactoryItem) =>
  reviewRuns(f, item).filter((r) => r.state === "reported" && dataOf(r, "review") && !dataOf(r, "review")!.stale);

const SEVERITY = { important: "Important", nit: "Nit", "pre-existing": "Pre-existing" };
export const describe = (finding: Finding) =>
  `**${SEVERITY[finding.severity]}** ${finding.file}${finding.line ? `:${finding.line}` : ""}: ${finding.text}`;
/** A finding as the PR's summary lists it: its text defused, since GitHub renders it for everyone. */
export const summaryLine = (finding: Finding) =>
  `- ${SEVERITY[finding.severity]}, \`${defuse(`${finding.file}${finding.line ? `:${finding.line}` : ""}`, 300)}\`: ${defuse(finding.text, 1000)}`;

/** The last review round that counted, for the PR's summary: how many rounds counted, the head it reviewed, and what it
 * reported. */
export function lastRound(f: FactoryRuntime, item: FactoryItem) {
  const counted = rounds(f, item);
  const last = counted.at(-1);
  const result = last?.report?.result;
  if (!last || result?.kind !== "review") return undefined;
  return { count: counted.length, head: dataOf(last, "review")!.head, result };
}

/** What a reported review means for the item, as a step of it, once: discarded when the PR moved on, otherwise its
 * findings go to the implement thread, or the item goes to `ready`. `read` is the PR follower's read of this pass. */
export async function takeReview(f: FactoryRuntime, id: string, read?: Followed) {
  const run = runs.get(f.s, id);
  const item = run?.item ? items.get(f.s, run.item) : undefined;
  const result = run?.report?.result;
  if (!run || !item?.pr || result?.kind !== "review" || dataOf(run, "review")) return;
  if (item.phase !== "review") {
    f.events.emit({ kind: "note", item: item.id, run: run.id, text: `${item.key} left review; the report is unused` });
    return;
  }
  // The report is a claim about one commit, checked against the PR as GitHub has it now.
  const view = read ?? (await prView(item.pr.url));
  const round = rounds(f, item).length + 1;
  if (!view.headRefOid.startsWith(result.commit.toLowerCase())) {
    runs.update(f.s, run.id, { checked: { kind: "review", head: result.commit, round, stale: true } });
    f.events.emit({
      kind: "note",
      item: item.id,
      run: run.id,
      text: `Discarded ${item.key}'s review of ${result.commit.slice(0, 12)}: the PR is at ${view.headRefOid.slice(0, 12)} now`,
    });
    return;
  }
  const head = view.headRefOid;
  const max = limits(f, item).reviewRounds;
  const open = result.findings.filter(holds);
  const final = !open.length || round >= max;
  // Recorded before anything is posted, so a restart never posts this round twice.
  const checked: RunDataOf<"review"> = { kind: "review", head, round, final };
  runs.update(f.s, run.id, { checked });
  f.events.emit({
    kind: "note",
    item: item.id,
    run: run.id,
    text: `${item.key}'s review round ${round} of ${max}: ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}`,
  });
  if (final) {
    await toReady(
      f,
      items.get(f.s, item.id)!,
      view,
      open.map(describe),
      `Review round ${round} of ${max} still found problems.`,
    );
    return;
  }
  const implement = prRun(f, item);
  if (!implement?.threadId) return;
  await sendToThread(
    f,
    implement,
    [
      `The factory's reviewer found these in ${head.slice(0, 12)} (round ${round} of ${max}):`,
      open.map((o) => `- ${describe(o)}`).join("\n"),
      `Fix them, push to ${view.headRefName}, and end your turn. Once the checks pass, the factory reviews the new commits. Do not comment on GitHub, mark the PR ready or merge it.`,
    ].join("\n\n"),
  ).catch((e) => {
    // T3 answered with an error, so the thread never got them: the round is taken again on the next pass. Any other
    // failure may have reached the thread, and the findings are never sent twice.
    const unsent = e instanceof T3McpError && e.answered;
    if (unsent) runs.update(f.s, run.id, { checked: undefined });
    f.events.emit({
      kind: "note",
      item: item.id,
      text: `Sending the findings to the implement thread failed: ${shortError(e)}${unsent ? "; the next pass sends them again" : ""}`,
    });
  });
}

/** For an item in `review`, as part of the PR follower's step: a report not taken yet is taken; the next round starts
 * once the PR's head moved past the reviewed commit and its checks pass; a stale report gets a new review; and the
 * PR goes to `ready` when the implement thread sat idle on the findings for `stalledAfter`, or marking it ready failed
 * before. */
export async function followReview(f: FactoryRuntime, item: FactoryItem, view: Followed, headAt: number) {
  const max = limits(f, item).reviewRounds;
  // Review was switched off while the item was in it.
  if (max === 0) {
    if (green(f, view, headAt)) await toReady(f, item, view, [], "");
    return;
  }
  const last = reviewRuns(f, item).at(-1);
  // The last round ended without a report (it failed twice and was retried, or the budget stopped it): another round
  // starts once the PR is green, as after a push.
  if (!last || (last.state !== "reported" && !ACTIVE.includes(last.state))) {
    if (view.state === "OPEN" && green(f, view, headAt)) enqueueRun(f, { kind: "review", item: item.id });
    else if (checksPending(f, view, headAt)) waitFor(f, item.id, "checks", "Waits for the PR's checks to review it");
    return;
  }
  if (last.state !== "reported") return;
  const data = dataOf(last, "review");
  if (!data) {
    await takeReview(f, last.id, view);
    return;
  }
  if (view.state !== "OPEN") return;
  const why =
    data.round >= max
      ? `Review round ${data.round} of ${max} still found problems.`
      : `The implement thread left round ${data.round}'s findings unanswered.`;
  const open = () => findingsOf(last).filter(holds).map(describe);
  if (data.final) {
    await toReady(f, item, view, open(), why);
    return;
  }
  const moved = !view.headRefOid.startsWith(data.head.toLowerCase());
  if (data.stale || moved) {
    if (green(f, view, headAt)) enqueueRun(f, { kind: "review", item: item.id });
    else if (checksPending(f, view, headAt))
      waitFor(f, item.id, "checks", `Waits for the PR's checks before review round ${data.round + 1}`);
    return;
  }
  const thread = item.pr ? mirrorOf(f).thread(item.pr.thread) : undefined;
  const busy = !!thread && (thread.needsYou || isWorkingStatus(thread.status));
  if (busy || f.s.now() - (last.endedAt ?? 0) < durationMs(limits(f, item).stalledAfter)) {
    waitFor(f, item.id, "review", `Waits for the implement thread to push fixes for review round ${data.round}`);
    return;
  }
  runs.update(f.s, last.id, { checked: { ...data, final: true } });
  await toReady(f, item, view, open(), why);
}

export function setup(f: FactoryRuntime): void {
  operation(f, {
    name: "pr threads",
    summary: "what an implement thread did about its PR's review conversations",
    input: factoryPrThreadsInputSchema,
    run: (input, caller) => acceptConversations(f, input, caller),
    tool: {
      name: "factory_pr_threads",
      forRuns: true,
      description:
        "After you push fixes for the review conversations the factory quoted, say which you fixed and which you declined (with a note giving your reason). The factory replies on GitHub and resolves the fixed ones. Returns { accepted: n }, or an error naming what to fix.",
    },
  });
  f.loops.push({ name: "factory-prs", everyMs: 2 * 60_000, where: "factory-node", run: () => followPrs(f) });
}
