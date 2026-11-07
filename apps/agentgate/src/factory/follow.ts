import { parseArgs } from "node:util";
import { getErrorMessage } from "hanzio";
import { z } from "zod";
import { PeerError, peerCall } from "../handoff/jobs.ts";
import { jsonInput } from "../http.ts";
import { ACTIONS, findItem } from "./controller.ts";
import { runs } from "./db.ts";
import { runCommand, runTool, type FactoryRuntime, type ForwardOp } from "./runtime.ts";

/**
 * The factory across machines. Commands and tools on another machine run on the factory machine through
 * `/peer/factory/op`, except those about a run or an item this machine still holds after the factory moved away. A
 * stage thread handed to another machine leaves the factory (controller.ts), so threads are only ever acted on here.
 */

/** Commands such as `use` fetch the factory folder on the factory machine before they answer. */
const OP_TIMEOUT = 60_000;

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
    const { data } = op;
    // An item or run this machine still holds after the factory moved away: the factory machine sends those here.
    if (!f.isFactoryNode() && heldHere(f, data)) {
      try {
        return c.json((await runHere(f, data)) ?? null);
      } catch (e) {
        return c.json({ error: getErrorMessage(e) }, 400);
      }
    }
    // Two machines that disagree on where the factory runs would otherwise forward to each other.
    if (!f.isFactoryNode()) return c.json({ error: `${f.s.nodeId} does not run the factory` }, 409);
    try {
      if (data.kind === "tool") return c.json((await runTool(f, data.name, data.args, data.caller)) ?? null);
      const output: string[] = [];
      const io = { ...(data.stdin !== undefined && { stdin: data.stdin }), out: (line: string) => output.push(line) };
      const code = await runCommand(f, data.name, data.args, io);
      return c.json({ code, output });
    } catch (e) {
      return c.json({ error: getErrorMessage(e) }, 400);
    }
  });
}
