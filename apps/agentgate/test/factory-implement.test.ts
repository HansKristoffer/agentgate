import { afterAll, afterEach, expect, test } from "bun:test";
import { buildBoard } from "../src/factory/board.ts";
import { items, runs } from "../src/factory/db.ts";
import { parseMarkers } from "../src/factory/markers.ts";
import { prFactory } from "./fixtures/factory-pr.ts";
import { removeTmp } from "./fixtures/git.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

test("route implement starts a run on factory/<key> from the default branch, and waits while that branch's CI fails", async () => {
  const n = await prFactory(cleanup);
  n.github.ci = "failure";
  const { item, run } = await n.implementing(1);
  const implementLaunches = () =>
    n.mcp.calls.filter((c) => c.tool === "t3_thread_launch" && c.args.clientRequestId === run.id);

  expect(items.get(n.s, item.id)!.phase).toBe("implement");
  expect(runs.get(n.s, run.id)).toMatchObject({ state: "queued", error: expect.stringContaining("fails CI") });
  expect(implementLaunches()).toEqual([]);
  expect((await buildBoard(n.f, { includeWebhookUrls: false })).capacity.mainRed).toEqual([n.repo]);

  n.github.ci = "success";
  n.advance(2 * 60_000);
  await n.dispatch();
  expect(implementLaunches()).toHaveLength(1);
  const [launch] = implementLaunches();
  expect(launch!.args).toMatchObject({
    title: `Implement ${n.key(1)}: Issue 1`,
    workspaceStrategy: { type: "worktree", baseRef: "main", branch: `factory/${n.key(1)}`, startFromOrigin: true },
  });
  const brief = String(launch!.args.message);
  expect(brief).toContain("Never comment on GitHub or Linear");
  expect(brief).toContain("Before you open the PR, read your whole diff as a reviewer would");
  expect(brief).toContain("Put `Fixes #1` in its body.");
  expect(brief).toContain(`run: "${run.id}"`);
  expect((await buildBoard(n.f, { includeWebhookUrls: false })).capacity.mainRed).toEqual([]);
});

test("a done report missing prUrl, commit, claims or notChecked is refused, naming what is missing", async () => {
  const n = await prFactory(cleanup);
  const { item, run } = await n.implementing(1);

  expect(await n.report(run, { outcome: "done", summary: "Done." })).toEqual({
    error: 'The outcome done needs result: { kind: "implement", prUrl, commit, claims, notChecked }',
  });
  const partial = await n.report(run, {
    outcome: "done",
    summary: "Done.",
    result: { kind: "implement", prUrl: "https://github.com/a/b/pull/1", claims: [], notChecked: [] },
  });
  expect(partial.error).toStartWith("result.commit:");
  expect(runs.get(n.s, run.id)!.state).toBe("running");
  expect(items.get(n.s, item.id)!.phase).toBe("implement");
});

test("a draft on factory/<key> with the reported head moves to pr, gets the marker in its body and one comment, and no T3 watch unless the repository asks for one", async () => {
  const n = await prFactory(cleanup);
  const { item, run } = await n.implementing(1);
  const pr = n.github.openPr(101, `factory/${n.key(1)}`, { isDraft: false });

  const refused = await n.done(run, pr, { commit: "abcdef1" });
  expect(refused.error).toContain("it is not a draft");
  expect(refused.error).toContain(`its head is ${pr.headRefOid.slice(0, 12)}, not abcdef1`);
  expect(runs.get(n.s, run.id)).toMatchObject({ state: "running", nudges: 1 });

  pr.isDraft = true;
  expect(await n.done(run, pr)).toEqual({ accepted: true });
  expect(items.get(n.s, item.id)).toMatchObject({ phase: "pr", prUrl: pr.url, prCommit: pr.headRefOid });
  expect(runs.get(n.s, run.id)).toMatchObject({ state: "reported", nudges: 0, commitSha: pr.headRefOid });
  expect(pr.body).toStartWith("Fixes #1\n\n<!-- agentgate-factory:1 ");
  expect(parseMarkers(pr.body)).toEqual([
    expect.objectContaining({ item: item.id, stage: "implement", commit: pr.headRefOid, node: "a", state: "open" }),
  ]);
  // Only the factory wakes the thread, with what the repository's people wrote (D40).
  expect(n.mcp.calls.filter((c) => c.tool === "watch_pull_request")).toEqual([]);
  expect(n.github.posted(1)).toEqual([
    "The factory took this.",
    "The factory triaged this and starts on a fix.",
    "The factory opened a draft pull request.",
  ]);
  // The thread owns its PR until the item ships.
  expect(n.mcp.calls.some((c) => c.tool === "t3_thread_organize" && c.args.threadId === run.threadId)).toBe(false);
});

test("a mismatch the thread leaves uncorrected counts as a silent end, and the next attempt gets its own branch", async () => {
  const n = await prFactory(cleanup);
  const { item, run } = await n.implementing(1);
  await n.until(() => n.mirror.thread(run.threadId!)?.status === "running", "the implement thread to run");
  const pr = n.github.openPr(101, "feature/mine");

  expect((await n.done(run, pr)).error).toContain(`its branch is feature/mine, not factory/${n.key(1)}`);
  await n.thread(run.threadId!, "idle");
  await n.until(() => runs.get(n.s, run.id)!.state === "silent", "the run to end silent");
  // The correction was its reminder: the factory sent the thread nothing more.
  expect(n.sent(run.threadId!)).toEqual([]);

  await n.dispatch();
  const [, retry] = n.implementRuns(item);
  expect(retry).toMatchObject({ attempt: 2, state: "running" });
  const launch = n.mcp.calls.find((c) => c.tool === "t3_thread_launch" && c.args.clientRequestId === retry!.id);
  expect(launch!.args.workspaceStrategy).toMatchObject({ branch: `factory/${n.key(1)}-2` });
});

test("a repository that asks for T3 Code's PR watch gets it for the implement thread, and loses it when the item ships", async () => {
  const n = await prFactory(cleanup, (repo) => ({ repositories: { [repo]: { watchPullRequests: true } } }));
  const { run, pr } = await n.opened(1);
  const watches = (tool: string) => n.mcp.calls.filter((c) => c.tool === tool).map((c) => c.args);
  expect(watches("watch_pull_request")).toEqual([{ threadId: run.threadId, url: pr.url }]);
  expect(
    String(n.mcp.calls.find((c) => c.tool === "t3_thread_launch" && c.args.clientRequestId === run.id)!.args.message),
  ).toContain("T3 Code wakes you when the PR needs you");

  pr.state = "MERGED";
  await n.pollPrs();
  expect(watches("unwatch_pull_request")).toEqual([{ threadId: run.threadId, url: pr.url }]);
});
