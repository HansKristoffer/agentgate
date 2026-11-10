import { afterAll, afterEach, expect, test } from "bun:test";
import { buildBoard } from "../src/factory/board.ts";
import { items, runs, type FactoryItem, type FactoryRun } from "../src/factory/db.ts";
import { prFactory, triaged } from "./fixtures/factory-pr.ts";
import { removeTmp } from "./fixtures/git.ts";
import { idle } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const SPEC = "## Behavior\n\nSaving twice keeps the first copy.";

/** Issue 1 entered, triage routed it to spec, and the spec run was dispatched. */
async function specFactory() {
  const n = await prFactory(cleanup);
  n.github.addIssue(1);
  await n.intake();
  await n.dispatch();
  const item = items.byExternal(n.s, `${n.repo}#1`)!;
  await n.report(runs.forItem(n.s, item.id)[0]!, { ...triaged, result: { ...triaged.result, route: "spec" } });
  await n.dispatch();
  const specRuns = () => runs.forItem(n.s, item.id).filter((r) => r.kind === "spec");
  const launchOf = (run: FactoryRun) =>
    n.mcp.calls.find((c) => c.tool === "t3_thread_launch" && c.args.clientRequestId === run.id)?.args;
  const specReport = (run: FactoryRun, result: { approved: boolean; feedback?: string }) =>
    n.report(run, {
      outcome: "done",
      summary: "Wrote the spec.",
      result: { kind: "spec", spec: SPEC, review: "One finding: name the file. Fixed.", ...result },
    });
  const needsYou = async (it: FactoryItem) =>
    (await buildBoard(n.f, { includeWebhookUrls: false })).items.find((i) => i.id === it.id)?.needsYou;
  return { ...n, item, specRuns, launchOf, specReport, needsYou, run: specRuns()[0]! };
}

test("route spec starts a spec run whose brief requires a fresh-subagent review and one Approve or Change card", async () => {
  const n = await specFactory();

  expect(items.get(n.s, n.item.id)!.phase).toBe("spec");
  expect(n.run.state).toBe("running");
  const launch = n.launchOf(n.run)!;
  expect(launch).toMatchObject({
    title: `Spec ${n.key(1)}: Issue 1`,
    workspaceStrategy: { baseRef: "main", branch: `factory/${n.key(1)}-spec-1`, startFromOrigin: true },
  });
  const brief = String(launch.message);
  expect(brief).toContain("Have a fresh subagent review the spec");
  expect(brief).toContain("one question whose options are exactly `Approve` and `Change`");
  expect(brief).toContain(`run: "${n.run.id}"`);
  expect(n.github.posted(1)).toEqual(["The factory took this.", "The factory triaged this and writes a spec first."]);
});

test("an approved spec starts implement, reaches factory_item and the spec-approved comment", async () => {
  const n = await specFactory();

  expect(await n.specReport(n.run, { approved: true })).toEqual({ accepted: true });
  expect(items.get(n.s, n.item.id)!.phase).toBe("implement");
  await n.dispatch();
  const implement = n.implementRuns(n.item)[0]!;
  expect(implement.state).toBe("running");

  const builtin = (await n.ctx.gateway.builtin!()).client;
  const view = await builtin.callTool({
    name: "factory_item",
    arguments: { run: implement.id },
    _meta: { "dev.agentgate/t3Thread": implement.threadId },
  });
  expect(JSON.parse((view.content as { text: string }[])[0]!.text).spec).toBe(SPEC);

  const comments = n.github.issues.get(1)!.comments.map((c) => c.body);
  expect(n.github.posted(1).at(-1)).toBe("The spec is approved, and the factory starts on the fix.");
  expect(comments.at(-1)).toContain("Saving twice keeps the first copy.");
});

test("feedback starts one more spec round, and the next feedback leaves the item waiting for the maintainer", async () => {
  const n = await specFactory();

  expect(await n.specReport(n.run, { approved: false })).toEqual({
    error: "approved is false, so result.feedback needs the changes the maintainer asked for",
  });
  expect(await n.specReport(n.run, { approved: false, feedback: "Keep the newest copy instead." })).toEqual({
    accepted: true,
  });
  await n.dispatch();
  const [, round2] = n.specRuns();
  expect(round2!.state).toBe("running");
  expect(n.launchOf(round2!)!.workspaceStrategy).toMatchObject({ branch: `factory/${n.key(1)}-spec-2` });
  expect(String(n.launchOf(round2!)!.message)).toContain("This is round 2 of the spec.");

  await n.specReport(round2!, { approved: false, feedback: "Still not right." });
  await n.dispatch();
  expect(n.specRuns()).toHaveLength(2);
  expect(items.get(n.s, n.item.id)).toMatchObject({
    phase: "spec",
    needsYou: { cause: "failed", link: round2!.threadLink },
  });

  expect((await n.command("retry", n.key(1))).output).toEqual([`Retrying spec for ${n.key(1)}`]);
  expect(n.specRuns().at(-1)!.state).toBe("queued");
});

test("approve and reject answer the waiting card through t3_pending_request, and fail clearly when none is pending", async () => {
  const n = await specFactory();
  const threadId = n.run.threadId!;
  let pending: string[] = [];
  n.mcp.answer("t3_pending_request", (args) => {
    if (args.action === "list") return { requestIds: pending };
    if (args.action === "read")
      return {
        requestId: args.requestId,
        questions: [
          {
            id: "Approve the spec?",
            header: "Spec",
            question: "Approve the spec?",
            options: [
              { label: "Approve", description: "Start the fix" },
              { label: "Change", description: "Say what to change" },
            ],
          },
        ],
      };
    return { sequence: 1 };
  });
  const responses = () =>
    n.mcp.calls.filter((c) => c.tool === "t3_pending_request" && c.args.action === "respond").map((c) => c.args);

  n.mcp.setThread(threadId, { needsYou: true });
  await n.until(() => items.get(n.s, n.item.id)?.needsYou, "the spec item to wait");
  expect(runs.get(n.s, n.run.id)!.state).toBe("waiting");
  // T3 listed no request yet, so the wait says where the question is.
  expect(await n.needsYou(n.item)).toMatchObject({
    kind: "answer",
    cause: "question",
    question: "The spec thread asks you something in T3 Code",
    link: n.run.threadLink,
    request: "request-1",
  });
  const board = await buildBoard(n.f, { includeWebhookUrls: false });
  expect(board.items.find((i) => i.id === n.item.id)?.actions).toEqual([
    { name: "approve", label: "Approve", effect: "Approve what the thread asks", takesText: false },
    {
      name: "reject",
      label: "Ask for changes…",
      effect: "Ask the thread for changes, with your feedback",
      takesText: true,
    },
    {
      name: "drop",
      label: "Drop…",
      effect: "Stop its threads and close it, with your reason on the issue; its PR stays open",
      takesText: true,
    },
  ]);

  expect(await n.command("approve", n.key(1))).toEqual({
    code: 1,
    output: [`The spec thread has no pending question; look at it in T3 Code: ${n.run.threadLink}`],
  });

  pending = ["request-1"];
  expect((await n.command("reject", n.key(1), "--reason", "Keep the newest copy")).code).toBe(0);
  expect(await n.needsYou(n.item)).toBeUndefined();
  // T3 showing the answered request again does not ask again, though its question reads the same.
  n.mcp.setThread(threadId, { needsYou: true, request: "request-1" });
  await n.until(() => n.mirror.thread(threadId)?.request === "request-1", "the request to show again");
  await idle(n.f);
  expect(await n.needsYou(n.item)).toBeUndefined();
  expect(await n.command("approve", n.key(1))).toEqual({ code: 1, output: [`${n.key(1)} has nothing to approve`] });

  // The next round's card is a new request, asked with its question and options.
  pending = ["request-2"];
  n.mcp.setThread(threadId, { needsYou: true, request: "request-2" });
  await n.until(() => items.get(n.s, n.item.id)?.needsYou?.request === "request-2", "the second card to wait");
  expect(await n.needsYou(n.item)).toMatchObject({ question: "Approve the spec?", options: ["Approve", "Change"] });
  expect((await n.command("approve", n.key(1))).code).toBe(0);
  expect(responses()).toEqual([
    {
      action: "respond",
      threadId,
      requestId: "request-1",
      answers: { "Approve the spec?": "Change: Keep the newest copy" },
    },
    { action: "respond", threadId, requestId: "request-2", answers: { "Approve the spec?": "Approve" } },
  ]);

  n.mcp.setThread(threadId, { needsYou: false, status: "running" });
  await n.until(() => runs.get(n.s, n.run.id)!.state === "running", "the spec run to run again");
  expect(await n.needsYou(n.item)).toBeUndefined();
  // Each answer is one touch: the thread going on after it is not another answer in T3 Code.
  expect(items.get(n.s, n.item.id)!.touches).toBe(2);
});

test("the card a thread waits on shows in its item's wait, the spec as detail, without a second event", async () => {
  const n = await specFactory();
  const threadId = n.run.threadId!;
  const card = `Approve the spec for ${n.key(1)}?\n\n${SPEC}`;
  n.mcp.answer("t3_pending_request", (args) =>
    args.action === "list"
      ? { requestIds: ["request-1"] }
      : {
          requestId: "request-1",
          questions: [{ id: card, question: card, options: [{ label: "Approve" }, { label: "Change" }] }],
        },
  );
  const waits = () => n.f.events.recent(50).filter((e) => e.kind === "item.needs-you" && e.item === n.item.id);

  n.mcp.setThread(threadId, { needsYou: true });
  await n.until(() => items.get(n.s, n.item.id)?.needsYou?.detail, "the spec to show in the wait");
  expect(await n.needsYou(n.item)).toEqual({
    kind: "answer",
    cause: "question",
    title: "Asks you",
    question: `Approve the spec for ${n.key(1)}?`,
    detail: SPEC,
    options: ["Approve", "Change"],
    link: n.run.threadLink,
    since: expect.any(Number),
    run: n.run.id,
    request: "request-1",
  });
  expect(waits()).toHaveLength(1);
  const { output } = await n.command("show", n.key(1));
  expect(output).toContain(SPEC);
});
