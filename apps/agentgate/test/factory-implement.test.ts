import { afterAll, afterEach, expect, test } from "bun:test";
import { buildBoard } from "../src/factory/board.ts";
import { items, runs } from "../src/factory/db.ts";
import { prFactory } from "./fixtures/factory-pr.ts";
import { removeTmp, sh } from "./fixtures/git.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

test("route implement starts a run on factory/<key> from the default branch, and waits while that branch's CI fails", async () => {
  const n = await prFactory(cleanup);
  n.github.mainChecks = { test: "FAILURE" };
  const { item, run } = await n.implementing(1);
  const implementLaunches = () =>
    n.mcp.calls.filter((c) => c.tool === "t3_thread_launch" && c.args.clientRequestId === run.id);

  expect(items.get(n.s, item.id)!.phase).toBe("implement");
  expect(runs.get(n.s, run.id)).toMatchObject({ state: "queued", error: undefined });
  const waiting = async () =>
    (await buildBoard(n.f, { includeWebhookUrls: false })).items.find((i) => i.id === item.id)?.waiting;
  expect(await waiting()).toMatchObject({
    on: "default-branch",
    text: `Waits for the default branch of ${n.repo} to pass CI`,
  });
  expect(implementLaunches()).toEqual([]);
  expect((await buildBoard(n.f, { includeWebhookUrls: false })).capacity.mainRed).toEqual([n.repo]);

  n.github.mainChecks = { test: "SUCCESS" };
  n.advance(2 * 60_000);
  await n.dispatch();
  expect(implementLaunches()).toHaveLength(1);
  const [launch] = implementLaunches();
  expect(await waiting()).toBeUndefined();
  expect(launch!.args).toMatchObject({
    title: `Implement ${n.key(1)}: Issue 1`,
    workspaceStrategy: { type: "worktree", baseRef: "main", branch: `factory/${n.key(1)}`, startFromOrigin: true },
  });
  const brief = String(launch!.args.message);
  expect(brief).toContain("Put `Fixes #1` in its body.");
  expect(brief).toContain(`run: "${run.id}"`);
  expect((await buildBoard(n.f, { includeWebhookUrls: false })).capacity.mainRed).toEqual([]);
});

test("when the default branch requires checks, only a failing one of those holds implement back, not a failing release", async () => {
  const n = await prFactory(cleanup);
  Object.assign(n.github, { required: ["All checks", "build"], mainChecks: { build: "FAILURE" } });
  const { run } = await n.implementing(1);
  const implementLaunches = () =>
    n.mcp.calls.filter((c) => c.tool === "t3_thread_launch" && c.args.clientRequestId === run.id);
  expect(
    (await buildBoard(n.f, { includeWebhookUrls: false })).items.find((i) => i.id === run.item)?.waiting,
  ).toMatchObject({ on: "default-branch" });

  // The required checks run only on pull requests, and a release failed at the newest commit.
  n.github.mainChecks = { Release: "FAILURE" };
  n.advance(2 * 60_000);
  await n.dispatch();
  expect(implementLaunches()).toHaveLength(1);
});

test("a done report missing prUrl, commit, claims, notChecked or decisions is refused, naming what is missing", async () => {
  const n = await prFactory(cleanup);
  const { item, run } = await n.implementing(1);

  expect(await n.report(run, { outcome: "done", summary: "Done." })).toEqual({
    error: 'The outcome done needs result: { kind: "implement", prUrl, commit, claims, notChecked, decisions }',
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
  expect(items.get(n.s, item.id)).toMatchObject({
    phase: "pr",
    pr: { url: pr.url, head: pr.headRefOid, run: run.id, thread: run.threadId, nudges: 0 },
  });
  // The correction spent the run's one reminder; nudges about the PR are the item's.
  expect(runs.get(n.s, run.id)).toMatchObject({ state: "reported", nudges: 1 });
  // The PR body is the thread's own: the factory's marker travels on the issue.
  expect(pr.body).toBe("Fixes #1");
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

test("an implement run takes the first branch name free on origin, and its report is checked against the branch it was given", async () => {
  const n = await prFactory(cleanup);
  // An earlier item of the same issue, frozen on another machine or lost with its tables, left its branches behind.
  const branch = (suffix = "") => `factory/${n.key(7)}${suffix}`;
  const pushed = [branch(), branch("-2")];
  cleanup.push(() => pushed.forEach((name) => sh(n.origin.origin, "branch", "-D", name)));
  for (const name of pushed) sh(n.origin.origin, "branch", name, "main");

  const { item, run } = await n.implementing(7);
  const launch = n.mcp.calls.find((c) => c.tool === "t3_thread_launch" && c.args.clientRequestId === run.id)!;
  expect(launch.args.workspaceStrategy).toMatchObject({ branch: branch("-3") });
  expect(String(launch.args.message)).toContain(`Your branch is \`${branch("-3")}\``);

  // The thread pushes its branch, so that name is no longer free: the run still answers for the one it was given.
  sh(n.origin.origin, "branch", branch("-3"), "main");
  pushed.push(branch("-3"));
  const old = n.github.openPr(107, branch());
  expect((await n.done(run, old)).error).toContain(`its branch is ${branch()}, not ${branch("-3")}`);
  expect(await n.done(run, n.github.openPr(108, branch("-3")))).toEqual({ accepted: true });
  expect(items.get(n.s, item.id)!.phase).toBe("pr");
});
