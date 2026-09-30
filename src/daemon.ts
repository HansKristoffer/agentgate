import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { Credentials } from "./credentials.ts";
import { claude } from "./llm/claude.ts";
import { codex } from "./llm/codex.ts";
import { proxy, type Provider } from "./llm/pool.ts";
import { Gateway, aliasesFor } from "./mcp/gateway.ts";
import { PORT, type Store } from "./store.ts";
import { PULL_INTERVAL, peerRoutes, poke, pullAll, tailscale } from "./sync.ts";
import { ui } from "./ui/pages.tsx";

export type Listener = "loopback" | "tailnet";
export type Env = { Bindings: { listener: Listener } };

export interface Ctx {
  s: Store;
  creds: Credentials;
  gateway: Gateway;
}

export const providers: Record<"claude" | "codex", Provider> = { claude, codex };

export function makeCtx(s: Store): Ctx {
  const creds = new Credentials(s, (p, rt) => providers[p].refresh(rt), () => pullAll(s));
  return { s, creds, gateway: new Gateway(s) };
}

export function app(ctx: Ctx) {
  const { s } = ctx;
  const app = new Hono<Env>();
  const loopbackOnly = async (c: any, next: () => Promise<void>) => (c.env.listener === "loopback" ? next() : c.notFound());

  // Loopback needs no token, so a web page must not reach it: reject foreign Host headers (DNS rebinding).
  app.use("*", async (c, next) => {
    const host = c.req.header("host")?.replace(/:\d+$/, "");
    if (c.env.listener === "loopback" && host !== "127.0.0.1" && host !== "localhost") return c.text("forbidden host", 403);
    await next();
  });

  // Each node serves its own clients: the proxy, the MCP endpoint and secrets never go out on the tailnet.
  app.all("/anthropic/*", loopbackOnly, (c) => proxy(s, ctx.creds, claude, c.req.raw, pathAfter(c.req.url, "/anthropic")));
  app.all("/codex/*", loopbackOnly, (c) => proxy(s, ctx.creds, codex, c.req.raw, pathAfter(c.req.url, "/codex")));
  app.all("/mcp", loopbackOnly, (c) => ctx.gateway.handle(c.req.raw));
  app.get("/api/shim", loopbackOnly, (c) => {
    const project = c.req.query("project") || "*";
    const out = Object.entries(aliasesFor(s, project))
      .map(([alias, id]) => ({ alias, instance: s.get("mcp", id) }))
      .filter((x) => x.instance?.mode === "perSession");
    return c.json(out);
  });

  app.route("/peer", peerRoutes(s));

  // The UI and API need the admin token on the tailnet listener; loopback is trusted (PLAN §11).
  app.use("*", async (c, next) => {
    if (c.env.listener === "loopback" || c.req.path === "/login" || c.req.path === "/style.css") return next();
    if (getCookie(c, "agentgate_admin") === s.local("adminToken")) return next();
    return c.req.path.startsWith("/api/") ? c.json({ error: "unauthorized" }, 401) : c.redirect("/login");
  });
  // UI forms only from the UI's own pages (a cross-site POST could otherwise add a stdio MCP = run a command).
  app.use("*", csrf());
  app.route("/", ui(ctx));
  return app;
}

function pathAfter(url: string, prefix: string) {
  const u = new URL(url);
  return u.pathname.slice(prefix.length) + u.search;
}

/** `agentgate serve`: both listeners and the background timers. */
export async function serve(s: Store) {
  const ctx = makeCtx(s);
  const a = app(ctx);
  const listen = (hostname: string, listener: Listener) =>
    Bun.serve({ hostname, port: PORT, idleTimeout: 0, fetch: (req) => a.fetch(req, { listener }) });

  listen("127.0.0.1", "loopback");
  console.log(`agentgate ${s.nodeId}: http://127.0.0.1:${PORT}`);

  // Tailscale may not be up yet at boot; keep trying. Never bind 0.0.0.0.
  const bindTailnet = async () => {
    const ts = await tailscale();
    if (!ts) return setTimeout(bindTailnet, 30_000);
    try {
      listen(ts.ip, "tailnet");
      console.log(`tailnet: ${ts.url}`);
      const self = s.get("node", s.nodeId);
      if (self && self.url !== ts.url) s.put("node", s.nodeId, { ...self, url: ts.url });
    } catch (e) {
      console.error(`tailnet listener: ${e}`);
      setTimeout(bindTailnet, 30_000);
    }
  };
  bindTailnet();

  // Writes can come from this process or from the CLI (same SQLite file), so watch the change feed.
  let lastSeq = s.seq();
  setInterval(() => {
    const seq = s.seq();
    if (seq === lastSeq) return;
    const mcpChanged = s.db.query("select 1 from records where seq > ? and kind in ('mcp', 'project') limit 1").get(lastSeq);
    lastSeq = seq;
    poke(s);
    if (mcpChanged) ctx.gateway.toolsChanged();
  }, 1000);

  const pull = () => pullAll(s).then((errs) => errs.forEach((e) => console.error(e)));
  setInterval(pull, PULL_INTERVAL);
  pull();

  const tick = () => ctx.creds.tick().catch((e) => console.error(`credentials: ${e}`));
  setInterval(tick, 60_000);
  tick();

  setInterval(() => {
    s.trimLog();
    s.purgeTombstones();
  }, 3600_000);
}
