import type { FactoryCheck, RunState } from "@agentgate/protocol";
import { currentFolder, folderFor } from "./config.ts";
import { cancelLaunch, defaultBranch, endRun, enqueueRun } from "./controller.ts";
import { ACTIVE, runs, type FactoryRun } from "./db.ts";
import { t3Mcp } from "./t3-mcp.ts";
import { shortError, type FactoryRuntime, type LaunchSpec, type NoLaunch, type RunKindDefinition } from "./runtime.ts";

/**
 * `agentgate factory doctor --canary`: one short thread whose brief only calls `factory_report`, the one check that
 * proves the whole chain a stage needs: dispatch, the launch in T3 Code, the session's MCP shim, the gateway and the
 * report. It is a run of its own kind with no item, so nothing is posted and no item is made.
 */

/** How long `doctor` waits for the report: within the CLI's 100 s wait for an answer. Tests shorten it. */
export const canaryTiming = { waitMs: 90_000 };

const brief = (run: FactoryRun) =>
  `This is a canary of AgentGate's software factory: it only checks that a factory thread can reach the factory. Read no files, run no commands and change nothing.

Call the AgentGate MCP tool \`factory_report\` once, with \`{ "run": "${run.id}", "outcome": "done", "summary": "canary" }\`, then end your turn. If you have no such tool, say so in one sentence and end your turn.`;

/** The triage stage's model, the folder's cheapest stage by design, or else T3 Code's default. */
const modelOf = (f: FactoryRuntime, run: FactoryRun) => folderFor(f, run.configCommit)?.stages.triage?.file.model;

const canaryRun = (f: FactoryRuntime): RunKindDefinition => ({
  kind: "canary",
  model: (run) => modelOf(f, run),
  async launch(run): Promise<LaunchSpec | NoLaunch> {
    const repo = Object.keys(folderFor(f, run.configCommit)?.config.repositories ?? {})[0];
    if (!repo) return cancelLaunch(f, run, "the factory's folder names no repository");
    const model = modelOf(f, run);
    return {
      repo,
      title: `Factory canary ${run.id}`,
      brief: brief(run),
      baseRef: await defaultBranch(f, repo),
      branch: `factory/canary-${run.id}`,
      ...(model && { model }),
    };
  },
  async validate(report) {
    return report.outcome === "done" && !report.result
      ? undefined
      : 'A canary reports only { outcome: "done" }, with no result';
  },
  // `doctor` hears the report as the run ends; there is nothing to post.
  async accept() {},
});

/** Starts a canary and waits for its run to end, or for `canaryTiming.waitMs`: the check `doctor --canary` adds. */
export async function runCanary(f: FactoryRuntime): Promise<FactoryCheck> {
  const check = { id: "canary", title: "A factory thread starts and reports back (canary)" };
  const fix =
    "open the canary's thread in T3 Code; a thread without agentgate's MCP server cannot report (see the mcp check)";
  if (!currentFolder(f))
    return { ...check, state: "fail", detail: "the factory's folder has not loaded", fix: "agentgate factory reload" };
  // Queued as its last attempt, so a turn that ends without a report ends the run at once: no reminder, and no second
  // thread that nobody waits for.
  const run = enqueueRun(f, { kind: "canary", attempt: 2 });
  const started = f.s.now();
  let stop = () => {};
  const ended = await new Promise<RunState | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), canaryTiming.waitMs);
    const off = f.events.on("run.ended", (e) => {
      if (e.run === run.id) resolve(e.state);
    });
    stop = () => {
      clearTimeout(timer);
      off();
    };
  });
  stop();
  const now = runs.get(f.s, run.id)!;
  const where = now.threadLink ?? now.threadId;
  if (ended === "reported")
    return { ...check, state: "ok", detail: `${where} reported in ${Math.round((f.s.now() - started) / 1000)}s` };
  if (ended === "silent")
    return { ...check, state: "fail", detail: `${where} ended its turn without calling factory_report`, fix };
  if (ended)
    return { ...check, state: "fail", detail: `the run ended ${ended}${now.error ? `: ${now.error}` : ""}`, fix };

  const seconds = Math.round(canaryTiming.waitMs / 1000);
  if (ACTIVE.includes(now.state)) {
    endRun(f, now, now.threadId ? "failed" : "cancelled", { error: `no report within ${seconds}s` });
    // A thread that started is stopped; one still starting is stopped by its launch, which finds the run ended.
    if (now.threadId)
      await t3Mcp(f)
        .call("t3_thread_interrupt", { threadId: now.threadId, reason: "The factory's canary timed out." })
        .catch((e) =>
          f.events.emit({ kind: "note", run: run.id, text: `Stopping the canary failed: ${shortError(e)}` }),
        );
  }
  return {
    ...check,
    state: "fail",
    detail: now.threadId
      ? `${where} did not report within ${seconds}s`
      : `the thread did not start within ${seconds}s${now.error ? `: ${now.error}` : "; dispatch starts it once a thread is free and the factory is not paused"}`,
    fix,
  };
}

export function setup(f: FactoryRuntime): void {
  f.runKinds.set("canary", canaryRun(f));
}
