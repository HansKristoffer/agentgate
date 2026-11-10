import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Listener } from "../src/daemon.ts";
import { app, makeCtx, type Ctx } from "../src/daemon.ts";
import { host } from "../src/logins.ts";
import { boardView } from "../src/factory/board.ts";
import { fetcher } from "../src/factory/folder.ts";
import { loopTask, runTerminal, type FactoryRuntime } from "../src/factory/runtime.ts";
import { getSecret, resolveSecretRef, secretNames, setSecret } from "../src/factory/secrets.ts";
import { exportBackup, importBackup, Store } from "../src/store.ts";
import { peers, pullPeer } from "../src/sync.ts";
import { removeTmp, tmp } from "./fixtures/git.ts";
import { startNodes, type TestNode } from "./fixtures/nodes.ts";
import { postOp } from "./fixtures/t3-mcp.ts";

const VALUE = "lin_api_value-that-must-never-show";
const cleanup: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  fetcher.root = tmp("agentgate-factory-home-");
});
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
afterAll(removeTmp);

const realGh = host.gh;
function node(name = "a") {
  // No test reaches GitHub: `use` asks it whether the folder's branch is protected.
  host.gh = async () => undefined;
  cleanup.push(() => {
    host.gh = realGh;
  });
  const s = new Store(":memory:");
  s.setLocal("node", name);
  s.setLocal("adminToken", "admin-token");
  s.put("node", name, { id: name, protocol: 8 });
  const ctx = makeCtx(s);
  cleanup.push(async () => {
    ctx.abort.abort();
    ctx.skills.close();
    ctx.imports.close();
    await ctx.gateway.close();
    s.close();
  });
  return { s, ctx, f: ctx.factory };
}

const command = (f: FactoryRuntime, args: string[], stdin?: string) => runTerminal(f, ["secret", ...args], stdin);
/** A secret operation as the app sends it, with the admin token a tailnet caller needs. */
const op = (ctx: Ctx, listener: Listener, name: string, input?: unknown) =>
  postOp(ctx, name, input, listener, { authorization: "Bearer admin-token" });

const request = (ctx: Ctx, listener: Listener, method: string, path: string, body?: unknown) =>
  app(ctx).fetch(
    new Request(`http://127.0.0.1:7878${path}`, {
      method,
      headers: { host: "127.0.0.1:7878", authorization: "Bearer admin-token", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { listener },
  );

const pull = (to: TestNode, from: TestNode) =>
  pullPeer(
    to.s,
    peers(to.s).find((p) => p.node === from.name)!,
  );

/** Turns the factory on with the example folder, which declares LINEAR_KEY, GITHUB_HOOK and DESK_SIGNING. */
async function withFolder(f: FactoryRuntime) {
  const commit = "c".repeat(40);
  const fetch = fetcher.fetch;
  fetcher.fetch = async ({ since }) => {
    if (since === commit) return null;
    const dir = join(fetcher.root, commit);
    if (!existsSync(dir)) cpSync(join(import.meta.dir, "fixtures", "factory"), dir, { recursive: true });
    return { commit, dir };
  };
  cleanup.push(() => {
    fetcher.fetch = fetch;
  });
  expect((await runTerminal(f, ["use", "acme/factory"])).code).toBe(0);
  await loopTask(
    f,
    f.loops.find((l) => l.name === "factory-folder")!,
  )();
}

test("secret set takes the value from stdin and reaches a peer once every node understands secrets", async () => {
  const [a, b] = await startNodes("a", "b");
  cleanup.push(() => Promise.all([a!.stop(), b!.stop()]).then(() => {}));

  b!.s.put("node", "b", { id: "b", protocol: 7 });
  await pull(a!, b!);
  await expect(command(a!.ctx.factory, ["set", "LINEAR_KEY"], `${VALUE}\n`)).rejects.toThrow(
    "Update agentgate on b first: older versions cannot sync factory settings and secrets",
  );
  expect(a!.s.record("secret", "LINEAR_KEY")).toBeUndefined();

  b!.s.put("node", "b", { id: "b", protocol: 8 });
  await pull(a!, b!);
  expect(await command(a!.ctx.factory, ["set", "LINEAR_KEY"], `${VALUE}\n`)).toEqual({
    code: 0,
    output: ["Set LINEAR_KEY for every machine."],
  });
  await pull(b!, a!);
  expect(b!.s.get("secret", "LINEAR_KEY")).toEqual({ id: "LINEAR_KEY", value: VALUE, from: "a" });
  expect(resolveSecretRef(b!.s, "secret:LINEAR_KEY")).toBe(VALUE);

  // The delete travels as a tombstone, so b cannot hand the value back.
  expect((await command(b!.ctx.factory, ["delete", "LINEAR_KEY"])).code).toBe(0);
  await pull(a!, b!);
  expect(getSecret(a!.s, "LINEAR_KEY")).toBeUndefined();
  expect(a!.s.record("secret", "LINEAR_KEY")?.deleted).toBe(1);
});

test("secret list shows names only, with the names factory.yaml uses that this machine lacks, and hides agentgate's hook keys", async () => {
  const { s, f } = node();
  await withFolder(f);
  await command(f, ["set", "LINEAR_KEY"], VALUE);
  setSecret(s, "~hook:desk", "hook-key");
  setSecret(s, "EXTRA", "extra-value");

  expect(await command(f, ["list"])).toEqual({
    code: 0,
    output: [
      "EXTRA",
      "LINEAR_KEY",
      "GITHUB_HOOK  not set (named in factory.yaml)",
      "DESK_SIGNING  not set (named in factory.yaml)",
    ],
  });
  expect(secretNames(s)).toEqual(["EXTRA", "LINEAR_KEY"]);
  expect(getSecret(s, "~hook:desk")).toBe("hook-key");
});

test("the secret operations refuse a remote-management connection and work on loopback, while others take both", async () => {
  const { s, ctx } = node();
  const named = { name: "LINEAR_KEY" };
  for (const [name, input] of [
    ["secret list", {}],
    ["secret set", { ...named, value: VALUE }],
    ["secret delete", named],
  ] as const) {
    const res = await op(ctx, "tailnet", name, input);
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 403,
      body: { error: "This operation requires a local connection" },
    });
  }
  expect(getSecret(s, "LINEAR_KEY")).toBeUndefined();
  // An operation that is not loopback only answers the same connection.
  expect((await op(ctx, "tailnet", "off")).status).toBe(200);
  // The terminal's form is for this machine's CLI alone.
  const typed = await request(ctx, "tailnet", "POST", "/api/factory/terminal", { args: ["status"] });
  expect(typed.status).toBe(403);

  expect((await op(ctx, "loopback", "secret set", { ...named, value: VALUE })).status).toBe(200);
  expect(await (await op(ctx, "loopback", "secret list")).json()).toEqual({ set: ["LINEAR_KEY"], missing: [] });
  expect(await (await op(ctx, "loopback", "secret delete", named)).json()).toEqual({ ...named, deleted: true });
  expect(await (await op(ctx, "loopback", "secret delete", named)).json()).toEqual({ ...named, deleted: false });
});

test("backups carry secrets, export --no-secrets leaves them out, and import waits for every node", () => {
  const { s } = node();
  setSecret(s, "LINEAR_KEY", VALUE);
  setSecret(s, "~hook:desk", "hook-key");

  const full = exportBackup(s);
  expect(full.records.filter((r) => r.kind === "secret").map((r) => r.id)).toEqual(["LINEAR_KEY", "~hook:desk"]);
  expect(JSON.stringify(exportBackup(s, false))).not.toContain(VALUE);
  expect(exportBackup(s, false).records.some((r) => r.kind === "secret")).toBe(false);

  const restored = node("b").s;
  restored.put("node", "old", { id: "old", protocol: 7 });
  expect(() => importBackup(restored, full)).toThrow("Update agentgate on old first");
  expect(restored.list("secret")).toEqual([]);
  restored.put("node", "old", { id: "old", protocol: 8 });
  importBackup(restored, full);
  expect(getSecret(restored, "LINEAR_KEY")).toBe(VALUE);
  expect(getSecret(restored, "~hook:desk")).toBe("hook-key");
});

test("a secret value never shows in /status, the board, logs or error messages", async () => {
  const { s, ctx, f } = node();
  const logged: unknown[] = [];
  for (const method of ["log", "error", "warn"] as const) {
    const spy = spyOn(console, method).mockImplementation((...args) => void logged.push(...args));
    cleanup.push(() => spy.mockRestore());
  }

  await withFolder(f);
  await command(f, ["set", "LINEAR_KEY"], VALUE);
  // As the CLI sends them: a value typed where the name goes, a value too long, a set refused for an old node.
  const cli = (args: string[], stdin: string) =>
    request(ctx, "loopback", "POST", "/api/factory/terminal", { args: ["secret", ...args], stdin });
  const refusals = [
    await cli(["set", VALUE], VALUE),
    await cli(["set", "LONG"], VALUE.repeat(1000)),
    await cli(["sett", VALUE], VALUE),
    await op(ctx, "loopback", "secret set", { name: "LONG", value: VALUE.repeat(1000) }),
    await op(ctx, "loopback", "secret set", { name: VALUE, value: "x" }),
  ];
  s.put("node", "old", { id: "old", protocol: 7 });
  refusals.push(await cli(["set", "LINEAR_KEY"], VALUE));
  expect(refusals.map((r) => r.status)).toEqual([400, 400, 400, 400, 400, 400]);
  const errors = await Promise.all(refusals.map((r) => r.text()));

  const statusResponse = await request(ctx, "loopback", "GET", "/api/status");
  expect(statusResponse.status).toBe(200);
  const status = await statusResponse.text();
  const board = JSON.stringify(await boardView(f, { includeWebhookUrls: true }));
  const secrets = await (await op(ctx, "loopback", "secret list")).text();
  for (const text of [status, board, secrets, ...errors, JSON.stringify(logged)]) expect(text).not.toContain(VALUE);
  expect(getSecret(s, "LINEAR_KEY")).toBe(VALUE);
});
