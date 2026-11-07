import type { FactoryReport, StageResult } from "@agentgate/protocol";
import { renderBrief } from "./briefs.ts";
import { DEFAULT_LIMITS, durationMs, folderFor } from "./config.ts";
import { cancelLaunch, defaultBranch, enqueueRun, sendToThread } from "./controller.ts";
import { ACTIVE, dataOf, items, runs, type FactoryItem, type FactoryRun, type RunDataOf } from "./db.ts";
import { prView, type PrView } from "./gh.ts";
import { defuse } from "./markers.ts";
import { isWorkingStatus, mirrorOf } from "./mirror.ts";
import { green, prRun, toReady } from "./pr.ts";
import { later, shortError, type FactoryRuntime, type LaunchSpec } from "./runtime.ts";

/**
 * The review stage: a fresh thread in its own worktree reviews the PR's head, blind to what the implementer said
 * about it. The factory hands its findings to the implement thread and posts none on GitHub: the maintainer reads
 * the last round in the PR's summary at ready (pr.ts). Once the implement thread pushes and the checks pass, the next
 * round reviews only the new commits, until a round is clean or `reviewRounds` is used up; then the PR is marked ready
 * and goes to the maintainer. The PR follower (pr.ts) drives the rounds.
 */

const REVIEW_BRIEF = `You review one pull request for AgentGate's software factory.

- Check out the PR in this worktree, and read the item and spec with the \`factory_item\` tool. Never read the PR's description or comments: judge the change, not what anyone says about it.
- Revert the fix locally, keeping the new tests, and run them to show they fail without it. Tests that pass without the fix are an Important finding.
- In round 2 and later, review only the diff since the reviewed commit, and do not repeat the findings you are given.
- Review in focused passes, each as a subagent if you can start one, otherwise one after another: correctness, including how failures surface; tests, with the revert check above; reuse and simplicity; efficiency; security; and the repository's own rules (its AGENTS.md, CLAUDE.md or CONTRIBUTING.md, and the rulings). Merge their findings and drop duplicates.
- Report a finding only once you have confirmed it in the code, naming the file and line you read. A problem in code the PR did not change is Pre-existing, unless the change causes it.
- Report the risk: whether a revert undoes the change, how far a mistake reaches, changes the item did not ask for, and where a person should look first.
- Report findings tagged Important, Nit or Pre-existing for that commit.`;

type ReviewResult = Extract<StageResult, { kind: "review" }>;
type Finding = ReviewResult["findings"][number];
/** Pre-existing findings are not this PR's to fix: the summary shows them, but they never hold the PR back. */
const holds = (f: Finding) => f.severity !== "pre-existing";

const limitsOf = (f: FactoryRuntime, item: FactoryItem) =>
  folderFor(f, item.configCommit)?.config.limits ?? DEFAULT_LIMITS;
const reviewRuns = (f: FactoryRuntime, item: FactoryItem) =>
  runs.forItem(f.s, item.id).filter((r) => r.kind === "review");
const findingsOf = (run: FactoryRun) => (run.report?.result?.kind === "review" ? run.report.result.findings : []);
/** Review rounds whose findings counted, oldest first. */
const rounds = (f: FactoryRuntime, item: FactoryItem) =>
  reviewRuns(f, item).filter((r) => r.state === "reported" && dataOf(r, "review") && !dataOf(r, "review")!.stale);

const SEVERITY = { important: "Important", nit: "Nit", "pre-existing": "Pre-existing" };
const describe = (finding: Finding) =>
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

const review = (f: FactoryRuntime) => ({
  kind: "review" as const,
  async launch(run: FactoryRun, item: FactoryItem | undefined): Promise<LaunchSpec | { wait: string }> {
    if (!item?.prUrl) throw new Error(`the review run ${run.id} has no item with a PR`);
    const max = limitsOf(f, item).reviewRounds;
    // Review was switched off after this run was queued: the PR follower sends the PR to the maintainer.
    if (max === 0) return cancelLaunch(f, run, "reviewRounds is 0");
    const view = await prView(item.prUrl);
    const baseRef = await defaultBranch(f, item.repo);
    const done = rounds(f, item);
    const round = done.length + 1;
    const previous = done.at(-1);
    const earlier = done.flatMap(findingsOf);
    const lines = [
      `- This is review round ${round} of at most ${max}. The PR is ${view.url}; review its head \`${view.headRefOid}\` against \`${view.baseRefName}\`, and report that commit.`,
      `- Check it out here with \`gh pr checkout ${view.number} --detach\`, and stay on that commit.`,
      previous
        ? `- Review only \`git diff ${dataOf(previous, "review")!.head}..${view.headRefOid}\`: everything before it was reviewed in earlier rounds.`
        : "- Review the whole diff against the base branch.",
      '- Report `testsFailWithoutFix: true` when the new tests fail with the fix reverted, `false` when they pass, and `"no-new-tests"` when the PR adds none.',
      "- Never post anything on GitHub or Linear: no review, comment, approval or push.",
    ];
    const context = [
      "## This run",
      lines.join("\n"),
      ...(earlier.length
        ? [
            "## Findings from earlier rounds\n\nThe implementer has these already. Do not report them again.",
            earlier.map((e) => `- ${describe(e)}`).join("\n"),
          ]
        : []),
    ].join("\n\n");
    const n = reviewRuns(f, item).filter((r) => r.queuedAt <= run.queuedAt).length;
    const model = folderFor(f, item.configCommit)?.stages.review?.file.model;
    return {
      repo: item.repo,
      title: `Review ${item.key} (round ${round}): ${item.title}`,
      brief: renderBrief(f, { kind: "review", run, item, builtIn: REVIEW_BRIEF, context }),
      baseRef,
      branch: `factory/${item.key}-review-${n}`,
      startFromOrigin: true,
      ...(model && { model }),
    };
  },

  async validate(report: FactoryReport, _run: FactoryRun, item: FactoryItem | undefined) {
    const { result } = report;
    if (result && result.kind !== "review") return `A review run reports a review result, not ${result.kind}`;
    if (report.outcome === "blocked" || report.outcome === "needs-decision") return undefined;
    if (report.outcome !== "done")
      return `A review run reports done, blocked or needs-decision, not ${report.outcome}; put what you found in findings`;
    if (!result)
      return 'The outcome done needs result: { kind: "review", prUrl, commit, findings, testsFailWithoutFix, risk? }';
    if (item?.prUrl && result.prUrl.toLowerCase() !== item.prUrl.toLowerCase())
      return `You were asked to review ${item.prUrl}, not ${result.prUrl}`;
    return undefined;
  },

  async accept(_report: FactoryReport, run: FactoryRun, item: FactoryItem | undefined) {
    // GitHub is read and written after the report is answered, as the item's next step.
    if (item) later(f, item.id, `Taking ${item.key}'s review`, () => takeReview(f, run.id));
  },
});

/** What a reported review means for the item, as a step of it, once: discarded when the PR moved on, otherwise its
 * findings go to the implement thread, or the item goes to `ready`. */
export async function takeReview(f: FactoryRuntime, id: string) {
  const run = runs.get(f.s, id);
  const item = run?.item ? items.get(f.s, run.item) : undefined;
  const result = run?.report?.result;
  if (!run || !item?.prUrl || result?.kind !== "review" || dataOf(run, "review")) return;
  if (item.phase !== "review") {
    f.events.emit({ kind: "note", item: item.id, run: run.id, text: `${item.key} left review; the report is unused` });
    return;
  }
  // The report is a claim about one commit, checked against the PR as GitHub has it now.
  const view = await prView(item.prUrl);
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
  const max = limitsOf(f, item).reviewRounds;
  const open = result.findings.filter(holds);
  const final = !open.length || round >= max;
  // Recorded before anything is posted, so a restart never posts this round twice.
  const checked: RunDataOf<"review"> = { kind: "review", head, round, final };
  runs.update(f.s, run.id, { commitSha: head, checked });
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
  ).catch((e) =>
    f.events.emit({
      kind: "note",
      item: item.id,
      text: `Sending the findings to the implement thread failed: ${shortError(e)}`,
    }),
  );
}

/** For an item in `review`, as part of the PR follower's step: a report not taken yet is taken; the next round starts
 * once the PR's head moved past the reviewed commit and its checks pass; a stale report gets a new review; and the
 * PR goes to `ready` when the implement thread sat idle on the findings for `stalledAfter`, or marking it ready failed
 * before. */
export async function followReview(f: FactoryRuntime, item: FactoryItem, view: PrView, headAt: number) {
  const max = limitsOf(f, item).reviewRounds;
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
    return;
  }
  if (last.state !== "reported") return;
  const data = dataOf(last, "review");
  if (!data) {
    await takeReview(f, last.id);
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
    return;
  }
  const implement = prRun(f, item);
  const thread = implement?.threadId ? mirrorOf(f).thread(implement.threadId) : undefined;
  const busy = !!thread && (thread.needsYou || isWorkingStatus(thread.status));
  if (busy || f.s.now() - (last.endedAt ?? 0) < durationMs(limitsOf(f, item).stalledAfter)) return;
  runs.update(f.s, last.id, { checked: { ...data, final: true } });
  await toReady(f, item, view, open(), why);
}

export function setup(f: FactoryRuntime): void {
  f.runKinds.set("review", review(f));
}
