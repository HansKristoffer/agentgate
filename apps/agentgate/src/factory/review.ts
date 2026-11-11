import type { FactoryReport } from "@agentgate/protocol";
import { renderBrief } from "./briefs.ts";
import { cancelLaunch } from "./controller.ts";
import { dataOf, type FactoryItem, type FactoryRun } from "./db.ts";
import { prView } from "./gh.ts";
import { limits } from "./config.ts";
import { describe, findingsOf, rounds, takeReview } from "./pr.ts";
import { later, type FactoryRuntime, type NoLaunch, type StageLaunch } from "./runtime.ts";

/**
 * The review stage: a fresh thread in its own worktree reviews the PR's head, blind to what the implementer said
 * about it. The factory hands its findings to the implement thread and posts none on GitHub: the maintainer reads
 * the last round in the PR's summary at ready. Once the implement thread pushes and the checks pass, the next round
 * reviews only the new commits, until a round is clean or `reviewRounds` is used up; then the PR is marked ready and
 * goes to the maintainer. This file is the stage's launch and report check; the PR follower (pr.ts) drives the rounds.
 */

const REVIEW_BRIEF = `You review one pull request for AgentGate's software factory.

- Check out the PR in this worktree, and read the item and spec with the \`factory_item\` tool. Never read the PR's description or comments: judge the change, not what anyone says about it.
- Revert the fix locally, keeping the new tests, and run them to show they fail without it. Tests that pass without the fix are an Important finding.
- Ask what makes the fix hold for every input, not only the item's. A raised timeout or limit, a bigger buffer, or a special case sized to the reported input leaves the cause in place: that is an Important finding.
- In round 2 and later, review only the diff since the reviewed commit, and do not repeat the findings you are given.
- Review in focused passes, each as a subagent if you can start one, otherwise one after another: correctness, including how failures surface; tests, with the revert check above; reuse and simplicity; efficiency; security; and the repository's own rules (its AGENTS.md, CLAUDE.md or CONTRIBUTING.md, and the rulings). Merge their findings and drop duplicates.
- Report a finding only once you have confirmed it in the code, naming the file and line you read. A problem in code the PR did not change is Pre-existing, unless the change causes it.
- Report the risk: whether a revert undoes the change, how far a mistake reaches, changes the item did not ask for, and where a person should look first.
- Report findings tagged Important, Nit or Pre-existing for that commit.`;

const review = (f: FactoryRuntime) => ({
  kind: "review" as const,
  async launch(run: FactoryRun, item: FactoryItem): Promise<StageLaunch | NoLaunch> {
    if (!item.pr) throw new Error(`the review run ${run.id} has no item with a PR`);
    const max = limits(f, item).reviewRounds;
    // Review was switched off after this run was queued: the PR follower sends the PR to the maintainer.
    if (max === 0) return cancelLaunch(f, run, "reviewRounds is 0");
    const view = await prView(item.pr.url);
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
    return {
      title: `Review ${item.key} (round ${round}): ${item.title}`,
      brief: renderBrief(f, { kind: "review", run, item, builtIn: REVIEW_BRIEF, context }),
    };
  },

  async validate(report: FactoryReport, _run: FactoryRun, item: FactoryItem) {
    const { result } = report;
    if (report.outcome === "blocked" || report.outcome === "needs-decision") return undefined;
    if (report.outcome !== "done")
      return `A review run reports done, blocked or needs-decision, not ${report.outcome}; put what you found in findings`;
    if (result?.kind === "review" && item.pr && result.prUrl.toLowerCase() !== item.pr.url.toLowerCase())
      return `You were asked to review ${item.pr.url}, not ${result.prUrl}`;
    return undefined;
  },

  async accept(_report: FactoryReport, run: FactoryRun, item: FactoryItem) {
    // GitHub is read and written after the report is answered, as the item's next step.
    later(f, item.id, `Taking ${item.key}'s review`, () => takeReview(f, run.id));
  },
});

export function setup(f: FactoryRuntime): void {
  f.runKinds.set("review", review(f));
}
