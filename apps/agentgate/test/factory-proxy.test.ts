import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { app, makeCtx } from "../src/daemon.ts";
import { allowedFactoryPath, factoryPeerRoutes } from "../src/factory-proxy.ts";
import { relayedRoutes } from "../src/handoff/routes.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function startMockFactory() {
  const seen: {
    method: string;
    path: string;
    body: string;
    origin: string | null;
    ifNoneMatch: string | null;
  }[] = [];
  const bigHtml = `<!doctype html><h1>Factory</h1><p>${"fast-embed ".repeat(200)}</p>`;
  const htmlEtag = 'W/"v-test-1"';
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
      seen.push({
        method: req.method,
        path: url.pathname + url.search,
        body,
        origin: req.headers.get("origin"),
        ifNoneMatch: req.headers.get("if-none-match"),
      });
      if (url.pathname === "/health") return Response.json({ ok: true, version: "test", port: server.port });
      if (url.pathname === "/") {
        if (req.headers.get("if-none-match") === htmlEtag) {
          return new Response(null, {
            status: 304,
            headers: { etag: htmlEtag, "cache-control": "no-cache" },
          });
        }
        return new Response(bigHtml, {
          headers: { "content-type": "text/html; charset=utf-8", etag: htmlEtag, "cache-control": "no-cache" },
        });
      }
      if (url.pathname === "/api/board") return Response.json({ open: 2, needsYou: 1, issues: [], done: [] });
      if (url.pathname === "/api/issues/batch") {
        return Response.json({ issues: { t1: { id: "t1", pad: "x".repeat(2000) } } });
      }
      if (url.pathname === "/api/issues/t1/answers" && req.method === "POST") {
        return Response.json({ ok: true, received: JSON.parse(body) });
      }
      if (url.pathname === "/evidence/t1/shot.png") {
        return new Response(new Uint8Array(2048).fill(137), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname === "/overview/t1") {
        return new Response("<main>PR overview</main>", {
          headers: { "content-type": "text/html", "content-security-policy": "sandbox allow-scripts" },
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, seen, htmlEtag };
}

describe("factory proxy", () => {
  test("allowlists client routes and refuses CLI, MCP, shutdown and traversal paths", () => {
    expect(allowedFactoryPath("GET", "/")).toBe(true);
    expect(allowedFactoryPath("GET", "/health")).toBe(true);
    expect(allowedFactoryPath("GET", "/api/board")).toBe(true);
    expect(allowedFactoryPath("GET", "/api/changes")).toBe(true);
    expect(allowedFactoryPath("GET", "/api/issues/batch")).toBe(true);
    expect(allowedFactoryPath("POST", "/api/issues/t1/answers")).toBe(true);
    expect(allowedFactoryPath("PUT", "/api/settings/repo:acme/api")).toBe(true);
    expect(allowedFactoryPath("GET", "/evidence/t1/a.png")).toBe(true);
    expect(allowedFactoryPath("GET", "/overview/t1")).toBe(true);

    expect(allowedFactoryPath("POST", "/api/shutdown")).toBe(false);
    expect(allowedFactoryPath("POST", "/api/issue/start")).toBe(false);
    expect(allowedFactoryPath("POST", "/api/runs/r1/report")).toBe(false);
    expect(allowedFactoryPath("POST", "/mcp")).toBe(false);
    expect(allowedFactoryPath("GET", "/evidence/../secret")).toBe(false);
    expect(allowedFactoryPath("GET", "/api/board/%2e%2e/shutdown")).toBe(false);
  });

  test("proxies local factory HTML, JSON, writes, binary evidence, and sandboxed overviews", async () => {
    const mock = startMockFactory();
    const s = new Store(":memory:");
    s.setLocal("node", "laptop");
    cleanups.push(() => s.close());
    const ctx = makeCtx(s, { factoryUrl: mock.url });
    const api = app(ctx);
    const call = (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("host", "127.0.0.1:7878");
      return api.fetch(new Request(`http://127.0.0.1:7878${path}`, { ...init, headers }), { listener: "loopback" });
    };

    const health = await call("/api/factory-proxy/laptop/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, version: "test" });

    const html = await call("/api/factory-proxy/laptop/?embed=1");
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("<h1>Factory</h1>");

    const post = await call("/api/factory-proxy/laptop/api/issues/t1/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: [{ decision: "d_1", answer: "Approve" }] }),
    });
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ ok: true, received: { answers: [{ decision: "d_1", answer: "Approve" }] } });
    // Origin is never forwarded to local Factory.
    expect(mock.seen.at(-1)?.origin).toBeNull();

    const png = await call("/api/factory-proxy/laptop/evidence/t1/shot.png", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    // Binary images are not gzipped even when the caller accepts gzip.
    expect(png.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(new Uint8Array(2048).fill(137));

    // Compressible HTML/JSON preserves ETag, honors If-None-Match (304), and gzips when accepted.
    const gzipHtml = await call("/api/factory-proxy/laptop/?embed=1", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(gzipHtml.status).toBe(200);
    expect(gzipHtml.headers.get("content-encoding")).toBe("gzip");
    expect(gzipHtml.headers.get("etag")).toBe(mock.htmlEtag);
    expect(gzipHtml.headers.get("cache-control")).toBe("no-cache");
    const decodedHtml = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await gzipHtml.arrayBuffer())));
    expect(decodedHtml).toContain("<h1>Factory</h1>");

    const notMod = await call("/api/factory-proxy/laptop/?embed=1", {
      headers: { "accept-encoding": "gzip", "if-none-match": mock.htmlEtag },
    });
    expect(notMod.status).toBe(304);
    expect(notMod.headers.get("etag")).toBe(mock.htmlEtag);
    expect(await notMod.text()).toBe("");

    const batch = await call("/api/factory-proxy/laptop/api/issues/batch?ids=t1", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(batch.status).toBe(200);
    expect(batch.headers.get("content-encoding")).toBe("gzip");
    const batchJson = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await batch.arrayBuffer()))));
    expect(batchJson.issues.t1.id).toBe("t1");

    const overview = await call("/api/factory-proxy/laptop/overview/t1");
    expect(overview.status).toBe(200);
    expect(overview.headers.get("content-security-policy")).toContain("sandbox");

    const blocked = await call("/api/factory-proxy/laptop/api/shutdown", { method: "POST" });
    expect(blocked.status).toBe(403);
  });

  test("returns a clear 503 when factory is not running on the target machine", async () => {
    const s = new Store(":memory:");
    s.setLocal("node", "laptop");
    cleanups.push(() => s.close());
    // Port 1 is closed on loopback.
    const ctx = makeCtx(s, { factoryUrl: "http://127.0.0.1:1" });
    const api = app(ctx);
    const res = await api.fetch(
      new Request("http://127.0.0.1:7878/api/factory-proxy/laptop/health", { headers: { host: "127.0.0.1:7878" } }),
      { listener: "loopback" },
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("Factory is not running");
  });

  test("forwards remote node requests over peer routes and relayed channel routes", async () => {
    const remoteFactory = startMockFactory();
    const remoteStore = new Store(":memory:");
    remoteStore.setLocal("node", "server");
    cleanups.push(() => remoteStore.close());
    const remoteCtx = makeCtx(remoteStore, { factoryUrl: remoteFactory.url });
    const remoteApp = app(remoteCtx);
    const token = "peer-secret-token";
    remoteStore.db.run("insert into peers values ('laptop', 'http://127.0.0.1:1', ?, 0, ?)", [
      token,
      remoteStore.now(),
    ]);

    const remoteServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => remoteApp.fetch(req, { listener: "tailnet" }),
    });
    cleanups.push(() => remoteServer.stop(true));

    // 1. Over Tailscale peer route
    const localStore = new Store(":memory:");
    localStore.setLocal("node", "laptop");
    cleanups.push(() => localStore.close());
    localStore.db.run("insert into peers values ('server', ?, ?, 0, ?)", [
      `http://127.0.0.1:${remoteServer.port}`,
      token,
      localStore.now(),
    ]);
    const localCtx = makeCtx(localStore, { factoryUrl: "http://127.0.0.1:1" });
    const localApp = app(localCtx);

    const res = await localApp.fetch(
      new Request("http://127.0.0.1:7878/api/factory-proxy/server/api/board", { headers: { host: "127.0.0.1:7878" } }),
      { listener: "loopback" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ open: 2, needsYou: 1 });

    // Peer forwarding preserves ETag, gzip compression, and 304 Not Modified end-to-end.
    const peerHtml = await localApp.fetch(
      new Request("http://127.0.0.1:7878/api/factory-proxy/server/?embed=1", {
        headers: { host: "127.0.0.1:7878", "accept-encoding": "gzip" },
      }),
      { listener: "loopback" },
    );
    expect(peerHtml.status).toBe(200);
    expect(peerHtml.headers.get("content-encoding")).toBe("gzip");
    expect(peerHtml.headers.get("etag")).toBe(remoteFactory.htmlEtag);
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await peerHtml.arrayBuffer())))).toContain(
      "<h1>Factory</h1>",
    );

    const peerNotMod = await localApp.fetch(
      new Request("http://127.0.0.1:7878/api/factory-proxy/server/?embed=1", {
        headers: { host: "127.0.0.1:7878", "accept-encoding": "gzip", "if-none-match": remoteFactory.htmlEtag },
      }),
      { listener: "loopback" },
    );
    expect(peerNotMod.status).toBe(304);
    expect(peerNotMod.headers.get("etag")).toBe(remoteFactory.htmlEtag);
    expect(remoteFactory.seen.at(-1)?.ifNoneMatch).toBe(remoteFactory.htmlEtag);

    // 2. Through relayedRoutes (same handler NodeChannel runs for E2E-encrypted relay calls)
    const relayHandler = relayedRoutes(
      remoteCtx.handoffs,
      new Hono().route("/factory-proxy", factoryPeerRoutes(remoteFactory.url, remoteCtx.abort.signal)),
    );
    const relayed = await relayHandler("laptop", new Request("http://relay/factory-proxy/health"));
    expect(relayed.status).toBe(200);
    expect(await relayed.json()).toMatchObject({ ok: true, version: "test" });
  });

  test("names the update when the remote daemon predates the factory proxy", async () => {
    // A bare Hono app answers like a pre-0.37.0 daemon with no /peer/factory-proxy route.
    const oldDaemon = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => new Hono().fetch(req) });
    cleanups.push(() => oldDaemon.stop(true));
    const s = new Store(":memory:");
    s.setLocal("node", "laptop");
    cleanups.push(() => s.close());
    s.db.run("insert into peers values ('server', ?, 'token', 0, ?)", [`http://127.0.0.1:${oldDaemon.port}`, s.now()]);
    const res = await app(makeCtx(s, { factoryUrl: "http://127.0.0.1:1" })).fetch(
      new Request("http://127.0.0.1:7878/api/factory-proxy/server/health", { headers: { host: "127.0.0.1:7878" } }),
      { listener: "loopback" },
    );
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("agentgate update server");
  });
});
