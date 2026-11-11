import { Hono } from "hono";
import { accounts } from "./api/accounts.ts";
import { desktopRoutes } from "./api/desktop.ts";
import { ops } from "./api/ops.ts";
import { projects } from "./api/projects.ts";
import { servers } from "./api/servers.ts";
import { skills } from "./api/skills.ts";
import { system } from "./api/system.ts";
import { t3 } from "./api/t3.ts";
import type { Ctx, Env } from "./daemon.ts";
import { serverTools } from "./mcp/gateway.ts";
import { finishLogin } from "./mcp/oauth.ts";

/** JSON control plane, one sub-app per family in api/. Provider/MCP credentials never appear in its status response. */
export function management(ctx: Ctx) {
  return (
    new Hono<Env>()
      .route("/", system(ctx))
      .route("/", accounts(ctx))
      .route("/", servers(ctx))
      .route("/", skills(ctx))
      .route("/", projects(ctx))
      .route("/", t3(ctx))
      .route("/", desktopRoutes(ctx))
      .route("/", ops(ctx))
      // The board and every factory operation (factory/runtime.ts).
      .route("/factory", ctx.factory.api)
  );
}

/** Browser-only OAuth landing response, also used by headless CLI MCP logins. */
export function oauthCallback(ctx: Ctx) {
  return async (c: import("hono").Context<Env>) => {
    c.header("Cache-Control", "no-store");
    const { code, state, error, iss } = c.req.query();
    if (error || !code || !state) return c.text("Login failed. Return to Agentgate and start again.", 400);
    try {
      const inst = ctx.s.get("mcp", await finishLogin(ctx.s, state, code, iss));
      // Connect once signed in, so the server shows as available without a test; in the background, so this page
      // answers at once, and tracked, so the daemon stops after it.
      if (inst) {
        const check = serverTools(ctx.s, inst).then(
          () => {},
          () => {},
        );
        ctx.pending.add(check);
        void check.finally(() => ctx.pending.delete(check));
      }
      return c.text("Logged in. You can close this window and return to Agentgate.");
    } catch {
      return c.text("Login failed or expired. Return to Agentgate and start again.", 400);
    }
  };
}
