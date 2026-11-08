import { afterAll, afterEach, expect, test } from "bun:test";
import { buildBoard } from "../src/factory/board.ts";
import { workingCount } from "../src/factory/controller.ts";
import { items, newId, runs, scores, type FactoryRun } from "../src/factory/db.ts";
import { sampleJudges } from "../src/factory/scorers.ts";
import { recordUsage } from "../src/llm/quota.ts";
import { host } from "../src/logins.ts";
import { removeTmp } from "./fixtures/git.ts";
import { factoryNode } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const MODEL = { provider: "claudeAgent", model: "claude-haiku-5-5" };
const scorer = (stages: string[], sample: number) =>
  [
    "---",
    JSON.stringify({
      description: "Whether triage reproduced the bug",
      stages,
      labels: [
        { value: "reproduced", description: "A failing command shows the bug", score: 1 },
        { value: "guessed", description: "No reproduction", score: 0 },
      ],
      pass: 0.5,
      sample,
      model: MODEL,
    }),
    "---",
    "",
    "Run the reproduction command at the triaged commit.",
  ].join("\n");

const implement = {
  outcome: "done",
  summary: "Reproduced it.",
  result: { kind: "triage", route: "implement", reproduction: { command: "bun test", failsBefore: true } },
};

/** `main` as the default branch's checks read finds it: no required checks, nothing run yet. */
const MAIN = { refUpdateRule: null, rules: { nodes: [] }, target: { statusCheckRollup: null } };

/** The factory machine with three scorers: `repro` judges every triage run, `never` none, and `specs` a quarter of
 * spec runs. */
async function judgeFactory(threads = 20) {
  const n = await factoryNode(cleanup, {
    config: { limits: { threads } },
    files: {
      "scorers/repro.md": scorer(["triage"], 100),
      "scorers/never.md": scorer(["triage"], 0),
      "scorers/specs.md": scorer(["spec"], 25),
    },
  });
  // Implement reads the default branch's CI before it starts: no checks there. Nothing else reaches gh.
  const realGh = host.gh;
  host.gh = async (args) => {
    if (args[0] === "api" && args[1] === "graphql")
      return { ok: true, out: JSON.stringify({ data: { repository: { defaultBranchRef: MAIN } } }) };
    throw new Error(`no gh in this test: ${args.join(" ")}`);
  };
  cleanup.push(() => (host.gh = realGh));
  const builtin = (await n.ctx.gateway.builtin!()).client;
  /** A tool call from the run's own T3 thread: the parsed answer, or the tool error's text. */
  const call = async (name: string, run: FactoryRun, args: Record<string, unknown>) => {
    const result = await builtin.callTool({ name, arguments: args, _meta: { "dev.agentgate/t3Thread": run.threadId } });
    const text = (result.content as { text: string }[])[0]!.text;
    return result.isError ? { error: text } : JSON.parse(text);
  };
  const report = (run: FactoryRun, body: Record<string, unknown>) =>
    call("factory_report", run, { run: run.id, ...body });
  const judgeRuns = () => runs.list(n.s, { kinds: ["judge"] });
  const verdict = (label: string, scorerName = "repro") => ({
    outcome: "done",
    summary: "Graded it.",
    result: { kind: "judge", scorer: scorerName, label, reasoning: `It is ${label}.` },
  });

  /** An item added by hand whose triage thread reported `body` and went idle. */
  async function triaged(body: Record<string, unknown>) {
    await n.command("add", n.repo, "Crash on save");
    await n.dispatch();
    const triage = runs.list(n.s, { kinds: ["triage"] }).at(-1)!;
    expect(await report(triage, body)).toEqual({ accepted: true });
    n.mcp.setThread(triage.threadId!, { status: "idle" });
    await n.until(() => n.mirror.thread(triage.threadId!)?.status === "idle", "the triage thread to go idle");
    return runs.get(n.s, triage.id)!;
  }
  return { ...n, call, report, judgeRuns, verdict, triaged };
}

test("a quarter of reported spec runs are judged, the same runs every time, and each once", async () => {
  const n = await judgeFactory();
  await n.command("add", n.repo, "Crash on save");
  const item = items.list(n.s)[0]!;
  const ended = Array.from({ length: 400 }, () =>
    runs.insert(n.s, {
      id: newId("run"),
      item: item.id,
      kind: "spec",
      attempt: 1,
      state: "reported",
      nudges: 0,
      configCommit: item.configCommit,
    }),
  );
  const judged = () => {
    const before = n.judgeRuns().length;
    for (const run of ended) sampleJudges(n.f, run);
    return n
      .judgeRuns()
      .slice(before)
      .map((r) => r.checked);
  };

  const first = judged();
  expect(first.length).toBeGreaterThan(400 * 0.15);
  expect(first.length).toBeLessThan(400 * 0.35);
  expect(first).toEqual(first.map(() => expect.objectContaining({ scorer: "specs" })));
  // A run is judged once per scorer, however often it ends.
  expect(judged()).toEqual([]);
});

test("a reported triage run gets a judge thread on the scorer's model that reads the run through factory_run, and its label is stored with score, pass flag and reasoning", async () => {
  const n = await judgeFactory();
  const triage = await n.triaged(implement);

  // Only `repro` both scores triage and samples this run; `never`'s sample of 0 keeps it off.
  expect(n.judgeRuns().map((r) => r.checked)).toEqual([{ kind: "judge", run: triage.id, scorer: "repro" }]);
  await n.dispatch();
  const judge = n.judgeRuns()[0]!;
  expect(judge).toMatchObject({ state: "running", configCommit: triage.configCommit });
  const launch = n.mcp.calls.find((c) => c.tool === "t3_thread_launch" && c.args.clientRequestId === judge.id)!;
  expect(launch.args).toMatchObject({
    modelSelection: MODEL,
    workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
  });
  const brief = String(launch.args.message);
  expect(brief).toContain("Run the reproduction command at the triaged commit.");
  expect(brief).toContain("`reproduced` (score 1)");
  expect(brief).toContain(`call \`factory_run\` with \`run: "${triage.id}"\``);
  expect(brief).toContain(`run: "${judge.id}"`);

  const view = await n.call("factory_run", judge, { run: triage.id });
  expect(view).toMatchObject({
    run: triage.id,
    kind: "triage",
    state: "reported",
    report: { summary: "Reproduced it." },
  });
  expect(view.item).toMatchObject({ key: triage.item && items.get(n.s, triage.item)!.key, title: "Crash on save" });
  // Only a judge thread reads a run, and only the run it grades.
  expect((await n.call("factory_run", triage, { run: triage.id })).error).toContain("judge threads only");
  expect((await n.call("factory_run", judge, { run: judge.id })).error).toContain(`grades ${triage.id}`);

  expect(await n.report(judge, n.verdict("reproduced"))).toEqual({ accepted: true });
  expect(scores.forRun(n.s, triage.id)).toEqual([
    {
      run: triage.id,
      scorer: "repro",
      label: "reproduced",
      score: 1,
      passed: true,
      reasoning: "It is reproduced.",
      judgeRun: judge.id,
      at: n.s.now(),
    },
  ]);
  // The judge run has no item: its end leaves the item's phase and runs alone.
  expect(items.get(n.s, triage.item!)!.phase).toBe("implement");
});

test("a run that asked the maintainer is judged once, on the report after the answer", async () => {
  const n = await judgeFactory();
  const asks = {
    outcome: "needs-decision",
    summary: "Two ways.",
    decision: { question: "Keep v1?", recommendation: "Yes" },
  };
  const triage = await n.triaged(asks);
  expect(triage.state).toBe("reported");
  expect(n.judgeRuns()).toEqual([]);

  expect((await n.command("approve", items.list(n.s)[0]!.key)).code).toBe(0);
  expect(await n.report(triage, implement)).toEqual({ accepted: true });
  n.mcp.setThread(triage.threadId!, { status: "running" });
  n.mcp.setThread(triage.threadId!, { status: "idle" });
  await n.until(() => runs.get(n.s, triage.id)?.state === "reported", "the triage run to end again");
  expect(n.judgeRuns().map((r) => r.checked)).toEqual([{ kind: "judge", run: triage.id, scorer: "repro" }]);
});

test("a label outside the scorer's list is refused, and a failing grade makes the run it grades flawed", async () => {
  const n = await judgeFactory();
  // A triage that closes the item is still judged.
  const triage = await n.triaged({ outcome: "not-a-bug", summary: "Works as designed." });
  expect(items.get(n.s, triage.item!)!.phase).toBe("closed");
  await n.dispatch();
  const judge = n.judgeRuns()[0]!;
  expect(judge.state).toBe("running");

  expect((await n.report(judge, n.verdict("great"))).error).toContain(
    "great is not one of repro's labels: reproduced, guessed",
  );
  expect((await n.report(judge, n.verdict("reproduced", "specs"))).error).toContain("You judge as repro, not specs");
  expect(scores.forRun(n.s, triage.id)).toEqual([]);

  expect(await n.report(judge, n.verdict("guessed"))).toEqual({ accepted: true });
  expect(scores.forRun(n.s, triage.id)[0]).toMatchObject({ label: "guessed", score: 0, passed: false });
  expect(runs.get(n.s, triage.id)!.verdict).toBe("flawed");
});

test("judge runs count as working and wait for quota like any stage, and a stage run starts before them", async () => {
  const n = await judgeFactory(1);
  const triage = await n.triaged(implement);
  const implementRun = runs.forItem(n.s, triage.item!).find((r) => r.kind === "implement")!;

  n.s.put("account", "c1", { id: "c1", provider: "claude", label: "c1", priority: 1 });
  n.s.put("credential", "c1", {
    accountId: "c1",
    accessToken: "access-c1",
    refreshToken: "refresh-c1",
    expiresAt: n.s.now() + 7200_000,
    holder: "a",
  });
  recordUsage(n.s, "c1", {
    windows: [{ name: "5h", usedPct: 100, resetsAt: n.s.now() + 3600_000 }],
    status: "exhausted",
  });
  await n.dispatch();
  expect(n.judgeRuns()[0]).toMatchObject({ state: "queued", error: "no claude account has room" });

  n.advance(3600_001);
  await n.dispatch();
  // The judge was queued first, but live work goes first and takes the only thread.
  expect(runs.get(n.s, implementRun.id)!.state).toBe("running");
  expect(workingCount(n.f)).toBe(1);
  expect(n.judgeRuns()[0]!.state).toBe("queued");
});

test("with two threads and one at work, a triage queued after a judge takes the free thread, and the judge waits", async () => {
  const n = await judgeFactory(2);
  await n.command("add", n.repo, "Busy");
  await n.dispatch();
  const [busy] = runs.list(n.s, { kinds: ["triage"] });
  await n.until(() => n.mirror.thread(busy!.threadId!)?.status === "running", "the busy thread to run");
  await n.triaged({ outcome: "not-a-bug", summary: "Works as designed." });
  expect(n.judgeRuns().map((r) => r.state)).toEqual(["queued"]);

  await n.command("add", n.repo, "Later");
  await n.dispatch();
  const later = runs.list(n.s, { kinds: ["triage"] }).at(-1)!;
  expect(runs.get(n.s, later.id)!.state).toBe("running");
  expect(n.judgeRuns()[0]!.state).toBe("queued");
  expect(workingCount(n.f)).toBe(2);
});

test("a judge thread that ends twice without reporting is retried as attempt 2 on the same run", async () => {
  const n = await judgeFactory();
  const triage = await n.triaged(implement);
  await n.dispatch();
  const judge = n.judgeRuns()[0]!;
  await n.until(() => n.mirror.thread(judge.threadId!)?.status === "running", "the judge thread to run");
  n.mcp.setThread(judge.threadId!, { status: "idle" });
  await n.until(() => runs.get(n.s, judge.id)!.nudges === 1, "the reminder");
  await n.until(() => n.mirror.thread(judge.threadId!)?.status === "running", "the reminded thread to run");
  n.mcp.setThread(judge.threadId!, { status: "idle" });
  await n.until(() => n.judgeRuns().length === 2, "the retry");

  expect(runs.get(n.s, judge.id)!.state).toBe("silent");
  expect(n.judgeRuns()[1]).toMatchObject({
    attempt: 2,
    state: "queued",
    checked: { kind: "judge", run: triage.id, scorer: "repro" },
  });
});

test("the board shows each scorer's pass rate over the last 7 days, overall and per factory commit", async () => {
  const n = await judgeFactory();
  const run = (configCommit: string) =>
    runs.insert(n.s, { id: newId("run"), kind: "triage", attempt: 1, state: "reported", nudges: 0, configCommit });
  const grade = (scorerName: string, commit: string, passed: boolean) =>
    scores.put(n.s, {
      run: run(commit).id,
      scorer: scorerName,
      label: passed ? "reproduced" : "guessed",
      score: passed ? 1 : 0,
      passed,
      reasoning: "",
      judgeRun: newId("run"),
      at: n.s.now(),
    });
  grade("repro", "c1", false); // older than 7 days by the time the board is read
  n.advance(8 * 86_400_000);
  grade("repro", "c1", true);
  grade("repro", "c1", false);
  grade("repro", "c2", true);
  grade("specs", "c2", true);

  const board = await buildBoard(n.f, { includeWebhookUrls: false });
  expect(board.metrics.scorers).toEqual([
    {
      name: "repro",
      passRate: 2 / 3,
      runs: 3,
      byConfig: [
        { commit: "c1", passRate: 0.5, runs: 2 },
        { commit: "c2", passRate: 1, runs: 1 },
      ],
    },
    { name: "specs", passRate: 1, runs: 1, byConfig: [{ commit: "c2", passRate: 1, runs: 1 }] },
  ]);
});
