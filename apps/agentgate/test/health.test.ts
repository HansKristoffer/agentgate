import { afterEach, expect, test } from "bun:test";
import { hostname } from "node:os";
import { HEALTH_PATH, statusSchema } from "@agentgate/protocol";
import { app, makeCtx } from "../src/daemon.ts";
import { setHealthDashboard } from "../src/operations.ts";
import { NODE_PROTOCOL } from "../src/remote.ts";
import { Store } from "../src/store.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** This machine, named mac, with the daemon's routes. */
function machine() {
  const s = new Store(":memory:");
  s.setLocal("node", "mac");
  s.setLocal("adminToken", "admin-secret");
  s.put("node", "mac", { id: "mac", url: "http://mac.tail123.ts.net:7878", protocol: NODE_PROTOCOL });
  const ctx = makeCtx(s),
    handler = app(ctx);
  cleanup.push(async () => {
    ctx.health.stop();
    ctx.abort.abort();
    ctx.skills.close();
    ctx.imports.close();
    await ctx.imports.drain();
    await ctx.gateway.close();
    s.close();
  });
  const call = (
    path: string,
    options: {
      method?: string;
      body?: unknown;
      listener?: "loopback" | "tailnet";
      headers?: Record<string, string>;
    } = {},
  ) => {
    const { method = "GET", body, listener = "loopback", headers = {} } = options;
    return handler.fetch(
      new Request(`http://127.0.0.1:7878${path}`, {
        method,
        headers: {
          host: "127.0.0.1:7878",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { listener },
    );
  };
  return { s, ctx, call };
}

test("the dashboard is off until a machine turns it on, and turning it on waits for every machine's version", async () => {
  const { s, call } = machine();
  expect((await call(HEALTH_PATH, { headers: { accept: "text/html" } })).status).toBe(404);

  s.put("node", "old", { id: "old", protocol: NODE_PROTOCOL - 1 });
  expect(() => setHealthDashboard(s, "mac", true)).toThrow("Update agentgate on old first");
  expect(s.get("node", "mac")!.healthDashboard).toBe(false);
  expect(() => setHealthDashboard(s, "nobody", true)).toThrow("no machine nobody");

  s.put("node", "old", { id: "old", protocol: NODE_PROTOCOL });
  expect(setHealthDashboard(s, "mac", true).healthDashboard).toBe(true);
  // Linux serves the page; any other machine answers with a note instead.
  expect((await call(HEALTH_PATH, { headers: { accept: "text/html" } })).status).toBe(
    process.platform === "linux" ? 200 : 501,
  );

  // Turning it off needs no wait: a machine that drops the field reads it as off.
  s.put("node", "old", { id: "old", protocol: NODE_PROTOCOL - 1 });
  expect(setHealthDashboard(s, "mac", false).healthDashboard).toBe(false);
});

test("the API turns another machine's dashboard on and off, shows it in status, and needs the admin token on the tailnet", async () => {
  const { s, call } = machine();
  s.put("node", "b", { id: "b", protocol: NODE_PROTOCOL });
  const tailnet = { listener: "tailnet" as const, headers: { host: "mac.tail123.ts.net:7878" } };

  expect((await call("/api/nodes/b/dashboard", { ...tailnet, method: "POST", body: { on: true } })).status).toBe(401);
  expect((await call("/api/nodes/b/dashboard", { method: "POST", body: { on: true } })).status).toBe(200);
  expect(s.get("node", "b")!.healthDashboard).toBe(true);
  expect((await call("/api/nodes/nobody/dashboard", { method: "POST", body: { on: true } })).status).toBe(404);

  const status = statusSchema.parse(await (await call("/api/status")).json());
  expect(status.nodes.find((n) => n.id === "b")?.healthDashboard).toBe(true);

  const off = await call("/api/nodes/b/dashboard", {
    ...tailnet,
    method: "POST",
    body: { on: false },
    headers: { ...tailnet.headers, authorization: "Bearer admin-secret" },
  });
  expect(off.status).toBe(200);
  expect(s.get("node", "b")!.healthDashboard).toBe(false);
});

test.skipIf(process.platform === "linux")("a machine that is not Linux says so and never samples", async () => {
  const { s, ctx, call } = machine();
  setHealthDashboard(s, "mac", true);
  ctx.health.reconcile();
  expect((await call(HEALTH_PATH, { headers: { accept: "application/json" } })).status).toBe(501);
});

test.skipIf(process.platform !== "linux")(
  "the dashboard reports T3 Code only while agentgate is connected to it, and whether it answers",
  async () => {
    const { s, ctx, call } = machine();
    const t3 = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    cleanup.push(() => t3.stop(true));
    s.setLocal("t3:url", `http://127.0.0.1:${t3.port}`);
    s.setLocal("t3:token", "t3-token");
    setHealthDashboard(s, "mac", true);
    ctx.health.reconcile();
    const services = async () =>
      (
        (await (await call(HEALTH_PATH, { headers: { accept: "application/json" } })).json()) as {
          services: Record<string, boolean>;
        }
      ).services;

    await ctx.health.sample();
    expect(await services()).toMatchObject({ t3_code: true });
    t3.stop(true);
    await ctx.health.sample();
    expect(await services()).toMatchObject({ t3_code: false });
  },
);

test.skipIf(process.platform !== "linux")(
  "while on, the daemon samples this machine: the page and JSON answer, and the tailnet listener answers only this node's names",
  async () => {
    const { s, ctx, call } = machine();
    setHealthDashboard(s, "mac", true);
    ctx.health.reconcile();
    const json = { headers: { accept: "application/json" } };
    expect((await call(`${HEALTH_PATH}?history=1`, json)).status).toBe(503); // no sample yet

    await ctx.health.sample();
    const data = (await (await call(`${HEALTH_PATH}?history=1`, json)).json()) as {
      status: string;
      host: string;
      history: unknown[];
      services: Record<string, boolean>;
    };
    expect(data).toMatchObject({ status: "ok", host: hostname() });
    expect(data.history).toHaveLength(1);
    expect(data.services).not.toHaveProperty("t3_code"); // not connected to T3 Code here

    const page = await call(HEALTH_PATH, { headers: { accept: "text/html" } });
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("<title>Machine dashboard</title>");

    // A page on another site reaches the tailnet address by DNS rebinding under its own name: refused. An address or this
    // node's own name is what the app and the browser use.
    const tailnetHost = (host: string) =>
      call(HEALTH_PATH, { listener: "tailnet", headers: { host, accept: "application/json" } });
    expect((await tailnetHost("evil.example:7878")).status).toBe(403);
    expect((await tailnetHost("mac.tail123.ts.net:7878")).status).toBe(200);
    expect((await tailnetHost("100.89.253.6:7878")).status).toBe(200);

    setHealthDashboard(s, "mac", false);
    ctx.health.reconcile();
    expect((await call(HEALTH_PATH, json)).status).toBe(404);
  },
);
