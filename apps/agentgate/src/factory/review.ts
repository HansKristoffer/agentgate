import type { FactoryReport, MarkerPayload, StageResult } from "@agentgate/protocol";
import { z } from "zod";
import { renderBrief } from "./briefs.ts";
import { DEFAULT_LIMITS, durationMs, folderFor } from "./config.ts";
import { defaultBranch, endRun, enqueueRun, moveItem, sendToThread, writeBack } from "./controller.ts";
import { items, runs, type FactoryItem, type FactoryRun } from "./db.ts";
import { postPrReview, prView, type PrView } from "./gh.ts";
import { green, markReady, prRun } from "./implement.ts";
import { defuse, markerTag } from "./markers.ts";
import { isWorkingStatus, mirrorOf } from "./mirror.ts";
import { shortError, type FactoryRuntime, type LaunchSpec } from "./runtime.ts";

/**
 * The review stage: a fresh thread in its own worktree reviews the PR's head, blind to what the implementer said
 * about it. The factory posts its findings as one PR review and hands them to the implement thread. Once that thread
 * pushes and the checks pass, the next round reviews only the new commits, until a round is clean or `reviewRounds`
 * is used up; then the PR is marked ready and goes to the maintainer.
 */

const REVIEW_BRIEF = `You review one pull request for AgentGate's software factory.

- Check out the PR in this worktree, and read the item and spec with the \`factory_item\` tool. Never read the PR's description or comments: judge the change, not what anyone says about it.
- Revert the fix locally, keeping the new tests, and run them to show they fail without it. Tests that pass without the fix are an Important finding.
- In round 2 and later, review only the diff since the reviewed commit, and do not repeat the findings you are given.
- Report findings tagged Important, Nit or Pre-existing for that commit, and do not post them: the factory does.`;

type Finding = Extract<StageResult, { kind: "review" }>["findings"][number];
/** Pre-existing findings are posted, but they are not this PR's to fix and never hold it back. */
const holds = (f: Finding) => f.severity !== "pre-existing";

/** What the factory made of a review run's report, kept on the run so a restart knows where the item stands.
 * `stale`: the PR moved on before the report came, so it was discarded. `final`: the item goes to `ready` with this
 * round, which is retried until marking the PR ready works. */
const checkedSchema = z.object({
  head: z.string(),
  round: z.number(),
  stale: z.boolean().optional(),
  final: z.boolean().optional(),
});
type Checked = z.infer<typeof checkedSchema>;
const checkedOf = (run: FactoryRun | undefined) => {
  const parsed = checkedSchema.safeParse(run?.checked);
  return parsed.success ? parsed.data : undefined;
};

const limitsOf = (f: FactoryRuntime, item: FactoryItem) =>
  folderFor(f, item.configCommit)?.config.limits ?? DEFAULT_LIMITS;
const reviewRuns = (f: FactoryRuntime, item: FactoryItem) =>
  runs.forItem(f.s, item.id).filter((r) => r.kind === "review");
const findingsOf = (run: FactoryRun) => (run.report?.result?.kind === "review" ? run.report.result.findings : []);
/** Review rounds whose findings counted, oldest first. */
const rounds = (f: FactoryRuntime, item: FactoryItem) =>
  reviewRuns(f, item).filter((r) => r.state === "reported" && checkedOf(r) && !checkedOf(r)!.stale);

const SEVERITY = { important: "Important", nit: "Nit", "pre-existing": "Pre-existing" };
const describe = (finding: Finding) =>
  `**${SEVERITY[finding.severity]}** ${finding.file}${finding.line ? `:${finding.line}` : ""}: ${finding.text}`;

function marker(f: FactoryRuntime, item: FactoryItem, head: string): MarkerPayload {
  return {
    item: item.id,
    key: item.key,
    stage: "review",
    outcome: "done",
    route: null,
    commit: head,
    factory: item.configCommit.slice(0, 7),
    node: f.s.nodeId,
    state: "open",
  };
}

/** Marks the PR ready, requests the repository's reviewers and moves the item to `ready`, with the ready comment
 * listing what is still open. False when GitHub refused, so the review loop tries again. */
async function toReady(f: FactoryRuntime, item: FactoryItem, view: PrView, open: Finding[], why: string) {
  try {
    await markReady(f, item, view);
  } catch (e) {
    f.events.emit({ kind: "note", item: item.id, text: `Marking ${item.key}'s PR ready failed: ${shortError(e)}` });
    return false;
  }
  const ready = moveItem(f, item.id, "ready", item.needsYou?.reason === "stalled" ? null : undefined);
  const text = open.length
    ? `${view.url}\n\n${why} These findings are still open:\n\n${open.map((o) => `- ${describe(o)}`).join("\n")}`
    : view.url;
  await writeBack(f, ready, "ready", { text, commit: view.headRefOid });
  return true;
}

const review = (f: FactoryRuntime) => ({
  kind: "review" as const,
  async launch(run: FactoryRun, item: FactoryItem | undefined): Promise<LaunchSpec | { wait: string }> {
    if (!item?.prUrl) throw new Error(`the review run ${run.id} has no item with a PR`);
    const view = await prView(item.prUrl);
    const baseRef = await defaultBranch(f, item.repo);
    const max = limitsOf(f, item).reviewRounds;
    if (max === 0) {
      // Review is switched off: the PR goes straight to the maintainer, and a refusal is retried like a failed launch.
      if (!(await toReady(f, item, view, [], ""))) throw new Error(`marking ${view.url} ready failed`);
      endRun(f, run, "cancelled");
      return { wait: "reviewRounds is 0, so the PR went to the maintainer unreviewed" };
    }
    const done = rounds(f, item);
    const round = done.length + 1;
    const previous = done.at(-1);
    const earlier = done.flatMap(findingsOf);
    const lines = [
      `- This is review round ${round} of at most ${max}. The PR is ${view.url}; review its head \`${view.headRefOid}\` against \`${view.baseRefName}\`, and report that commit.`,
      `- Check it out here with \`gh pr checkout ${view.number} --detach\`, and stay on that commit.`,
      previous
        ? `- Review only \`git diff ${checkedOf(previous)!.head}..${view.headRefOid}\`: everything before it was reviewed in earlier rounds.`
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
      return 'The outcome done needs result: { kind: "review", prUrl, commit, findings, testsFailWithoutFix }';
    if (item?.prUrl && result.prUrl.toLowerCase() !== item.prUrl.toLowerCase())
      return `You were asked to review ${item.prUrl}, not ${result.prUrl}`;
    return undefined;
  },

  async accept(_report: FactoryReport, run: FactoryRun, item: FactoryItem | undefined) {
    if (!item) return;
    // The run has ended already, so a failure here is not the reviewer's to fix: the review loop finishes the job.
    await judge(f, run, item).catch((e) =>
      f.events.emit({
        kind: "note",
        item: item.id,
        run: run.id,
        text: `Taking ${item.key}'s review failed: ${shortError(e)}`,
      }),
    );
  },
});

/** What a reported review means for the item: discarded when the PR moved on, otherwise its findings are posted and go
 * to the implement thread, or the item goes to `ready`. */
async function judge(f: FactoryRuntime, run: FactoryRun, item: FactoryItem) {
  const result = run.report?.result;
  if (!item.prUrl || result?.kind !== "review") return;
  if (item.phase !== "review") {
    f.events.emit({
      kind: "note",
      item: item.id,
      run: run.id,
      text: `${item.key} left review; the report is unused`,
    });
    return;
  }
  // The report is a claim about one commit, checked against the PR as GitHub has it now.
  const view = await prView(item.prUrl);
  const round = rounds(f, item).length + 1;
  if (!view.headRefOid.startsWith(result.commit.toLowerCase())) {
    runs.update(f.s, run.id, { checked: { head: result.commit, round, stale: true } satisfies Checked });
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
  runs.update(f.s, run.id, { commitSha: head, checked: { head, round, final } satisfies Checked });

  if (result.findings.length) {
    const count = `${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}`;
    const body = [
      `**${item.key}**: The factory's review, round ${round} of ${max}, of ${head.slice(0, 12)}: ${count}.`,
      markerTag(marker(f, item, head)),
    ].join("\n\n");
    const comments = result.findings.map((x) => ({
      path: x.file,
      ...(x.line && { line: x.line }),
      body: defuse(describe(x)),
    }));
    const posted = await postPrReview(view.url, { commit: head, body, comments });
    f.events.emit({
      kind: "note",
      item: item.id,
      run: run.id,
      text: `The review of ${item.key}'s round ${round}: ${posted.status}${posted.error ? ` (${posted.error})` : ""}`,
    });
  }

  if (final) {
    await toReady(f, items.get(f.s, item.id)!, view, open, `Review round ${round} of ${max} still found problems.`);
    return;
  }
  const implement = prRun(f, item);
  if (!implement?.threadId) return;
  await sendToThread(
    f,
    implement,
    [
      `The factory's reviewer found these in ${head.slice(0, 12)} (round ${round} of ${max}). They are posted on ${view.url} too:`,
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

// ---- the review loop

/** For an item in `review` whose review run reported: the next round once the PR's head moved past the reviewed commit
 * and its checks pass, a new review when the last report was stale, and `ready` when the implement thread sat idle on
 * the findings for `stalledAfter` or marking the PR ready failed before. */
async function followReview(f: FactoryRuntime, item: FactoryItem) {
  const last = reviewRuns(f, item).at(-1);
  if (last?.state !== "reported") return;
  const checked = checkedOf(last);
  if (!checked) {
    await judge(f, last, item);
    return;
  }
  const view = await prView(item.prUrl!);
  if (view.state !== "OPEN") return; // the implement loop ships or closes it
  const max = limitsOf(f, item).reviewRounds;
  const why =
    checked.round >= max
      ? `Review round ${checked.round} of ${max} still found problems.`
      : `The implement thread left round ${checked.round}'s findings unanswered.`;
  if (checked.final) {
    await toReady(f, item, view, findingsOf(last).filter(holds), why);
    return;
  }
  const moved = !view.headRefOid.startsWith(checked.head.toLowerCase());
  if (checked.stale || moved) {
    if (green(view)) enqueueRun(f, { kind: "review", item: item.id });
    return;
  }
  const implement = prRun(f, item);
  const thread = implement?.threadId ? mirrorOf(f).thread(implement.threadId) : undefined;
  const busy = !!thread && (thread.needsYou || isWorkingStatus(thread.status));
  if (busy || f.s.now() - (last.endedAt ?? 0) < durationMs(limitsOf(f, item).stalledAfter)) return;
  runs.update(f.s, last.id, { checked: { ...checked, final: true } satisfies Checked });
  await toReady(f, item, view, findingsOf(last).filter(holds), why);
}

async function followReviews(f: FactoryRuntime) {
  for (const item of items.list(f.s, { open: true })) {
    if (item.phase !== "review" || !item.prUrl) continue;
    try {
      await followReview(f, item);
    } catch (e) {
      f.events.emit({ kind: "note", item: item.id, text: `Following ${item.key}'s review failed: ${shortError(e)}` });
    }
  }
}

export function setup(f: FactoryRuntime): void {
  f.runKinds.set("review", review(f));
  // Every machine follows the reviews of the items in its own tables.
  f.loops.push({ name: "factory-reviews", everyMs: 2 * 60_000, where: "every-node", run: () => followReviews(f) });
}
