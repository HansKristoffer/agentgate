import type { FactoryReport } from "@agentgate/protocol";
import { z } from "zod";
import { renderBrief } from "./briefs.ts";
import { folderFor } from "./config.ts";
import { closeItem, defaultBranch, elsewhere, enqueueRun, moveItem, setNeedsYou, writeBack } from "./controller.ts";
import { runs, type FactoryItem, type FactoryRun } from "./db.ts";
import type { FactoryRuntime, LaunchSpec } from "./runtime.ts";
import { t3Mcp } from "./t3-mcp.ts";

/**
 * The spec stage, for items triage found unclear or large. The thread writes a spec, has a fresh agent review it, and
 * asks the maintainer one Approve or Change question card in T3. An approved spec starts implement, and
 * `factory_item` hands it to the implement and review runs from the run's report. A Change answer starts one more
 * round in a new thread; after that the item waits for the maintainer.
 */

const SPEC_BRIEF = `You write the spec for one item for AgentGate's software factory.

- Write the behavior, design, interfaces and test plan.
- Have a fresh subagent review the spec, and fix or answer every finding.
- Ask the maintainer one question card, Approve or Change, showing the spec.
- Report \`approved\` or the feedback.`;

/** The labels the card must use, so `agentgate factory approve|reject` can answer it. */
const APPROVE = "Approve";
const CHANGE = "Change";
/** Rounds the factory starts by itself before the item waits for the maintainer. */
const ROUNDS = 2;

const specRuns = (f: FactoryRuntime, item: FactoryItem) => runs.forItem(f.s, item.id).filter((r) => r.kind === "spec");
const asksForChanges = (r: FactoryRun) =>
  r.state === "reported" && r.report?.result?.kind === "spec" && !r.report.result.approved;

const listed = z.object({ requestIds: z.array(z.string()) });
const pendingRequest = z.object({
  requestId: z.string(),
  questions: z.array(
    z.object({
      id: z.string(),
      question: z.string(),
      options: z.array(z.object({ label: z.string(), value: z.string().optional() })),
    }),
  ),
});

/** The spec's Approve or Change card among the run's pending questions, with the answer each option takes. Throws
 * when there is none, naming the thread so the maintainer can answer in T3 Code. */
async function findCard(f: FactoryRuntime, run: FactoryRun & { threadId: string }) {
  const mcp = t3Mcp(f);
  const { threadId } = run;
  const where = run.threadLink ? `: ${run.threadLink}` : "";

  const { requestIds } = listed.parse(await mcp.call("t3_pending_request", { action: "list", threadId }));
  if (!requestIds.length) throw new Error(`The spec thread has no pending question; look at it in T3 Code${where}`);

  for (const requestId of requestIds) {
    const request = pendingRequest.parse(await mcp.call("t3_pending_request", { action: "read", threadId, requestId }));
    for (const question of request.questions) {
      const option = (label: string) =>
        question.options.find((o) => o.label.trim().toLowerCase() === label.toLowerCase());
      const approve = option(APPROVE);
      const change = option(CHANGE);
      if (!approve || !change) continue;
      return {
        requestId,
        question: question.id,
        approve: approve.value ?? approve.label,
        change: change.value ?? change.label,
      };
    }
  }
  throw new Error(`The spec thread asks something other than Approve or Change; answer it in T3 Code${where}`);
}

const spec = (f: FactoryRuntime) => ({
  kind: "spec" as const,

  async launch(run: FactoryRun, item: FactoryItem | undefined): Promise<LaunchSpec> {
    if (!item) throw new Error(`the spec run ${run.id} has no item`);
    // The next spec run is queued only after this one ends, so every other spec run of the item came before it. A
    // retry after a silent end repeats its round, but still gets a branch of its own.
    const before = specRuns(f, item);
    const round = before.filter(asksForChanges).length + 1;
    const model = folderFor(f, item.configCommit)?.stages.spec?.file.model;
    const context = [
      "## This run",
      [
        `- This is round ${round} of the spec. Put the spec in your report, not in a commit: this worktree is for reading the code.`,
        "- Read the triage result with the `factory_item` tool.",
        round > 1 &&
          "- The maintainer asked for changes to the previous round's spec. Read that spec and their feedback in the earlier spec run with `factory_item`, and address every point.",
        `- Ask with your question tool: one question whose options are exactly \`${APPROVE}\` and \`${CHANGE}\`, with the spec in the question so the maintainer reads it there. The maintainer may also answer from the command line, which picks one of those two labels, adding their feedback after \`${CHANGE}: \`.`,
        "- Report `approved: true` only when the maintainer chose Approve. When they chose Change, report `approved: false` with their feedback in `feedback`, and end your turn: the factory starts the next round.",
        "- Put the reviewer's findings and how you resolved each in `review`.",
      ]
        .filter((line): line is string => !!line)
        .join("\n"),
    ].join("\n\n");
    return {
      repo: item.repo,
      title: `Spec ${item.key}: ${item.title}`,
      brief: renderBrief(f, { kind: "spec", run, item, builtIn: SPEC_BRIEF, context }),
      baseRef: await defaultBranch(f, item.repo),
      branch: `factory/${item.key}-spec-${before.length}`,
      startFromOrigin: true,
      ...(model && { model }),
    };
  },

  async validate(report: FactoryReport) {
    const { result } = report;
    if (result && result.kind !== "spec") return `A spec run reports a spec result, not ${result.kind}`;
    if (report.outcome !== "done") return undefined;
    if (!result) return 'The outcome done needs result: { kind: "spec", spec, review, approved, feedback? }';
    if (!result.spec.trim()) return "result.spec is empty; report the spec the maintainer saw";
    if (!result.review.trim())
      return "result.review is empty; have a fresh subagent review the spec, and report its findings and how you resolved each";
    if (!result.approved && !result.feedback?.trim())
      return "approved is false, so result.feedback needs the changes the maintainer asked for";
    return undefined;
  },

  async accept(report: FactoryReport, run: FactoryRun, item: FactoryItem | undefined) {
    if (!item) return;
    const { result } = report;
    if (result?.kind !== "spec") return closeItem(f, item, "There is nothing to do.", report);
    if (result.approved) {
      const moved = moveItem(f, item.id, "implement");
      enqueueRun(f, { kind: "implement", item: item.id });
      await writeBack(f, moved, "spec-approved", { report, text: result.spec });
      return;
    }
    // Every round past the second waits too, including one the maintainer started with `retry`.
    const rounds = specRuns(f, item).filter(asksForChanges).length;
    if (rounds < ROUNDS) {
      f.events.emit({
        kind: "note",
        item: item.id,
        run: run.id,
        text: `The maintainer asked for changes to ${item.key}'s spec; round ${rounds + 1} is queued`,
      });
      enqueueRun(f, { kind: "spec", item: item.id });
      return;
    }
    setNeedsYou(f, item.id, {
      reason: "failed",
      question: `You asked for changes to ${item.key}'s spec ${rounds} times. Read the thread, then run agentgate factory retry ${item.key} for another round, or drop it.`,
      ...(run.threadLink && { link: run.threadLink }),
    });
  },

  /** `agentgate factory approve|reject` while the thread waits: the same answer the card would get in T3. */
  async answer(run: FactoryRun, decision: { approve: boolean; reason?: string }) {
    const { threadId } = run;
    if (!threadId) throw new Error(`The spec run ${run.id} has no thread yet`);
    if (elsewhere(f, run)) {
      const where = run.threadLink ? `: ${run.threadLink}` : "";
      throw new Error(`The spec thread runs on ${run.node}; answer its question in T3 Code there${where}`);
    }

    const card = await findCard(f, { ...run, threadId });
    const reason = decision.reason?.trim();
    const change = reason ? `${card.change}: ${reason}` : card.change;
    await t3Mcp(f).call("t3_pending_request", {
      action: "respond",
      threadId,
      requestId: card.requestId,
      answers: { [card.question]: decision.approve ? card.approve : change },
    });
  },
});

export function setup(f: FactoryRuntime): void {
  f.runKinds.set("spec", spec(f));
}
