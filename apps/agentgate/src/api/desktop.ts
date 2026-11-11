import { Hono } from "hono";
import { z } from "zod";
import type { Ctx, Env } from "../daemon.ts";
import * as desktop from "../desktop.ts";
import { jsonInput as json } from "../http.ts";
import { input, inputAsync, local } from "./http.ts";

/** Claude Desktop on this Mac. Loopback only: a remote connection must never drive another Mac's Desktop. */
export function desktopRoutes(ctx: Ctx) {
  const { s } = ctx;
  const app = new Hono<Env>();
  app.get("/desktop", (c) => {
    local(c.env.listener);
    return c.json(desktop.status(s));
  });
  app.post("/desktop/capture", (c) => {
    local(c.env.listener);
    return c.json({ accountUuid: input(() => desktop.capture(s)) });
  });
  app.post("/desktop/add", async (c) => {
    local(c.env.listener);
    const f = z
      .object({ expected: z.string().max(320).optional() })
      .strict()
      .parse(await json(c.req.raw));
    await inputAsync(() => desktop.add(s, f.expected));
    return c.json({ ok: true });
  });
  app.delete("/desktop/add", async (c) => {
    local(c.env.listener);
    await inputAsync(() => desktop.cancelAdd(s));
    return c.json({ ok: true });
  });
  app.post("/desktop/use", async (c) => {
    local(c.env.listener);
    const f = z
      .object({ accountUuid: z.string().min(1).max(64) })
      .strict()
      .parse(await json(c.req.raw));
    await inputAsync(() => desktop.use(s, f.accountUuid));
    return c.json({ ok: true });
  });
  app.delete("/desktop/logins/:uuid", (c) => {
    local(c.env.listener);
    input(() => desktop.forget(s, c.req.param("uuid")));
    return c.json({ ok: true });
  });
  app.post("/desktop/gateway", async (c) => {
    local(c.env.listener);
    const f = z
      .object({ on: z.boolean() })
      .strict()
      .parse(await json(c.req.raw));
    await inputAsync(() => desktop.gateway(s, f.on));
    return c.json({ ok: true });
  });
  return app;
}
