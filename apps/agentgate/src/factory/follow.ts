import { parseArgs } from "node:util";
import type { HandoffJob } from "@agentgate/protocol";
import { getErrorMessage } from "hanzio";
import { z } from "zod";
import { PeerError, peerCall } from "../handoff/jobs.ts";
import { ACTIVE, dispatch, projection, t3Client, type Call } from "../handoff/t3.ts";
import { peerView, type ViewThread } from "../handoff/threads.ts";
import { jsonInput } from "../http.ts";
import { ACTIONS, findItem, setNeedsYou } from "./controller.ts";
import { items, runs, type FactoryRun } from "./db.ts";
import type { MirrorThread } from "./mirror.ts";
import { runCommand, runTool, type FactoryRuntime, type ForwardOp } from "./runtime.ts";

/**
 * The factory across machines. Commands and tools on another machine run on the factory machine through
 * `/peer/factory/op`, except those about a run or an item this machine still holds after the factory moved away. A
 * stage thread handed to another machine takes its run along: the run's `node` and `threadId` become the
 * destination's once it imported the thread, that machine's daemon forwards the thread's reports, and the run's status
 * is read from its `/peer/threads`.
 */

/** Commands such as `use` fetch the factory folder on the factory machine before they answer. */
const OP_TIMEOUT = 60_000;
/** A run's `threadId` while its thread moves away from this machine, followed by the handoff job's id. The
 * controller's watcher matches runs by thread, so the stopped and archived source thread is not a silent end. */
export const MOVING = "handoff:";

const callerSchema = z
  .object({ thread: z.string().min(1).max(512).optional(), node: z.string().min(1).max(512) })
  .strict();
const opSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("tool"),
      name: z.string().min(1).max(100),
      args: z.record(z.string(), z.unknown()),
      caller: callerSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("command"),
      name: z.string().min(1).max(100),
      args: z.array(z.string()).max(100),
      stdin: z.string().optional(),
    })
    .strict(),
]);

const threadId = z.string().min(1).max(512);
/** What the factory machine does to a stage thread this machine holds (`sendToThread`, `interruptItem`, the settle
 * after a report). `text` is the message to send, or the interrupt's reason. */
const threadActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("send"), threadId, text: z.string().min(1).max(256_000) }).strict(),
  z.object({ action: z.literal("interrupt"), threadId, text: z.string().max(2000).optional() }).strict(),
  z.object({ action: z.literal("settle"), threadId }).strict(),
]);
const shellThreads = z.object({
  threads: z.array(z.object({ id: z.string() })),
  archivedThreads: z.array(z.object({ id: z.string() })).default([]),
});

/** Commands that name an item, which the machine that holds it answers. */
const isItemCommand = (name: string) => name === "show" || (ACTIONS as readonly string[]).includes(name);

/** A call about a run or an item in this machine's tables: after the factory moved away, this machine still drives
 * them, and their threads report here. */
function heldHere(f: FactoryRuntime, op: ForwardOp) {
  if (op.kind === "tool") return typeof op.args.run === "string" && !!runs.get(f.s, op.args.run);
  if (!isItemCommand(op.name)) return false;
  const { positionals } = parseArgs({
    args: op.args,
    options: { reason: { type: "string" }, json: { type: "boolean" } },
    strict: false,
  });
  const ref = positionals[0];
  try {
    return !!ref && !!findItem(f, ref);
  } catch {
    // A reference two items here share: the command here says so.
    return true;
  }
}

async function runHere(f: FactoryRuntime, op: ForwardOp) {
  if (op.kind === "tool") return f.tools.get(op.name)!.call(op.args, op.caller);
  const output: string[] = [];
  const io = { ...(op.stdin !== undefined && { stdin: op.stdin }), out: (line: string) => output.push(line) };
  const code = await f.commands.get(op.name)!.run(op.args, io);
  return { code, output };
}

export function setup(f: FactoryRuntime): void {
  f.forwarder = async (op) => {
    if (heldHere(f, op)) return runHere(f, op);
    const node = f.pointer()!.node;
    try {
      return await peerCall(f.s, node, "/factory/op", { json: op, timeout: OP_TIMEOUT });
    } catch (e) {
      // A PeerError is the factory machine's own answer.
      if (e instanceof PeerError) throw e;
      throw new Error(`The factory runs on ${node}, and this machine cannot reach it`);
    }
  };

  // The response is the tool's value, or { code, output } for a command; an error is { error } with its message, as
  // the caller would have seen it here.
  f.peer.post("/op", async (c) => {
    const op = opSchema.safeParse(await jsonInput(c.req.raw));
    if (!op.success) return c.json({ error: "invalid factory operation" }, 400);
    // Two machines that disagree on where the factory runs would otherwise forward to each other.
    if (!f.isFactoryNode()) return c.json({ error: `${f.s.nodeId} does not run the factory` }, 409);
    try {
      const { data } = op;
      if (data.kind === "tool") return c.json((await runTool(f, data.name, data.args, data.caller)) ?? null);
      const output: string[] = [];
      const io = { ...(data.stdin !== undefined && { stdin: data.stdin }), out: (line: string) => output.push(line) };
      const code = await runCommand(f, data.name, data.args, io);
      return c.json({ code, output });
    } catch (e) {
      return c.json({ error: getErrorMessage(e) }, 400);
    }
  });

  // Only the factory machine signs in to T3's MCP, so a moved thread is reached through this machine's own T3 client.
  f.peer.post("/thread", async (c) => {
    const input = threadActionSchema.safeParse(await jsonInput(c.req.raw));
    if (!input.success) return c.json({ error: "invalid thread action" }, 400);
    const { data } = input;
    try {
      const t3 = t3Client(f.s);
      const { threads, archivedThreads } = shellThreads.parse(await t3.shell());
      if (![...threads, ...archivedThreads].some((t) => t.id === data.threadId))
        return c.json({ error: `T3 Code on ${f.s.nodeId} has no thread ${data.threadId}` }, 404);
      await t3.rpc((call) => threadAction(call, data));
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: getErrorMessage(e) }, 502);
    }
  });

  // Every machine, like dispatch: a machine drives the runs in its own tables.
  f.loops.push({ name: "factory-follow", everyMs: 5000, where: "every-node", run: () => follow(f) });
}

/** The T3 commands behind the MCP tools the controller calls on its own machine: `message.dispatch` as
 * `t3_thread_send` with mode queue, `run.interrupt` for the turn `t3_thread_interrupt` stops, and `thread.settle`. */
async function threadAction(call: Call, input: z.infer<typeof threadActionSchema>) {
  const { threadId } = input;
  if (input.action === "send")
    await dispatch(call, {
      type: "message.dispatch",
      threadId,
      messageId: crypto.randomUUID(),
      text: input.text,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
  else if (input.action === "interrupt") {
    for (const run of (await projection(call, threadId)).runs.filter((r) => ACTIVE.has(r.status)))
      await dispatch(call, {
        type: "run.interrupt",
        threadId,
        runId: run.id,
        ...(input.text && { reason: input.text }),
      });
  } else await dispatch(call, { type: "thread.settle", threadId });
}

const active = (f: FactoryRuntime) => runs.list(f.s, { states: ["running", "waiting"] });

/** Whether the run's thread here is being handed to another machine; it then waits for the move instead of being
 * taken for a silent end. The controller asks before it looks at a thread's turn. */
export function handoffOf(f: FactoryRuntime, run: FactoryRun, thread: MirrorThread) {
  if (run.node !== f.s.nodeId) return false;
  const job = f.ctx.handoffs
    .list("source")
    .find((j) => j.thread === thread.id && j.step !== "done" && j.step !== "failed");
  if (job) moving(f, run, job.id, job.target);
  return !!job;
}

function note(f: FactoryRuntime, run: FactoryRun, text: string) {
  f.events.emit({ kind: "note", run: run.id, ...(run.item && { item: run.item }), text });
}

function moving(f: FactoryRuntime, run: FactoryRun, job: string, to: string) {
  runs.update(f.s, run.id, { threadId: `${MOVING}${job}` });
  note(f, run, `The ${run.kind} thread is moving to ${to}`);
}

function moved(f: FactoryRuntime, run: FactoryRun, job: HandoffJob & { destThreadId: string }) {
  // The link opened the thread on the machine it left.
  runs.update(f.s, run.id, { node: job.to, threadId: job.destThreadId, threadLink: undefined, error: undefined });
  seen(f).delete(run.id);
  note(f, run, `The ${run.kind} thread moved to ${job.to}, and its run follows it there`);
}

const imported = (j: HandoffJob | undefined): j is HandoffJob & { destThreadId: string } =>
  !!j?.destThreadId && (j.status === "imported" || j.status === "done");

/** The newest handoff that started or ended at this thread: one that ended here was already followed. */
function lastMove(jobs: HandoffJob[], node: string, thread: string) {
  const involved = jobs.filter(
    (j) => (j.from === node && j.thread === thread) || (j.to === node && j.destThreadId === thread),
  );
  const newest = involved.sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!newest || newest.from !== node || newest.status === "failed") return undefined;
  // Both machines list the same job; the destination knows the new thread first.
  return involved.find((j) => j.id === newest.id && imported(j)) ?? newest;
}

const seenRuns = new WeakMap<FactoryRuntime, Set<string>>();
/** Runs on other machines whose thread this daemon saw working, so an idle one ended its turn. */
function seen(f: FactoryRuntime) {
  let set = seenRuns.get(f);
  if (!set) seenRuns.set(f, (set = new Set()));
  return set;
}

async function follow(f: FactoryRuntime) {
  const { s } = f;
  const list = active(f).filter((r) => r.node && r.threadId);
  if (!list.length) return;
  const h = f.ctx.handoffs;
  const local = h.list().map((j) => h.view(j));
  const views = new Map<string, ReturnType<typeof peerView>>();
  const view = (node: string) => {
    let v = views.get(node);
    if (!v) views.set(node, (v = peerView(h, { id: node, alwaysOn: s.get("node", node)?.alwaysOn ?? false })));
    return v;
  };

  for (const run of list) {
    const node = run.node!;
    const thread = run.threadId!;
    if (thread.startsWith(MOVING)) {
      const job = local.find((j) => j.role === "source" && j.id === thread.slice(MOVING.length));
      if (imported(job)) moved(f, run, job);
      else if (job?.status === "failed") {
        runs.update(s, run.id, { threadId: job.thread });
        note(f, run, `Handing the ${run.kind} thread to ${job.to} failed, so its run stays on ${node}`);
      }
      continue;
    }
    if (node === s.nodeId) {
      // The listener missed the start of a handoff, or this daemon restarted during one.
      const job = lastMove(local, node, thread);
      if (imported(job)) moved(f, run, job);
      else if (job) moving(f, run, job.id, job.to);
      continue;
    }

    const v = await view(node);
    const unreachable = `${node} is unreachable`;
    if (v.error) {
      // The run waits for its machine: nothing here can tell whether its thread still works.
      if (run.error !== unreachable) {
        runs.update(s, run.id, { error: unreachable });
        note(f, run, `The ${run.kind} run on ${node} is unreachable; it waits for ${node} and is not retried`);
      }
      continue;
    }
    if (run.error === unreachable) {
      runs.update(s, run.id, { error: undefined });
      note(f, run, `${node} is reachable again`);
    }
    const job = lastMove([...v.jobs, ...local], node, thread);
    if (imported(job)) moved(f, run, job);
    else if (!job)
      remoteStatus(
        f,
        run,
        v.threads.find((t) => t.id === thread),
      );
  }
}

/** What the controller's watcher does for a thread on this machine, from another machine's `/peer/threads`. A turn
 * that ends without a report is not reminded or retried from here: the thread is the person's on that machine. */
function remoteStatus(f: FactoryRuntime, run: FactoryRun, thread: ViewThread | undefined) {
  const { s } = f;
  const item = run.item ? items.get(s, run.item) : undefined;
  if (thread?.needsYou) {
    if (run.state === "waiting") return;
    runs.update(s, run.id, { state: "waiting" });
    if (item)
      setNeedsYou(f, item.id, {
        reason: "approval",
        question: `The ${run.kind} thread on ${run.node} asks you something in T3 Code`,
      });
    return;
  }
  if (run.state === "waiting") runs.update(s, run.id, { state: "running" });
  if (thread?.running) {
    seen(f).add(run.id);
    if (item?.needsYou?.reason === "approval" || item?.needsYou?.reason === "stalled") setNeedsYou(f, item.id, null);
    return;
  }
  if (!seen(f).delete(run.id)) return;
  if (item)
    setNeedsYou(f, item.id, {
      reason: "stalled",
      question: `The ${run.kind} thread on ${run.node} ended its turn without a report; continue it there, or drop the item`,
    });
  else note(f, run, `The ${run.kind} thread on ${run.node} ended its turn without a report`);
}
