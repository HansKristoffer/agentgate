import { afterAll, afterEach, expect, test } from "bun:test";
import { app } from "../src/daemon.ts";
import { sendToThread } from "../src/factory/controller.ts";
import { items, runs, type FactoryRun } from "../src/factory/db.ts";
import { PeerError, peerCall } from "../src/handoff/jobs.ts";
import { connectT3 } from "../src/handoff/t3.ts";
import { NODE_PROTOCOL } from "../src/remote.ts";
import { removeTmp, tmp } from "./fixtures/git.ts";
import { startNodes } from "./fixtures/nodes.ts";
import { fakeT3 } from "./fixtures/t3.ts";
import { factoryNode } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** The factory machine `a`, and `b` with its own T3 Code holding a stage thread that moved there. */
async function movedRun() {
  const a = await factoryNode(cleanup);
  const handler = app(a.ctx);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => handler.fetch(req, { listener: "tailnet" }),
  });
  cleanup.push(() => server.stop(true));
  const [b] = await startNodes("b");
  let stopped = false;
  const stopB = async () => {
    if (!stopped) await b!.stop();
    stopped = true;
  };
  cleanup.push(stopB);
  const token = crypto.randomUUID();
  a.s.db.run("insert into peers values (?, ?, ?, 0, ?)", ["b", b!.url, token, a.s.now()]);
  b!.s.db.run("insert into peers values (?, ?, ?, 0, ?)", ["a", `http://127.0.0.1:${server.port}`, token, b!.s.now()]);
  a.s.put("node", "b", { id: "b", protocol: NODE_PROTOCOL });
  b!.s.put("node", "a", { id: "a", protocol: NODE_PROTOCOL });
  b!.s.put("setting", "settings", { ...b!.s.settings(), factory: a.f.pointer() });

  const t3 = fakeT3({ claudeDir: tmp() });
  cleanup.push(t3.stop);
  await connectT3(b!.s, { url: t3.url, token: t3.pairingToken() });
  const project = t3.addProject(tmp());
  const thread = t3.addThread({
    projectId: project.id,
    sessionId: crypto.randomUUID(),
    runs: [{ id: "r1", status: "running" }],
  });

  expect((await a.command("add", a.repo, "Crash on save")).code).toBe(0);
  await a.dispatch();
  const [started] = runs.list(a.s);
  // Where follow.ts leaves a run once b imported its thread.
  const run = runs.update(a.s, started!.id, { node: "b", threadId: thread.id, threadLink: undefined });
  return { a, b: b!, t3, run, thread, stopB };
}

const commands = (t3: ReturnType<typeof fakeT3>, threadId: string) =>
  t3.commands.filter((c) => c.threadId === threadId);

test("a message to a moved run's thread is queued in the T3 Code that holds it", async () => {
  const { a, t3, run, thread } = await movedRun();

  await sendToThread(a.f, run, "The maintainer answered: go ahead.");

  expect(commands(t3, thread.id)).toMatchObject([
    {
      type: "message.dispatch",
      text: "The maintainer answered: go ahead.",
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
    },
  ]);
  expect(a.mcp.calls.filter((c) => c.args.threadId === thread.id)).toEqual([]);
});

test("a report from the moved thread settles it in the T3 Code that holds it", async () => {
  const { b, t3, run, thread } = await movedRun();
  const client = (await b.ctx.gateway.builtin!()).client;

  const result = await client.callTool({
    name: "factory_report",
    arguments: { run: run.id, outcome: "not-a-bug", summary: "Works as designed." },
    _meta: { "dev.agentgate/t3Thread": thread.id },
  });

  expect(result.isError).toBeFalsy();
  expect(commands(t3, thread.id)).toMatchObject([{ type: "thread.settle" }]);
});

test("dropping an item interrupts and settles its moved thread, and an unreachable machine leaves a note instead", async () => {
  const { a, t3, run, thread, stopB } = await movedRun();
  const item = run.item!;

  expect((await a.command("drop", item)).code).toBe(0);
  expect(commands(t3, thread.id)).toMatchObject([
    { type: "run.interrupt", runId: "r1", reason: "Dropped by the maintainer" },
    { type: "thread.settle" },
  ]);
  expect(t3.threads.get(thread.id)!.settledOverride).toBe("settled");
  expect(runs.get(a.s, run.id)!.state).toBe("cancelled");

  expect((await a.command("add", a.repo, "Typo on login")).code).toBe(0);
  await a.dispatch();
  const second = runs.list(a.s).find((r) => r.id !== run.id)!;
  runs.update(a.s, second.id, { node: "b", threadId: thread.id });
  await stopB();

  const key = items.get(a.s, second.item!)!.key;
  expect(await a.command("drop", key)).toEqual({ code: 0, output: [`Dropped ${key}`] });
  expect(runs.get(a.s, second.id)).toMatchObject({
    state: "cancelled",
    error: expect.stringContaining(`Settling the thread of ${second.id} on b failed: b is not reachable`),
  });
  const notes = a.f.events.recent(20).map((e) => e.text);
  expect(notes).toContain(`Interrupting the thread of ${second.id} on b failed: b is not reachable`);
});

test("dropping an item with a PR unwatches it from the implement thread on this machine, not from a moved one", async () => {
  const { a, run } = await movedRun();
  const unwatches = () => a.mcp.calls.filter((c) => c.tool === "unwatch_pull_request");
  const withPr = (r: FactoryRun, url: string) => {
    runs.update(a.s, r.id, { kind: "implement" });
    return items.update(a.s, r.item!, { phase: "pr", prUrl: url });
  };

  const moved = withPr(run, "https://github.com/acme/app/pull/1");
  expect((await a.command("drop", moved.key)).code).toBe(0);
  expect(unwatches()).toEqual([]);

  expect((await a.command("add", a.repo, "Typo on login")).code).toBe(0);
  await a.dispatch();
  const local = runs.list(a.s).find((r) => r.id !== run.id)!;
  const item = withPr(local, "https://github.com/acme/app/pull/2");
  expect((await a.command("drop", item.key)).code).toBe(0);
  expect(unwatches()).toEqual([
    { tool: "unwatch_pull_request", args: { threadId: local.threadId, url: "https://github.com/acme/app/pull/2" } },
  ]);
});

test("POST /peer/factory/thread refuses an unknown action and a thread its T3 Code does not have", async () => {
  const { a } = await movedRun();
  const post = (json: unknown) =>
    peerCall(a.s, "b", "/factory/thread", { json }).catch((e: PeerError) => [e.status, e.message]);

  expect(await post({ action: "archive", threadId: "t1" })).toEqual([400, "invalid thread action"]);
  expect(await post({ action: "settle", threadId: "gone" })).toEqual([404, "T3 Code on b has no thread gone"]);
});
