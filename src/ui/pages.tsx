/** @jsxImportSource hono/jsx */
import { Hono, type Context } from "hono";
import { setCookie } from "hono/cookie";
import type { Child } from "hono/jsx";
import { homedir } from "node:os";
import { z } from "zod";
import { pkce } from "../credentials.ts";
import type { Ctx, Env } from "../daemon.ts";
import * as claudeLogin from "../llm/claude.ts";
import * as codexLogin from "../llm/codex.ts";
import { connect, listAllTools, needsLogin, renameInstance } from "../mcp/gateway.ts";
import { finishLogin, startLogin } from "../mcp/oauth.ts";
import { freeId, preset } from "../mcp/templates.ts";
import { createInstance, deleteAccount, deleteInstance, saveProject, setAccount } from "../operations.ts";
import { setup } from "../setup.ts";
import { importBackup, schemas, type Account } from "../store.ts";
import { pairCode, unpair } from "../sync.ts";

import { Layout, Panel } from "./components.tsx";
import { registerViews } from "./views.tsx";

export function ui(ctx: Ctx) {
  const { s } = ctx;
  const pending = new Map<string, { provider: "claude" | "codex"; verifier: string; label?: string; at: number }>();
  const app = new Hono<Env>();
  const back = (c: Context<Env>, path: string, msg: string) => c.redirect(`${path}?msg=${encodeURIComponent(msg)}`);
  const page = (c: Context<Env>, path: string, body: Child, head?: { title: string; lede?: string }) =>
    c.html(<Layout path={path} s={s} msg={c.req.query("msg")} head={head}>{body}</Layout>);
  const form = async (c: Context<Env>): Promise<Record<string, string>> => {
    const body = await c.req.parseBody();
    return z.record(z.string(), z.string()).parse(body);
  };

  registerViews(app, ctx, page);

  app.post("/login", async (c) => {
    const { token } = await form(c);
    if (!token || token !== s.local("adminToken")) return back(c, "/login", "Wrong token");
    setCookie(c, "agentgate_admin", token, { httpOnly: true, sameSite: "Strict", path: "/", maxAge: 30 * 86400 });
    return c.redirect("/");
  });

  // ---- Dashboard

  // ---- Accounts

  app.post("/accounts/:id/:action{enable|disable|pin|unpin|rm|priority}", async (c) => {
    const id = c.req.param("id");
    const a = s.get("account", id);
    if (!a) return back(c, "/accounts", "No such account");
    const action = c.req.param("action");
    if (action === "rm") {
      deleteAccount(s, id);
      return back(c, "/accounts", `Deleted ${a.label}`);
    }
    const patch: Partial<Account> =
      action === "enable" ? { enabled: true } : action === "disable" ? { enabled: false } : action === "pin" ? { pinned: true } : action === "unpin" ? { pinned: false } : action === "priority" ? { priority: Number((await form(c)).priority) } : {};
    setAccount(s, id, patch);
    return c.redirect("/accounts");
  });

  app.post("/accounts/import", async (c) => {
    const f = await form(c);
    const dir = z.string().min(1).parse(f.dir).replace(/^~/, process.env.HOME ?? "~");
    try {
      const id = await (f.provider === "claude" ? claudeLogin.importFrom(s, dir, f.label || undefined) : codexLogin.importFrom(s, dir, f.label || undefined));
      return back(c, "/accounts", `Imported ${id}`);
    } catch (e) {
      return back(c, "/accounts", String(e));
    }
  });

  // Native OAuth (PKCE). The provider shows a code (Claude) or redirects to a localhost URL (Codex); the user pastes it here.
  app.post("/accounts/login", async (c) => {
    const f = await form(c);
    const provider = z.enum(["codex", "claude"]).parse(f.provider);
    const { verifier, challenge, state } = await pkce();
    for (const [k, v] of pending) if (s.now() - v.at > 30 * 60_000) pending.delete(k);
    if (pending.size >= 128) return back(c, "/accounts", "Too many pending logins; wait for old logins to expire");
    pending.set(state, { provider, verifier, label: f.label || undefined, at: s.now() });
    const url = provider === "claude" ? claudeLogin.authorizeUrl(challenge, state) : codexLogin.authorizeUrl(challenge, state);
    return page(c, "/accounts", (
      <Panel cls="narrow">
        <ol class="steps">
          <li>
            <b>Sign in</b>
            <p>Open the login page and sign in with the account you want to add.</p>
            <a class="btn primary" href={url} target="_blank" rel="noreferrer">Open {provider === "claude" ? "Claude" : "ChatGPT"} login ↗</a>
          </li>
          <li>
            <b>Copy the result</b>
            <p>{provider === "claude"
              ? "At the end the page shows a code. Copy it."
              : "The browser ends on a localhost:1455 page that doesn't load. Copy that page's full address from the address bar."}</p>
          </li>
          <li>
            <b>Paste it here</b>
            <form method="post" action="/accounts/login/finish" class="row">
              <input type="hidden" name="state" value={state} />
              <input name="code" autofocus class="mono grow" placeholder={provider === "claude" ? "code#state" : "http://localhost:1455/auth/callback?code=…"} />
              <button class="btn primary">Finish</button>
            </form>
          </li>
        </ol>
      </Panel>
    ), { title: `Add a ${provider === "claude" ? "Claude" : "Codex"} account`, lede: "Three steps. The login stays with agentgate; your own CLI login is not touched." });
  });

  app.post("/accounts/login/finish", async (c) => {
    const f = await form(c);
    const p = pending.get(f.state!);
    if (!p || s.now() - p.at > 30 * 60_000) { pending.delete(f.state!); return back(c, "/accounts", "That login expired; start again"); }
    pending.delete(f.state!);
    try {
      const id = await (p.provider === "claude" ? claudeLogin.exchange(s, f.code!, p.verifier, p.label, f.state) : codexLogin.exchange(s, f.code!, p.verifier, p.label, f.state));
      return back(c, "/accounts", `Logged in ${s.get("account", id)?.label ?? id}`);
    } catch (e) {
      return back(c, "/accounts", `Login failed: ${e}`);
    }
  });

  // ---- MCP servers

  const callbackUrl = (c: Context<Env>) => `${new URL(c.req.url).origin}/oauth/callback`;

  async function tryTools(id: string) {
    const client = await connect(s.get("mcp", id)!, process.cwd(), s);
    try { return await listAllTools(client); } finally { await client.close(); }
  }

  /** Connect; when the server wants a login, send the browser to its login page. */
  async function connectOrLogin(c: Context<Env>, id: string, forceLogin = false) {
    const inst = s.get("mcp", id)!;
    try {
      if (inst.url && forceLogin) throw new Error("401 login requested");
      const tools = await tryTools(id);
      return back(c, "/servers", `Connected ${id}: ${tools.length} tools`);
    } catch (e) {
      if (!inst.url || !needsLogin(e)) return back(c, "/servers", `${id}: ${e}`);
      try {
        const url = await startLogin(s, id, callbackUrl(c));
        if (url) return c.redirect(url.href);
        return back(c, "/servers", `Connected ${id}: ${(await tryTools(id)).length} tools`);
      } catch (e2) {
        return back(c, "/servers", `${id} needs a login, but it could not be started: ${e2}. If the server takes an API key, add it under Extra headers.`);
      }
    }
  }

  app.post("/servers/add", async (c) => {
    const f = await form(c);
    try {
      const p = f.preset ? preset(f.preset) : undefined;
      if (f.preset && !p) throw new Error(`unknown preset ${f.preset}`);
      const id = f.id?.trim() || (p ? freeId((x) => !!s.get("mcp", x), p.id) : "");
      const inst = createInstance(s, { id, target: f.preset || f.url, command: f.command, perSession: !!f.perSession, headers: f.headers });
      if (inst.mode === "perSession") return back(c, "/servers", `Added ${id}; it starts inside each session.`);
      return connectOrLogin(c, id);
    } catch (e) {
      return back(c, "/servers", String(e));
    }
  });

  app.post("/servers/:id/rename", async (c) => {
    const to = (await form(c)).id?.trim() ?? "";
    try {
      renameInstance(s, c.req.param("id"), to);
      return back(c, "/servers", `Renamed to ${to}; its tools are now ${to}__…`);
    } catch (e) {
      return back(c, "/servers", String(e));
    }
  });

  app.post("/servers/:id/login", (c) => (s.get("mcp", c.req.param("id")) ? connectOrLogin(c, c.req.param("id"), true) : back(c, "/servers", "No such server")));

  app.get("/oauth/callback", async (c) => {
    const { code, state, error, error_description } = c.req.query();
    if (error || !code || !state) return back(c, "/servers", `Login failed: ${error_description ?? error ?? "no code returned"}`);
    try {
      const id = await finishLogin(s, state, code);
      const tools = await tryTools(id).catch(() => undefined);
      return back(c, "/servers", `Logged in to ${id}${tools ? `: ${tools.length} tools` : ""}`);
    } catch (e) {
      return back(c, "/servers", `Login failed: ${e}`);
    }
  });

  app.post("/servers/:id/test", async (c) => {
    const id = c.req.param("id");
    if (!s.get("mcp", id)) return back(c, "/servers", "No such server");
    try {
      const tools = await tryTools(id);
      return back(c, "/servers", `${id}: ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
    } catch (e) {
      return back(c, "/servers", `${id}: ${needsLogin(e) ? "needs a login (click Log in)" : e}`);
    }
  });

  app.post("/servers/:id/rm", (c) => {
    const id = c.req.param("id");
    deleteInstance(s, id);
    return back(c, "/servers", `Deleted ${id}`);
  });

  // ---- Projects

  const formAll = async (c: Context<Env>) => {
    const body = await c.req.parseBody({ all: true });
    return z.record(z.string(), z.union([z.string(), z.array(z.string())])).parse(body);
  };
  const many = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

  app.post("/projects/scan-dir", async (c) => {
    const dir = (await form(c)).dir?.trim().replace(/^~/, homedir());
    if (dir) s.setLocal("scanDir", dir);
    return c.redirect("/projects");
  });

  app.post("/projects/add", async (c) => {
    const repos = many((await formAll(c)).repo).map((r) => r.trim()).filter((r) => /^[^/\s]+\/[^/\s]+$/.test(r));
    for (const id of repos) if (!s.get("project", id)) s.put("project", id, { id });
    return back(c, "/projects", repos.length ? `Added ${repos.length} project${repos.length === 1 ? "" : "s"}; pick their servers below.` : "Nothing selected");
  });

  /** Checked servers are mapped under their own name; a custom prefix on a server that stays checked is kept. */
  app.post("/projects/servers", async (c) => {
    const id = c.req.query("project")!;
    const selected = new Set(many((await formAll(c)).server));
    const p = s.get("project", id) ?? schemas.project.parse({ id });
    const mcp = Object.fromEntries(Object.entries(p.mcp).filter(([, inst]) => selected.has(inst) || !s.get("mcp", inst)));
    for (const inst of selected) if (!Object.values(mcp).includes(inst)) mcp[inst] = inst;
    saveProject(s, id, { mcp });
    return c.redirect("/projects");
  });

  app.post("/projects/alias", async (c) => {
    const f = await form(c);
    const id = c.req.query("project") ?? f.project!;
    const p = s.get("project", id) ?? schemas.project.parse({ id });
    const mcp = { ...p.mcp };
    if (f.instance) mcp[f.alias!] = f.instance;
    else delete mcp[f.alias!];
    saveProject(s, id, { mcp });
    return c.redirect(c.req.query("back") === "/servers" ? "/servers" : "/projects");
  });
  app.post("/projects/inherit", (c) => {
    const id = c.req.query("project")!;
    const p = s.get("project", id) ?? schemas.project.parse({ id });
    saveProject(s, id, { inheritDefaults: !p.inheritDefaults });
    return c.redirect("/projects");
  });
  app.post("/projects/rm", (c) => {
    s.del("project", c.req.query("project")!);
    return c.redirect("/projects");
  });

  // ---- Nodes

  app.post("/nodes/pair", (c) => c.redirect(`/nodes?code=${pairCode(s)}`));
  app.post("/nodes/:id/unpair", (c) => {
    unpair(s, c.req.param("id"));
    return back(c, "/nodes", `Unpaired ${c.req.param("id")}`);
  });
  app.post("/nodes/:id/always-on", (c) => {
    const n = s.get("node", c.req.param("id"));
    if (n) s.put("node", n.id, { ...n, alwaysOn: !n.alwaysOn });
    return c.redirect("/nodes");
  });
  app.post("/nodes/setup", async (c) =>
    page(c, "/nodes", <Panel><pre class="mono output">{await setup()}</pre></Panel>, { title: "Setup done", lede: "Paste these settings into T3 Code." }));

  // ---- Settings

  app.post("/settings", async (c) => {
    const f = await form(c);
    s.put("setting", "settings", { threshold: Number(f.threshold), whenExhausted: z.enum(["fail", "wait"]).parse(f.whenExhausted), retryLimit: Number(f.retryLimit), logRetention: Number(f.logRetention) });
    return back(c, "/settings", "Saved");
  });

  app.post("/settings/import", async (c) => {
    const f = (await c.req.parseBody()).file;
    if (!(f instanceof File)) return back(c, "/settings", "Choose a backup file");
    try {
      return back(c, "/settings", `Restored ${importBackup(s, JSON.parse(await f.text()))} records`);
    } catch (e) {
      return back(c, "/settings", `Restore failed: ${e}`);
    }
  });

  return app;
}
