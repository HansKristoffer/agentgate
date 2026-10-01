import {
  API_VERSION,
  accountSchema,
  projectSchema,
  providerSchema,
  settingsSchema,
  type Status,
  type ToolPreview,
} from "@agentgate/protocol";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { homedir } from "node:os";
import { z } from "zod";
import { pkce } from "./credentials.ts";
import type { Ctx, Env } from "./daemon.ts";
import * as claude from "./llm/claude.ts";
import * as codex from "./llm/codex.ts";
import { accountStatus } from "./llm/pool.ts";
import {
  aliasesFor,
  connect,
  listAllTools,
  needsLogin,
  renameInstance,
  scanRepos,
  toolName,
} from "./mcp/gateway.ts";
import { finishLogin, startLogin } from "./mcp/oauth.ts";
import { presets } from "./mcp/templates.ts";
import {
  createInstance,
  deleteAccount,
  deleteInstance,
  saveProject,
  setAccount,
} from "./operations.ts";
import { readBody, MAX_BODY } from "./runtime.ts";
import { exportBackup, importBackup } from "./store.ts";
import { join, lastSeen, pairCode, peers, tailscale, unpair } from "./sync.ts";

const required = (value: unknown, name: string) => {
  if (!value) throw new HTTPException(404, { message: `No such ${name}` });
};
const moduleFor = (provider: "claude" | "codex") =>
  provider === "claude" ? claude : codex;
const readableEndpoint = (url?: string) => {
  if (!url) return "Local command";
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "HTTP server";
  }
};

/** JSON control plane. Provider/MCP credentials never appear in its status response. */
export function management(ctx: Ctx) {
  const { s } = ctx;
  const app = new Hono<Env>();
  const pending = new Map<
    string,
    {
      provider: "claude" | "codex";
      verifier: string;
      label?: string;
      at: number;
    }
  >();
  const json = async (req: Request) => {
    if (
      req.headers.get("content-type")?.split(";")[0]?.trim() !==
      "application/json"
    )
      throw new HTTPException(415, { message: "Send application/json" });
    try {
      return JSON.parse(
        new TextDecoder().decode(
          await readBody(req.body, MAX_BODY, req.signal),
        ),
      );
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new HTTPException(400, { message: "Invalid JSON" });
      throw error;
    }
  };
  const local = (listener: string) => {
    if (listener !== "loopback")
      throw new HTTPException(403, {
        message: "This operation requires a local connection",
      });
  };
  const tools = async (id: string) => {
    const inst = s.get("mcp", id);
    required(inst, "server");
    const client = await connect(inst!, process.cwd(), s);
    try {
      return await listAllTools(client);
    } finally {
      await client.close();
    }
  };
  // Operational input errors are safe to show to a signed-in administrator.
  const input = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof HTTPException)
        throw error;
      throw new HTTPException(400, {
        message: error instanceof Error ? error.message : "Invalid operation",
      });
    }
  };
  app.get("/status", (c) => {
    const status: Status = {
      apiVersion: API_VERSION,
      node: s.nodeId,
      accounts: s.list("account").map((a) => accountStatus(s, a)),
      servers: s.list("mcp").map((i) => ({
        id: i.id,
        template: i.template,
        transport: i.transport,
        mode: i.mode,
        endpoint: readableEndpoint(i.url),
        loggedIn: !!s.get("mcpCredential", i.id)?.tokens,
        needsLogin: !!s.get("mcpCredential", i.id)?.needsLogin,
        refreshError: s.local(`refreshError:mcpCredential:${i.id}`)
          ? "Token refresh failed"
          : undefined,
      })),
      projects: s.list("project"),
      settings: s.settings(),
      nodes: s.list("node").map((n) => ({
        ...n,
        lastSeen: lastSeen(s, n.id),
        online: n.id === s.nodeId || s.now() - lastSeen(s, n.id) < 60_000,
        syncError: s.local(`syncError:${n.id}`) ? "Sync failed" : undefined,
      })),
      peers: peers(s).map((p) => ({
        node: p.node,
        url: p.url,
        lastSeen: p.last_seen ?? 0,
        cursor: p.cursor,
        error: s.local(`syncError:${p.node}`) ? "Sync failed" : undefined,
      })),
      unknownQuota: Object.fromEntries(
        (["claude", "codex"] as const).map((p) => [
          p,
          s.local(`quotaUnknown:${p}`),
        ]),
      ),
      activity: s.db
        .query(
          "select at, provider, account, model, status, ms, note from request_log order by at desc limit 50",
        )
        .all() as Status["activity"],
    };
    return c.json(status);
  });
  app.patch("/accounts/:id", async (c) => {
    required(s.get("account", c.req.param("id")), "account");
    const patch = accountSchema
      .pick({ label: true, enabled: true, priority: true, pinned: true })
      .partial()
      .strict()
      .parse(await json(c.req.raw));
    return c.json(input(() => setAccount(s, c.req.param("id"), patch)));
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
      id: await moduleFor(f.provider).importFrom(
        s,
        f.dir.replace(/^~/, homedir()),
        f.label,
      ),
    });
  });
  app.post("/accounts/login", async (c) => {
    const f = z
      .object({ provider: providerSchema, label: z.string().optional() })
      .parse(await json(c.req.raw));
    for (const [state, p] of pending)
      if (s.now() - p.at > 30 * 60_000) pending.delete(state);
    if (pending.size >= 128)
      throw new HTTPException(429, { message: "Too many pending logins" });
    const { verifier, challenge, state } = await pkce();
    pending.set(state, { ...f, verifier, at: s.now() });
    return c.json({
      state,
      provider: f.provider,
      url: moduleFor(f.provider).authorizeUrl(challenge, state),
    });
  });
  app.post("/accounts/login/finish", async (c) => {
    const f = z
      .object({ state: z.string().min(1), code: z.string().min(1) })
      .parse(await json(c.req.raw));
    const p = pending.get(f.state);
    pending.delete(f.state);
    if (!p || s.now() - p.at > 30 * 60_000)
      throw new HTTPException(400, {
        message: "That login expired; start again",
      });
    return c.json({
      id: await moduleFor(p.provider).exchange(
        s,
        f.code,
        p.verifier,
        p.label,
        f.state,
      ),
    });
  });
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
    const inst = input(() => createInstance(s, f));
    return c.json({ id: inst.id }, 201);
  });
  app.post("/servers/:id/rename", async (c) => {
    const f = z.object({ id: z.string().min(1) }).parse(await json(c.req.raw));
    input(() => renameInstance(s, c.req.param("id"), f.id));
    return c.json({ ok: true });
  });
  app.post("/servers/:id/test", async (c) => {
    try {
      return c.json({ tools: await tools(c.req.param("id")) });
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
    const url = await startLogin(
      s,
      c.req.param("id"),
      `${new URL(c.req.url).origin}/oauth/callback`,
    );
    return c.json({ url: url?.href, ok: !url });
  });
  app.delete("/servers/:id", (c) => {
    required(s.get("mcp", c.req.param("id")), "server");
    deleteInstance(s, c.req.param("id"));
    return c.json({ ok: true });
  });
  app.put("/projects", async (c) => {
    const f = projectSchema
      .pick({ id: true, mcp: true, inheritDefaults: true })
      .parse(await json(c.req.raw));
    return c.json(input(() => saveProject(s, f.id, f)));
  });
  app.delete("/projects", (c) => {
    const id = z.string().min(1).parse(c.req.query("id"));
    s.del("project", id);
    return c.json({ ok: true });
  });
  app.post("/projects/scan", async (c) => {
    local(c.env.listener);
    const { dir } = z
      .object({ dir: z.string().min(1) })
      .parse(await json(c.req.raw));
    return c.json({
      repos: input(() => scanRepos(dir.replace(/^~/, homedir()))),
    });
  });
  app.get("/projects/tools", async (c) => {
    const result: ToolPreview[] = [];
    for (const [alias, id] of Object.entries(
      aliasesFor(s, c.req.query("id") ?? "*"),
    )) {
      const inst = s.get("mcp", id);
      if (inst?.mode === "perSession")
        result.push({
          name: `${alias}__*`,
          description: "Starts inside each session's worktree",
        });
      else
        try {
          for (const t of await tools(id))
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
  app.post("/nodes/pair", async (c) => {
    const url = s.get("node", s.nodeId)?.url ?? (await tailscale())?.url;
    if (!url)
      throw new HTTPException(409, {
        message: "Start Tailscale before pairing",
      });
    return c.json({
      command: `agentgate join ${url} ${pairCode(s)}`,
      expiresIn: 600,
    });
  });
  app.post("/nodes/join", async (c) => {
    const f = z
      .object({ url: z.url(), code: z.string().min(1) })
      .parse(await json(c.req.raw));
    const self = s.get("node", s.nodeId)?.url ?? (await tailscale())?.url;
    if (!self)
      throw new HTTPException(409, {
        message: "Start Tailscale before pairing",
      });
    return c.json({ node: await join(s, f.url, f.code, self) });
  });
  app.patch("/nodes/:id", async (c) => {
    const f = z
      .object({ alwaysOn: z.boolean() })
      .strict()
      .parse(await json(c.req.raw));
    const n = s.get("node", c.req.param("id"));
    required(n, "node");
    return c.json(s.put("node", n!.id, { ...n!, ...f }));
  });
  app.delete("/nodes/:id", (c) => {
    input(() => unpair(s, c.req.param("id")));
    return c.json({ ok: true });
  });
  app.put("/settings", async (c) =>
    c.json(
      s.put(
        "setting",
        "settings",
        settingsSchema.strict().parse(await json(c.req.raw)),
      ),
    ),
  );
  app.get("/backup", (c) => {
    local(c.env.listener);
    return c.json(exportBackup(s, c.req.query("secrets") === "true"));
  });
  app.post("/backup", async (c) => {
    local(c.env.listener);
    const backup = await json(c.req.raw);
    return c.json({ restored: input(() => importBackup(s, backup)) });
  });
  return app;
}

/** Browser-only OAuth landing response, also used by headless CLI MCP logins. */
export function oauthCallback(ctx: Ctx) {
  return async (c: import("hono").Context<Env>) => {
    c.header("Cache-Control", "no-store");
    const { code, state, error } = c.req.query();
    if (error || !code || !state)
      return c.text("Login failed. Return to Agentgate and start again.", 400);
    try {
      await finishLogin(ctx.s, state, code);
      return c.text(
        "Logged in. You can close this window and return to Agentgate.",
      );
    } catch {
      return c.text(
        "Login failed or expired. Return to Agentgate and start again.",
        400,
      );
    }
  };
}
