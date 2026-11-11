import {
  ConfigurationConflict,
  accountPatchSchema,
  failureSchema,
  loginIdSchema,
  modelIdSchema,
  providerSchema,
} from "@agentgate/protocol";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { homedir } from "node:os";
import { z } from "zod";
import { checkRevision } from "../configuration.ts";
import { pkce } from "../credentials.ts";
import type { Ctx, Env } from "../daemon.ts";
import { jsonInput as json } from "../http.ts";
import * as cursor from "../llm/cursor.ts";
import { providerLogins } from "../llm/providers.ts";
import { route } from "../llm/routing.ts";
import { metrics, requestDetail, requests, tokenHours, tokenUsage } from "../llm/telemetry.ts";
import { forgetLogin, infisicalSite, setInfisicalIdentity, shareLogins, startInfisicalSignIn } from "../logins.ts";
import { deleteAccount, setAccount } from "../operations.ts";
import { input, inputAsync, local, optionalJson, required, signal } from "./http.ts";

export const moduleFor = <P extends keyof typeof providerLogins>(provider: P) => providerLogins[provider];

/** Pooled accounts and their logins, the proxy's diagnostics, and the shared gh and Infisical logins. */
export function accounts(ctx: Ctx) {
  const { s } = ctx;
  const app = new Hono<Env>();
  const pending = new Map<
    string,
    {
      provider: z.infer<typeof providerSchema>;
      verifier: string;
      label?: string;
      at: number;
    }
  >();
  app.patch("/accounts/:id", async (c) => {
    required(s.get("account", c.req.param("id")), "account");
    const patch = accountPatchSchema
      .extend({ revision: z.string().length(64).optional() })
      .strict()
      .parse(await json(c.req.raw));
    const { revision: expected, ...fields } = patch;
    if ((fields.label !== undefined || fields.priority !== undefined || fields.policy !== undefined) && !expected)
      throw new ConfigurationConflict();
    return c.json(
      input(() =>
        s.transaction(() => {
          if (expected) checkRevision(s, "account", c.req.param("id"), expected);
          return setAccount(s, c.req.param("id"), fields);
        }),
      ),
    );
  });
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
  app.get("/proxy/metrics", (c) => c.json(metrics(s)));
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
  app.delete("/accounts/:id", (c) => {
    required(s.get("account", c.req.param("id")), "account");
    deleteAccount(s, c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/accounts/import", async (c) => {
    local(c.env.listener);
    const f = z
      .object({
        provider: providerSchema,
        dir: z.string().min(1),
        label: z.string().optional(),
      })
      .parse(await json(c.req.raw));
    return c.json({
      id: await moduleFor(f.provider).importFrom(s, f.dir.replace(/^~/, homedir()), f.label),
    });
  });
  app.post("/accounts/login", async (c) => {
    const f = z
      .object({ provider: providerSchema, label: z.string().optional(), email: z.email().optional() })
      .parse(await json(c.req.raw));
    for (const [state, p] of pending) if (s.now() - p.at > 30 * 60_000) pending.delete(state);
    if (pending.size >= 128) throw new HTTPException(429, { message: "Too many pending logins" });
    const { verifier, challenge, state: oauthState } = await pkce();
    // Cursor names the attempt with a UUID that it polls on, rather than an OAuth state.
    const state = f.provider === "cursor" ? crypto.randomUUID() : oauthState;
    pending.set(state, { provider: f.provider, label: f.label, verifier, at: s.now() });
    return c.json({
      state,
      provider: f.provider,
      url: moduleFor(f.provider).authorizeUrl(challenge, state, f.email),
    });
  });
  app.delete("/accounts/login/:state", (c) => {
    pending.delete(c.req.param("state"));
    return c.json({ ok: true });
  });
  app.post("/accounts/login/finish", async (c) => {
    const f = z.object({ state: z.string().min(1), code: z.string().min(1).optional() }).parse(await json(c.req.raw));
    const p = pending.get(f.state);
    if (!p || s.now() - p.at > 30 * 60_000) {
      pending.delete(f.state);
      throw new HTTPException(400, {
        message: "That login expired; start again",
      });
    }
    // Cursor has no code to paste: wait for the browser sign-in, and answer `pending` before the client's request times out.
    if (p.provider === "cursor") {
      const id = await cursor.finish(s, f.state, p.verifier, p.label, signal(ctx, c.req.raw));
      if (id) pending.delete(f.state);
      return c.json(id ? { id } : { pending: true });
    }
    pending.delete(f.state);
    if (!f.code) throw new HTTPException(400, { message: "Paste the code shown after signing in" });
    return c.json({
      id: await moduleFor(p.provider).exchange(s, f.code, p.verifier, p.label, f.state),
    });
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
