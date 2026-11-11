import { projectChangeSchema } from "@agentgate/protocol";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Ctx, Env } from "../daemon.ts";
import { jsonInput as json } from "../http.ts";
import { needsLogin, serverTools } from "../mcp/gateway.ts";
import { startLogin } from "../mcp/oauth.ts";
import { presets } from "../mcp/templates.ts";
import { changeServerProjects, createInstance, deleteInstance, labelInstance, renameInstance } from "../operations.ts";
import type { Store } from "../store.ts";
import { input, required } from "./http.ts";

/** A server's tools, or a 404 when there is no such server. */
export const tools = async (s: Store, id: string) => {
  const inst = s.get("mcp", id);
  required(inst, "server");
  return serverTools(s, inst!);
};

/** MCP servers and the presets they start from. */
export function servers(ctx: Ctx) {
  const { s } = ctx;
  const app = new Hono<Env>();
  app.get("/presets", (c) => c.json(presets));
  app.post("/servers", async (c) => {
    const f = z
      .object({
        id: z.string().min(1),
        target: z.string().optional(),
        command: z.string().optional(),
        perSession: z.boolean().optional(),
        headers: z.string().optional(),
      })
      .strict()
      .parse(await json(c.req.raw));
    const { id: name, ...rest } = f;
    const inst = input(() => createInstance(s, { name, ...rest }));
    // Connect a hosted server right away: it shows as available, or the app goes straight on to its sign-in.
    const login = inst.url ? await serverTools(s, inst).then(() => false, needsLogin) : false;
    return c.json({ id: inst.id, needsLogin: login }, 201);
  });
  app.patch("/servers/:id", async (c) => {
    const f = z
      .object({ label: z.string() })
      .strict()
      .parse(await json(c.req.raw));
    input(() => labelInstance(s, c.req.param("id"), f.label));
    return c.json({ ok: true });
  });
  app.post("/servers/:id/rename", async (c) => {
    const f = z.object({ id: z.string().min(1) }).parse(await json(c.req.raw));
    input(() => renameInstance(s, c.req.param("id"), f.id));
    return c.json({ ok: true });
  });
  app.post("/servers/:id/test", async (c) => {
    try {
      return c.json({ tools: await tools(s, c.req.param("id")) });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      throw new HTTPException(needsLogin(error) ? 401 : 502, {
        message: needsLogin(error)
          ? "This server needs a login. Click Sign in."
          : "Could not connect to this server. Check its URL or command and daemon service logs.",
      });
    }
  });
  app.post("/servers/:id/login", async (c) => {
    required(s.get("mcp", c.req.param("id")), "server");
    const url = await startLogin(s, c.req.param("id"), `${new URL(c.req.url).origin}/oauth/callback`);
    return c.json({ url: url?.href, ok: !url });
  });
  app.put("/servers/:id/projects", async (c) => {
    const f = projectChangeSchema.parse(await json(c.req.raw));
    input(() => changeServerProjects(s, c.req.param("id"), f));
    return c.json({ ok: true });
  });
  app.delete("/servers/:id", (c) => {
    required(s.get("mcp", c.req.param("id")), "server");
    deleteInstance(s, c.req.param("id"));
    return c.json({ ok: true });
  });
  return app;
}
