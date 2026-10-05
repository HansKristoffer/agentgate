import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { Credentials, drainRefresh } from "./credentials.ts";
import { proxy } from "./llm/pool.ts";
import { providers } from "./llm/providers.ts";
import { Quotas } from "./llm/quota.ts";
import { ProxyOperations } from "./llm/operations.ts";
import { Gateway, aliasesFor } from "./mcp/gateway.ts";
import { expireLogins, tickMcp } from "./mcp/oauth.ts";
import { BodyTooLarge, MAX_BODY, serialTask } from "./runtime.ts";
import { pollDesktopLogin } from "./desktop.ts";
import { rotateLogs } from "./service.ts";
import { PORT, type Store } from "./store.ts";
import { PULL_INTERVAL, drainPulls, peerRoutes, poke, pullAll, tailscale } from "./sync.ts";
import { management, oauthCallback } from "./api.ts";
import { SkillLinks, syncSkillRepos, updateSkills } from "./skills.ts";
import { z } from "zod";
import { projectIdSchema, SkillConflict, ConfigurationConflict } from "@agentgate/protocol";
import { jsonInput } from "./http.ts";
import { SkillImports } from "./skill-import.ts";
import { relaySync, stopRelay, syncAll } from "./relay.ts";
import { NODE_PROTOCOL, RemoteEndpoints } from "./remote.ts";

export type Listener = "loopback" | "tailnet";
export type Env = { Bindings: { listener: Listener } };

export interface Ctx {
  s: Store;
  creds: Credentials;
  gateway: Gateway;
  skills: SkillLinks;
  imports: SkillImports;
  abort: AbortController;
  pending: Set<Promise<void>>;
  quotas: Quotas;
  proxyOperations: ProxyOperations;
  remote: RemoteEndpoints;
}

export { providers } from "./llm/providers.ts";

export function makeCtx(s: Store, options: { skills?: SkillLinks; imports?: SkillImports } = {}): Ctx {
  const creds = new Credentials(s, (p, rt) => providers[p].refresh(rt), () => syncAll(s));
  const quotas = new Quotas(s, creds, providers);
  const gateway = new Gateway(s);
  return { s, creds, quotas, proxyOperations: new ProxyOperations(s, creds, quotas, providers), gateway, remote: new RemoteEndpoints(s, gateway), skills: options.skills ?? new SkillLinks(s, s.db.filename === ":memory:" ? null : undefined), imports: options.imports ?? new SkillImports(), abort: new AbortController(), pending: new Set() };
}

export function app(ctx: Ctx) {
  const { s } = ctx;
  const app = new Hono<Env>();
  const loopbackOnly: MiddlewareHandler<Env> = async (c, next) => (c.env.listener === "loopback" ? next() : c.notFound());

  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message || "Request failed" }, error.status);
    if (error instanceof SkillConflict) return c.json({ error: error.message }, 409);
    if (error instanceof ConfigurationConflict) return c.json({ error: error.message }, 409);
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

  // Register before every API handler, including the MCP shim's checkout write.
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.header("origin") || c.req.header("sec-fetch-site")) return c.json({ error: "Use the Agentgate app or CLI" }, 403);
    if (c.env.listener === "tailnet") {
      const token = s.local("adminToken");
      if (!token || c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  // Each node serves its own clients: the proxy, the MCP endpoint and secrets never go out on the tailnet.
  app.all("/anthropic/*", loopbackOnly, (c) => proxy(s, ctx.creds, providers.claude, cancellable(c.req.raw), pathAfter(c.req.url, "/anthropic")));
  app.all("/codex/*", loopbackOnly, (c) => proxy(s, ctx.creds, providers.codex, cancellable(c.req.raw), pathAfter(c.req.url, "/codex")));
  app.all("/mcp", loopbackOnly, (c) => ctx.gateway.handle(c.req.raw));
  app.get("/api/shim", loopbackOnly, (c) => {
    const project = c.req.query("project") || "*";
    const out = Object.entries(aliasesFor(s, project))
      .map(([alias, id]) => ({ alias, instance: s.get("mcp", id) }))
      .filter((x) => x.instance?.mode === "perSession");
    return c.json(out);
  });

  // The shim reports its checkout, so that repo's worktrees get their project skills before the next session starts.
  app.post("/api/checkout", loopbackOnly, async (c) => {
    const f = z.object({ path: z.string().min(1).max(4096), project: projectIdSchema.optional() }).strict().parse(await jsonInput(c.req.raw));
    const checkout = ctx.skills.register(f.path, f.project) ?? null;
    return c.json({ checkout, errors: ctx.skills.health().errors });
  });

  app.route("/peer", peerRoutes(s));

  app.get("/oauth/callback", oauthCallback(ctx));
  app.route("/api", management(ctx));
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
  // Tell other nodes this daemon keeps virtual projects' endpoints intact (see remote.ts versionGate).
  const me = s.get("node", s.nodeId);
  if (me && (me.protocol ?? 0) < NODE_PROTOCOL) s.put("node", s.nodeId, { ...me, protocol: NODE_PROTOCOL });
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
    lastSeq = snapshot.seq; poke(s); void relaySync(s, { pull: false });
    if (snapshot.records.some(r => ["mcp", "mcpCredential", "project"].includes(r.kind))) ctx.gateway.toolsChanged();
    if (snapshot.records.some(r => ["skill", "project"].includes(r.kind))) ctx.skills.soon();
    if (snapshot.records.some(r => r.kind === "project")) ctx.remote.reconcile();
  }, 1000);
  schedule(async () => { ctx.remote.reconcile(); }, 30000);
  schedule(async () => { ctx.skills.sync(); }, 30000);
  schedule(() => syncSkillRepos(s, undefined, ctx.abort.signal), 10 * 60_000);
  // ponytail: refetches every installed skill through `npx skills` hourly; group by source if that gets heavy.
  schedule(async () => {
    for (const { id, outcome } of await updateSkills(s, undefined, ctx.abort.signal))
      if (outcome.startsWith("failed")) console.error(`skills: ${id}: ${outcome}`);
  }, 3600000);
  schedule(() => Promise.all([pullAll(s), relaySync(s)]), PULL_INTERVAL);
  schedule(async () => { await ctx.creds.tick(ctx.abort.signal); await tickMcp(s, ctx.abort.signal); }, 60000);
  schedule(() => ctx.quotas.poll(ctx.abort.signal), 60000);
  schedule(async () => { if (process.platform === "darwin") await pollDesktopLogin(s); }, 2000);
  schedule(async () => { s.trimLog(); expireLogins(s); rotateLogs(); }, 3600000);
  let stopping: Promise<void> | undefined;
  return {
    ctx, loopback, stop: () => stopping ??= (async () => {
      stopped = true; ctx.abort.abort(); timers.forEach(clearInterval); ctx.skills.close(); ctx.imports.close();
      // Abort active streams and MCP sessions; finite background requests finish before the store closes.
      loopback.stop(true); tailnet?.stop(true);
      ctx.remote.close();
      await ctx.gateway.close();
      await stopRelay(s);
      await Promise.allSettled([...jobs, ...ctx.pending]); await ctx.imports.drain(); await drainRefresh(s); await drainPulls(s);
    })()
  };
}
