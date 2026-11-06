import { afterAll, afterEach, expect, test } from "bun:test";
import { app } from "../src/daemon.ts";
import { items, runs, type FactoryRun } from "../src/factory/db.ts";
import { loopTask, runCommand } from "../src/factory/runtime.ts";
import type { SourceState } from "../src/handoff/source.ts";
import { connectT3 } from "../src/handoff/t3.ts";
import { createRelay, joinRelay, syncAll } from "../src/relay.ts";
import { NODE_PROTOCOL } from "../src/remote.ts";
import { memoryRelay, serveRelay } from "../../relay/test/memory.ts";
import { removeTmp, tmp } from "./fixtures/git.ts";
import { startNodes, type TestNode } from "./fixtures/nodes.ts";
import { fakeT3 } from "./fixtures/t3.ts";
import { factoryNode } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

type Factory = Awaited<ReturnType<typeof factoryNode>>;

/** The factory machine `a` and a machine `b` with its own T3 Code, paired over Tailscale. */
async function twoMachines() {
  const a = await factoryNode(cleanup);
  const handler = app(a.ctx);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => handler.fetch(req, { listener: "tailnet" }),
  });
  cleanup.push(() => server.stop(true));
  const b = await machineB();
  const token = crypto.randomUUID();
  a.s.db.run("insert into peers values (?, ?, ?, 0, ?)", ["b", b.url, token, a.s.now()]);
  b.s.db.run("insert into peers values (?, ?, ?, 0, ?)", ["a", `http://127.0.0.1:${server.port}`, token, b.s.now()]);
  a.s.put("node", "b", { id: "b", protocol: NODE_PROTOCOL });
  b.s.put("setting", "settings", { ...b.s.settings(), factory: a.f.pointer() });

  const t3 = fakeT3({ claudeDir: tmp() });
  cleanup.push(t3.stop);
  await connectT3(b.s, { url: t3.url, token: t3.pairingToken() });
  const project = t3.addProject(tmp());
  /** A thread on b, as a handoff imports it, with its turn running. */
  const thread = () =>
    t3.addThread({ projectId: project.id, sessionId: crypto.randomUUID(), runs: [{ id: "r1", status: "running" }] });

  const follow = loopTask(
    a.f,
    a.f.loops.find((l) => l.name === "factory-follow")!,
  );
  return { a, b, t3, thread, follow };
}

async function machineB() {
  const [b] = await startNodes("b");
  let stopped = false;
  const stop = async () => {
    if (!stopped) await b!.stop();
    stopped = true;
  };
  cleanup.push(stop);
  b!.s.put("node", "a", { id: "a", protocol: NODE_PROTOCOL });
  return { ...b!, stop };
}

/** One item whose triage thread runs on the factory machine. */
async function runningTriage(a: Factory) {
  expect((await a.command("add", a.repo, "Crash on save")).code).toBe(0);
  await a.dispatch();
  const [run] = runs.list(a.s);
  await a.until(() => a.mirror.thread(run!.threadId!)?.status === "running", "the triage thread to run");
  return run!;
}

/** What handing the run's thread to b does on a: the source job interrupts it, b imports it, a archives its copy. */
async function handOff(a: Factory, run: FactoryRun, destThreadId: string) {
  const h = a.ctx.handoffs;
  const job = h.create<SourceState>({
    id: crypto.randomUUID(),
    role: "source",
    thread: run.threadId!,
    target: "b",
    step: "stop",
    state: { warnings: [], timings: [] },
  });
  a.mcp.setThread(run.threadId!, { status: "interrupted" });
  await a.until(() => a.mirror.thread(run.threadId!)?.status === "interrupted", "the interrupt");

  job.state.destThreadId = destThreadId;
  h.advance(job, "finish");
  a.t3.threads.get(run.threadId!)!.archivedAt = new Date().toISOString();
  a.mcp.setThread(run.threadId!, {});
  await a.until(() => a.mirror.thread(run.threadId!)?.archived, "the archive");
  h.advance(job, "done");
}

const sends = (a: Factory) => a.mcp.calls.filter((c) => c.tool === "t3_thread_send");

/** factory_report through a machine's MCP gateway, as the shim forwards it from a T3 thread. */
async function report(n: { ctx: Factory["ctx"] }, run: FactoryRun, thread: string) {
  const client = (await n.ctx.gateway.builtin!()).client;
  const result = await client.callTool({
    name: "factory_report",
    arguments: { run: run.id, outcome: "not-a-bug", summary: "Works as designed." },
    _meta: { "dev.agentgate/t3Thread": thread },
  });
  const text = (result.content as { text: string }[])[0]!.text;
  return result.isError ? { error: text } : JSON.parse(text);
}

test("a stage thread handed to another machine takes its run along, and the source's archive is not a silent end", async () => {
  const { a, thread, follow } = await twoMachines();
  const run = await runningTriage(a);
  const moved = thread();

  await handOff(a, run, moved.id);
  await a.dispatch();
  await follow();

  expect(runs.get(a.s, run.id)).toMatchObject({ state: "running", node: "b", threadId: moved.id, nudges: 0 });
  // Neither a reminder in the stopped thread nor a second attempt.
  expect(sends(a)).toEqual([]);
  await a.dispatch();
  expect(runs.list(a.s)).toHaveLength(1);
  expect(a.f.events.recent(10).map((e) => e.text)).toContain(
    "The triage thread moved to b, and its run follows it there",
  );
});

test("a handoff that fails before the import leaves the run on its own thread", async () => {
  const { a, follow } = await twoMachines();
  const run = await runningTriage(a);
  const h = a.ctx.handoffs;
  const job = h.create<SourceState>({
    id: crypto.randomUUID(),
    role: "source",
    thread: run.threadId!,
    target: "b",
    step: "stop",
    state: { warnings: [], timings: [] },
  });
  a.mcp.setThread(run.threadId!, { status: "interrupted" });
  await a.until(() => a.mirror.thread(run.threadId!)?.status === "interrupted", "the interrupt");
  h.fail(job, "b lost the handoff");
  await follow();

  expect(runs.get(a.s, run.id)).toMatchObject({ state: "running", node: "a", threadId: run.threadId });
  expect(sends(a)).toEqual([]);
});

test("a run handed back to the factory machine returns to its first thread there and stays", async () => {
  const { a, b, thread, follow } = await twoMachines();
  const run = await runningTriage(a);
  const moved = thread();
  await handOff(a, run, moved.id);
  await follow();

  // The way back, later, on both machines' records: T3 there brings back the thread the session left.
  a.advance(1000);
  const id = crypto.randomUUID();
  const back = { id, thread: moved.id, step: "done", state: { warnings: [], timings: [] } };
  b.ctx.handoffs.create<SourceState>({
    ...back,
    role: "source",
    target: "a",
    state: { ...back.state, destThreadId: run.threadId },
  });
  a.ctx.handoffs.create({
    ...back,
    role: "destination",
    target: "a",
    state: { ...back.state, source: "b", threadId: run.threadId },
  });
  await follow();
  expect(runs.get(a.s, run.id)).toMatchObject({ node: "a", threadId: run.threadId });
  // The first trip's job also names this thread, but the newer one ended here.
  await follow();
  expect(runs.get(a.s, run.id)).toMatchObject({ node: "a", threadId: run.threadId });
});

test("factory_report from the moved thread is forwarded with its thread and node, and accepted only for that run", async () => {
  const { a, b, thread, follow } = await twoMachines();
  const run = await runningTriage(a);
  const moved = thread();
  await handOff(a, run, moved.id);
  await follow();

  const other = `Run ${run.id} belongs to another T3 Code thread; report only on your own run`;
  expect(await report(b, run, "some-other-thread")).toEqual({ error: other });
  // The right thread id, but named by the machine the thread left.
  expect(await report(a, run, moved.id)).toEqual({ error: other });
  expect(runs.get(a.s, run.id)!.state).toBe("running");

  expect(await report(b, run, moved.id)).toEqual({ accepted: true });
  expect(runs.get(a.s, run.id)).toMatchObject({ state: "reported", report: { outcome: "not-a-bug" } });
  expect(items.get(a.s, run.item!)!.phase).toBe("closed");
});

test("a moved run's status comes from its machine's threads, and while that machine is unreachable it waits and is not retried", async () => {
  const { a, b, t3, thread, follow } = await twoMachines();
  const run = await runningTriage(a);
  const moved = thread();
  await handOff(a, run, moved.id);
  await follow();
  await follow();
  expect(runs.get(a.s, run.id)!.state).toBe("running");
  expect(items.get(a.s, run.item!)!.needsYou).toBeUndefined();

  // The turn ended on b without a report: it waits for a person there, never a reminder or a retry from a.
  t3.threads.get(moved.id)!.runs[0]!.status = "completed";
  await follow();
  expect(items.get(a.s, run.item!)!.needsYou).toMatchObject({ reason: "stalled" });
  t3.threads.get(moved.id)!.runs.push({ id: "r2", status: "running" });
  await follow();
  expect(items.get(a.s, run.item!)!.needsYou).toBeUndefined();

  await b.stop();
  await follow();
  expect(runs.get(a.s, run.id)).toMatchObject({ state: "running", node: "b", error: "b is unreachable" });
  expect(a.f.events.recent(1)[0]!.text).toBe("The triage run on b is unreachable; it waits for b and is not retried");
  a.advance(3 * 3600_000);
  await a.dispatch();
  await follow();
  expect(runs.list(a.s).map((r) => [r.id, r.state])).toEqual([[run.id, "running"]]);
  expect(sends(a)).toEqual([]);
});

test("on a machine that does not run the factory, factory_add and the item commands act on the factory machine", async () => {
  const { a, b } = await twoMachines();
  const command = async (...args: string[]) => {
    const output: string[] = [];
    const code = await runCommand(b.ctx.factory, args[0]!, args.slice(1), { out: (line) => output.push(line) });
    return { code, output };
  };

  expect((await command("add", a.repo, "Crash on save")).code).toBe(0);
  const client = (await b.ctx.gateway.builtin!()).client;
  const added = await client.callTool({ name: "factory_add", arguments: { repo: a.repo, title: "Typo on login" } });
  expect(added.isError).toBeFalsy();
  expect(items.list(b.s)).toEqual([]);
  const [crash, typo] = items.list(a.s);
  expect([crash!.title, typo!.title]).toEqual(["Crash on save", "Typo on login"]);

  items.update(a.s, crash!.id, { phase: "held" });
  items.update(a.s, typo!.id, { phase: "held" });
  expect(await command("approve", crash!.key)).toEqual({
    code: 0,
    output: [`Approved ${crash!.key}; triage is queued`],
  });
  expect(await command("reject", typo!.key)).toEqual({ code: 0, output: [`Rejected ${typo!.key}`] });
  expect(items.get(a.s, typo!.id)!.phase).toBe("closed");

  items.update(a.s, crash!.id, { needsYou: { reason: "failed" } });
  expect(await command("retry", crash!.key)).toEqual({ code: 0, output: [`Retrying triage for ${crash!.key}`] });
  expect(await command("drop", crash!.key)).toEqual({ code: 0, output: [`Dropped ${crash!.key}`] });
  expect(items.get(a.s, crash!.id)!.phase).toBe("closed");
  // The factory machine's answer, as it would have been there.
  expect(command("approve", typo!.key)).rejects.toThrow(`${typo!.key} has no question to approve`);
});

test("a machine paired only through the relay forwards a command to the factory machine", async () => {
  process.env.AGENTGATE_RELAY_ALLOW_HTTP = "1";
  cleanup.push(() => {
    delete process.env.AGENTGATE_RELAY_ALLOW_HTTP;
  });
  const server = serveRelay(memoryRelay());
  cleanup.push(() => server.stop(true));
  const a = await factoryNode(cleanup);
  cleanup.push(() => a.ctx.channel.close());
  const b: TestNode = await machineB();
  a.s.put("node", "b", { id: "b", protocol: NODE_PROTOCOL });
  await joinRelay(b.s, await createRelay(a.s, `http://127.0.0.1:${server.port}`));
  await syncAll(a.s);
  await syncAll(b.s);
  expect(b.ctx.factory.pointer()?.node).toBe("a");
  for (const n of [a, b]) {
    await n.ctx.channel.reconcile();
    await a.until(() => n.ctx.channel.connected, "the relay channel");
  }

  const output: string[] = [];
  const code = await runCommand(b.ctx.factory, "add", [a.repo, "Crash on save"], { out: (line) => output.push(line) });
  expect(code).toBe(0);
  expect(items.list(a.s).map((i) => i.title)).toEqual(["Crash on save"]);
  expect(output[0]).toStartWith(`Added ${items.list(a.s)[0]!.key}`);
});
