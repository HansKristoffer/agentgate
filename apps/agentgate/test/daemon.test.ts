import { expect, test } from "bun:test";
import { app, makeCtx, serve } from "../src/daemon.ts";
import { Store } from "../src/store.ts";

const request = (path: string, options?: RequestInit) => new Request(`http://127.0.0.1:7878${path}`, { ...options, headers: { host: "127.0.0.1:7878", ...options?.headers } });
test("tailnet administration fails closed without a token and cannot reach local proxy/MCP routes", async () => {
  const s = new Store(":memory:"), ctx = makeCtx(s), handler = app(ctx);
  try { expect((await handler.fetch(request("/api/status"), { listener: "tailnet" })).status).toBe(401); expect((await handler.fetch(request("/mcp"), { listener: "tailnet" })).status).toBe(404); expect((await handler.fetch(request("/anthropic/v1/messages"), { listener: "tailnet" })).status).toBe(404); s.setLocal("adminToken", "test-token"); expect((await handler.fetch(request("/api/status", { headers: { authorization: "Bearer test-token" } }), { listener: "tailnet" })).status).toBe(200); }
  finally { await ctx.gateway.close(); s.close(); }
});

test("loopback rejects foreign hosts and malformed settings return actionable 400 responses", async () => {
  const s = new Store(":memory:"), ctx = makeCtx(s), handler = app(ctx);
  try {
    expect((await handler.fetch(new Request("http://hostile.example/api/status", { headers: { host: "hostile.example" } }), { listener: "loopback" })).status).toBe(403);
    const res = await handler.fetch(request("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ threshold: "NaN", retryLimit: 999, logRetention: -1, whenExhausted: "other" }) }), { listener: "loopback" }); expect(res.status).toBe(400); expect(await res.text()).toContain("invalid input");
    expect(s.get("setting", "settings")).toBeUndefined();
  } finally { await ctx.gateway.close(); s.close(); }
});

test("daemon lifecycle closes listeners and drains work before returning", async () => {
  const s = new Store(":memory:"); s.setLocal("node", "n"); const daemon = await serve(s, { port: 0, discover: async () => undefined, logs: { claude: [], codex: [] } });
  const url = `http://127.0.0.1:${daemon.loopback.port}`; expect((await fetch(`${url}/api/status`)).status).toBe(200);
  await daemon.stop(); await daemon.stop(); await expect(fetch(url)).rejects.toThrow(); s.close();
});

test("native login expiry is enforced when finishing without another login starting", async () => {
  const s = new Store(":memory:"), ctx = makeCtx(s), handler = app(ctx);
  try {
    const start = await handler.fetch(request("/api/accounts/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "claude" }) }), { listener: "loopback" });
    const { state } = await start.json() as { state: string }; expect(state).toBeDefined();
    s.now = () => Date.now() + 31 * 60000;
    const finish = await handler.fetch(request("/api/accounts/login/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, code: "code#state" }) }), { listener: "loopback" });
    expect(finish.status).toBe(400); expect(await finish.text()).toContain("expired"); expect(s.list("account")).toEqual([]);
  } finally { await ctx.gateway.close(); s.close(); }
});

test("shutdown waits for an already-issued refresh to persist before the store can close", async () => {
  const { Credentials } = await import("../src/credentials.ts"); const { CLAUDE } = await import("../src/llm/claude.ts");
  const originalApi = CLAUDE.api, s = new Store(":memory:"); s.setLocal("node", "n"); s.put("account", "a", { id: "a", provider: "claude", label: "a" }); s.put("credential", "a", { accountId: "a", accessToken: "old", refreshToken: "old", expiresAt: Date.now() + 3600000, holder: "n" });
  const upstream = Bun.serve({ port: 0, fetch: () => new Response("unauthorized", { status: 401 }) }); CLAUDE.api = `http://127.0.0.1:${upstream.port}`;
  const daemon = await serve(s, { port: 0, discover: async () => undefined, logs: { claude: [], codex: [] } }); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => release = r), start = new Promise<void>(r => entered = r);
  daemon.ctx.creds = new Credentials(s, async () => { entered(); await gate; return { accessToken: "persisted", refreshToken: "rotated", expiresAt: Date.now() + 3600000 }; }, async () => {});
  try {
    const response = fetch(`http://127.0.0.1:${daemon.loopback.port}/anthropic/v1/messages`, { method: "POST", body: '{"model":"sonnet"}' }).catch(() => undefined);
    await start; let closed = false; const stopping = daemon.stop().then(() => { closed = true; }); await Bun.sleep(10); expect(closed).toBe(false);
    release(); await stopping; await response; expect(s.get("credential", "a")?.accessToken).toBe("persisted"); expect(daemon.ctx.pending.size).toBe(0);
  } finally { release(); await daemon.stop(); CLAUDE.api = originalApi; upstream.stop(true); s.close(); }
});
