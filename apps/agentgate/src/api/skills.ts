import {
  SkillConflict,
  decodedSize,
  projectChangeSchema,
  projectIdSchema,
  skillIdSchema,
  type SkillPreviewResponse,
} from "@agentgate/protocol";
import { sumBy } from "hanzio";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Ctx, Env } from "../daemon.ts";
import { jsonInput as json } from "../http.ts";
import { changeSkillProjects } from "../operations.ts";
import {
  connectSkillRepo,
  deleteSkill,
  installSkills,
  searchSkills,
  setSkillRepoProjects,
  skillRevision,
  syncSkillRepo,
  updateSkill,
  writeSkillMd,
} from "../skills.ts";
import { SKILL_ID } from "../store.ts";
import { input, inputAsync, required, signal } from "./http.ts";

/** Skills, the GitHub repositories kept in sync for them, and the links that clash in checkouts. */
export function skills(ctx: Ctx) {
  const { s } = ctx;
  const app = new Hono<Env>();
  const skillRequired = (id: string) => {
    const skill = s.get("skill", id);
    required(skill, "skill");
    return skill!;
  };
  const sourceInput = z.object({
    source: z.string().trim().min(1).max(2048),
    skill: z.string().min(1).max(256).optional(),
  });
  app.get("/skills/search", async (c) => {
    const q = z.string().trim().min(2).max(200).parse(c.req.query("q"));
    try {
      return c.json(await searchSkills(q, signal(ctx, c.req.raw)));
    } catch {
      throw new HTTPException(502, { message: "skills.sh search is unavailable; add a skill by its source instead" });
    }
  });
  // GitHub repositories the daemon keeps in sync. Not under /skills/, where a skill could be named "repos".
  const repoInput = z
    .object({ url: z.string().trim().min(1).max(512), projects: z.array(projectIdSchema).max(5000) })
    .strict();
  app.post("/skill-repos", async (c) => {
    const f = repoInput.parse(await json(c.req.raw));
    return c.json(
      { url: await inputAsync(() => connectSkillRepo(s, f.url, f.projects, undefined, signal(ctx, c.req.raw))) },
      201,
    );
  });
  app.put("/skill-repos", async (c) => {
    const f = repoInput.parse(await json(c.req.raw));
    input(() => setSkillRepoProjects(s, f.url, f.projects));
    return c.json({ ok: true });
  });
  app.post("/skill-repos/sync", async (c) => {
    const f = repoInput.pick({ url: true }).parse(await json(c.req.raw));
    return c.json({ updated: await inputAsync(() => syncSkillRepo(s, f.url, undefined, signal(ctx, c.req.raw))) });
  });
  app.post("/skills/fetch", async (c) => {
    const f = sourceInput.strict().parse(await json(c.req.raw));
    try {
      const artifact = await ctx.imports.preview(f.source, f.skill, signal(ctx, c.req.raw));
      const preview: SkillPreviewResponse = {
        token: artifact.token,
        skills: artifact.skills.map((k) => {
          const existing = s.get("skill", k.id);
          return {
            id: k.id,
            description: k.description,
            files: k.files.length,
            size: sumBy(k.files, (file) => decodedSize(file.data)),
            hash: k.hash,
            security: k.security,
            installed: !!existing,
            conflict:
              existing && existing.source !== f.source
                ? `Already exists ${existing.source ? `from ${existing.source}` : "as a handwritten skill"}`
                : undefined,
          };
        }),
      };
      return c.json(preview);
    } catch (error) {
      if (error instanceof SkillConflict) throw error;
      throw new HTTPException(502, { message: error instanceof Error ? error.message : "Could not fetch skills" });
    }
  });
  app.post("/skills", async (c) => {
    const f = z
      .object({
        token: z.string().uuid(),
        ids: z.array(skillIdSchema).min(1).max(100),
        projects: z.array(projectIdSchema).max(5000).default([]),
      })
      .strict()
      .parse(await json(c.req.raw));
    const artifact = ctx.imports.get(f.token);
    return c.json(
      { installed: input(() => installSkills(s, artifact.source, artifact.skills, f.ids, f.projects)) },
      201,
    );
  });
  app.get("/skills/:id", (c) => {
    const skill = s.get("skill", c.req.param("id"));
    required(skill, "skill");
    const md = skill!.files.find((f) => f.path === "SKILL.md");
    return c.json({
      id: skill!.id,
      source: skill!.source,
      revision: skillRevision(s, skill!.id),
      skillMd: md ? Buffer.from(md.data, "base64").toString() : "",
      files: skill!.files.map((f) => ({ path: f.path, size: decodedSize(f.data) })),
    });
  });
  app.put("/skills/:id", async (c) => {
    const id = c.req.param("id");
    if (!SKILL_ID.test(id))
      throw new HTTPException(400, { message: "Skill names use lowercase letters, digits, ., _ and -" });
    const f = z
      .object({ skillMd: z.string().max(1024 * 1024), revision: z.string().max(1024).nullable() })
      .strict()
      .parse(await json(c.req.raw));
    input(() => writeSkillMd(s, id, f.skillMd, f.revision));
    return c.json({ ok: true });
  });
  app.put("/skills/:id/projects", async (c) => {
    skillRequired(c.req.param("id"));
    const f = projectChangeSchema.parse(await json(c.req.raw));
    input(() => changeSkillProjects(s, c.req.param("id"), f));
    return c.json({ ok: true });
  });
  app.post("/skills/:id/update", async (c) => {
    if (!skillRequired(c.req.param("id")).source)
      throw new HTTPException(400, { message: "This skill was written by hand; edit it instead" });
    try {
      return c.json({
        updated: await updateSkill(s, c.req.param("id"), ctx.imports.fetchFresh, signal(ctx, c.req.raw)),
      });
    } catch (error) {
      if (error instanceof SkillConflict) throw error;
      throw new HTTPException(502, { message: error instanceof Error ? error.message : "Update failed" });
    }
  });
  app.post("/skills/conflicts", async (c) => {
    const f = z
      .object({ path: z.string().min(1).max(4096), use: z.enum(["agentgate", "keep"]) })
      .strict()
      .parse(await json(c.req.raw));
    return c.json({ backup: input(() => ctx.skills.resolveConflict(f.path, f.use)) });
  });
  app.delete("/skills/:id", (c) => {
    skillRequired(c.req.param("id"));
    input(() => deleteSkill(s, c.req.param("id")));
    return c.json({ ok: true });
  });
  return app;
}
