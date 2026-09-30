import { Hono, type MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { Credentials, drainRefresh } from "./credentials.ts";
import { claude } from "./llm/claude.ts";
import { codex } from "./llm/codex.ts";
import { proxy, type Provider } from "./llm/pool.ts";
import { Gateway, aliasesFor } from "./mcp/gateway.ts";
import { expireLogins, tickMcp } from "./mcp/oauth.ts";
import { BodyTooLarge, MAX_BODY, serialTask } from "./runtime.ts";
import { rotateLogs } from "./service.ts";
import { PORT, type Store } from "./store.ts";
import { PULL_INTERVAL, drainPulls, peerRoutes, poke, pullAll, tailscale } from "./sync.ts";
import { ui } from "./ui/pages.tsx";

export type Listener = "loopback" | "tailnet";
export type Env = { Bindings: { listener: Listener } };

export interface Ctx {
  s: Store;
  creds: Credentials;
  gateway: Gateway;
  abort: AbortController;
  pending: Set<Promise<void>>;
}

export const providers: Record<"claude" | "codex", Provider> = { claude, codex };

export function makeCtx(s: Store): Ctx {
  const creds = new Credentials(s, (p, rt) => providers[p].refresh(rt), () => pullAll(s));
  return { s, creds, gateway: new Gateway(s), abort: new AbortController(), pending: new Set() };
}

export function app(ctx: Ctx) {
  const { s } = ctx;
  const app = new Hono<Env>();
  const loopbackOnly: MiddlewareHandler<Env> = async (c, next) => (c.env.listener === "loopback" ? next() : c.notFound());

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof ZodError) return c.json({ error: "invalid input", issues: error.issues.map(i => ({ path: i.path, message: i.message })) }, 400);
    if (error instanceof BodyTooLarge) return c.json({ error: error.message }, 413);
    console.error(`request failed: ${error.name}`);
    return c.json({ error: "request failed" }, 500);
  });
  app.use("*", async (_, next) => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; }); ctx.pending.add(pending);
    try { await next(); } finally { finish(); ctx.pending.delete(pending); }
  });
  const cancellable = (req: Request) => new Request(req, { signal: AbortSignal.any([req.signal, ctx.abort.signal]) });
  // Loopback needs no token, so a web page must not reach it: reject foreign Host headers (DNS rebinding).
  app.use("*", async (c, next) => {
    const host = c.req.header("host")?.replace(/:\d+$/, "");
    if (c.env.listener === "loopback" && host !== "127.0.0.1" && host !== "localhost") return c.text("forbidden host", 403);
    await next();
  });

  // Each node serves its own clients: the proxy, the MCP endpoint and secrets never go out on the tailnet.
  app.all("/anthropic/*", loopbackOnly, (c) => proxy(s, ctx.creds, claude, cancellable(c.req.raw), pathAfter(c.req.url, "/anthropic")));
  app.all("/codex/*", loopbackOnly, (c) => proxy(s, ctx.creds, codex, cancellable(c.req.raw), pathAfter(c.req.url, "/codex")));
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
    if (c.env.listener === "loopback" || c.req.path === "/login" || c.req.path === "/style.css" || c.req.path === "/oauth/callback") return next();
    if (s.local("adminToken") && getCookie(c, "agentgate_admin") === s.local("adminToken")) return next();
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
export async function serve(s: Store, options: { port?: number; discover?: typeof tailscale } = {}) {
  const ctx = makeCtx(s);
  const a = app(ctx);
  let stopped = false;
  const timers: ReturnType<typeof setInterval>[] = [];
  const jobs = new Set<Promise<unknown>>();
  const listen = (hostname: string, listener: Listener, port: number) =>
    Bun.serve({ hostname, port, idleTimeout: 0, maxRequestBodySize: MAX_BODY, fetch: req => a.fetch(req, { listener }) });
  const loopback = listen("127.0.0.1", "loopback", options.port ?? PORT);
  let tailnet: ReturnType<typeof listen> | undefined;
  let address: string | undefined;
  console.log(`agentgate ${s.nodeId}: http://127.0.0.1:${loopback.port}`);
  const schedule = (task: () => Promise<unknown>, interval: number) => {
    const serial = serialTask(async () => { if (!stopped) await task(); });
    const run = () => { if (stopped) return; const job = serial().catch(e => console.error(`background task: ${e?.name ?? "failed"}`)); jobs.add(job); void job.finally(() => jobs.delete(job)); };
    timers.push(setInterval(run, interval)); run();
  };
  // Discover again after address changes or Tailscale restarts. Never bind a public interface.
  schedule(async () => {
    const ts = await (options.discover ?? tailscale)();
    if (stopped) return;
    if (ts?.ip === address && tailnet) return;
    if (tailnet) { tailnet.stop(true); tailnet = undefined; }
    address = undefined;
    if (!ts) return;
    tailnet = listen(ts.ip, "tailnet", loopback.port!); address = ts.ip;
    const self = s.get("node", s.nodeId);
    if (self && self.url !== ts.url) s.put("node", s.nodeId, { ...self, url: ts.url });
  }, 30000);
  let lastSeq = s.seq();
  schedule(async () => {
    const snapshot = s.changes(lastSeq);
    if (snapshot.seq === lastSeq) return;
    lastSeq = snapshot.seq; poke(s);
    if (snapshot.records.some(r => ["mcp", "mcpCredential", "project"].includes(r.kind))) ctx.gateway.toolsChanged();
  }, 1000);
  schedule(() => pullAll(s), PULL_INTERVAL);
  schedule(async () => { await ctx.creds.tick(ctx.abort.signal); await tickMcp(s, ctx.abort.signal); }, 60000);
  schedule(async () => { s.trimLog(); expireLogins(s); rotateLogs(); }, 3600000);
  let stopping: Promise<void> | undefined;
  return {
    ctx, loopback, stop: () => stopping ??= (async () => {
      stopped = true; ctx.abort.abort(); timers.forEach(clearInterval);
      // Abort active streams and MCP sessions; finite background requests finish before the store closes.
      loopback.stop(true); tailnet?.stop(true);
      await ctx.gateway.close();
      await Promise.allSettled([...jobs, ...ctx.pending]); await drainRefresh(s); await drainPulls(s);
    })()
  };
}
