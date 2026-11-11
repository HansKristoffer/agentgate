import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Ctx, Env } from "../daemon.ts";
import { jsonInput as json } from "../http.ts";
import { removeNode, setHealthDashboard } from "../operations.ts";
import {
  cleanupRelay,
  createRelay,
  installAndJoin,
  joinRelay,
  leaveRelay,
  newNodeName,
  parseJoin,
  reconcileRelay,
  rotateRelay,
  setServiceKey,
} from "../relay.ts";
import { join, pairCode, tailscale } from "../sync.ts";
import { routeNode, updateTracked } from "../update.ts";
import { input, inputAsync, local, optionalJson, relayed, required } from "./http.ts";

/** Pairing and joining machines, the relay, and what one machine changes on another. */
export function nodes(ctx: Ctx) {
  const { s } = ctx;
  const app = new Hono<Env>();
  app.post("/nodes/pair", async (c) => {
    const f = z
      .object({
        method: z.enum(["tailnet", "relay"]).default("tailnet"),
        relayUrl: z.string().max(2000).optional(),
        name: z.string().max(63).optional(),
      })
      .strict()
      .parse(await optionalJson(c.req.raw));
    const name = f.name?.trim() ? await relayed(async () => newNodeName(s, f.name!.trim())) : undefined;
    if (f.method === "relay") {
      // The invite is a master key: only a local caller may see it.
      local(c.env.listener);
      const invite = await relayed(() => createRelay(s, f.relayUrl));
      return c.json({ command: installAndJoin(invite, name), method: "relay" });
    }
    const url = s.get("node", s.nodeId)?.url ?? (await tailscale())?.url;
    if (!url)
      throw new HTTPException(409, {
        message: "Start Tailscale before pairing",
      });
    return c.json({
      command: installAndJoin(`${url} ${pairCode(s)}`, name),
      method: "tailnet",
      expiresIn: 600,
    });
  });
  app.post("/nodes/join", async (c) => {
    const f = z
      .union([
        z.object({ command: z.string().min(1).max(4096) }).strict(),
        z.object({ url: z.url(), code: z.string().min(1) }).strict(),
      ])
      .parse(await json(c.req.raw));
    const target = "command" in f ? await relayed(async () => parseJoin(f.command)) : f;
    if ("invite" in target) return c.json(await relayed(() => joinRelay(s, target.invite, target.force)));
    const self = s.get("node", s.nodeId)?.url ?? (await tailscale())?.url;
    if (!self)
      throw new HTTPException(409, {
        message: "Start Tailscale before pairing",
      });
    return c.json({ node: await join(s, target.url, target.code, self) });
  });
  app.post("/relay/reconcile", async (c) => {
    await relayed(() => reconcileRelay(s));
    return c.json({ ok: true });
  });
  app.post("/relay/rotate", async (c) => {
    local(c.env.listener);
    return c.json(await relayed(() => rotateRelay(s)));
  });
  app.post("/relay/leave", async (c) => {
    const f = z
      .object({ wipe: z.boolean().default(false) })
      .strict()
      .parse(await optionalJson(c.req.raw));
    return c.json(await relayed(() => leaveRelay(s, f.wipe)));
  });
  app.post("/relay/cleanup", async (c) => {
    const f = z
      .object({ abandon: z.boolean().default(false) })
      .strict()
      .parse(await optionalJson(c.req.raw));
    return c.json(await relayed(() => cleanupRelay(s, f.abandon)));
  });
  app.put("/relay/service-key", async (c) => {
    local(c.env.listener);
    const f = z
      .object({ key: z.string().min(1).max(512).nullable() })
      .strict()
      .parse(await json(c.req.raw));
    setServiceKey(s, f.key ?? undefined);
    return c.json({ ok: true });
  });
  // Not local-only, like always-on (ops/nodes.ts): any paired machine's dashboard is turned on from here (operations.ts).
  app.post("/nodes/:id/dashboard", async (c) => {
    const { on } = z
      .object({ on: z.boolean() })
      .strict()
      .parse(await json(c.req.raw));
    required(s.get("node", c.req.param("id")), "node");
    return c.json(input(() => setHealthDashboard(s, c.req.param("id"), on)));
  });
  // Not local-only: updating an always-on server from wherever you are is the point. The node runs the release
  // checks itself and refuses copies another tool owns.
  app.post("/nodes/:id/update", async (c) => {
    const n = s.get("node", c.req.param("id"));
    required(n, "node");
    return c.json(await inputAsync(() => updateTracked(s, n!.id)));
  });
  // Not local-only either, on purpose: see routeNode.
  app.post("/nodes/:id/primary", async (c) => {
    const { on } = z
      .object({ on: z.boolean() })
      .strict()
      .parse(await json(c.req.raw));
    const n = s.get("node", c.req.param("id"));
    required(n, "node");
    return c.json(await inputAsync(() => routeNode(s, n!.id, on)));
  });
  app.delete("/nodes/:id", async (c) => {
    // New endpoint URLs and the new relay secret are credentials: only a local caller removes a machine that needs them.
    const { endpoints, rotated } = await relayed(() => removeNode(s, c.req.param("id"), () => local(c.env.listener)));
    if (endpoints.length) ctx.remote.reconcile();
    return c.json(rotated ? { ok: true, rotated: true, ...rotated, endpoints } : { ok: true, endpoints });
  });
  return app;
}
