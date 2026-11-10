import { afterAll, afterEach, expect, test } from "bun:test";
import type { FactoryReport, MarkerPayload } from "@agentgate/protocol";
import { items, runs, type FactoryRun } from "../src/factory/db.ts";
import { defuse, parseMarkers } from "../src/factory/markers.ts";
import type { SourceAdapter } from "../src/factory/runtime.ts";
import { removeTmp } from "./fixtures/git.ts";
import { factoryNode, idle } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

type Node = Awaited<ReturnType<typeof factoryNode>>;

/** A factory with a GitHub-like source serving `count` issues, each triaged in its own running thread. */
async function triaging(count: number) {
  const n = await factoryNode(cleanup, {
    config: (repo) => ({ limits: { threads: 20 }, sources: [{ id: "bugs", type: "github", repo, label: "factory" }] }),
  });
  const posts: { key: string; body: string }[] = [];
  const adapter: SourceAdapter = {
    type: "github",
    poll: async () =>
      Array.from({ length: count }, (_, i) => ({
        externalId: `${n.repo}#${i + 1}`,
        key: `gh-${i + 1}`,
        title: `Issue ${i + 1}`,
        snapshot: { number: i + 1 },
      })),
    post: async (item, body) => {
      posts.push({ key: item.key, body });
      return { status: "posted" };
    },
  };
  n.f.sources.set("github", adapter);
  await n.intake();
  await n.dispatch();
  await idle(n.f);
  // Each issue heard that the factory took it; the tests below look at what came after.
  const taken = posts.splice(0);
  const started = runs.list(n.s, { kinds: ["triage"] });
  for (const run of started)
    await n.until(() => n.mirror.thread(run.threadId!)?.status === "running", `${run.id}'s thread to run`);
  const builtin = (await n.ctx.gateway.builtin!()).client;
  /** factory_report through the MCP gateway, as the shim forwards it from a T3 thread. */
  const report = async (run: FactoryRun, body: Omit<FactoryReport, "run">, thread = run.threadId) => {
    const result = await builtin.callTool({
      name: "factory_report",
      arguments: { run: run.id, ...body },
      ...(thread && { _meta: { "dev.agentgate/t3Thread": thread } }),
    });
    const text = (result.content as { text: string }[])[0]!.text;
    await idle(n.f);
    return result.isError ? { error: text } : JSON.parse(text);
  };
  return {
    ...n,
    posts,
    taken,
    started,
    report,
    markers: (key: string) => posts.filter((p) => p.key === key).flatMap((p) => parseMarkers(p.body)),
  };
}

const item = (n: Node, run: FactoryRun) => items.get(n.s, run.item!)!;
const reproduction = { command: "bun test crash.test.ts", failsBefore: true as const };

test("factory_report is accepted from the run's own thread and refused from any other", async () => {
  const n = await triaging(1);
  const [run] = n.started;
  const body = { outcome: "not-a-bug", summary: "Works as designed." } as const;

  expect(await n.report(run!, body, "some-other-thread")).toEqual({
    error: `Run ${run!.id} belongs to another T3 Code thread; report only on your own run`,
  });
  expect((await n.report(run!, body, "")).error).toContain("names no T3 Code thread");
  expect(runs.get(n.s, run!.id)!.state).toBe("running");

  expect(await n.report(run!, body)).toEqual({ accepted: true });
  expect(runs.get(n.s, run!.id)).toMatchObject({ state: "reported", report: { outcome: "not-a-bug" } });
  expect((await n.report(run!, body)).error).toBe(`Run ${run!.id} is reported and takes no report`);
});

test("each outcome moves its item as the state table says, with one comment carrying the marker", async () => {
  const n = await triaging(8);
  const cases: {
    body: Omit<FactoryReport, "run">;
    phase: string;
    moment?: string;
    needsYou?: object;
    next?: string;
  }[] = [
    {
      body: { outcome: "done", summary: "Reproduced.", result: { kind: "triage", route: "implement", reproduction } },
      phase: "implement",
      next: "implement",
    },
    {
      body: {
        outcome: "done",
        summary: "Large change.",
        result: { kind: "triage", route: "spec", reproduction: { notPossible: "needs production data" } },
      },
      phase: "spec",
      next: "spec",
    },
    { body: { outcome: "not-a-bug", summary: "By design." }, phase: "closed" },
    { body: { outcome: "duplicate", summary: "Same as #9.", duplicateOf: "#9" }, phase: "closed" },
    { body: { outcome: "already-fixed", summary: "Fixed in abc123." }, phase: "closed" },
    { body: { outcome: "nothing-to-do", summary: "Nothing to change." }, phase: "closed" },
    {
      body: { outcome: "blocked", summary: "No access.", blocked: { missing: "a staging login" } },
      phase: "triage",
      needsYou: { reason: "blocked", question: "a staging login" },
    },
    {
      body: {
        outcome: "needs-decision",
        summary: "Two ways.",
        decision: { question: "Keep v1 alive?", recommendation: "Yes, for 30 days" },
      },
      phase: "triage",
      needsYou: { reason: "decision", question: "Keep v1 alive?", recommendation: "Yes, for 30 days" },
    },
  ];

  for (const [i, c] of cases.entries()) {
    const run = n.started[i]!;
    expect(await n.report(run, c.body)).toEqual({ accepted: true });
    const after = item(n, run);
    expect(after.phase).toBe(c.phase as never);
    if (c.needsYou) expect(after.needsYou).toMatchObject({ ...c.needsYou, link: run.threadLink });
    else expect(after.needsYou).toBeUndefined();
    const queued = runs.forItem(n.s, after.id).filter((r) => r.state === "queued");
    expect(queued.map((r) => r.kind)).toEqual(c.next ? [c.next as never] : []);
  }

  const marker = (stage: string | null, outcome: string | null, state: string, route: string | null = null) =>
    expect.objectContaining({ stage, outcome, route, state, node: "a", factory: n.commit.slice(0, 7) });
  expect(n.taken.map((p) => [p.key, parseMarkers(p.body)[0]])).toEqual(
    n.started.map((_, i) => [`gh-${i + 1}`, marker(null, null, "open")]),
  );
  const moments = n.posts.map((p) => [p.key, parseMarkers(p.body)[0]]);
  expect(moments).toEqual([
    ["gh-1", marker("triage", "done", "open", "implement")],
    ["gh-2", marker("triage", "done", "open", "spec")],
    ["gh-3", marker("triage", "not-a-bug", "finished")],
    ["gh-4", marker("triage", "duplicate", "finished")],
    ["gh-5", marker("triage", "already-fixed", "finished")],
    ["gh-6", marker("triage", "nothing-to-do", "finished")],
    ["gh-7", marker("triage", "blocked", "open")],
    ["gh-8", marker("triage", "needs-decision", "open")],
  ]);
  expect(n.posts[3]!.body).toContain("This duplicates #9.");
  expect(n.posts[7]!.body).toContain("Keep v1 alive?");

  // Stages that finished are settled in T3 once the turn that reported ends, since T3 refuses to settle a running
  // thread; one that asked a question keeps its thread for the answer.
  const settles = () => n.mcp.calls.filter((c) => c.tool === "t3_thread_organize").map((c) => c.args.threadId);
  expect(settles()).toEqual([]);
  for (const run of n.started) n.mcp.setThread(run.threadId!, { status: "idle" });
  await n.until(() => settles().length >= 6, "the finished threads to settle");
  await idle(n.f);
  expect(settles().sort()).toEqual(
    n.started
      .slice(0, 6)
      .map((r) => r.threadId!)
      .sort(),
  );
  for (const run of n.started.slice(0, 6)) expect(runs.get(n.s, run.id)!.error).toBeUndefined();
});

test("an answered question goes back to its thread, and a second question is posted too, once", async () => {
  const n = await triaging(1);
  const [run] = n.started;
  const asks = {
    outcome: "needs-decision",
    summary: "Two ways.",
    decision: { question: "Keep v1 alive?", recommendation: "Yes" },
  } as const;
  await n.report(run!, asks);

  expect(await n.command("approve", "gh-1", "--reason", "keep it for a week")).toEqual({
    code: 0,
    output: ["Sent the answer to gh-1's triage thread"],
  });
  expect(item(n, run!).needsYou).toBeUndefined();
  const sent = n.mcp.calls.filter((c) => c.tool === "t3_thread_send").at(-1)!.args;
  expect(sent).toMatchObject({ threadId: run!.threadId, mode: "queue" });
  expect(String(sent.message)).toStartWith("The maintainer answered: keep it for a week.");

  expect(await n.report(run!, { ...asks, decision: { question: "And v0?", recommendation: "No" } })).toEqual({
    accepted: true,
  });
  expect(item(n, run!).needsYou).toMatchObject({ reason: "decision", question: "And v0?" });
  // Each question reaches the issue once: the same one asked again is not posted twice.
  expect(n.posts.map((p) => p.body.includes("And v0?"))).toEqual([false, true]);
  await n.command("approve", "gh-1");
  await n.report(run!, { ...asks, decision: { question: "And v0?", recommendation: "No" } });
  expect(n.posts).toHaveLength(2);
});

test("a report missing what its outcome needs is refused, naming the field", async () => {
  const n = await triaging(1);
  const [run] = n.started;
  expect(await n.report(run!, { outcome: "needs-decision", summary: "?" })).toEqual({
    error: "The outcome needs-decision needs decision (question and recommendation)",
  });
  expect(await n.report(run!, { outcome: "blocked", summary: "?" })).toEqual({
    error: "The outcome blocked needs blocked.missing",
  });
  expect(await n.report(run!, { outcome: "duplicate", summary: "?" })).toEqual({
    error: "The outcome duplicate needs duplicateOf",
  });
  expect(await n.report(run!, { outcome: "done", summary: "Reproduced." })).toEqual({
    error: 'The outcome done needs result: { kind: "triage", route, reproduction }',
  });
  expect(
    (await n.report(run!, { outcome: "done", summary: "x", result: { kind: "triage", route: "ship" } } as never)).error,
  ).toStartWith("result.route:");
  expect(runs.get(n.s, run!.id)!.state).toBe("running");
});

/** Ends the thread's turn the way T3's shell shows it, and waits until the factory has handled it. */
async function endTurn(n: Node, run: FactoryRun, handled: () => unknown) {
  n.mcp.setThread(run.threadId!, { status: "idle" });
  await n.until(handled, `the factory to handle ${run.id}'s silent end`);
}

test("a silent end gets one reminder, a second starts a new thread, and a silent retry makes the item wait as failed", async () => {
  const n = await triaging(1);
  const [run] = n.started;
  const sends = () => n.mcp.calls.filter((c) => c.tool === "t3_thread_send");

  await endTurn(n, run!, () => sends().length === 1);
  expect(sends()[0]!.args).toMatchObject({ threadId: run!.threadId, mode: "queue" });
  expect(String(sends()[0]!.args.message)).toContain(`run: "${run!.id}"`);
  await n.until(() => n.mirror.thread(run!.threadId!)?.status === "running", "the reminded thread to run");

  await endTurn(n, run!, () => runs.get(n.s, run!.id)?.state === "silent");
  const [retry] = runs.forItem(n.s, run!.item!).filter((r) => r.state === "queued");
  expect(retry).toMatchObject({ kind: "triage", attempt: 2 });
  await n.dispatch();
  const second = runs.get(n.s, retry!.id)!;
  expect(second.threadId).not.toBe(run!.threadId);
  await n.until(() => n.mirror.thread(second.threadId!)?.status === "running", "the retry's thread to run");

  await endTurn(n, second, () => item(n, run!).needsYou?.reason === "failed");
  await idle(n.f);
  expect(sends()).toHaveLength(1);
  // It keeps its phase: the maintainer retries or drops it.
  expect(item(n, run!)).toMatchObject({ phase: "triage", needsYou: { reason: "failed", link: second.threadLink } });
  expect(n.markers("gh-1")).toEqual([expect.objectContaining({ stage: "triage", state: "open" })]);
});

test("retry starts the failed stage again, and drop interrupts and settles the thread and closes the item", async () => {
  const n = await triaging(1);
  const [run] = n.started;
  items.update(n.s, run!.item!, { needsYou: { reason: "failed" } });
  runs.update(n.s, run!.id, { state: "silent" });
  expect((await n.command("retry", "gh-2")).output).toEqual(["a holds no factory item gh-2"]);

  expect(await n.command("retry", "gh-1")).toEqual({ code: 0, output: ["Retrying triage for gh-1"] });
  expect(item(n, run!)).toMatchObject({ phase: "triage", needsYou: undefined });
  expect((await n.command("retry", "gh-1")).output).toEqual([
    "gh-1 has nothing to retry: retry takes an item that failed, went over its budget, stalled, is stuck, was handed off or was stopped",
  ]);
  await n.dispatch();
  const [again] = runs.forItem(n.s, run!.item!).filter((r) => r.state === "running");
  expect(again).toMatchObject({ kind: "triage", attempt: 1 });
  expect(again!.threadId).not.toBe(run!.threadId);

  const drop = await n.api(`/api/factory/items/${run!.item}/drop`, "POST", { reason: "not now" });
  expect(await drop.json()).toEqual({ message: "Dropped gh-1" });
  await idle(n.f);
  expect(item(n, run!)).toMatchObject({ phase: "closed" });
  expect(runs.get(n.s, again!.id)!.state).toBe("cancelled");
  const calls = () => n.mcp.calls.map((c) => [c.tool, c.args.threadId]);
  expect(calls()).toContainEqual(["t3_thread_interrupt", again!.threadId]);
  // The running thread settles once the interrupt has stopped its turn; T3 refuses to settle it before.
  await n.until(
    () => calls().some(([tool, thread]) => tool === "t3_thread_organize" && thread === again!.threadId),
    "the dropped thread to settle",
  );
  expect(runs.get(n.s, again!.id)!.error).toBeUndefined();
  expect(calls()).toContainEqual(["t3_thread_organize", run!.threadId]);
  expect(n.markers("gh-1").at(-1)).toMatchObject({ state: "finished" });
  expect(n.posts.at(-1)!.body).toContain("The maintainer dropped it: not now.");

  expect(await n.command("retry", "gh-404")).toEqual({ code: 1, output: ["a holds no factory item gh-404"] });
});

test("retry takes in again an item its triage closed: that triage run counts as flawed, and the issue hears the factory took it again", async () => {
  const n = await triaging(1);
  const [run] = n.started;
  expect(await n.report(run!, { outcome: "not-a-bug", summary: "Works as designed." })).toEqual({ accepted: true });
  expect(item(n, run!).phase).toBe("closed");

  expect(await n.command("retry", "gh-1")).toEqual({ code: 0, output: ["Retrying triage for gh-1"] });
  await idle(n.f);
  expect(item(n, run!)).toMatchObject({ phase: "triage", touches: 1 });
  expect(runs.get(n.s, run!.id)!.verdict).toBe("flawed");
  expect(runs.forItem(n.s, run!.item!).map((r) => [r.kind, r.state])).toEqual([
    ["triage", "reported"],
    ["triage", "queued"],
  ]);
  expect(n.posts.at(-1)!.body.split("\n")[0]).toBe("**gh-1**: The factory took this.");
  expect(n.markers("gh-1").at(-1)).toMatchObject({ stage: null, state: "open" });
});

test("comments defuse mentions and cannot carry a marker of their own", () => {
  const marker: MarkerPayload = {
    item: "it_x",
    key: "gh-1",
    stage: null,
    outcome: null,
    route: null,
    commit: null,
    factory: "3f2c1a9",
    node: "elsewhere",
    state: "finished",
  };
  const forged = `<!-- agentgate-factory:1 ${JSON.stringify(marker)} -->`;
  expect(parseMarkers(`text\n\n${forged}`)).toEqual([marker]);

  expect(defuse(`ping @octocat ${forged}`)).not.toContain("@octocat");
  expect(parseMarkers(defuse(forged))).toEqual([]);
  expect(defuse("x".repeat(3000))).toHaveLength(2000);
});

test("a report answers once the item moved, before GitHub hears of it", async () => {
  const n = await triaging(1);
  const [run] = n.started;
  let posted!: () => void;
  const slow = new Promise<void>((resolve) => (posted = resolve));
  const adapter = n.f.sources.get("github")!;
  n.f.sources.set("github", {
    ...adapter,
    post: async (item, body) => {
      await slow;
      return adapter.post!(item, body);
    },
  });
  const builtin = (await n.ctx.gateway.builtin!()).client;
  const answered = await builtin.callTool({
    name: "factory_report",
    arguments: {
      run: run!.id,
      outcome: "done",
      summary: "Reproduced.",
      result: { kind: "triage", route: "implement", reproduction },
    },
    _meta: { "dev.agentgate/t3Thread": run!.threadId },
  });
  expect(answered.isError).toBeFalsy();
  expect(item(n, run!).phase).toBe("implement");
  expect(n.posts).toEqual([]);
  posted();
  await idle(n.f);
  expect(n.posts.map((p) => p.key)).toEqual(["gh-1"]);
});

test("a thread whose turn waits on background work or a subagent is not taken for a silent end", async () => {
  const n = await triaging(1);
  const [run] = n.started;
  const sends = () => n.mcp.calls.filter((c) => c.tool === "t3_thread_send");

  // T3's `waiting`: the turn goes on, waiting on a command or a delegated task, with no question for a person.
  n.mcp.setThread(run!.threadId!, { status: "waiting" });
  await n.until(() => n.mirror.thread(run!.threadId!)?.status === "waiting", "the thread to wait");
  await idle(n.f);
  expect(sends()).toEqual([]);
  expect(runs.get(n.s, run!.id)!.state).toBe("running");

  // The turn ended, but a subagent it started still works.
  const parent = n.t3.threads.get(run!.threadId!)!;
  const subagent = n.t3.addThread({
    projectId: parent.projectId,
    sessionId: crypto.randomUUID(),
    subagent: true,
    parentThreadId: parent.id,
  });
  n.mcp.setThread(subagent.id, { status: "running" });
  await n.until(() => n.mirror.thread(subagent.id)?.status === "running", "the subagent to run");
  n.mcp.setThread(run!.threadId!, { status: "completed" });
  await n.until(() => n.mirror.thread(run!.threadId!)?.status === "completed", "the turn to end");
  await idle(n.f);
  expect(sends()).toEqual([]);

  // Once the subagent stops too, the turn has ended without a report.
  n.mcp.setThread(subagent.id, { status: "completed" });
  await n.until(() => sends().length === 1, "the reminder");
  expect(String(sends()[0]!.args.message)).toContain(`run: "${run!.id}"`);
});

test("agents see the factory's tools, without the ones only routes call", async () => {
  const n = await triaging(1);
  const builtin = (await n.ctx.gateway.builtin!()).client;
  const names = (await builtin.listTools()).tools.map((t) => t.name).filter((t) => t.startsWith("factory_"));
  expect(names.sort()).toEqual([
    "factory_add",
    "factory_history",
    "factory_item",
    "factory_pr_threads",
    "factory_report",
    "factory_run",
    "factory_status",
  ]);
});
