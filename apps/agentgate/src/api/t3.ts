import { Hono } from "hono";
import { z } from "zod";
import type { Ctx, Env } from "../daemon.ts";
import { connectInput, pairingLinkInput, t3State } from "../handoff/t3.ts";
import {
  allNodes,
  cancelHandoffOn,
  connectNode,
  disconnectNode,
  handoffJob,
  pairingLinkNode,
  requestHandoff,
} from "../handoff/threads.ts";
import { jsonInput as json } from "../http.ts";
import { inputAsync, local, required } from "./http.ts";

/** T3 Code connections, threads and handoffs. Connecting receives a T3 pairing token and a pairing link is one,
 * credentials: local callers only. */
export function t3(ctx: Ctx) {
  const { s } = ctx;
  const app = new Hono<Env>();
  app.get("/t3", (c) => c.json(t3State(s)));
  app.post("/t3/connect", async (c) => {
    local(c.env.listener);
    const node = c.req.query("node");
    const input = connectInput.parse(await json(c.req.raw));
    return c.json(await inputAsync(() => connectNode(ctx.handoffs, node, input)));
  });
  app.post("/t3/pairing-link", async (c) => {
    local(c.env.listener);
    const input = pairingLinkInput.parse(await json(c.req.raw));
    return c.json(await inputAsync(() => pairingLinkNode(ctx.handoffs, c.req.query("node"), input)));
  });
  app.delete("/t3", async (c) => {
    await inputAsync(() => disconnectNode(ctx.handoffs, c.req.query("node")));
    return c.json({ ok: true });
  });
  // The app's T3 Code page asks for a T3 project sync when it opens; it runs in the background.
  app.post("/t3/projects/sync", (c) => {
    void ctx.handoffs.syncProjects().catch(() => {});
    return c.json({ ok: true }, 202);
  });
  app.get("/threads", async (c) => c.json(await allNodes(ctx.handoffs)));
  app.get("/handoffs", (c) => c.json(ctx.handoffs.list().map((job) => ctx.handoffs.view(job))));
  app.post("/handoffs", async (c) => {
    const f = z
      .object({
        threadId: z.string().min(1).max(512),
        node: z.string().min(1).max(512).optional(),
        to: z.string().min(1).max(512).optional(),
      })
      .strict()
      .parse(await json(c.req.raw));
    return c.json(await inputAsync(() => requestHandoff(ctx.handoffs, f)), 201);
  });
  app.get("/handoffs/:id", async (c) => {
    const job = await inputAsync(() => handoffJob(ctx.handoffs, c.req.param("id"), c.req.query("node")));
    required(job, "handoff");
    return c.json(job);
  });
  app.post("/handoffs/:id/cancel", async (c) =>
    c.json(await inputAsync(() => cancelHandoffOn(ctx.handoffs, c.req.param("id"), c.req.query("node")))),
  );
  return app;
}
