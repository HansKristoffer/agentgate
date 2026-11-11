import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Ctx, Env } from "../daemon.ts";
import { searchSkills, skillDetail } from "../skills.ts";
import { required, signal } from "./http.ts";

/** Reads of skills; their changes are control operations (ops/skills.ts). */
export function skills(ctx: Ctx) {
  const { s } = ctx;
  const app = new Hono<Env>();
  app.get("/skills/search", async (c) => {
    const q = z.string().trim().min(2).max(200).parse(c.req.query("q"));
    try {
      return c.json(await searchSkills(q, signal(ctx, c.req.raw)));
    } catch {
      throw new HTTPException(502, { message: "skills.sh search is unavailable; add a skill by its source instead" });
    }
  });
  app.get("/skills/:id", (c) => {
    const detail = skillDetail(s, c.req.param("id"));
    required(detail, "skill");
    return c.json(detail!);
  });
  return app;
}
