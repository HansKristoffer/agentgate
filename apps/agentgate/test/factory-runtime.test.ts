import { afterEach, expect, spyOn, test } from "bun:test";
import { revision } from "../src/configuration.ts";
import { app, makeCtx, type Listener } from "../src/daemon.ts";
import {
  ensureFactoryTables,
  items,
  runs,
  scores,
  transcripts,
  trimFactory,
  type FactoryItem,
  type FactoryRun,
} from "../src/factory/db.ts";
import { later, loopTask, withItem, type ForwardOp, type ToolCaller } from "../src/factory/runtime.ts";
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

test("items, runs, transcripts and scores keep every field, and the tables survive being created again", () => {
  const { s } = fixture();
  ensureFactoryTables(s);

  const item = items.insert(s, {
    id: "it_1",
    source: "bugs",
    externalId: "acme/api#12",
    key: "api-12",
    repo: "acme/api",
    title: "Crash on save",
    url: "https://github.com/acme/api/issues/12",
    snapshot: { body: "steps", labels: ["factory"] },
    phase: "implement",
    needsYou: { reason: "decision", question: "Which API?", recommendation: "v2", link: "https://t3/x" },
    prUrl: "https://github.com/acme/api/pull/13",
    prCommit: "abc1234",
    configCommit: "3f2c1a9",
  });
  ensureFactoryTables(s);
  expect(item).toMatchObject({ touches: 0, phaseAt: item.createdAt });
  expect(items.get(s, "it_1")).toEqual(item);
  expect(items.byExternal(s, "acme/api#12")).toEqual(item);
  expect(items.byKey(s, "api-12")).toEqual(item);
  // One item per issue and per key, whichever source took it in.
  expect(() => items.insert(s, { ...item, id: "it_2", source: "other", key: "api-12b" })).toThrow();
  expect(() => items.insert(s, { ...item, id: "it_3", externalId: "acme/api#13" })).toThrow();

  s.now = () => item.updatedAt + 1000;
  const cleared = items.update(s, "it_1", { phase: "shipped", needsYou: undefined, url: undefined, touches: 2 });
  expect(cleared).toEqual({
    ...item,
    phase: "shipped",
    needsYou: undefined,
    url: undefined,
    touches: 2,
    updatedAt: item.updatedAt + 1000,
    finishedAt: item.updatedAt + 1000,
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
    checked: { kind: "implement", pr: "https://github.com/acme/api/pull/13", head: "abc1234", headAt: 4 },
    verdict: "success",
    nudges: 1,
    tokens: 0,
    sessions: 0,
    error: "none",
    configCommit: "3f2c1a9",
    launchSession: "session-1",
    queuedAt: 1,
    startedAt: 2,
    endedAt: 3,
  };
  runs.insert(s, run);
  expect(runs.get(s, "run_1")).toEqual(run);
  // A value no kind reads is no run data.
  s.db.run("update factory_runs set checked=? where id=?", [JSON.stringify({ checks: "passing" }), "run_1"]);
  expect(runs.get(s, "run_1")!.checked).toBeUndefined();
  transcripts.put(s, "run_1", "the transcript");
  expect(transcripts.get(s, "run_1")).toBe("the transcript");
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
  expect(runs.heads(s, ["running", "reported"]).map((r) => r.id)).toEqual(["run_2"]);
  expect(runs.byThreads(s, ["thread-1", "elsewhere"]).map((r) => [r.id, r.item])).toEqual([["run_1", "it_1"]]);

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

test("open items stay; items finished 90 days ago go with their runs, transcripts and scores", () => {
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
    transcripts.put(s, `run_${id}`, "transcript");
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
  expect(transcripts.get(s, "run_old-done")).toBeUndefined();
  expect(transcripts.get(s, "run_old-open")).toBe("transcript");
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
  expect((await builtin.listTools()).tools.map((t) => t.name)).toContain("factory_echo");
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
    error: "Update agentgate on old first: older versions cannot sync factory settings and secrets",
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

test("an item's steps never overlap and a failed one does not hold up the next; steps of two items run side by side", async () => {
  const { f } = fixture();
  const log: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const step = (name: string, wait?: Promise<void>) => async () => {
    log.push(`${name} starts`);
    await wait;
    log.push(`${name} ends`);
  };
  const first = withItem(f, "it_1", step("first", gate));
  const failing = withItem(f, "it_1", async () => {
    log.push("failing starts");
    throw new Error("broke");
  });
  const second = withItem(f, "it_1", step("second"));
  const other = withItem(f, "it_2", step("other"));
  await other;
  expect(log).toEqual(["first starts", "other starts", "other ends"]);
  release();
  await first;
  await expect(failing).rejects.toThrow("broke");
  await second;
  expect(log).toEqual([
    "first starts",
    "other starts",
    "other ends",
    "first ends",
    "failing starts",
    "second starts",
    "second ends",
  ]);
  expect(f.locks.size).toBe(0);

  // Work queued from inside a step runs after it, and its failure is a note on the item.
  await withItem(f, "it_1", async () => {
    later(f, "it_1", "Posting", async () => {
      log.push("later");
      throw new Error("GitHub said no");
    });
    log.push("queued");
  });
  while (f.locks.size) await Promise.all([...f.locks.values()]);
  expect(log.slice(-2)).toEqual(["queued", "later"]);
  expect(f.events.recent(1)[0]).toMatchObject({ item: "it_1", text: "Posting failed: GitHub said no" });
});

test("an item's tokens are its runs' sum and only grow, and a later change to a finished item keeps when it finished", () => {
  const { s } = fixture();
  s.now = () => 1000;
  items.insert(s, {
    id: "it_t",
    source: "bugs",
    externalId: "acme/api#77",
    key: "api-77",
    repo: "acme/api",
    title: "t",
    snapshot: {},
    phase: "implement",
    configCommit: "c",
  });
  for (const id of ["run_a", "run_b"])
    runs.insert(s, { id, item: "it_t", kind: "implement", attempt: 1, state: "running", nudges: 0, configCommit: "c" });
  runs.measured(s, "run_a", 500, 1);
  runs.measured(s, "run_b", 700, 2);
  runs.measured(s, "run_a", 300, 1); // a dropped subagent thread does not lower the count
  expect(items.get(s, "it_t")!.tokens).toBe(1200);

  s.now = () => 2000;
  items.update(s, "it_t", { phase: "shipped" });
  s.now = () => 9000;
  items.update(s, "it_t", { touches: 1 });
  expect(items.get(s, "it_t")).toMatchObject({ finishedAt: 2000, updatedAt: 9000 });
  expect(items.list(s, { finishedSince: 3000 })).toEqual([]);
});
