import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { operationFor, type FactoryCommandResult, type FactoryOperationInfo } from "@agentgate/protocol";
import { z } from "zod";
import { revision } from "../src/configuration.ts";
import { app, makeCtx, type Listener } from "../src/daemon.ts";
import { ensureFactoryTables, items, runs, trimFactory, type FactoryItem, type FactoryRun } from "../src/factory/db.ts";
import {
  Backoff,
  later,
  loopTask,
  operation,
  SayOnce,
  UsageError,
  withItem,
  type Caller,
  type FactoryRuntime,
  type ForwardOp,
  type Operation,
} from "../src/factory/runtime.ts";
import { getSecret } from "../src/factory/secrets.ts";
import { Store } from "../src/store.ts";
import { removeTmp, tmp } from "./fixtures/git.ts";

afterAll(removeTmp);

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
  s.put("setting", "settings", { ...s.settings(), factory: { store: "github", repo: "acme/api", node } });

test("items and runs keep every field, and the tables survive being created again", () => {
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
    needsYou: {
      kind: "answer",
      cause: "decision",
      title: "Needs a decision",
      question: "Which API?",
      recommendation: "v2",
      options: ["v1", "v2"],
      link: "https://t3/x",
      since: 1,
      run: "run_1",
    },
    pr: {
      url: "https://github.com/acme/api/pull/13",
      head: "abc1234",
      headAt: 4,
      run: "run_1",
      thread: "thread-1",
      nudges: 1,
      conversations: { PRRT_1: { outcome: "fixed", commit: "abc1234", seen: "2026-11-05T00:00:00Z" } },
    },
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
    report: { run: "run_1", outcome: "done", summary: "fixed" },
    checked: { kind: "review", head: "abc1234", round: 1 },
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
  const scout = runs.insert(s, {
    id: "run_2",
    kind: "scout",
    attempt: 1,
    state: "queued",
    nudges: 0,
    configCommit: "3f2c1a9",
  });
  expect(runs.get(s, "run_2")).toEqual(scout);
  expect(runs.update(s, "run_2", { state: "running", startedAt: 5 })).toEqual({
    ...scout,
    state: "running",
    startedAt: 5,
  });
  expect(runs.forItem(s, "it_1").map((r) => r.id)).toEqual(["run_1"]);
  expect(runs.list(s, { states: ["running"], kinds: ["scout"] }).map((r) => r.id)).toEqual(["run_2"]);
  expect(runs.list(s, { endedSince: 3 }).map((r) => r.id)).toEqual(["run_1"]);
  expect(runs.heads(s, ["running", "reported"]).map((r) => r.id)).toEqual(["run_2"]);
  expect(runs.byThreads(s, ["thread-1", "elsewhere"]).map((r) => [r.id, r.item])).toEqual([["run_1", "it_1"]]);
});

test("open items stay; items finished 90 days ago go with their runs", () => {
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

const word = z.object({ word: z.string().max(10).optional() }).strict();
/** An operation of a feature under test: it says its word back, and records its input and who called. */
function echo(f: FactoryRuntime, name: string, more: Partial<Operation<typeof word, { said: string }>> = {}) {
  const calls: { input: { word?: string }; caller: Caller }[] = [];
  operation(f, {
    name,
    summary: "says it back",
    input: word,
    run: async (input, caller) => {
      calls.push({ input, caller });
      return { said: input.word ?? "" };
    },
    terminal: {
      usage: `${name} [<word>] [--json]`,
      parse(args) {
        const words = args.filter((a) => a !== "--json");
        if (words.length > 1) throw new UsageError();
        return { input: { ...(words[0] && { word: words[0] }) }, json: args.includes("--json") };
      },
      print: ({ said }, { input, json }) =>
        json ? [JSON.stringify({ said })] : { lines: [`said ${said}`, `asked ${input.word}`], code: 3 },
    },
    ...more,
  });
  return calls;
}

test("one operation is reached from the terminal, the control API and an agent's tool, each naming its caller, and its factory-node loop runs only there", async () => {
  const { s, ctx, f } = fixture();
  f.api.get("/hello", (c) => c.json({ hello: true }));
  f.peer.get("/ping", (c) => c.json({ pong: true }));
  const calls = echo(f, "echo", {
    tool: { name: "factory_echo", description: "Echoes", result: ({ said }) => ({ word: said }) },
  });
  let loops = 0;
  const loop = loopTask(f, { name: "count", everyMs: 1000, where: "factory-node", run: async () => void loops++ });
  const call = caller(app(ctx));

  expect(await (await call("/api/factory/hello")).json()).toEqual({ hello: true });

  expect((await call("/peer/factory/ping", "GET", undefined, "tailnet")).status).toBe(401);
  s.db.run("insert into peers values ('b', 'http://b', 'peer-token', 0, null)");
  const ping = await call("/peer/factory/ping", "GET", undefined, "tailnet", { authorization: "Bearer peer-token" });
  expect(await ping.json()).toEqual({ pong: true });

  // The terminal: its words parsed and its result printed by the operation, with the exit code it gives.
  expect(await (await call("/api/factory/operations")).json()).toContainEqual({
    name: "echo",
    summary: "says it back",
    usage: "echo [<word>] [--json]",
  });
  const typed = (...args: string[]) => call("/api/factory/terminal", "POST", { args });
  expect(await (await typed("echo", "hi")).json()).toEqual({ code: 3, output: ["said hi", "asked hi"] });
  expect(await (await typed("echo", "hi", "--json")).json()).toEqual({ code: 0, output: ['{"said":"hi"}'] });
  // Words it cannot read print its own usage.
  expect(await (await typed("echo", "a", "b")).json()).toEqual({
    code: 2,
    output: ["usage: agentgate factory echo [<word>] [--json]"],
  });
  const remote = await call("/api/factory/terminal", "POST", { args: ["echo"] }, "tailnet", {
    authorization: "Bearer admin-secret",
  });
  expect(remote.status).toBe(403);

  // The control API: the input as JSON, the result as it is, and a refusal as a 400 with its reason.
  const op = (name: string, input: unknown) => call(`/api/factory/op/${encodeURIComponent(name)}`, "POST", input);
  expect(await (await op("echo", { word: "hey" })).json()).toEqual({ said: "hey" });
  const invalid = await op("echo", { word: "much too long a word" });
  expect([invalid.status, ((await invalid.json()) as { error: string }).error]).toEqual([400, "invalid input"]);
  operation(f, {
    name: "refuse",
    summary: "refuses",
    input: z.object({}),
    run: async () => {
      throw new Error("Not today");
    },
  });
  const refused = await op("refuse", {});
  expect([refused.status, await refused.json()]).toEqual([400, { error: "Not today" }]);
  expect((await op("nonesuch", {})).status).toBe(404);

  const builtin = (await ctx.gateway.builtin!()).client;
  expect((await builtin.listTools()).tools).toEqual([]);
  await loop();
  expect(loops).toBe(0);

  useFactory(s, "a");
  const listed = (await builtin.listTools()).tools.find((t) => t.name === "factory_echo");
  expect(listed).toMatchObject({
    description: "Echoes",
    inputSchema: {
      type: "object",
      properties: { word: { type: "string", maxLength: 10 } },
      additionalProperties: false,
    },
  });
  const tool = (args: Record<string, unknown>) =>
    builtin.callTool({ name: "factory_echo", arguments: args, _meta: { "dev.agentgate/t3Thread": "thread-1" } });
  // The tool answers with its own form of the result, as JSON text.
  expect(JSON.parse(((await tool({ word: "hi" })).content as { text: string }[])[0]!.text)).toEqual({ word: "hi" });
  // Arguments the schema refuses are a tool error that names the field.
  expect(await tool({ word: "hi", extra: 1 })).toMatchObject({
    isError: true,
    content: [{ text: 'extra: Unrecognized key: "extra"' }],
  });
  expect(calls).toEqual([
    { input: { word: "hi" }, caller: { via: "terminal", node: "a" } },
    { input: { word: "hi" }, caller: { via: "terminal", node: "a" } },
    { input: { word: "hey" }, caller: { via: "api", node: "a" } },
    { input: { word: "hi" }, caller: { via: "tool", thread: "thread-1", node: "a" } },
  ]);
  await loop();
  expect(loops).toBe(1);

  useFactory(s, "b");
  await loop();
  expect(loops).toBe(1);
});

test("on another machine, an operation goes to the factory machine with its input and its caller, and fails clearly when that cannot be reached", async () => {
  const { s, ctx, f } = fixture();
  const here = echo(f, "echo", { tool: { name: "factory_echo", description: "Echoes" } });
  const local = echo(f, "echo here", { local: true });
  const call = caller(app(ctx));
  const typed = async (...args: string[]) => {
    const res = await call("/api/factory/terminal", "POST", { args });
    return { status: res.status, body: await res.json() };
  };

  expect(await typed("echo", "hi")).toEqual({ status: 200, body: { code: 3, output: ["said hi", "asked hi"] } });

  useFactory(s, "b");
  expect(await typed("echo", "hi")).toEqual({
    status: 400,
    body: { error: "The factory runs on b, and this machine cannot reach it" },
  });

  const sent: ForwardOp[] = [];
  f.forwarder = async (op) => {
    sent.push(op);
    return { said: "from b" };
  };
  // The words are parsed here and the result is printed here; the typed input and the caller travel.
  expect(await typed("echo", "hi")).toEqual({ status: 200, body: { code: 3, output: ["said from b", "asked hi"] } });
  // A usage error and an input the schema refuses never leave this machine.
  expect((await typed("echo", "a", "b")).body).toMatchObject({ code: 2 });
  expect((await typed("echo", "much too long a word")).status).toBe(400);
  const builtin = (await ctx.gateway.builtin!()).client;
  const result = await builtin.callTool({
    name: "factory_echo",
    arguments: { word: "yo" },
    _meta: { "dev.agentgate/t3Thread": "thread-9" },
  });
  expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual({ said: "from b" });
  expect(sent).toEqual([
    { name: "echo", input: { word: "hi" }, caller: { via: "terminal", node: "a" } },
    { name: "echo", input: { word: "yo" }, caller: { via: "tool", thread: "thread-9", node: "a" } },
  ]);
  expect(here).toHaveLength(1);

  // A local operation runs where it is asked, whoever runs the factory.
  expect((await typed("echo", "here", "now")).body).toEqual({ code: 3, output: ["said now", "asked now"] });
  expect(local.map((c) => c.input)).toEqual([{ word: "now" }]);
  expect(sent).toHaveLength(2);
});

test("the factory machine runs a forwarded operation with the caller that came along, and no other machine takes one", async () => {
  const { s, ctx, f } = fixture();
  const calls = echo(f, "echo");
  s.db.run("insert into peers values ('b', 'http://b', 'peer-token', 0, null)");
  const forwarded = (body: unknown) =>
    caller(app(ctx))("/peer/factory/op", "POST", body, "tailnet", { authorization: "Bearer peer-token" });
  const op = { name: "echo", input: { word: "hi" }, caller: { via: "tool", thread: "thread-9", node: "b" } };

  useFactory(s, "b");
  const elsewhere = await forwarded(op);
  expect([elsewhere.status, await elsewhere.json()]).toEqual([409, { error: "a does not run the factory" }]);

  useFactory(s, "a");
  expect(await (await forwarded(op)).json()).toEqual({ said: "hi" });
  expect(calls).toEqual([{ input: { word: "hi" }, caller: { via: "tool", thread: "thread-9", node: "b" } }]);
  expect((await forwarded({ ...op, caller: { node: "b" } })).status).toBe(400);
  const unknown = await forwarded({ ...op, name: "nonesuch" });
  expect([unknown.status, await unknown.json()]).toEqual([400, { error: "unknown factory operation nonesuch" }]);
});

test("the words name the operation with the longest name they start with, and words that name none are refused", async () => {
  const { ctx, f } = fixture();
  echo(f, "echo");
  echo(f, "echo twice");
  const typed = async (...args: string[]) => {
    const res = await caller(app(ctx))("/api/factory/terminal", "POST", { args });
    return { status: res.status, body: await res.json() };
  };

  expect((await typed("echo", "twice", "hi")).body).toMatchObject({ output: ["said hi", "asked hi"] });
  expect((await typed("echo", "twice")).body).toMatchObject({ output: ["said ", "asked undefined"] });
  expect((await typed("echo", "thrice")).body).toMatchObject({ output: ["said thrice", "asked thrice"] });
  // `secret set NAME` is `secret set`, never `secret` with two arguments: there is no `secret`.
  expect((await typed("secret", "list")).body).toEqual({ code: 0, output: ["No factory secrets."] });
  // A first word that several operations share answers with the ones it could have meant, and repeats no value.
  const family = (await typed("secret", "sett", "LINEAR_KEY", "blue")).body as FactoryCommandResult;
  expect((await typed("secret")).body).toEqual(family);
  expect(family.code).toBe(2);
  expect(family.output.map((line) => line.split(" ").slice(0, 5).join(" "))).toEqual([
    "usage: agentgate factory secret set",
    "usage: agentgate factory secret list",
    "usage: agentgate factory secret delete",
  ]);
  expect(await typed("nonesuch", "LINEAR_KEY", "blue", "x")).toEqual({
    status: 400,
    body: { error: "unknown factory command nonesuch; run agentgate factory help" },
  });
  // An operation only agents call has no words.
  expect((await typed("report")).body).toEqual({ error: "unknown factory command report; run agentgate factory help" });
});

test("only the operations that take input on stdin are said to read it", async () => {
  const { ctx } = fixture();
  const listed = await caller(app(ctx))("/api/factory/operations");
  const operations = (await listed.json()) as FactoryOperationInfo[];
  const reads = (line: string) => !!operationFor(operations, line.split(" "))?.stdin;

  expect(
    operations
      .filter((op) => op.stdin)
      .map((op) => op.name)
      .toSorted(),
  ).toEqual(["deliver", "folder put", "secret set", "source add", "source test"]);
  expect(
    [
      "status",
      "status --json",
      "reload",
      "secret list",
      "secret delete LINEAR_KEY",
      "secret set LINEAR_KEY",
      "folder ls",
      "folder cat put",
      "folder put factory.yaml",
      "source add",
      "source add --json",
      "source --json add",
      "nonesuch add",
    ].filter(reads),
  ).toEqual(["secret set LINEAR_KEY", "folder put factory.yaml", "source add", "source add --json"]);
});

test("the CLI answers a command while its stdin stays open and silent, still pipes a value to one that takes it, lists the commands and refuses an unknown one", async () => {
  const { s, ctx } = fixture();
  const handler = app(ctx);
  const daemon = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => handler.fetch(req, { listener: "loopback" }),
  });
  cleanup.push(() => daemon.stop(true));
  // The CLI from this checkout, pointed at the daemon above and at an empty home of its own.
  const cli = (...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "factory", ...args], {
      env: { ...process.env, AGENTGATE_HOME: tmp(), AGENTGATE_PORT: String(daemon.port), AGENTGATE_DEV: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    cleanup.push(async () => child.kill());
    return child;
  };

  // As under an agent or a cron job: stdin is a pipe nobody writes to or closes.
  const status = cli("status");
  const set = cli("secret", "set", "LINEAR_KEY");
  set.stdin.write("blue\n");
  set.stdin.end();

  expect(await status.exited).toBe(0);
  expect(await new Response(status.stdout).text()).toStartWith("Factory: off\n");
  expect(await set.exited).toBe(0);
  expect(getSecret(s, "LINEAR_KEY")).toBe("blue");

  // Help: the commands to start with, then the rest, with those that share a first word together.
  const help = cli("help");
  expect(await help.exited).toBe(0);
  const groups = (await new Response(help.stdout).text())
    .trim()
    .split("\n\n")
    .map((group) => group.split("\n"));
  const names = (lines: string[]) => lines.map((line) => line.trim().split(/ {2,}/)[0]);
  expect(names(groups[0]!)).toEqual([
    "factory init <owner/repo> [--label <label>] [--node <machine>] [--json]",
    "factory status [--all] [--json]",
    "factory add <owner/repo> <title> [--body <text>] [--json]",
    "factory approve <item> [--reason <text>]",
    "factory show <item> [--json]",
  ]);
  expect(groups[0]![1]).toMatch(/^  factory status \[--all\] \[--json\] {2,}the board: items by phase/);
  expect(groups.slice(2).map((group) => names(group).map((usage) => usage!.split(" ")[1]))).toEqual([
    ["folder", "folder", "folder", "folder", "folder", "folder", "folder"],
    ["repo", "repo"],
    ["t3", "t3"],
    ["secret", "secret", "secret"],
    ["source", "source"],
  ]);

  const unknown = cli("nonesuch", "words");
  expect(await unknown.exited).toBe(1);
  expect(await new Response(unknown.stderr).text()).toBe(
    "unknown factory command nonesuch; run agentgate factory help\n",
  );
});

test("the generic settings patch cannot write the factory pointer", async () => {
  const { s, ctx } = fixture();
  const call = caller(app(ctx));
  const res = await call("/api/settings", "PATCH", {
    revision: revision(s, "setting", "settings"),
    patch: { factory: { store: "github", repo: "acme/api", node: "a" } },
  });
  expect(res.status).toBe(400);
  expect(s.settings().factory).toBeUndefined();
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

test("a loop that fails every pass logs its name once per distinct error, and again after it recovers", async () => {
  const { s, f } = fixture();
  useFactory(s, "a");
  const errors = spyOn(console, "error").mockImplementation(() => {});
  cleanup.push(async () => void errors.mockRestore());
  let failure: Error | undefined = new TypeError("secret detail");
  const loop = loopTask(f, {
    name: "flaky",
    everyMs: 1000,
    where: "every-node",
    run: async () => {
      if (failure) throw failure;
    },
  });
  await loop();
  await loop();
  failure = new RangeError("other");
  await loop();
  failure = undefined;
  await loop();
  failure = new RangeError("other");
  await loop();
  // An error whose text agentgate did not write is logged by its name only.
  expect(errors.mock.calls.map((c) => c[0])).toEqual([
    "factory: the flaky loop failed: TypeError",
    "factory: the flaky loop failed: RangeError",
    "factory: the flaky loop failed: RangeError",
  ]);
});

test("SayOnce says a key's text once, again when the text changes, and again after the key recovered", () => {
  const said = new SayOnce();
  expect(said.fresh("loop", "HTTP 502")).toBe(true);
  expect(said.fresh("loop", "HTTP 502")).toBe(false);
  expect(said.fresh("other", "HTTP 502")).toBe(true);
  expect(said.fresh("loop", "HTTP 503")).toBe(true);
  expect(said.clear("loop")).toBe(true);
  expect(said.clear("loop")).toBe(false);
  expect(said.fresh("loop", "HTTP 503")).toBe(true);
  // Keys left out are forgotten, so they are said again.
  said.keepOnly((key) => key === "loop");
  expect(said.fresh("loop", "HTTP 503")).toBe(false);
  expect(said.fresh("other", "HTTP 502")).toBe(true);
});

test("Backoff waits its base after a failure, doubling up to its most, per key, until the key works again", () => {
  let now = 1000;
  const backoff = new Backoff({ now: () => now }, { baseMs: 100, maxMs: 350 });
  expect(backoff.due("a")).toBe(true);
  expect([backoff.failed("a"), backoff.failed("a"), backoff.failed("a"), backoff.failed("a")]).toEqual([
    1100, 1200, 1350, 1350,
  ]);
  expect(backoff.due("a")).toBe(false);
  expect(backoff.due("b")).toBe(true);
  now = 1350;
  expect(backoff.due("a")).toBe(true);
  // A count the caller keeps itself, such as one stored on a run, sets the wait.
  expect(backoff.failed("b", 2)).toBe(1550);
  expect(backoff.ok("a")).toBe(true);
  expect(backoff.ok("a")).toBe(false);
  expect(backoff.failed("a")).toBe(1450);
});
