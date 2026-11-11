import { projectIdSchema } from "@agentgate/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { fileContent } from "../checkout-files.ts";
import { revision } from "../configuration.ts";
import type { Ctx, Env } from "../daemon.ts";
import { publicProject, showRemote } from "../remote.ts";
import type { Project } from "../store.ts";
import { input, local } from "./http.ts";

/** A project as the app sees it: no endpoint secret, with the revision a save must name. */
export const shownProject = (ctx: Ctx, p: Project) => ({
  ...publicProject(p, ctx.remote),
  revision: revision(ctx.s, "project", p.id),
});

/** The projects family's reads; its changes are control operations (ops/projects.ts). Both read secrets, so they are
 * local only. */
export function projects(ctx: Ctx) {
  const { s } = ctx;
  const app = new Hono<Env>();
  app.get("/projects/files/content", (c) => {
    local(c.env.listener);
    const id = projectIdSchema.parse(c.req.query("id")),
      path = z.string().min(1).max(512).parse(c.req.query("path"));
    return c.json(
      input(() => {
        if (!ctx.files.root) throw new Error("Env files are off in this daemon");
        return fileContent(s, ctx.files.root, id, path);
      }),
    );
  });
  app.get("/projects/remote", (c) => {
    local(c.env.listener);
    const id = z.string().min(1).max(80).parse(c.req.query("id"));
    return c.json(input(() => showRemote(s, id)));
  });
  return app;
}
