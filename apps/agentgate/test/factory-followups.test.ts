import { afterAll, afterEach, expect, test } from "bun:test";
import type { FactoryItemDetail, MarkerPayload } from "@agentgate/protocol";
import { buildBoard } from "../src/factory/board.ts";
import { setNeedsYou } from "../src/factory/controller.ts";
import { items, runs, type FactoryItem } from "../src/factory/db.ts";
import { MARKER_PREFIX } from "../src/factory/markers.ts";
import { itemOutcome } from "../src/factory/records.ts";
import { factoryNode } from "./fixtures/t3-mcp.ts";
import { prFactory, type FakePr } from "./fixtures/factory-pr.ts";
import { removeTmp } from "./fixtures/git.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A factory comment on issue `number`, as some machine posted it. */
function markerComment(number: number, marker: Partial<MarkerPayload>) {
  const payload: MarkerPayload = {
    item: `it_${number}`,
    key: `gh-${number}`,
    stage: "implement",
    outcome: null,
    route: null,
    commit: null,
    factory: "3f2c1a9",
    node: "b",
    state: "open",
    ...marker,
  };
  return {
    body: `**gh-${number}**: Shipped.\n\n${MARKER_PREFIX}${JSON.stringify(payload)} -->`,
    author: { login: "maintainer" },
    authorAssociation: "OWNER",
    createdAt: "2026-11-02T10:00:00Z",
  };
}

test("intake leaves out an open issue the factory finished on another machine, and retry takes it in again at triage", async () => {
  const n = await prFactory(cleanup);
  n.github.addIssue(1);
  n.github.issues.get(1)!.comments.push(markerComment(1, { state: "finished" }));

  await n.intake();
  expect(items.list(n.s)).toEqual([]);

  expect(await n.command("retry", `${n.repo}#1`)).toEqual({
    code: 0,
    output: [`Took over ${n.key(1)}; it starts at triage`],
  });
  const [item] = items.list(n.s);
  expect(item).toMatchObject({ key: n.key(1), phase: "triage" });
  expect(runs.forItem(n.s, item!.id).map((r) => [r.kind, r.state])).toEqual([["triage", "queued"]]);
});

test("a run that ends twice without reporting is retried as attempt 2 with what the factory checked for attempt 1", async () => {
  const n = await prFactory(cleanup);
  n.github.addIssue(1);
  await n.intake();
  await n.dispatch();
  const [first] = runs.list(n.s);
  const checked = { kind: "judge" as const, run: "run_graded", scorer: "tests" };
  runs.update(n.s, first!.id, { checked });
  const threadId = first!.threadId!;

  await n.until(() => n.mirror.thread(threadId)?.status === "running", "the thread to run");
  n.mcp.setThread(threadId, { status: "idle" });
  await n.until(() => runs.get(n.s, first!.id)!.nudges === 1, "the reminder");
  await n.until(() => n.mirror.thread(threadId)?.status === "running", "the reminded thread to run");
  n.mcp.setThread(threadId, { status: "idle" });
  await n.until(() => runs.list(n.s).length === 2, "the retry");

  expect(runs.list(n.s).map((r) => [r.attempt, r.state, r.checked])).toEqual([
    [1, "silent", checked],
    [2, "queued", checked],
  ]);
});

test("the board shows an item's review rounds, and the findings left open when it went to ready", async () => {
  const n = await prFactory(cleanup, () => ({ limits: { threads: 20, reviewRounds: 2 } }));
  const latestReview = (item: FactoryItem) => runs.forItem(n.s, item.id).findLast((r) => r.kind === "review")!;
  const reviewed = (pr: FakePr, findings: { severity: string; text: string }[]) => ({
    outcome: "done",
    summary: "Reviewed it.",
    result: {
      kind: "review",
      prUrl: pr.url,
      commit: pr.headRefOid,
      findings: findings.map((x) => ({ file: "src/save.ts", line: 12, ...x })),
      testsFailWithoutFix: true,
    },
  });
  const row = async (item: FactoryItem) =>
    (await buildBoard(n.f, { includeWebhookUrls: false })).items.find((i) => i.id === item.id)!;

  const { item, pr } = await n.opened(1, { checks: "passing" });
  await n.pollPrs();
  await n.dispatch();
  await n.report(latestReview(item), reviewed(pr, [{ severity: "important", text: "The lock is never released." }]));
  expect((await row(item)).pr).toEqual({ url: pr.url, commit: expect.any(String), reviewRound: 1 });

  pr.headRefOid = "c".repeat(40);
  await n.pollPrs();
  await n.dispatch();
  await n.report(
    latestReview(item),
    reviewed(pr, [
      { severity: "important", text: "The retry loop never ends." },
      { severity: "nit", text: "Name the constant." },
      { severity: "pre-existing", text: "The old parser drops tabs." },
    ]),
  );

  expect(items.get(n.s, item.id)!.phase).toBe("ready");
  const pre = { url: pr.url, commit: expect.any(String), reviewRound: 2, openFindings: 2 };
  expect((await row(item)).pr).toEqual(pre);

  // The pre-existing finding became an issue, and the item's detail still shows with that write in it.
  const detail = await n.api(`/api/factory/items/${item.key}`);
  expect(detail.status).toBe(200);
  expect(((await detail.json()) as FactoryItemDetail).writebacks.map((w) => w.moment)).toContain("issue");
});

test("approving, retrying and adding by hand are each one human touch, and a question the factory asks is none", async () => {
  const n = await prFactory(cleanup, (repo) => ({
    sources: [{ id: "bugs", type: "github", repo, label: "factory", intake: "hold" }],
  }));
  n.github.addIssue(1);
  await n.intake();
  const [held] = items.list(n.s);
  const touches = (item: FactoryItem) => itemOutcome(items.get(n.s, item.id)!).humanTouches;

  expect((await n.command("approve", held!.key)).code).toBe(0);
  expect(touches(held!)).toBe(1);
  setNeedsYou(n.f, held!.id, { reason: "decision", question: "Rename the flag?" });
  expect(touches(held!)).toBe(1);
  setNeedsYou(n.f, held!.id, { reason: "failed", question: "Triage ended twice without a report." });
  expect((await n.command("retry", held!.key)).code).toBe(0);
  expect(touches(held!)).toBe(2);

  expect((await n.command("add", n.repo, "Crash on save")).code).toBe(0);
  const manual = items.list(n.s).find((i) => i.source === "manual")!;
  expect(touches(manual)).toBe(1);
});

test("a run dropped while its launch is in flight stays cancelled, and the thread T3 then starts is interrupted", async () => {
  const n = await factoryNode(cleanup);
  let answerLaunch!: () => void;
  const launchAnswered = new Promise<void>((resolve) => (answerLaunch = resolve));
  n.mcp.answer("t3_thread_launch", async (args) => {
    await launchAnswered;
    const thread = n.t3.addThread({ projectId: String(args.projectId), sessionId: crypto.randomUUID() });
    return { threadId: thread.id };
  });
  expect((await n.command("add", n.repo, "Crash on save")).code).toBe(0);
  const [run] = runs.list(n.s);

  const dispatched = n.dispatch();
  await n.until(() => n.mcp.calls.some((c) => c.tool === "t3_thread_launch"), "the launch");
  expect((await n.command("drop", run!.item!)).code).toBe(0);
  answerLaunch();
  await dispatched;

  const ended = runs.get(n.s, run!.id)!;
  expect(ended).toMatchObject({ state: "cancelled", threadId: expect.any(String) });
  const interrupted = n.mcp.calls.filter((c) => c.tool === "t3_thread_interrupt").map((c) => c.args.threadId);
  expect(interrupted).toEqual([ended.threadId]);
});
