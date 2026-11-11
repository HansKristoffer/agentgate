import { afterAll, afterEach, expect, test } from "bun:test";
import { buildBoard } from "../src/factory/board.ts";
import { makeCtx } from "../src/daemon.ts";
import { ensureFactoryTables, items, runs } from "../src/factory/db.ts";
import { claimWrite } from "../src/factory/outbox.ts";
import { itemOutcome, runTokens } from "../src/factory/records.ts";
import { loopTask, type FactoryRuntime } from "../src/factory/runtime.ts";
import { recordSessionUsage } from "../src/llm/sessions.ts";
import { host } from "../src/logins.ts";
import { Store } from "../src/store.ts";
import { prFactory } from "./fixtures/factory-pr.ts";
import { removeTmp } from "./fixtures/git.ts";
import { idle } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const MERGED_AT = "2026-11-05T12:00:00Z"; // the fake GitHub's mergedAt

/** One response's tokens, as the proxy records them under the session. */
function use(s: Store, session: string, model: string, tokens: { input: number; output: number; cacheRead?: number }) {
  recordSessionUsage(s, { session, provider: "claude", model, cacheRead: 0, cacheWrite: 0, ...tokens, at: s.now() });
}

const loop = (f: FactoryRuntime, name: string) =>
  loopTask(
    f,
    f.loops.find((l) => l.name === name)!,
  );

test("a run that ends records the tokens of its thread and its subagent threads", async () => {
  const n = await prFactory(cleanup);
  const { item, run } = await n.implementing(1);
  const thread = n.t3.threads.get(run.threadId!)!;
  // A subagent the implement thread delegated to, as T3's shell stream reports it. The sequence is past the
  // fixture's own, so the mirror applies it.
  const subagent = n.t3.addThread({ projectId: thread.projectId, sessionId: crypto.randomUUID(), subagent: true });
  n.t3.shell.push({
    kind: "thread.updated",
    sequence: 1_500_000,
    location: "active",
    thread: {
      id: subagent.id,
      projectId: subagent.projectId,
      title: subagent.title,
      status: "idle",
      updatedAt: subagent.updatedAt,
      lineage: { parentThreadId: thread.id, relationshipToParent: "subagent" },
    },
  });
  await n.until(() => n.mirror.thread(subagent.id)?.parentThreadId === thread.id, "the subagent in the mirror");
  use(n.s, thread.sessionId, "opus", { input: 1000, output: 200, cacheRead: 5000 });
  use(n.s, thread.sessionId, "haiku", { input: 100, output: 20 });
  use(n.s, subagent.sessionId, "sonnet", { input: 400, output: 80 });
  use(n.s, "another-session", "opus", { input: 9999, output: 9999 });

  const pr = n.github.openPr(101, `factory/${n.key(1)}`);
  expect(await n.done(run, pr)).toEqual({ accepted: true });
  await n.until(() => items.get(n.s, item.id)!.tokens > 0, "the run's tokens");

  const recorded = runs.get(n.s, run.id)!;
  expect(recorded).toMatchObject({ report: { outcome: "done", result: { kind: "implement", prUrl: pr.url } } });
  expect(items.get(n.s, item.id)!.pr).toMatchObject({ url: pr.url, head: pr.headRefOid, run: run.id });
  expect(items.get(n.s, item.id)!.tokens).toBe(6800);
  expect(await runTokens(n.f, recorded)).toBe(6800);
});

test("an item over its token budget has its threads interrupted and waits for the maintainer in its phase, and its threads are not read again", async () => {
  const n = await prFactory(cleanup, () => ({ limits: { threads: 20, itemTokens: 1000 } }));
  const { item, run } = await n.implementing(1);
  const session = n.t3.threads.get(run.threadId!)!.sessionId;
  const measure = loop(n.f, "factory-tokens");

  use(n.s, session, "opus", { input: 500, output: 100 });
  await measure();
  expect(items.get(n.s, item.id)).toMatchObject({ phase: "implement", tokens: 600 });
  expect(runs.get(n.s, run.id)!.state).toBe("running");

  use(n.s, session, "opus", { input: 400, output: 100 });
  await measure();
  expect(items.get(n.s, item.id)).toMatchObject({
    phase: "implement",
    tokens: 1100,
    needsYou: { kind: "stopped", cause: "budget", question: expect.stringContaining("Raise limits.itemTokens") },
  });
  expect(runs.get(n.s, run.id)!.state).toBe("cancelled");
  expect(n.mcp.calls).toContainEqual({
    tool: "t3_thread_interrupt",
    args: expect.objectContaining({ threadId: run.threadId }),
  });

  // While it waits, the token loop leaves its threads alone.
  const reads = () => n.t3.reads.get("orchestration.getThreadProjection") ?? 0;
  const before = reads();
  for (let minute = 0; minute < 60; minute++) {
    n.advance(60_000);
    await measure();
  }
  expect(reads()).toBe(before);
});

test("a report that races its item's budget stop is refused: the item stays stopped and no run is queued", async () => {
  const n = await prFactory(cleanup, () => ({ limits: { threads: 20, itemTokens: 1000 } }));
  const { item, run } = await n.implementing(1);

  // The run's thread went over the budget. While the stop interrupts it, the run reports its PR.
  let interrupted!: () => void;
  const stopping = new Promise<void>((resolve) => (interrupted = resolve));
  n.mcp.answer("t3_thread_interrupt", async () => {
    await stopping;
    return { ok: true };
  });
  use(n.s, n.t3.threads.get(run.threadId!)!.sessionId, "opus", { input: 1000, output: 100 });
  const measuring = loop(n.f, "factory-tokens")();
  await n.until(() => n.mcp.calls.some((c) => c.tool === "t3_thread_interrupt"), "the stop to interrupt a thread");
  const reporting = n.done(run, n.github.openPr(101, `factory/${item.key}`));
  interrupted();
  await measuring;
  expect(await reporting).toEqual({ error: `Run ${run.id} is cancelled and takes no report` });
  expect(items.get(n.s, item.id)).toMatchObject({ phase: "implement", needsYou: { cause: "budget" } });
  expect(items.get(n.s, item.id)!.pr).toBeUndefined();
  expect(runs.forItem(n.s, item.id).filter((r) => r.state === "queued")).toEqual([]);
});

test("a budget stop in pr reads no thread and sends no nudge, a merge still ships the item, and retry keeps its PR", async () => {
  const n = await prFactory(cleanup, () => ({ limits: { threads: 20, itemTokens: 1000 } }));
  const stop = async (run: { threadId?: string }) => {
    use(n.s, n.t3.threads.get(run.threadId!)!.sessionId, "opus", { input: 1000, output: 100 });
    await loop(n.f, "factory-tokens")();
    await idle(n.f);
  };
  const merged = await n.opened(1);
  const retried = await n.opened(2);
  await stop(merged.run);
  await stop(retried.run);
  for (const { item, run } of [merged, retried]) {
    expect(items.get(n.s, item.id)).toMatchObject({ phase: "pr", needsYou: { cause: "budget" } });
    // The implement thread owns the PR and still works after its report: the stop interrupts it too.
    await n.until(() => n.mirror.thread(run.threadId!)?.status === "interrupted", "the PR thread's interrupt");
  }

  // A failing check at a new head is a problem the follower would wake the thread for, but not while it is stopped.
  const reads = () => n.t3.reads.get("orchestration.getThreadProjection") ?? 0;
  const before = reads();
  for (const { pr } of [merged, retried]) Object.assign(pr, { checks: "failing", headRefOid: "c2" });
  for (let minute = 0; minute < 30; minute++) {
    n.advance(60_000);
    await loop(n.f, "factory-tokens")();
    if (minute % 2 === 0) await n.pollPrs();
  }
  expect(reads()).toBe(before);
  for (const { run } of [merged, retried]) expect(n.sent(run.threadId!)).toEqual([]);

  merged.pr.state = "MERGED";
  await n.pollPrs();
  expect(items.get(n.s, merged.item.id)!.phase).toBe("shipped");

  // retry goes on with the PR the item has: no second implement run and no second branch.
  expect(await n.command("retry", n.key(2))).toEqual({ code: 0, output: [`Retrying ${n.key(2)} with its PR`] });
  await n.dispatch();
  const after = items.get(n.s, retried.item.id)!;
  expect(after).toMatchObject({ phase: "pr", pr: { url: retried.pr.url, nudges: 0 } });
  expect(after.needsYou).toBeUndefined();
  expect(n.implementRuns(after).map((r) => r.state)).toEqual(["reported"]);
  await n.pollPrs();
  expect(n.sent(retried.run.threadId!)).toEqual([expect.stringContaining("its checks fail")]);
});

test("the token loop reads a thread's projections when a subagent starts, not every time the thread changes", async () => {
  const n = await prFactory(cleanup);
  // The implement run reported and its thread owns the PR, so the thread's turns are its own.
  const { run } = await n.opened(1);
  const measure = loop(n.f, "factory-tokens");
  const reads = () => n.t3.reads.get("orchestration.getThreadProjection") ?? 0;
  await measure();
  const first = reads();
  for (let minute = 0; minute < 60; minute++) {
    n.advance(60_000);
    await n.thread(run.threadId!, minute % 2 ? "idle" : "running");
    await measure();
  }
  expect(reads()).toBe(first);

  // A subagent's provider session counts too, so the thread and the subagent are read once.
  const parent = n.t3.threads.get(run.threadId!)!;
  const subagent = n.t3.addThread({
    projectId: parent.projectId,
    sessionId: crypto.randomUUID(),
    subagent: true,
    parentThreadId: parent.id,
  });
  n.mcp.setThread(subagent.id, { status: "running" });
  await n.until(() => n.mirror.thread(subagent.id)?.parentThreadId === parent.id, "the subagent in the mirror");
  await measure();
  expect(reads()).toBe(first + 2);
  await measure();
  expect(reads()).toBe(first + 2);
});

test("the token loop leaves the threads of an item's settled runs alone", async () => {
  const n = await prFactory(cleanup);
  const { item, run: owner } = await n.opened(1);
  const measure = loop(n.f, "factory-tokens");
  const reads = () => n.t3.reads.get("orchestration.getThreadProjection") ?? 0;
  await measure();
  const before = reads();
  const projectId = n.t3.threads.get(owner.threadId!)!.projectId;
  for (let i = 0; i < 20; i++) {
    const thread = n.t3.addThread({ projectId, sessionId: crypto.randomUUID() });
    runs.insert(n.s, {
      id: `run_old${i}`,
      item: item.id,
      kind: "triage",
      attempt: 1,
      state: "reported",
      threadId: thread.id,
      nudges: 0,
      configCommit: owner.configCommit,
      queuedAt: 0,
    });
  }
  await measure();
  expect(reads()).toBe(before);
});

test("a run whose tokens cannot be measured is noted once, and its item's tokens show as unknown after 10 minutes", async () => {
  const n = await prFactory(cleanup);
  const { run } = await n.implementing(1);
  const measure = loop(n.f, "factory-tokens");
  // T3 no longer has the thread, so its projection cannot be read.
  n.t3.threads.delete(run.threadId!);
  for (let pass = 0; pass < 3; pass++) {
    n.advance(5 * 60_000);
    await measure();
  }
  const notes = n.f.events.recent(50).filter((e) => e.text.startsWith(`Measuring the tokens of ${run.id} failed`));
  expect(notes).toHaveLength(1);
  const board = await buildBoard(n.f, { includeWebhookUrls: false });
  expect(board.items.find((i) => i.id === run.item)).toMatchObject({ tokensUnknown: true });
});

test("outcomes come from each item's PR and stay the item's, and the board shows the week's metrics", async () => {
  const n = await prFactory(cleanup);
  // GitHub's revert of PR 104, the only merged PR whose title starts with "Revert".
  const fakeGh = host.gh;
  let searches = 0;
  host.gh = async (args, stdin) => {
    if (args[0] !== "pr" || args[1] !== "list") return fakeGh(args, stdin);
    searches++;
    const revert = {
      number: 200,
      title: 'Revert "Other"',
      body: `Reverts ${n.repo}#104`,
      mergedAt: "2026-11-06T09:00:00Z",
    };
    return { ok: true, out: JSON.stringify([revert]) };
  };
  cleanup.push(() => (host.gh = fakeGh));
  const ready = async (number: number) => {
    const opened = await n.opened(number);
    items.update(n.s, opened.item.id, { phase: "ready" });
    return opened;
  };

  const merged = await ready(1);
  items.update(n.s, merged.item.id, { touches: 1 });
  merged.pr.state = "MERGED";
  const early = await n.opened(2);
  early.pr.state = "MERGED"; // merged before the factory called it ready
  const closed = await n.opened(3);
  closed.pr.state = "CLOSED";
  const reverted = await ready(4);
  reverted.pr.state = "MERGED";
  await n.pollPrs();
  await loop(n.f, "factory-outcomes")();
  // One revert search covers the repository's merged PRs.
  expect(searches).toBe(1);

  const outcome = (id: string) => itemOutcome(items.get(n.s, id)!);
  expect(outcome(merged.item.id)).toEqual({
    pr: {
      number: 101,
      title: "Fix it",
      state: "MERGED",
      mergedAt: MERGED_AT,
      reverted: false,
    },
    humanTouches: 1,
    hoursToMerge: (Date.parse(MERGED_AT) - merged.item.createdAt) / 3600_000,
    tokens: 0,
  });
  expect(outcome(closed.item.id).pr).toMatchObject({ state: "CLOSED", reverted: false });
  expect(outcome(reverted.item.id).pr).toMatchObject({ state: "MERGED", reverted: true });

  const { metrics } = await buildBoard(n.f, { includeWebhookUrls: false });
  expect(metrics).toMatchObject({
    merged: 3,
    mergeRate: 0.75,
    reverts14d: 1,
    medianHoursToMerge: expect.any(Number),
    humanTouchesPerItem: 0.25,
    tokensPerMergedPr: 0,
  });
});

test("each factory write the board shows bumps the factory topic", async () => {
  const s = new Store(":memory:");
  s.setLocal("node", "a");
  const ctx = makeCtx(s);
  cleanup.push(async () => {
    ctx.abort.abort();
    ctx.skills.close();
    ctx.imports.close();
    await ctx.gateway.close();
    s.close();
  });
  const f = ctx.factory;
  ensureFactoryTables(s);
  const item = items.insert(s, {
    id: "it_1",
    source: "bugs",
    externalId: "acme/api#12",
    key: "api-12",
    repo: "acme/api",
    title: "Crash on save",
    snapshot: { body: "steps", labels: ["factory"] },
    phase: "implement",
    configCommit: "3f2c1a9",
  });
  runs.insert(s, {
    id: "run_1",
    item: item.id,
    kind: "implement",
    attempt: 1,
    state: "queued",
    nudges: 0,
    configCommit: "3f2c1a9",
  });
  const bumped = (write: () => unknown) => {
    const bumps: string[] = [];
    s.onChange = (topic) => bumps.push(topic);
    write();
    s.onChange = undefined;
    return bumps;
  };

  expect(bumped(() => items.update(s, item.id, { title: "Crash on every save" }))).toEqual(["factory"]);
  expect(bumped(() => runs.update(s, "run_1", { state: "running" }))).toEqual(["factory"]);
  expect(bumped(() => runs.measured(s, "run_1", 500, 1))).toEqual(["factory"]);
  expect(bumped(() => claimWrite(f, item.id, "notify", "r1", "body", "A note"))).toEqual(["factory"]);
  expect(bumped(() => f.events.emit({ kind: "note", item: item.id, text: "Noted" }))).toEqual(["factory"]);
  await idle(f);
});
