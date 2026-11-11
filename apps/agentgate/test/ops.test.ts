import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { app, makeCtx, type Listener } from "../src/daemon.ts";
import { recordUsage } from "../src/llm/quota.ts";
import { controlOp, controlOps } from "../src/ops/index.ts";
import { Store } from "../src/store.ts";
import { removeTmp, tmp } from "./fixtures/git.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** A store with this node `a` and an always-on node `b`. */
function machines(s: Store) {
  s.setLocal("node", "a");
  s.setLocal("adminToken", "admin-secret");
  s.put("node", "a", { id: "a" });
  s.put("node", "b", { id: "b", alwaysOn: true });
  return s;
}

function daemon() {
  const s = machines(new Store(":memory:"));
  const ctx = makeCtx(s);
  const handler = app(ctx);
  cleanup.push(async () => {
    ctx.abort.abort();
    ctx.skills.close();
    ctx.imports.close();
    await ctx.gateway.close();
    s.close();
  });
  const call = (path: string, body: unknown, listener: Listener = "loopback") =>
    handler.fetch(
      new Request(`http://127.0.0.1:7878/api${path}`, {
        method: "POST",
        headers: {
          host: "127.0.0.1:7878",
          "content-type": "application/json",
          ...(listener === "tailnet" && { authorization: "Bearer admin-secret" }),
        },
        body: JSON.stringify(body),
      }),
      { listener },
    );
  return { s, handler, call };
}

/** The CLI from this checkout, with its own home and the daemon port given. */
async function cli(home: string, port: number, ...words: string[]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...words], {
    env: { ...process.env, AGENTGATE_HOME: home, AGENTGATE_PORT: String(port), AGENTGATE_DEV: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanup.push(() => child.kill());
  return { code: await child.exited, out: await new Response(child.stdout).text() };
}

test("the CLI changes a machine through the running daemon", async () => {
  const { s, handler } = daemon();
  const served = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => handler.fetch(req, { listener: "loopback" }),
  });
  cleanup.push(() => served.stop(true));

  const { code, out } = await cli(tmp(), served.port!, "nodes", "always-on", "b", "off");

  expect(code).toBe(0);
  expect(out).toBe("b is no longer always on\n");
  expect(s.get("node", "b")?.alwaysOn).toBe(false);
});

test("with no daemon, the CLI runs a store operation in its own process", async () => {
  const home = tmp();
  machines(new Store(join(home, "agentgate.db"))).close();
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = closed.port!;
  closed.stop(true);

  const { code, out } = await cli(home, port, "nodes", "always-on", "b", "off");

  expect(code).toBe(0);
  expect(out).toBe("b is no longer always on\n");
  const s = new Store(join(home, "agentgate.db"));
  expect(s.get("node", "b")?.alwaysOn).toBe(false);
  s.close();
});

test("the app calls an operation by name from a remote connection, and a refusal is a 400 with its reason", async () => {
  const { s, call } = daemon();

  const on = await call("/ops/nodes%20always-on", { node: "a", on: true }, "tailnet");
  expect(on.status).toBe(200);
  expect(s.get("node", "a")?.alwaysOn).toBe(true);

  const missing = await call("/ops/nodes%20always-on", { node: "c", on: true }, "tailnet");
  expect(missing.status).toBe(400);
  expect(await missing.json()).toEqual({ error: "No machine named c" });
});

test("accounts exhaust benches an account for a while and keeps the windows it last saw", async () => {
  const { s, call } = daemon();
  s.now = () => 1_000_000;
  s.put("account", "a", { id: "a", provider: "claude", label: "a" });
  recordUsage(s, "a", { windows: [{ name: "5h", usedPct: 40 }], status: "ok" }, undefined, "poll");

  expect((await call("/ops/accounts%20exhaust", { id: "a", minutes: 30 })).status).toBe(200);

  expect(s.get("usage", "a")).toMatchObject({
    status: "exhausted",
    exhaustedUntil: 1_000_000 + 30 * 60_000,
    source: "manual",
    windows: [{ name: "5h", usedPct: 40 }],
  });
});

test("every loopback-only operation is refused on the tailnet listener", async () => {
  controlOp({
    name: "test secret",
    summary: "a loopback-only operation",
    input: z.object({}),
    needs: "store",
    loopbackOnly: true,
    run: () => ({ ok: true }),
  });
  cleanup.push(() => controlOps.delete("test secret"));
  const { call } = daemon();

  const local = [...controlOps.values()].filter((op) => op.loopbackOnly);
  expect(local.length).toBeGreaterThan(0);
  for (const op of local) expect((await call(`/ops/${encodeURIComponent(op.name)}`, {}, "tailnet")).status).toBe(403);
});

test("an operation's unexpected error answers a fixed 500 and keeps its text out of the response and the log", async () => {
  controlOp({
    name: "test broken",
    summary: "fails with a secret in its message",
    input: z.object({}),
    needs: "store",
    run: () => {
      throw new Error("token sk-secret-value");
    },
  });
  cleanup.push(() => controlOps.delete("test broken"));
  const logged = spyOn(console, "error").mockImplementation(() => {});
  cleanup.push(() => logged.mockRestore());
  const { call } = daemon();

  const res = await call("/ops/test%20broken", {});

  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "request failed" });
  expect(logged).toHaveBeenCalled();
  expect(JSON.stringify(logged.mock.calls)).not.toContain("sk-secret-value");
});
