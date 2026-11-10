import { getErrorMessage } from "hanzio";
import { z } from "zod";
import { PeerError, peerCall } from "../handoff/jobs.ts";
import { jsonInput } from "../http.ts";
import { runOperation, type FactoryRuntime } from "./runtime.ts";

/**
 * The factory across machines. An operation asked for on another machine runs on the factory machine through
 * `/peer/factory/op`, with its caller: only that machine drives items. A stage thread handed to another machine
 * leaves the factory (controller.ts), so threads are only ever acted on there.
 */

/** Operations such as `reload` fetch the factory folder on the factory machine before they answer. */
const OP_TIMEOUT = 60_000;

const forwardSchema = z
  .object({
    name: z.string().min(1).max(100),
    input: z.unknown(),
    caller: z
      .object({
        via: z.enum(["terminal", "api", "tool", "remote"]),
        thread: z.string().min(1).max(512).optional(),
        node: z.string().min(1).max(512),
      })
      .strict(),
  })
  .strict();

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

  // The response is the operation's result; an error is { error } with its message, as the caller would have seen it
  // here.
  f.peer.post("/op", async (c) => {
    const op = forwardSchema.safeParse(await jsonInput(c.req.raw));
    if (!op.success) return c.json({ error: "invalid factory operation" }, 400);
    const { name, input, caller } = op.data;
    // Two machines that disagree on where the factory runs would otherwise forward to each other.
    if (!f.isFactoryNode()) return c.json({ error: `${f.s.nodeId} does not run the factory` }, 409);
    try {
      return c.json((await runOperation(f, name, input, caller)) ?? null);
    } catch (e) {
      return c.json({ error: getErrorMessage(e) }, 400);
    }
  });
}
