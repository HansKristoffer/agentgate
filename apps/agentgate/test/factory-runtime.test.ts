import { afterEach, expect, spyOn, test } from "bun:test";
import { revision } from "../src/configuration.ts";
import { app, makeCtx, type Listener } from "../src/daemon.ts";
import {
  ensureFactoryTables,
  items,
  runs,
  scores,
  trimFactory,
  type FactoryItem,
  type FactoryRun,
} from "../src/factory/db.ts";
import { loopTask, type ForwardOp, type ToolCaller } from "../src/factory/runtime.ts";
import { Store } from "../src/store.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

function fixture() {
  const s = new Store(":memory:");
  s.setLocal("node", "a");
  s.setLocal("adminToken", "admin-secret");
  s.put("node", "a", { id: "a", protocol: 8 });
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

function caller(handler: ReturnType<typeof app>) {
  return (path: string, method = "GET", body?: unknown, listener: Listener = "loopback", headers = {}) =>
    handler.fetch(
      new Request(`http://127.0.0.1:7878${path}`, {
        method,
        headers: {
          host: "127.0.0.1:7878",
          ...(body !== undefined && { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { listener },
    );
}

const useFactory = (s: Store, node: string) =>
  s.put("setting", "settings", { ...s.settings(), factory: { repo: "acme/api", node } });

test("items, runs and scores keep every field, and the tables survive being created again", () => {
  const { s } = fixture();
  ensureFactoryTables(s);

  const item = items.insert(s, {
    id: "it_1",
    source: "bugs",
    externalId: "acme/api#12",
    key: "gh-12",
    repo: "acme/api",
    title: "Crash on save",
    url: "https://github.com/acme/api/issues/12",
    snapshot: { body: "steps", labels: ["factory"] },
    phase: "implement",
    needsYou: { reason: "decision", question: "Which API?", recommendation: "v2", link: "https://t3/x" },
    prUrl: "https://github.com/acme/api/pull/13",
    prCommit: "abc1234",
    configCommit: "3f2c1a9",
    tokens: 1200,
  });
  ensureFactoryTables(s);
  expect(items.get(s, "it_1")).toEqual(item);
  expect(items.byExternal(s, "bugs", "acme/api#12")).toEqual(item);

  s.now = () => item.updatedAt + 1000;
  const cleared = items.update(s, "it_1", { phase: "shipped", needsYou: undefined, url: undefined });
  expect(cleared).toEqual({
    ...item,
    phase: "shipped",
    needsYou: undefined,
    url: undefined,
    updatedAt: item.updatedAt + 1000,
  });

  const run: FactoryRun = {
    id: "run_1",
    item: "it_1",
    kind: "implement",
    attempt: 2,
    state: "reported",
    node: "a",
    threadId: "thread-1",
    threadLink: "t3://thread-1",
    commitSha: "abc1234",
    report: { run: "run_1", outcome: "done", summary: "fixed" },
    checked: { checks: "passing" },
    verdict: "success",
    transcript: "...",
    nudges: 1,
    error: "none",
    configCommit: "3f2c1a9",
    queuedAt: 1,
    startedAt: 2,
    endedAt: 3,
  };
  runs.insert(s, run);
  expect(runs.get(s, "run_1")).toEqual(run);
  const learn = runs.insert(s, {
    id: "run_2",
    kind: "learn",
    attempt: 1,
    state: "queued",
    nudges: 0,
    configCommit: "3f2c1a9",
  });
  expect(runs.get(s, "run_2")).toEqual(learn);
  expect(runs.update(s, "run_2", { state: "running", startedAt: 5 })).toEqual({
    ...learn,
    state: "running",
    startedAt: 5,
  });
  expect(runs.forItem(s, "it_1").map((r) => r.id)).toEqual(["run_1"]);
  expect(runs.list(s, { states: ["running"], kinds: ["learn"] }).map((r) => r.id)).toEqual(["run_2"]);
  expect(runs.list(s, { endedSince: 3 }).map((r) => r.id)).toEqual(["run_1"]);

  const score = {
    run: "run_1",
    scorer: "tests",
    label: "good",
    score: 1,
    passed: true,
    reasoning: "ok",
    judgeRun: "run_3",
    at: 50,
  };
  scores.put(s, score);
  expect(scores.forRun(s, "run_1")).toEqual([score]);
  expect(scores.since(s, 51)).toEqual([]);
});

test("open items stay; items finished 90 days ago go with their runs and scores", () => {
  const { s } = fixture();
  const day = 24 * 3600_000;
  const base = { source: "bugs", repo: "acme/api", title: "t", snapshot: {}, configCommit: "c", tokens: 0 };
  const add = (id: string, phase: FactoryItem["phase"]) => {
    items.insert(s, { ...base, id, externalId: id, key: id, phase });
    runs.insert(s, {
      id: `run_${id}`,
      item: id,
      kind: "triage",
      attempt: 1,
      state: "reported",
      nudges: 0,
      configCommit: "c",
    });
    scores.put(s, {
      run: `run_${id}`,
      scorer: "x",
      label: "y",
      score: 1,
      passed: true,
      reasoning: "",
      judgeRun: "j",
      at: 0,
    });
  };
  s.now = () => 0;
  add("old-open", "review");
  add("old-done", "shipped");
  s.now = () => 80 * day;
  add("recent-done", "closed");

  s.now = () => 91 * day;
  trimFactory(s);
  expect(items.list(s).map((i) => i.id)).toEqual(["old-open", "recent-done"]);
  expect(runs.list(s).map((r) => r.id)).toEqual(["run_old-open", "run_recent-done"]);
  expect(scores.forRun(s, "run_old-done")).toEqual([]);
  expect(items.list(s, { open: true }).map((i) => i.id)).toEqual(["old-open"]);
  expect(items.list(s, { finishedSince: 85 * day }).map((i) => i.id)).toEqual(["old-open"]);
});

test("events are recorded and reach their listeners, and a failing listener never reaches the emitter", async () => {
  const { f } = fixture();
  let asyncLogged!: () => void;
  const logged = new Promise<void>((resolve) => (asyncLogged = resolve));
  const errors = spyOn(console, "error").mockImplementation((line) => {
    if (String(line).includes("RangeError")) asyncLogged();
  });
  cleanup.push(async () => errors.mockRestore());
  const phases: string[] = [];
  f.events.on("item.phase", (e) => {
    phases.push(`${e.from}->${e.to}`);
  });
  f.events.on("item.phase", () => {
    throw new TypeError("sync listener broke");
  });
  f.events.on("item.phase", async () => {
    throw new RangeError("async listener broke");
  });

  f.events.emit({ kind: "item.phase", item: "it_1", from: "triage", to: "implement", text: "Triaged" });
  f.events.emit({ kind: "writeback", item: "it_1", moment: "triaged", status: "posted", text: "Commented" });
  await logged;

  expect(phases).toEqual(["triage->implement"]);
  expect(f.events.recent(10).map(({ item, kind, text }) => ({ item, kind, text }))).toEqual([
    { item: "it_1", kind: "writeback:triaged", text: "Commented" },
    { item: "it_1", kind: "item.phase", text: "Triaged" },
  ]);
  expect(f.events.has("it_1", "writeback:triaged")).toBe(true);
  expect(f.events.has("it_1", "writeback:ready")).toBe(false);
  expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([
    "factory: item.phase listener failed: TypeError",
    "factory: item.phase listener failed: RangeError",
  ]);
});

test("a feature's route, peer route, command and tool are reachable, and its factory-node loop runs only there", async () => {
  const { s, ctx, f } = fixture();
  f.api.get("/hello", (c) => c.json({ hello: true }));
  f.peer.get("/ping", (c) => c.json({ pong: true }));
  f.commands.set("echo", {
    usage: "echo <words>",
    run: async (args, io) => {
      io.out(args.join(" "));
      io.out(`stdin: ${io.stdin}`);
      return 3;
    },
  });
  const callers: ToolCaller[] = [];
  f.tools.set("factory_echo", {
    name: "factory_echo",
    description: "Echoes",
    inputSchema: { type: "object", properties: { word: { type: "string" } } },
    call: async (args, from) => {
      callers.push(from);
      return { word: args.word };
    },
  });
  let loops = 0;
  const loop = loopTask(f, { name: "count", everyMs: 1000, where: "factory-node", run: async () => void loops++ });
  const call = caller(app(ctx));

  expect(await (await call("/api/factory/hello")).json()).toEqual({ hello: true });

  expect((await call("/peer/factory/ping", "GET", undefined, "tailnet")).status).toBe(401);
  s.db.run("insert into peers values ('b', 'http://b', 'peer-token', 0, null)");
  const ping = await call("/peer/factory/ping", "GET", undefined, "tailnet", { authorization: "Bearer peer-token" });
  expect(await ping.json()).toEqual({ pong: true });

  expect(await (await call("/api/factory/commands")).json()).toContainEqual({ name: "echo", usage: "echo <words>" });
  const command = { name: "echo", args: ["a", "--b"], stdin: "in" };
  expect(await (await call("/api/factory/command", "POST", command)).json()).toEqual({
    code: 3,
    output: ["a --b", "stdin: in"],
  });
  const remote = await call("/api/factory/command", "POST", command, "tailnet", {
    authorization: "Bearer admin-secret",
  });
  expect(remote.status).toBe(403);

  const builtin = (await ctx.gateway.builtin!()).client;
  expect((await builtin.listTools()).tools).toEqual([]);
  await loop();
  expect(loops).toBe(0);

  useFactory(s, "a");
  expect((await builtin.listTools()).tools.map((t) => t.name)).toEqual(["factory_echo"]);
  const result = await builtin.callTool({
    name: "factory_echo",
    arguments: { word: "hi" },
    _meta: { "dev.agentgate/t3Thread": "thread-1" },
  });
  expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual({ word: "hi" });
  expect(callers).toEqual([{ thread: "thread-1", node: "a" }]);
  await loop();
  expect(loops).toBe(1);

  useFactory(s, "b");
  await loop();
  expect(loops).toBe(1);
});

test("on another machine, commands go to the factory machine, and fail clearly when it cannot be reached", async () => {
  const { s, ctx, f } = fixture();
  f.commands.set("status", {
    usage: "status",
    run: async (_, io) => {
      io.out("here");
      return 0;
    },
  });
  f.commands.set("t3", {
    usage: "t3",
    local: true,
    run: async (_, io) => {
      io.out("local");
      return 0;
    },
  });
  const call = caller(app(ctx));
  const run = async (name: string) => {
    const res = await call("/api/factory/command", "POST", { name, args: ["--json"] });
    return { status: res.status, body: await res.json() };
  };

  expect(await run("status")).toEqual({ status: 200, body: { code: 0, output: ["here"] } });

  useFactory(s, "b");
  expect(await run("status")).toEqual({
    status: 400,
    body: { error: "The factory runs on b, and this machine cannot reach it" },
  });

  const sent: ForwardOp[] = [];
  f.forwarder = async (op) => {
    sent.push(op);
    return { code: 2, output: ["from b"] };
  };
  expect(await run("status")).toEqual({ status: 200, body: { code: 2, output: ["from b"] } });
  expect(sent).toEqual([{ kind: "command", name: "status", args: ["--json"] }]);
  expect(await run("t3")).toEqual({ status: 200, body: { code: 0, output: ["local"] } });
});

test("the factory setting waits until every machine understands it, and null turns it off", async () => {
  const { s, ctx } = fixture();
  s.put("node", "old", { id: "old", protocol: 7 });
  const call = caller(app(ctx));
  const patch = (value: unknown) =>
    call("/api/settings", "PATCH", { revision: revision(s, "setting", "settings"), patch: { factory: value } });
  const pointer = { repo: "acme/api", node: "a" };

  const refused = await patch(pointer);
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({
    error: "Update agentgate on old first: older versions drop the factory setting",
  });
  expect(s.settings().factory).toBeUndefined();

  s.put("node", "old", { id: "old", protocol: 8 });
  expect((await patch(pointer)).status).toBe(200);
  expect(s.settings().factory).toEqual({ ...pointer, path: "" });

  await call("/api/settings", "PATCH", { revision: revision(s, "setting", "settings"), patch: { threshold: 90 } });
  expect(s.settings().factory).toEqual({ ...pointer, path: "" });

  expect((await patch(null)).status).toBe(200);
  expect(s.settings().factory).toBeUndefined();
  expect(s.settings().threshold).toBe(90);
});
