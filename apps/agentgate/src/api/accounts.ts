import { failureSchema, loginIdSchema, modelIdSchema, providerSchema } from "@agentgate/protocol";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Ctx, Env } from "../daemon.ts";
import { jsonInput as json } from "../http.ts";
import { providerLogins } from "../llm/providers.ts";
import { route } from "../llm/routing.ts";
import { requestDetail, requests, tokenHours, tokenUsage } from "../llm/telemetry.ts";
import { forgetLogin, infisicalSite, setInfisicalIdentity, shareLogins, startInfisicalSignIn } from "../logins.ts";
import { input, inputAsync, local, optionalJson, required, signal } from "./http.ts";

export const moduleFor = <P extends keyof typeof providerLogins>(provider: P) => providerLogins[provider];

/** The proxy's diagnostics and account checks (account writes are operations, ops/accounts.ts), and the shared gh and Infisical logins. */
export function accounts(ctx: Ctx) {
  const { s } = ctx;
  const app = new Hono<Env>();
  app.get("/requests", (c) => {
    const f = z
      .object({
        provider: providerSchema.optional(),
        account: z.string().max(512).optional(),
        model: modelIdSchema.optional(),
        outcome: z.enum(["pending", "success", "failed", "interrupted", "cancelled"]).optional(),
        failure: failureSchema.optional(),
        search: z.string().max(128).optional(),
        since: z.coerce.number().int().nonnegative().optional(),
        until: z.coerce.number().int().nonnegative().optional(),
        cursor: z
          .string()
          .regex(/^\d{1,16}$/)
          .optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .strict()
      .parse(c.req.query());
    return c.json(input(() => requests(s, f)));
  });
  app.get("/requests/:id", (c) => {
    const result = requestDetail(s, c.req.param("id"));
    required(result, "request");
    return c.json(result!);
  });
  const since = z.object({ since: z.coerce.number().int().nonnegative().optional() }).strict();
  app.get("/proxy/tokens", (c) => c.json(tokenUsage(s, since.parse(c.req.query()).since)));
  app.get("/proxy/tokens/hours", (c) => c.json(tokenHours(s, since.parse(c.req.query()).since)));
  app.get("/proxy/route", (c) => {
    const f = z.object({ provider: providerSchema, model: modelIdSchema.optional() }).strict().parse(c.req.query());
    return c.json(route(s, f.provider, f.model));
  });
  app.post("/accounts/batch", async (c) => {
    const f = z
      .object({
        ids: z.array(z.string().min(1).max(512)).min(1).max(100),
        action: z.enum(["quota", "verify", "enable", "disable", "refresh", "models", "reset-cooldown"]),
      })
      .strict()
      .parse(await json(c.req.raw));
    return c.json(
      await ctx.proxyOperations.batch(
        f.ids,
        f.action,
        AbortSignal.any([signal(ctx, c.req.raw), AbortSignal.timeout(90000)]),
      ),
    );
  });
  app.post("/accounts/:id/verify", async (c) => {
    required(s.get("account", c.req.param("id")), "account");
    const f = z
      .object({ probe: z.boolean().default(false), model: modelIdSchema.optional() })
      .strict()
      .parse(await optionalJson(c.req.raw));
    if (f.probe && !f.model) throw new HTTPException(400, { message: "Choose a model for the quota-consuming probe" });
    return c.json(
      await ctx.proxyOperations.verify(
        c.req.param("id"),
        AbortSignal.any([signal(ctx, c.req.raw), AbortSignal.timeout(90000)]),
        f,
      ),
    );
  });
  // Sharing reads this machine's own gh and Infisical logins, like coding-tool setup: loopback only.
  app.post("/logins/share", async (c) => {
    local(c.env.listener);
    const f = z
      .object({ id: loginIdSchema.optional() })
      .strict()
      .parse(await json(c.req.raw));
    return c.json({ results: await inputAsync(() => shareLogins(s, f.id)) });
  });
  // The browser login answers on this machine's loopback, so it signs in where the app's browser is: loopback only.
  app.post("/logins/infisical/signin", async (c) => {
    local(c.env.listener);
    const url = await inputAsync(() => startInfisicalSignIn(s, ctx.abort.signal));
    // On macOS the Infisical CLI opens the browser itself.
    return c.json({ url, opened: process.platform === "darwin" });
  });
  // Receives a client secret: loopback only.
  app.put("/logins/infisical-identity", async (c) => {
    local(c.env.listener);
    const f = z
      .object({
        clientId: z.string().min(1).max(512),
        clientSecret: z.string().min(1).max(4096),
        siteUrl: z.string().url().max(2048).optional(),
      })
      .strict()
      .parse(await json(c.req.raw));
    await inputAsync(() => setInfisicalIdentity(s, { ...f, siteUrl: f.siteUrl ?? infisicalSite() }));
    return c.json({ ok: true });
  });
  app.delete("/logins/:id", (c) => {
    input(() => forgetLogin(s, loginIdSchema.parse(c.req.param("id"))));
    return c.json({ ok: true });
  });
  return app;
}
