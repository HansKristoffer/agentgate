import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Hono } from "hono";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { machineHealthSchema } from "@agentgate/protocol";
import { app, makeCtx } from "../src/daemon.ts";
import { countWorktrees, dockerDisk } from "../src/health.ts";
import { startLagProbe } from "../src/lag.ts";
import { NODE_PROTOCOL } from "../src/remote.ts";
import { Store } from "../src/store.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A machine with the daemon's routes. */
function machine(name = "mac", options: { worktreesDir?: () => string } = {}) {
  const s = new Store(":memory:");
  s.setLocal("node", name);
  s.setLocal("adminToken", "admin-secret");
  s.put("node", name, { id: name, url: `http://${name}.tail123.ts.net:7878`, protocol: NODE_PROTOCOL });
  const ctx = makeCtx(s, { factoryUrl: "http://127.0.0.1:1", worktreesDir: options.worktreesDir }),
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
  /** The `health` operation, as the app calls it. */
  const health = (body: { node?: string }, options: { listener?: "loopback" | "tailnet"; token?: string } = {}) =>
    handler.fetch(
      new Request("http://127.0.0.1:7878/api/ops/health", {
        method: "POST",
        headers: {
          host: options.listener === "tailnet" ? `${name}.tail123.ts.net:7878` : "127.0.0.1:7878",
          "content-type": "application/json",
          ...(options.token && { authorization: `Bearer ${options.token}` }),
        },
        body: JSON.stringify(body),
      }),
      { listener: options.listener ?? "loopback" },
    );
  /** Starts sampling the way the first read does, and takes the baseline and the first sample without waiting for
   * the timer. */
  const firstRead = async () => {
    const reading = ctx.health.read();
    await ctx.health.sample();
    await ctx.health.sample();
    return reading;
  };
  return { s, ctx, handler, health, firstRead };
}

const errorOf = async (response: Response) => ((await response.json()) as { error: string }).error;

test("health needs the admin token on the tailnet, and names a machine that is not there", async () => {
  const { health } = machine();
  expect((await health({}, { listener: "tailnet" })).status).toBe(401);

  const unknown = await health({ node: "nobody" });
  expect(unknown.status).toBe(400);
  expect(await errorOf(unknown)).toContain("No machine named nobody");
});

test("another machine's health is asked of its own daemon, and one from before the route names the update", async () => {
  // A bare Hono app answers like a daemon from before /peer/health.
  const oldDaemon = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => new Hono().fetch(req) });
  cleanup.push(() => oldDaemon.stop(true));
  const { s, health } = machine("laptop");
  s.put("node", "server", { id: "server", protocol: NODE_PROTOCOL });
  s.put("node", "lonely", { id: "lonely", protocol: NODE_PROTOCOL });
  s.db.run("insert into peers values ('server', ?, 'token', 0, ?)", [`http://127.0.0.1:${oldDaemon.port}`, s.now()]);

  const old = await health({ node: "server" });
  expect(old.status).toBe(400);
  expect(await errorOf(old)).toContain("agentgate update server");

  const unpaired = await health({ node: "lonely" });
  expect(await errorOf(unpaired)).toContain("lonely is not paired with laptop");
});

test.skipIf(process.platform === "linux")("a machine that is not Linux says so and never samples", async () => {
  const { health } = machine();
  const response = await health({});
  expect(response.status).toBe(400);
  expect(await errorOf(response)).toContain("not a Linux machine");
});

test.skipIf(process.platform !== "linux")(
  "the first read waits for the first sample, and the API answers with this machine's health",
  async () => {
    const { health, firstRead } = machine();
    const probe = startLagProbe();
    cleanup.push(() => probe.stop());

    expect((await firstRead()).history).toHaveLength(1);
    const response = await health({});
    expect(response.status).toBe(200);
    const data = machineHealthSchema.parse(await response.json());
    expect(data.host).toBe(hostname());
    // The sample reads /proc asynchronously, so the probe may tick, with a millisecond of jitter, while it runs.
    expect(data.daemon_lag).toEqual({ worstMs: expect.any(Number), p99Ms: expect.any(Number) });
    expect(data.services).not.toHaveProperty("t3_code"); // not connected to T3 Code here
  },
);

test.skipIf(process.platform !== "linux")(
  "the daemon samples only while someone watches: from the first read until a minute after the last",
  async () => {
    const { s, ctx, firstRead } = machine();
    let now = Date.now();
    s.now = () => now;

    // Unwatched, the timer's ticks take nothing.
    await ctx.health.sample();
    expect((await firstRead()).history).toHaveLength(1);
    await ctx.health.sample();
    expect((await ctx.health.read()).history).toHaveLength(2);

    // A minute without a read: the next tick stops sampling and drops what it had, and the next read starts over.
    now += 60_000;
    await ctx.health.sample();
    await ctx.health.sample();
    expect((await firstRead()).history).toHaveLength(1);
  },
);

test.skipIf(process.platform !== "linux")(
  "health reports T3 Code only while agentgate is connected to it, and whether it answers",
  async () => {
    const { s, ctx, firstRead } = machine();
    const t3 = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    cleanup.push(() => t3.stop(true));
    s.setLocal("t3:url", `http://127.0.0.1:${t3.port}`);
    s.setLocal("t3:token", "t3-token");
    let now = Date.now();
    s.now = () => now;
    const services = async () => (await ctx.health.read()).services;

    expect((await firstRead()).services).toMatchObject({ t3_code: true });
    t3.stop(true);
    // Services are asked every 30 seconds, not on every sample.
    await ctx.health.sample();
    expect(await services()).toMatchObject({ t3_code: true });
    now += 30_000;
    await ctx.health.sample();
    expect(await services()).toMatchObject({ t3_code: false });
  },
);

test.skipIf(process.platform !== "linux")(
  "a paired machine's health comes over its peer route, behind the peer token",
  async () => {
    const remote = machine("server");
    const token = "peer-secret-token";
    remote.s.db.run("insert into peers values ('laptop', 'http://127.0.0.1:1', ?, 0, ?)", [token, remote.s.now()]);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => remote.handler.fetch(req, { listener: "tailnet" }),
    });
    cleanup.push(() => server.stop(true));
    await remote.firstRead();

    const local = machine("laptop");
    local.s.put("node", "server", { id: "server", protocol: NODE_PROTOCOL });
    local.s.db.run("insert into peers values ('server', ?, ?, 0, ?)", [
      `http://127.0.0.1:${server.port}`,
      token,
      local.s.now(),
    ]);
    const response = await local.health({ node: "server" });
    expect(response.status).toBe(200);
    expect(machineHealthSchema.parse(await response.json()).history).toHaveLength(1);

    // Without the peer token the route is closed.
    expect((await fetch(`http://127.0.0.1:${server.port}/peer/health`)).status).toBe(401);
  },
);

test("dockerDisk parses volume counts, active volumes and reclaimable space from docker system df JSON", () => {
  const df = [
    '{"Active":"9","Reclaimable":"20.15GB (84%)","Size":"23.89GB","TotalCount":"39","Type":"Images"}',
    '{"Active":"29","Reclaimable":"143.8GB (63%)","Size":"227.3GB","TotalCount":"4848","Type":"Local Volumes"}',
    '{"Active":"0","Reclaimable":"16.48GB","Size":"39.39GB","TotalCount":"304","Type":"Build Cache"}',
  ].join("\n");
  expect(dockerDisk(df)).toEqual({
    images: "23.89GB",
    images_reclaimable: "20.15GB (84%)",
    volumes: "227.3GB",
    volumes_count: 4848,
    volumes_active: 29,
    volumes_reclaimable: "143.8GB (63%)",
    build_cache: "39.39GB",
    build_cache_reclaimable: "16.48GB",
  });
  expect(dockerDisk("")).toBeNull();
  expect(dockerDisk("not-json")).toBeNull();
});

test("countWorktrees counts nested repo worktrees and direct worktrees, and omits missing directories", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-wt-health-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  expect(await countWorktrees(join(dir, "missing"))).toBeUndefined();

  const root = join(dir, "worktrees");
  mkdirSync(join(root, "agentgate", "wt-1"), { recursive: true });
  mkdirSync(join(root, "agentgate", "wt-2"), { recursive: true });
  mkdirSync(join(root, "agentgate", ".hidden"), { recursive: true });
  mkdirSync(join(root, "hellu", "wt-a"), { recursive: true });
  mkdirSync(join(root, "direct-wt"), { recursive: true });
  writeFileSync(join(root, "direct-wt", ".git"), "gitdir: /tmp/fake\n");
  writeFileSync(join(root, "README.txt"), "ignore files");
  expect(await countWorktrees(root)).toEqual({ count: 4, path: root });
});

test.skipIf(process.platform !== "linux")(
  "health reports root inode usage and worktrees count when present, and omits worktrees when absent",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentgate-health-hygiene-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const wtRoot = join(dir, "worktrees");
    mkdirSync(join(wtRoot, "repo-a", "wt-1"), { recursive: true });
    mkdirSync(join(wtRoot, "repo-a", "wt-2"), { recursive: true });

    const withWt = machine("worker", { worktreesDir: () => wtRoot });
    const sample = machineHealthSchema.parse(await withWt.firstRead());
    expect(sample.disk.inodes_used_percent).toBeGreaterThanOrEqual(0);
    expect(sample.disk.inodes_used_percent).toBeLessThanOrEqual(100);
    expect(sample.disk.inodes_total).toBeGreaterThan(0);
    expect(sample.workload.worktrees).toEqual({ count: 2, path: wtRoot });

    const withoutWt = machine("worker-no-wt", { worktreesDir: () => join(dir, "absent") });
    const sampleNoWt = machineHealthSchema.parse(await withoutWt.firstRead());
    expect(sampleNoWt.workload.worktrees).toBeUndefined();
  },
);
