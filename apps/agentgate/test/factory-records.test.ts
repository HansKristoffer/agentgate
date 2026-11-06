import { afterAll, afterEach, expect, test } from "bun:test";
import { buildBoard } from "../src/factory/board.ts";
import { items, runs, transcripts } from "../src/factory/db.ts";
import { MARKER_PREFIX } from "../src/factory/markers.ts";
import { itemOutcome, runTokens } from "../src/factory/records.ts";
import { loopTask, type FactoryRuntime } from "../src/factory/runtime.ts";
import { connectT3 } from "../src/handoff/t3.ts";
import { recordSessionUsage } from "../src/llm/sessions.ts";
import { host } from "../src/logins.ts";
import { NODE_PROTOCOL } from "../src/remote.ts";
import type { Store } from "../src/store.ts";
import { prFactory } from "./fixtures/factory-pr.ts";
import { removeTmp, tmp } from "./fixtures/git.ts";
import { startNodes } from "./fixtures/nodes.ts";
import { fakeT3 } from "./fixtures/t3.ts";
import { factoryNode, idle } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const KiB = 1024;
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

test("a run that ends keeps the start and the newest of its transcript in 256 KiB, and the tokens of its thread and its subagent threads", async () => {
  const n = await prFactory(cleanup);
  const { item, run } = await n.implementing(1);
  const thread = n.t3.threads.get(run.threadId!)!;
  const conversation = [
    { id: "m1", role: "user", text: "Implement gh-1", attachments: [] },
    { id: "m2", role: "assistant", text: `${"x".repeat(300 * KiB)}Opened the draft PR.`, attachments: [] },
  ];
  thread.conversation = conversation;
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
  expect(recorded).toMatchObject({
    report: { outcome: "done", result: { kind: "implement", prUrl: pr.url } },
    checked: { kind: "implement", pr: pr.url, head: pr.headRefOid },
    commitSha: pr.headRefOid,
  });
  const transcript = transcripts.get(n.s, run.id)!;
  expect(new TextEncoder().encode(transcript).length).toBeLessThanOrEqual(256 * KiB);
  // The brief and the first steps stay, and so does the end of the run.
  expect(transcript).toStartWith("## user\n\nImplement gh-1");
  expect(transcript).toContain("bytes of this transcript were cut here.");
  expect(transcript).toEndWith("Opened the draft PR.");
  expect(items.get(n.s, item.id)!.tokens).toBe(6800);
  expect(await runTokens(n.f, recorded)).toBe(6800);
});

test("a run that moved to another machine is read there through the peer routes, plus what this machine counted before the move", async () => {
  const a = await factoryNode(cleanup);
  const [b] = await startNodes("b");
  cleanup.push(() => b!.stop());
  const token = crypto.randomUUID();
  a.s.db.run("insert into peers values (?, ?, ?, 0, ?)", ["b", b!.url, token, a.s.now()]);
  b!.s.db.run("insert into peers values (?, ?, ?, 0, ?)", ["a", "http://127.0.0.1:1", token, b!.s.now()]);
  a.s.put("node", "b", { id: "b", protocol: NODE_PROTOCOL });
  b!.s.put("setting", "settings", { ...b!.s.settings(), factory: a.f.pointer() });
  const t3 = fakeT3({ claudeDir: tmp() });
  cleanup.push(t3.stop);
  await connectT3(b!.s, { url: t3.url, token: t3.pairingToken() });

  expect((await a.command("add", a.repo, "Crash on save")).code).toBe(0);
  await a.dispatch();
  const [run] = runs.list(a.s);
  // The handoff resumed the same session on b.
  const session = a.t3.threads.get(run!.threadId!)!.sessionId;
  const moved = t3.addThread({ projectId: t3.addProject(tmp()).id, sessionId: session });
  const conversation = [{ id: "m1", role: "assistant", text: "Reproduced it on b.", attachments: [] }];
  moved.conversation = conversation;
  runs.update(a.s, run!.id, { node: "b", threadId: moved.id });
  use(a.s, session, "opus", { input: 300, output: 50 });
  use(b!.s, session, "opus", { input: 1000, output: 150 });

  expect(await runTokens(a.f, runs.get(a.s, run!.id)!)).toBe(1500);

  expect((await a.command("drop", run!.item!)).code).toBe(0);
  await a.until(() => transcripts.get(a.s, run!.id), "the transcript from b");
  expect(transcripts.get(a.s, run!.id)).toBe("## assistant\n\nReproduced it on b.");
  expect(items.get(a.s, run!.item!)!.tokens).toBe(1500);
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
    needsYou: { reason: "budget", question: expect.stringContaining(`agentgate factory retry ${n.key(1)}`) },
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
  const { item, run: first } = await n.implementing(1);
  // Attempt 1 ends twice without a report, so attempt 2 works in a thread of its own.
  n.mcp.setThread(first.threadId!, { status: "idle" });
  await n.until(() => n.sent(first.threadId!).length === 1, "the reminder");
  await n.until(() => n.mirror.thread(first.threadId!)?.status === "running", "the reminded thread to run");
  n.mcp.setThread(first.threadId!, { status: "idle" });
  await n.until(() => runs.get(n.s, first.id)?.state === "silent", "attempt 1's silent end");
  await n.dispatch();
  const second = n.implementRuns(item).find((r) => r.attempt === 2)!;
  expect(second.state).toBe("running");

  // Attempt 1's thread went over the budget. While the stop interrupts the threads, attempt 2 reports its PR.
  let interrupted!: () => void;
  const stopping = new Promise<void>((resolve) => (interrupted = resolve));
  n.mcp.answer("t3_thread_interrupt", async () => {
    await stopping;
    return { ok: true };
  });
  use(n.s, n.t3.threads.get(first.threadId!)!.sessionId, "opus", { input: 1000, output: 100 });
  const measuring = loop(n.f, "factory-tokens")();
  await n.until(() => n.mcp.calls.some((c) => c.tool === "t3_thread_interrupt"), "the stop to interrupt a thread");
  const reporting = n.done(second, n.github.openPr(101, `factory/${item.key}-2`));
  interrupted();
  await measuring;
  expect(await reporting).toEqual({ error: `Run ${second.id} is cancelled and takes no report` });
  expect(items.get(n.s, item.id)).toMatchObject({ phase: "implement", needsYou: { reason: "budget" } });
  expect(items.get(n.s, item.id)!.prUrl).toBeUndefined();
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
    expect(items.get(n.s, item.id)).toMatchObject({ phase: "pr", needsYou: { reason: "budget" } });
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
  expect(after).toMatchObject({ phase: "pr", prUrl: retried.pr.url });
  expect(after.needsYou).toBeUndefined();
  expect(n.implementRuns(after).map((r) => r.state)).toEqual(["reported"]);
  await n.pollPrs();
  expect(n.sent(retried.run.threadId!)).toEqual([expect.stringContaining("its checks fail")]);
});

test("once its item ships, an implement run's transcript is read again: its start, and what its thread did after the report", async () => {
  const n = await prFactory(cleanup);
  const { item, run, pr } = await n.opened(1);
  await n.until(() => transcripts.get(n.s, run.id) !== undefined, "the report's transcript");
  const conversation = [
    { id: "m1", role: "user", text: "Implement the fix for issue 1", attachments: [] },
    { id: "m2", role: "assistant", text: "Opened the draft PR.", attachments: [] },
    { id: "m3", role: "user", text: "Its checks fail.", attachments: [] },
    { id: "m4", role: "assistant", text: "Pushed a fix for the failing check.", attachments: [] },
  ];
  n.t3.threads.get(run.threadId!)!.conversation = conversation;
  expect(transcripts.get(n.s, run.id)).not.toContain("Pushed a fix");

  pr.state = "MERGED";
  await n.pollPrs();
  expect(items.get(n.s, item.id)!.phase).toBe("shipped");
  expect(transcripts.get(n.s, run.id)).toContain("Implement the fix for issue 1");
  expect(transcripts.get(n.s, run.id)).toContain("Pushed a fix for the failing check.");
});

test("the token loop reads a thread's projection only when the thread changed", async () => {
  const n = await prFactory(cleanup);
  // The implement run reported and its thread owns the PR, so the thread's turns are its own.
  const { run } = await n.opened(1);
  const measure = loop(n.f, "factory-tokens");
  const reads = () => n.t3.reads.get("orchestration.getThreadProjection") ?? 0;
  await measure();
  const first = reads();
  for (let minute = 0; minute < 60; minute++) {
    n.advance(60_000);
    await measure();
  }
  expect(reads()).toBe(first);
  await n.thread(run.threadId!, "idle");
  await measure();
  expect(reads()).toBe(first + 1);
});

test("outcomes come from each item's PR and stay the item's, and the board shows the week's metrics", async () => {
  const n = await prFactory(cleanup);
  // GitHub's revert of PR 104, the only merged PR whose title starts with "Revert".
  const fakeGh = host.gh;
  host.gh = async (args, stdin) => {
    if (args[0] !== "pr" || args[1] !== "list") return fakeGh(args, stdin);
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
  const marker = { item: "it_x", key: "gh-1", stage: "review", outcome: null, route: null, commit: null };
  const factoryComment = `**gh-1**: Reviewed.\n\n${MARKER_PREFIX}${JSON.stringify({ ...marker, factory: "abc1234", node: "a", state: "open" })} -->`;

  const merged = await ready(1);
  merged.pr.comments.push(
    { body: "Please rename the flag.", authorAssociation: "OWNER", createdAt: MERGED_AT },
    { body: factoryComment, authorAssociation: "OWNER", createdAt: MERGED_AT },
    // A bot's comment is not a person's, whatever GitHub calls its association.
    {
      body: "Deployed to preview.",
      author: { login: "vercel[bot]" },
      authorAssociation: "CONTRIBUTOR",
      createdAt: MERGED_AT,
    },
  );
  merged.pr.reviews.push(
    { body: "Looks right now.", authorAssociation: "OWNER", submittedAt: MERGED_AT, state: "APPROVED" },
    { body: "", authorAssociation: "OWNER", submittedAt: MERGED_AT, state: "APPROVED" },
  );
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

  const outcome = (id: string) => itemOutcome(n.f, items.get(n.s, id)!);
  const verdicts = (id: string) => runs.forItem(n.s, id).map((r) => r.verdict);
  expect(outcome(merged.item.id)).toEqual({
    pr: {
      number: 101,
      title: "Fix it",
      state: "MERGED",
      mergedAt: MERGED_AT,
      reverted: false,
      peopleComments: 2,
      peopleReviews: 2,
    },
    humanTouches: 1,
    hoursToMerge: (Date.parse(MERGED_AT) - merged.item.createdAt) / 3600_000,
    tokens: 0,
  });
  expect(outcome(closed.item.id).pr).toMatchObject({ state: "CLOSED", reverted: false });
  expect(outcome(reverted.item.id).pr).toMatchObject({ state: "MERGED", reverted: true });
  // A run's verdict is what judged that run: a triage that did its job is not flawed because a PR was closed.
  for (const { item } of [merged, early, closed, reverted]) expect(verdicts(item.id)).toEqual([undefined, undefined]);

  const { metrics } = await buildBoard(n.f, { includeWebhookUrls: false });
  expect(metrics).toMatchObject({
    merged: 3,
    mergeRate: 0.75,
    reverts14d: 1,
    medianHoursToMerge: expect.any(Number),
    humanTouchesPerItem: 0.25,
    tokensPerMergedPr: 0,
    scorers: [],
  });
});
