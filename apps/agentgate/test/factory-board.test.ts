import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { factoryBoardSchema, type FactoryBoard } from "@agentgate/protocol";
import { app, makeCtx, type Listener } from "../src/daemon.ts";
import { buildBoard } from "../src/factory/board.ts";
import { items } from "../src/factory/db.ts";
import { mirrorOf, timing } from "../src/factory/mirror.ts";
import { FACTORY_PAGE } from "../src/factory/page.ts";
import { connectT3 } from "../src/handoff/t3.ts";
import { Store } from "../src/store.ts";
import { removeTmp, tmp } from "./fixtures/git.ts";
import { startNodes } from "./fixtures/nodes.ts";
import { fakeT3 } from "./fixtures/t3.ts";

afterAll(removeTmp);

const pollMs = timing.pollMs;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  timing.pollMs = pollMs;
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function until(fn: () => unknown, what: string) {
  const deadline = Date.now() + 3_000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

function fixture() {
  const s = new Store(":memory:");
  s.setLocal("node", "a");
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

async function withT3(s: Store, routes?: (req: Request) => Response | undefined) {
  const fake = fakeT3({ claudeDir: tmp(), routes });
  cleanup.push(fake.stop);
  await connectT3(s, { url: fake.url, token: fake.pairingToken() });
  return fake;
}

const useFactory = (s: Store, node: string) =>
  s.put("setting", "settings", { ...s.settings(), factory: { repo: "acme/api", node } });

function caller(handler: ReturnType<typeof app>) {
  return (path: string, init: { method?: string; body?: unknown; listener?: Listener; headers?: object } = {}) =>
    handler.fetch(
      new Request(`http://127.0.0.1:7878${path}`, {
        method: init.method ?? "GET",
        headers: {
          host: "127.0.0.1:7878",
          ...(init.body !== undefined && { "content-type": "application/json" }),
          ...init.headers,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
      { listener: init.listener ?? "loopback" },
    );
}

const PENDING = { id: "request-1", kind: "approval", createdAt: "2026-11-05T10:00:00.000Z" };
const UPDATED = "2026-11-05T10:00:00.000Z";

/** T3's HTTP shell with one thread waiting on an approval. */
const waitingShell = {
  threads: [
    {
      id: "t-waiting",
      projectId: "p1",
      title: "Needs approval",
      providerInstanceId: "claudeAgent",
      branch: null,
      worktreePath: null,
      status: "waiting",
      archivedAt: null,
      updatedAt: UPDATED,
      createdAt: UPDATED,
      pendingRuntimeRequest: PENDING,
    },
  ],
  archivedThreads: [],
  projects: [{ id: "p1", title: "api", workspaceRoot: "/repo", scripts: [] }],
};

test("the mirror follows T3's stream, marks a thread with a pending request, and polls after an unreadable update", async () => {
  timing.pollMs = 50;
  const { s, f } = fixture();
  const fake = await withT3(s);
  const project = fake.addProject(tmp());
  const thread = fake.addThread({ projectId: project.id, sessionId: "s1", title: "Fix login" });
  useFactory(s, "a");
  const mirror = mirrorOf(f);
  await until(() => mirror.status().stream === "live", "the snapshot");
  expect(mirror.thread(thread.id)).toMatchObject({ title: "Fix login", status: "idle", needsYou: false });

  const changes: string[] = [];
  mirror.onChange((t, before) => changes.push(`${t.id}: ${before?.needsYou} -> ${t.needsYou}`));
  const shell = { id: thread.id, projectId: project.id, title: "Fix login", updatedAt: UPDATED };
  fake.shell.push({
    kind: "thread.updated",
    sequence: 5,
    location: "active",
    thread: { ...shell, status: "waiting", pendingRuntimeRequest: PENDING },
  });
  await until(() => mirror.thread(thread.id)?.needsYou, "the pending request");
  expect(changes).toEqual([`${thread.id}: false -> true`]);
  const live = await buildBoard(f, { includeWebhookUrls: false });
  expect(live.t3).toEqual({ stream: "live", mcp: "off" });
  expect(live.machines[0]).toEqual({
    node: "a",
    online: true,
    threads: [
      {
        id: thread.id,
        title: "Fix login",
        project: "repo",
        status: "waiting",
        needsYou: true,
        updatedAt: Date.parse(UPDATED),
      },
    ],
  });

  fake.shell.push({ kind: "thread.updated", sequence: 6, location: "active", thread: { id: thread.id } });
  await until(() => mirror.status().stream === "polling", "polling");
  const polling = await buildBoard(f, { includeWebhookUrls: false });
  expect(polling.t3.stream).toBe("polling");
  expect(polling.t3.error).toStartWith("T3 Code sent a shell update agentgate cannot read (thread.title:");

  // It resumes after the last update it applied, and is live again once T3 says the stream caught up.
  await until(() => fake.shell.subscriptions.length === 2, "a new subscription");
  expect(fake.shell.subscriptions).toEqual([{}, { afterSequence: 5 }]);
  fake.shell.push({ kind: "synchronized" });
  await until(() => mirror.status().stream === "live", "the stream again");
  expect(mirror.status()).toEqual({ stream: "live" });
});

test("a machine that neither runs the factory nor holds its work opens no stream, and starts one once it holds an item", async () => {
  timing.pollMs = 50;
  const { s, f } = fixture();
  await withT3(s);
  s.put("node", "b", { id: "b", protocol: 8 });
  useFactory(s, "b");
  const mirror = mirrorOf(f);
  await Bun.sleep(100);
  expect(mirror.status().stream).toBe("down");

  items.insert(s, {
    id: "it_1",
    source: "bugs",
    externalId: "1",
    key: "gh-1",
    repo: "acme/api",
    title: "Crash",
    snapshot: {},
    phase: "implement",
    configCommit: "c0ffee",
  });
  await until(() => mirrorOf(f).status().stream === "live", "the stream");
});

test("while the stream is down the mirror polls T3's shell on the interval, and the board says polling", async () => {
  const { s, f } = fixture();
  const polls: number[] = [];
  await withT3(s, (req) => {
    const path = new URL(req.url).pathname;
    // No WebSocket: every subscription fails before it opens.
    if (path === "/api/auth/websocket-ticket") return new Response("unavailable", { status: 503 });
    if (path === "/api/orchestration/shell") {
      polls.push(Date.now());
      return Response.json(waitingShell);
    }
  });
  polls.length = 0; // connecting read the shell once
  timing.pollMs = 40;
  useFactory(s, "a");
  mirrorOf(f);

  await until(() => polls.length >= 4, "four polls");
  const gaps = polls.slice(1).map((at, i) => at - polls[i]!);
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(35);
  const board = await buildBoard(f, { includeWebhookUrls: false });
  expect(board.t3).toEqual({
    stream: "polling",
    mcp: "off",
    error: "T3 Code on a answered 503 for /api/auth/websocket-ticket",
  });
  expect(board.machines[0]!.threads).toEqual([
    {
      id: "t-waiting",
      title: "Needs approval",
      project: "api",
      status: "waiting",
      needsYou: true,
      updatedAt: Date.parse(UPDATED),
    },
  ]);
});

const hookSource = {
  id: "hooks",
  type: "webhook" as const,
  repo: "acme/api",
  webhook: { configured: true, url: "https://relay.example/hook/secret-key" },
};

test("/factory is the page for browsers and the board's JSON otherwise, only while the dashboard is on and for its own host", async () => {
  const { s, f, ctx } = fixture();
  f.boardParts.push(async () => ({ sources: [hookSource] }));
  const call = caller(app(ctx));

  expect((await call("/factory")).status).toBe(404);
  s.put("node", "a", { id: "a", protocol: 8, healthDashboard: true, url: "http://a.tailnet.ts.net:7878" });

  const page = await call("/factory", { headers: { accept: "text/html,application/xhtml+xml" } });
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await page.text()).toContain("<title>Factory board</title>");

  const json = await call("/factory");
  const board = factoryBoardSchema.parse(await json.json());
  expect(board.node).toBe("a");
  expect(board.sources).toEqual([{ id: "hooks", type: "webhook", repo: "acme/api", webhook: { configured: true } }]);

  const foreign = await call("/factory", { listener: "tailnet", headers: { host: "evil.example:7878" } });
  expect(foreign.status).toBe(403);
  for (const host of ["100.64.0.1:7878", "a.tailnet.ts.net:7878"])
    expect((await call("/factory", { listener: "tailnet", headers: { host } })).status).toBe(200);
});

test("the board lists every machine's threads from /peer/threads, and a machine that does not answer as offline", async () => {
  const [a, b, c] = await startNodes("a", "b", "c");
  cleanup.push(a!.stop, b!.stop);
  await withT3(b!.s, (req) =>
    new URL(req.url).pathname === "/api/orchestration/shell" ? Response.json(waitingShell) : undefined,
  );
  await c!.stop();
  a!.s.put("node", "a", { ...a!.s.get("node", "a")!, healthDashboard: true });

  const res = await caller(app(a!.ctx))("/factory");
  expect(res.status).toBe(200);
  const { machines } = (await res.json()) as FactoryBoard;
  expect(machines).toEqual([
    { node: "a", online: true, threads: [] },
    {
      node: "b",
      online: true,
      threads: [
        {
          id: "t-waiting",
          title: "Needs approval",
          project: "api",
          status: "waiting",
          needsYou: true,
          updatedAt: Date.parse(UPDATED),
        },
      ],
    },
    { node: "c", online: false, threads: [] },
  ]);
});

test("factory status and GET /api/factory show one board, with the board parts merged", async () => {
  const { s, f, ctx } = fixture();
  s.now = () => 1_000_000;
  useFactory(s, "a");
  const item = (id: string, title: string) => ({
    id,
    key: id,
    repo: "acme/api",
    title,
    source: "bugs",
    phase: "implement" as const,
    heldBy: "a",
    actions: [],
    tokens: 0,
    inPhaseSince: 1,
    updatedAt: 1,
  });
  const scorer = (name: string) => ({ name, passRate: 1, runs: 1, byConfig: [] });
  f.boardParts.push(
    async () => ({
      items: [item("it_1", "First"), item("it_2", "Second")],
      sources: [hookSource],
      metrics: { merged: 3, mergeRate: 0.5, reverts14d: 0, scorers: [scorer("tests")] },
      config: { commit: "aaaaaaa", name: "old", loadedAt: 1 },
    }),
    async () => {
      throw new Error("this part broke");
    },
    async () => ({
      items: [item("it_1", "First, renamed")],
      metrics: { merged: 4, mergeRate: 0.8, reverts14d: 1, medianHoursToMerge: 2, scorers: [scorer("review")] },
      config: { commit: "bbbbbbb", name: "new", loadedAt: 2 },
    }),
  );
  const errors = spyOn(console, "error").mockImplementation(() => {});
  cleanup.push(() => errors.mockRestore());
  const call = caller(app(ctx));

  const api = (await (await call("/api/factory")).json()) as FactoryBoard;
  const command = (await (
    await call("/api/factory/command", { method: "POST", body: { name: "status", args: ["--json"] } })
  ).json()) as { code: number; output: string[] };
  expect(command.code).toBe(0);
  expect(JSON.parse(command.output.join("\n"))).toEqual(api);

  expect(api.items.map((i) => [i.id, i.title])).toEqual([
    ["it_1", "First, renamed"],
    ["it_2", "Second"],
  ]);
  expect(api.metrics).toEqual({
    merged: 4,
    mergeRate: 0.8,
    reverts14d: 1,
    medianHoursToMerge: 2,
    scorers: [scorer("tests"), scorer("review")],
  });
  expect(api.config?.name).toBe("new");
  expect(api.sources).toEqual([hookSource]);
  expect(errors.mock.calls.map((c) => String(c[0]))).toContain("factory: a board part failed: Error");

  // People at the terminal see the webhook URL; agents never do.
  const text = await call("/api/factory/command", { method: "POST", body: { name: "status", args: [] } });
  expect(((await text.json()) as { output: string[] }).output.join("\n")).toContain(hookSource.webhook.url);
  const builtin = (await ctx.gateway.builtin!()).client;
  const tool = await builtin.callTool({ name: "factory_status", arguments: {} });
  const status = JSON.parse((tool.content as { text: string }[])[0]!.text) as string;
  expect(status).toContain("implement it_1 First, renamed");
  expect(status).not.toContain("secret-key");
});

test("on another machine, GET /api/factory and factory status show the factory machine's board", async () => {
  const [a, b] = await startNodes("a", "b");
  cleanup.push(a!.stop, b!.stop);
  for (const n of [a!, b!]) useFactory(n.s, "b");
  b!.ctx.factory.boardParts.push(async () => ({
    config: { commit: "ccccccc", name: "on-b", loadedAt: 1 },
    sources: [hookSource],
  }));
  const call = caller(app(a!.ctx));

  const board = (await (await call("/api/factory")).json()) as FactoryBoard;
  expect(board.node).toBe("a");
  expect(board.factory).toMatchObject({ node: "b", online: true });
  expect(board.config?.name).toBe("on-b");
  expect(board.sources).toEqual([hookSource]);
  expect(board.machines.map((m) => m.node)).toEqual(["b", "a"]);

  const res = await call("/api/factory/command", { method: "POST", body: { name: "status", args: [] } });
  const { output } = (await res.json()) as { output: string[] };
  expect(output).toContain("Factory: acme/api on b, online");
  expect(output).toContain("  a (this machine): 0 threads");
});

/** Just enough DOM for the board page's script: elements with text, classes and children. */
class FakeElement {
  className = "";
  hidden = false;
  href = "";
  target = "";
  rel = "";
  children: FakeElement[] = [];
  #text = "";
  get textContent(): string {
    return this.#text + this.children.map((c) => c.textContent).join(" ");
  }
  set textContent(text: string) {
    this.#text = text;
    this.children = [];
  }
  append(...nodes: FakeElement[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.children = nodes;
  }
}

/** Runs the page's script once against `fetchBoard`, and returns each element with an id. */
async function renderPage(fetchBoard: (path: string, init: { headers: object }) => Response | Promise<Response>) {
  const byId = new Map<string, FakeElement>();
  const document = {
    createElement: () => new FakeElement(),
    getElementById: (id: string) => byId.get(id) ?? byId.set(id, new FakeElement()).get(id)!,
  };
  let refresh: () => Promise<void> = async () => {};
  const script = FACTORY_PAGE.match(/<script>([\s\S]*)<\/script>/)![1]!;
  new Function("document", "fetch", "location", "setInterval", script)(
    document,
    fetchBoard,
    { pathname: "/factory" },
    (fn: () => Promise<void>) => (refresh = fn),
  );
  await refresh();
  return (id: string) => document.getElementById(id);
}

test("the page and factory status show the last 7 days' outcomes and each judge's pass rate by factory commit", async () => {
  const { s, f, ctx } = fixture();
  useFactory(s, "a");
  s.put("node", "a", { id: "a", protocol: 8, healthDashboard: true });
  // As records.ts and scorers.ts report them.
  f.boardParts.push(
    async () => ({
      metrics: {
        merged: 4,
        mergeRate: 0.8,
        reverts14d: 1,
        medianHoursToMerge: 5.25,
        humanTouchesPerItem: 1.5,
        tokensPerMergedPr: 1_234_567,
        scorers: [],
      },
    }),
    async () =>
      ({
        metrics: {
          scorers: [
            {
              name: "review",
              passRate: 0.75,
              runs: 4,
              byConfig: [
                { commit: "aaaaaaa1111", passRate: 1, runs: 2 },
                { commit: "bbbbbbb2222", passRate: 0.5, runs: 2 },
              ],
            },
          ],
        },
      }) as Partial<FactoryBoard>,
  );
  const call = caller(app(ctx));

  const page = await renderPage((path, init) => call(path, init));
  expect(page("updated").textContent).toStartWith("Updated");
  expect(page("metrics-section").hidden).toBe(false);
  expect(page("metrics").textContent).toBe(
    "4 merged 80% merge rate 1 reverted within 14 days 5.3h median time to merge 1.5 human touches per item 1.2M tokens per merged PR",
  );
  expect(page("judges").textContent).toContain("review 75% 4 aaaaaaa 100% of 2 · bbbbbbb 50% of 2");

  const res = await call("/api/factory/command", { method: "POST", body: { name: "status", args: [] } });
  const text = ((await res.json()) as { output: string[] }).output;
  expect(text).toContain(
    "Last 7 days: 4 merged, merge rate 80%, 1 reverted within 14 days, median 5.3h to merge, 1.5 human touches per item, 1.2M tokens per merged PR",
  );
  expect(text).toContain("  review: 75% passed of 4 runs");
});
