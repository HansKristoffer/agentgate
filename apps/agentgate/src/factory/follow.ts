import { getErrorMessage } from "hanzio";
import { z } from "zod";
import { PeerError, peerCall } from "../handoff/jobs.ts";
import { jsonInput } from "../http.ts";
import { runCommand, runOp, runTool, type FactoryRuntime } from "./runtime.ts";

/**
 * The factory across machines. Commands, tools and operations on another machine run on the factory machine through
 * `/peer/factory/op`: only that machine drives items. A stage thread handed to another machine leaves the factory
 * (controller.ts), so threads are only ever acted on there.
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
  z.object({ kind: z.literal("op"), name: z.string().min(1).max(100), input: z.unknown() }).strict(),
]);

export function setup(f: FactoryRuntime): void {
  f.forwarder = async (op) => {
    const node = f.pointer()!.node;
    try {
      return await peerCall(f.s, node, "/factory/op", { json: op, timeout: OP_TIMEOUT });
    } catch (e) {
      // A PeerError is the factory machine's own answer.
      if (e instanceof PeerError) throw e;
      throw new Error(`The factory runs on ${node}, and this machine cannot reach it`);
    }
  };

  // The response is the tool's or operation's value, or { code, output } for a command; an error is { error } with
  // its message, as the caller would have seen it here.
  f.peer.post("/op", async (c) => {
    const op = opSchema.safeParse(await jsonInput(c.req.raw));
    if (!op.success) return c.json({ error: "invalid factory operation" }, 400);
    const { data } = op;
    // Two machines that disagree on where the factory runs would otherwise forward to each other.
    if (!f.isFactoryNode()) return c.json({ error: `${f.s.nodeId} does not run the factory` }, 409);
    try {
      if (data.kind === "tool") return c.json((await runTool(f, data.name, data.args, data.caller)) ?? null);
      if (data.kind === "op") return c.json((await runOp(f, data.name, data.input)) ?? null);
      const output: string[] = [];
      const io = { ...(data.stdin !== undefined && { stdin: data.stdin }), out: (line: string) => output.push(line) };
      const code = await runCommand(f, data.name, data.args, io);
      return c.json({ code, output });
    } catch (e) {
      return c.json({ error: getErrorMessage(e) }, 400);
    }
  });
}
