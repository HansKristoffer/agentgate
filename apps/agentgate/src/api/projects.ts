import { projectIdSchema, projectSchema, skillIdSchema, type ToolPreview } from "@agentgate/protocol";
import { Hono } from "hono";
import { homedir } from "node:os";
import { z } from "zod";
import { addFileAt, fileContent, removeFiles, setFileContent } from "../checkout-files.ts";
import { revision } from "../configuration.ts";
import type { Ctx, Env } from "../daemon.ts";
import { jsonInput as json } from "../http.ts";
import { aliasesFor, scanRepos, toolName } from "../mcp/gateway.ts";
import { saveProject, setFactoryTools, setFactoryWebhook } from "../operations.ts";
import {
  deleteProject,
  disableRemote,
  enableRemote,
  publicProject,
  regenerate,
  rotateSecret,
  showRemote,
} from "../remote.ts";
import type { Project } from "../store.ts";
import { input, inputAsync, local } from "./http.ts";
import { tools } from "./servers.ts";

/** A project as the app sees it: no endpoint secret, with the revision a save must name. */
export const shownProject = (ctx: Ctx, p: Project) => ({
  ...publicProject(p, ctx.remote),
  revision: revision(ctx.s, "project", p.id),
});

/** Projects, their env files and remote endpoints, scanned checkouts and the tools a project offers. */
export function projects(ctx: Ctx) {
  const { s } = ctx;
  const app = new Hono<Env>();
  app.put("/projects", async (c) => {
    const f = projectSchema
      .pick({ id: true, mcp: true, inheritDefaults: true })
      // Optional, so a client that does not know skills cannot clear them.
      .extend({ skills: z.array(skillIdSchema).max(5000).optional(), revision: z.string().length(64).optional() })
      .parse(await json(c.req.raw));
    const { revision: expected, ...fields } = f;
    const saved = input(() => saveProject(s, f.id, fields, expected));
    ctx.remote.reconcile();
    return c.json(shownProject(ctx, saved));
  });
  // A repository's env files (checkout-files.ts). Adding reads a file from this machine's checkout, so it is local only.
  const filesRoot = () => {
    if (!ctx.files.root) throw new Error("Env files are off in this daemon");
    return ctx.files.root;
  };
  app.post("/projects/files", async (c) => {
    local(c.env.listener);
    const f = z
      .object({ project: projectIdSchema, path: z.string().min(1).max(4096) })
      .strict()
      .parse(await json(c.req.raw));
    return c.json({ project: await inputAsync(() => addFileAt(s, filesRoot(), f.project, f.path)) });
  });
  // A file's contents are secrets, so reading and editing them is local only.
  app.get("/projects/files/content", (c) => {
    local(c.env.listener);
    const id = projectIdSchema.parse(c.req.query("id")),
      path = z.string().min(1).max(512).parse(c.req.query("path"));
    return c.json(input(() => fileContent(s, filesRoot(), id, path)));
  });
  app.put("/projects/files/content", async (c) => {
    local(c.env.listener);
    const f = z
      .object({
        project: projectIdSchema,
        path: z.string().min(1).max(512),
        content: z.string().max(1024 * 1024),
        sha256: z.string().max(64).optional(),
      })
      .strict()
      .parse(await json(c.req.raw));
    return c.json(await inputAsync(() => setFileContent(s, filesRoot(), f.project, f.path, f.content, f.sha256)));
  });
  app.delete("/projects/files", (c) => {
    const id = projectIdSchema.parse(c.req.query("id")),
      path = z.string().min(1).max(512).parse(c.req.query("path"));
    return c.json({ project: input(() => removeFiles(s, filesRoot(), id, [path])) });
  });
  // Virtual projects' endpoints. Every route that returns or changes a secret is loopback-only.
  const remoteId = (c: { req: { query(name: string): string | undefined } }) =>
    z.string().min(1).max(80).parse(c.req.query("id"));
  const remoteBody = async (req: Request) =>
    z
      .object({ id: z.string().min(1).max(80), servedBy: z.string().min(1).max(512).optional() })
      .strict()
      .parse(await json(req));
  const remoteChanged = <T>(fn: () => T): T => {
    const out = input(fn);
    ctx.remote.reconcile();
    return out;
  };
  app.post("/projects/remote", async (c) => {
    local(c.env.listener);
    const f = await remoteBody(c.req.raw);
    return c.json(remoteChanged(() => enableRemote(s, f.id, f.servedBy)));
  });
  app.get("/projects/remote", (c) => {
    local(c.env.listener);
    return c.json(input(() => showRemote(s, remoteId(c))));
  });
  app.post("/projects/remote/secret", async (c) => {
    local(c.env.listener);
    const f = await remoteBody(c.req.raw);
    return c.json(remoteChanged(() => rotateSecret(s, f.id)));
  });
  app.post("/projects/remote/regenerate", async (c) => {
    local(c.env.listener);
    const f = await remoteBody(c.req.raw);
    return c.json(remoteChanged(() => regenerate(s, f.id, f.servedBy)));
  });
  app.delete("/projects/remote", (c) => {
    remoteChanged(() => disableRemote(s, remoteId(c)));
    return c.json({ ok: true });
  });
  app.put("/projects/factory-tools", async (c) => {
    const f = z
      .object({ id: z.string().min(1).max(80), on: z.boolean() })
      .strict()
      .parse(await json(c.req.raw));
    return c.json(
      shownProject(
        ctx,
        input(() => setFactoryTools(s, f.id, f.on)),
      ),
    );
  });
  app.put("/projects/factory-webhook", async (c) => {
    const f = z
      .object({ id: z.string().min(1).max(80), url: z.string().max(2000).nullable() })
      .strict()
      .parse(await json(c.req.raw));
    return c.json(
      shownProject(
        ctx,
        input(() => setFactoryWebhook(s, f.id, f.url ?? undefined)),
      ),
    );
  });
  app.delete("/projects", (c) => {
    const id = z.string().min(1).parse(c.req.query("id"));
    deleteProject(s, id);
    ctx.remote.reconcile();
    return c.json({ ok: true });
  });
  app.post("/projects/scan", async (c) => {
    local(c.env.listener);
    const { dir } = z.object({ dir: z.string().min(1) }).parse(await json(c.req.raw));
    const repos = input(() => scanRepos(dir.replace(/^~/, homedir())));
    // Scanned checkouts receive their project's skills on this machine.
    for (const r of repos) ctx.skills.register(r.path, r.repo, false);
    ctx.skills.sync();
    return c.json({ repos });
  });
  app.put("/checkouts/mirroring", async (c) => {
    local(c.env.listener);
    const f = z
      .object({ path: z.string().min(1).max(4096), enabled: z.boolean() })
      .strict()
      .parse(await json(c.req.raw));
    input(() => ctx.skills.setMirroring(f.path, f.enabled));
    return c.json({ ok: true });
  });
  app.get("/projects/tools", async (c) => {
    const result: ToolPreview[] = [];
    for (const [alias, id] of Object.entries(aliasesFor(s, c.req.query("id") ?? "*"))) {
      const inst = s.get("mcp", id);
      if (inst?.mode === "perSession")
        result.push({
          name: `${alias}__*`,
          description: "Starts inside each session's worktree",
        });
      else
        try {
          for (const t of await tools(ctx, id))
            if (!inst?.tools || inst.tools.includes(t.name))
              result.push({
                name: toolName(alias, t.name),
                description: t.description,
              });
        } catch {
          result.push({
            name: `${alias}__*`,
            error: "Could not connect; test the server or sign in again",
          });
        }
    }
    return c.json(result);
  });
  return app;
}
