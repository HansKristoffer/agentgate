import { Hono } from "hono";
import type { Ctx, Env } from "../daemon.ts";
import { startLogin } from "../mcp/oauth.ts";
import { presets } from "../mcp/templates.ts";
import { toolList } from "../ops/servers.ts";
import { required } from "./http.ts";

/** A server's tools over the gateway's shared connection (`toolList`), or a 404 when there is no such server. */
export const tools = async (ctx: Ctx, id: string) => {
  const inst = ctx.s.get("mcp", id);
  required(inst, "server");
  return toolList(ctx, inst!);
};

/** The presets servers start from, and the sign-in start. The writes are operations (ops/servers.ts). */
export function servers(ctx: Ctx) {
  const { s } = ctx;
  const app = new Hono<Env>();
  app.get("/presets", (c) => c.json(presets));
  // A route, not an operation: the sign-in returns to the address the caller reached this daemon on.
  app.post("/servers/:id/login", async (c) => {
    required(s.get("mcp", c.req.param("id")), "server");
    const url = await startLogin(s, c.req.param("id"), `${new URL(c.req.url).origin}/oauth/callback`);
    return c.json({ url: url?.href, ok: !url });
  });
  return app;
}
