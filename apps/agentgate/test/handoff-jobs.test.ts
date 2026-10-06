import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { repos, sh, tmp } from "./fixtures/git.ts";
import { fakeT3 } from "./fixtures/t3.ts";
import { Handoffs } from "../src/handoff/jobs.ts";
import { handoffRoutes } from "../src/handoff/routes.ts";
import { CONTINUE, READY, restartTasks } from "../src/handoff/destination.ts";
import { claudeProjectKey } from "../src/handoff/session.ts";
import { connectT3 } from "../src/handoff/t3.ts";
import { connectNode, disconnectNode, localView, requestHandoff, resolveTarget, sidebarOrder } from "../src/handoff/threads.ts";
import { handoffSource } from "../src/handoff/tools.ts";
import { Store } from "../src/store.ts";
import { peerRoutes } from "../src/sync.ts";
import { handoffTargets, type NodeThreads } from "@agentgate/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Gateway } from "../src/mcp/gateway.ts";
import { saveProject } from "../src/operations.ts";
import { disconnectT3, t3State } from "../src/handoff/t3.ts";
import { memoryRelay, serveRelay } from "../../relay/test/memory.ts";
import { createRelay, deriveKeys, joinRelay, parseInvite, syncAll } from "../src/relay.ts";
import { NodeChannel } from "../src/channel.ts";
import { relayedRoutes } from "../src/handoff/routes.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const SID = "7d1f0c2e-9a7b-4c51-8e3d-2b6f4a9c0e11";

async function until<T>(fn: () => T | undefined | false, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (; ;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

/** One node: a store, a fake T3 Code with a project for its checkout, a Claude home, and its peer listener. */
async function node(name: string, main: string, options: { server?: boolean; setup?: string } = {}) {
  const root = tmp(), claudeDir = join(root, "claude");
  mkdirSync(claudeDir);
  const s = new Store(":memory:");
  s.setLocal("node", name);
  const t3 = fakeT3({ claudeDir });
  const project = t3.addProject(main, options.setup ? [{ id: "setup", name: "Setup", command: options.setup, icon: "configure", runOnWorktreeCreate: true }] : []);
  await connectT3(s, { url: t3.url, token: t3.pairingToken() });
  const h = new Handoffs(s, { claudeDir, worktreesDir: join(root, "worktrees"), cloneDir: join(root, "clones"), tempDir: join(root, "handoffs"), pollMs: 20 });
  const server = Bun.serve({ port: 0, fetch: new Hono().route("/peer", peerRoutes(s, () => { }).route("/", handoffRoutes(h))).fetch });
  cleanup.push(async () => { await h.close(); server.stop(true); t3.stop(); s.close(); });
  return { name, s, t3, project, claudeDir, h, url: `http://127.0.0.1:${server.port}`, server: !!options.server };
}
type Node = Awaited<ReturnType<typeof node>>;

function pair(...nodes: Node[]) {
  for (const n of nodes) for (const m of nodes) {
    n.s.put("node", m.name, { id: m.name, alwaysOn: m.server });
    if (n !== m) n.s.db.run("insert into peers values (?, ?, ?, 0, ?)", [m.name, m.url, [n.name, m.name].sort().join("-") + "-token-0123456789abcdef", Date.now()]);
  }
}

/** A Claude session recorded in `cwd`, with a subagent transcript, under the node's Claude home. */
function session(n: Node, cwd: string, words: string[]) {
  const dir = join(n.claudeDir, "projects", claudeProjectKey(cwd));
  mkdirSync(join(dir, SID, "subagents"), { recursive: true });
  writeFileSync(join(dir, `${SID}.jsonl`), words.map((w) => JSON.stringify({ type: "user", cwd, message: w })).join("\n") + "\n");
  writeFileSync(join(dir, SID, "subagents", "agent-1.jsonl"), JSON.stringify({ cwd }) + "\n");
}

async function done(n: Node, id: string, role: "source" | "destination" = "source") {
  return until(() => { const j = n.h.load(role, id); return j && ["done", "failed"].includes(j.step) && j; }, `${role} job on ${n.name}`);
}

test("a working thread moves to the server with its session and code, continues there, and comes back and goes again", async () => {
  const r = repos("a", "b");
  const setupLog = join(r.root, "setup.log");
  const a = await node("a", r.a), b = await node("b", r.b, { server: true, setup: `echo ran >> ${setupLog}` });
  pair(a, b);
  // A's T3 Code leaves its Claude provider on Claude's default home; B's names one.
  a.t3.homePath = undefined;

  // A thread in its own worktree, working, with an unpushed commit and uncommitted files.
  const wtA = join(r.root, "wt-a");
  sh(r.a, "worktree", "add", wtA, "-b", "feature", "main");
  writeFileSync(join(wtA, "feature.txt"), "committed\n"); sh(wtA, "add", "-A"); sh(wtA, "commit", "-m", "unpushed");
  writeFileSync(join(wtA, "notes.txt"), "uncommitted\n");
  session(a, wtA, ["code word: falcon"]);
  const thread = a.t3.addThread({ projectId: a.project.id, sessionId: SID, branch: "feature", worktreePath: wtA, runs: [{ id: "run-1", status: "running" }], background: [{ kind: "command", description: "gh pr checks 72 --watch" }] });

  // Started through the agent's own MCP tool, which returns before the job ends.
  const tools = await handoffSource(a.h);
  cleanup.push(() => tools.client.close());
  expect((await tools.client.listTools()).tools.map((t) => t.name)).toEqual(["handoff_targets", "handoff_thread"]);
  const listed = await tools.client.callTool({ name: "handoff_targets", arguments: {} });
  expect(JSON.parse((listed.content as { text: string }[])[0]!.text)).toEqual([{ node: "b", server: true, available: true }]);
  const started = JSON.parse(((await tools.client.callTool({ name: "handoff_thread", arguments: { threadId: thread.id } })).content as { text: string }[])[0]!.text);
  expect(started).toMatchObject({ status: "started", node: "a", to: "b" });
  expect(a.h.load("source", started.handoffId)!.step).not.toBe("done");

  const source = await done(a, started.handoffId);
  expect(source.error).toBeUndefined();
  const dest = await done(b, started.handoffId, "destination");
  expect(dest.error).toBeUndefined();

  // B: the imported thread runs in a new worktree on the branch, with A's settings and code.
  const imported = b.t3.threads.get(`import:claudeAgent:${SID}`)!;
  const wtB = imported.worktreePath!;
  expect(wtB.startsWith(join(b.h.options.worktreesDir, "b"))).toBe(true);
  // T3 imports into Settled; the handed-over thread is back in the active list.
  expect(imported).toMatchObject({ archivedAt: null, settledOverride: "active", branch: "feature", title: "Fix the bug", runtimeMode: "full-access", modelSelection: { instanceId: "claudeAgent", model: "opus" } });
  expect(readFileSync(join(wtB, "feature.txt"), "utf8")).toBe("committed\n");
  expect(readFileSync(join(wtB, "notes.txt"), "utf8")).toBe("uncommitted\n");
  // The session sits under the worktree's key with cwd rewritten, where Claude resumes it. The main checkout's copy
  // was only for T3's import and is gone.
  const resumed = join(b.claudeDir, "projects", claudeProjectKey(wtB));
  expect(JSON.parse(readFileSync(join(resumed, `${SID}.jsonl`), "utf8").split("\n")[0]!)).toEqual({ type: "user", cwd: wtB, message: "code word: falcon" });
  expect(existsSync(join(resumed, SID, "subagents", "agent-1.jsonl"))).toBe(true);
  expect(existsSync(join(b.claudeDir, "projects", claudeProjectKey(r.b), `${SID}.jsonl`))).toBe(false);
  // B took T3's first-turn failure with the ready message, then continued the working agent and named the background
  // work that A stopped.
  expect(imported.messages).toEqual([READY, READY, `${CONTINUE}\n\n${restartTasks(["command: gh pr checks 72 --watch"])}`]);
  expect(a.t3.threads.get(thread.id)!.background).toEqual([]);
  expect(readFileSync(setupLog, "utf8")).toBe("ran\n");

  // A: archived, its worktree clean (the sent changes parked in a stash), and timings for every step on both sides.
  expect(a.t3.threads.get(thread.id)!.archivedAt).not.toBeNull();
  expect(a.t3.commands.some((c) => c.type === "run.interrupt" && c.runId === "run-1")).toBe(true);
  expect(sh(wtA, "status", "--porcelain")).toBe("");
  expect(sh(wtA, "stash", "list")).toContain("agentgate: handed to b");
  const view = a.h.view(source);
  expect(view).toMatchObject({ status: "done", destThreadId: imported.id, from: "a", to: "b" });
  expect(view.timings.map((t) => `${t.node}:${t.step}`)).toEqual(expect.arrayContaining(["a:resolve", "a:stop", "a:package", "a:send", "a:await b", "b:prepare", "b:apply", "b:place", "b:import"]));
  expect(existsSync(a.h.dir(started.handoffId)) || existsSync(b.h.dir(started.handoffId))).toBe(false);

  // Work on B, then hand it back: A reuses its original thread and its worktree takes B's code.
  writeFileSync(join(wtB, "from-b.txt"), "b's work\n"); sh(wtB, "add", "-A"); sh(wtB, "commit", "-m", "b's work");
  const back = await requestHandoff(b.h, { threadId: imported.id, to: "a" });
  expect(back).toMatchObject({ node: "b", to: "a" });
  expect((await done(b, back.handoffId)).error).toBeUndefined();
  expect((await done(a, back.handoffId, "destination")).error).toBeUndefined();
  expect(a.t3.threads.get(thread.id)).toMatchObject({ archivedAt: null, worktreePath: wtA });
  // A's own thread came back; T3's import, which would have duplicated it, was not asked.
  expect(a.t3.threads.has(`import:claudeAgent:${SID}`)).toBe(false);
  expect(readFileSync(join(wtA, "from-b.txt"), "utf8")).toBe("b's work\n");
  expect(b.t3.threads.get(imported.id)!.archivedAt).not.toBeNull();
  // The changes A parked when the thread left came back with it, so their stash is gone.
  expect(sh(wtA, "stash", "list")).toBe("");

  // And to B again: the archived import is unarchived, the worktree reused, setup not run again.
  const again = await requestHandoff(a.h, { threadId: thread.id });
  expect((await done(a, again.handoffId)).error).toBeUndefined();
  expect((await done(b, again.handoffId, "destination")).error).toBeUndefined();
  expect(b.t3.threads.get(imported.id)).toMatchObject({ archivedAt: null, worktreePath: wtB });
  expect(readFileSync(setupLog, "utf8")).toBe("ran\n");
  expect(b.h.view(b.h.load("destination", again.handoffId)!).timings.some((t) => t.step === "setup")).toBe(false);
});

test("when the destination keeps its own code, the source keeps its uncommitted changes in place", async () => {
  const r = repos("a", "b");
  const a = await node("a", r.a), b = await node("b", r.b, { server: true });
  pair(a, b);
  const wtA = join(r.root, "wt-a");
  sh(r.a, "worktree", "add", wtA, "-b", "feature", "main");
  writeFileSync(join(wtA, "mine.txt"), "only on a\n");
  // B already has a worktree on the branch, with work of its own.
  const wtB = join(r.root, "wt-b");
  sh(r.b, "worktree", "add", wtB, "-b", "feature", "main");
  writeFileSync(join(wtB, "theirs.txt"), "only on b\n");
  session(a, wtA, ["hello"]);
  const thread = a.t3.addThread({ projectId: a.project.id, sessionId: SID, branch: "feature", worktreePath: wtA });

  const { handoffId } = await requestHandoff(a.h, { threadId: thread.id, to: "b" });
  const job = await done(a, handoffId);
  expect(job.step).toBe("done");
  expect(a.h.view(job).warnings.some((w) => w.includes("Kept b's code") && w.includes("uncommitted changes"))).toBe(true);
  expect(readFileSync(join(wtA, "mine.txt"), "utf8")).toBe("only on a\n");
  expect(sh(wtA, "stash", "list")).toBe("");
  expect(existsSync(join(wtB, "mine.txt"))).toBe(false);
});

test("an idle thread's background work is stopped on the source and named on the destination", async () => {
  const r = repos("a", "b");
  const a = await node("a", r.a), b = await node("b", r.b, { server: true });
  pair(a, b);
  session(a, r.a, ["watch the PR"]);
  const thread = a.t3.addThread({ projectId: a.project.id, sessionId: SID, branch: "main", runs: [{ id: "run-1", status: "completed" }], background: [{ kind: "monitor", description: "CI checks on PR #72" }] });

  const { handoffId } = await requestHandoff(a.h, { threadId: thread.id, to: "b" });
  expect((await done(a, handoffId)).step).toBe("done");
  expect((await done(b, handoffId, "destination")).step).toBe("done");
  expect(a.t3.threads.get(thread.id)!.background).toEqual([]);
  expect(b.t3.threads.get(`import:claudeAgent:${SID}`)!.messages).toEqual([READY, READY, restartTasks(["monitor: CI checks on PR #72"])]);
});

test("queued messages move with the thread and queue again behind the continued turn", async () => {
  const r = repos("a", "b");
  const a = await node("a", r.a), b = await node("b", r.b, { server: true });
  pair(a, b);
  session(a, r.a, ["build it"]);
  const thread = a.t3.addThread({
    projectId: a.project.id, sessionId: SID, branch: "main",
    runs: [
      { id: "run-1", status: "running", ordinal: 1 },
      { id: "q-later", status: "queued", userMessageId: "m-later", ordinal: 2, queuePosition: 3 },
      { id: "q-result", status: "queued", userMessageId: "m-result", ordinal: 3, queuePosition: 1 },
      { id: "q-first", status: "queued", userMessageId: "m-first", ordinal: 4, queuePosition: 2 },
    ],
    conversation: [
      { id: "m-later", text: "then add tests", attachments: [] },
      { id: "m-result", text: "a child task finished", attachments: [], delegatedCompletion: { parentRunId: "run-1" } },
      { id: "m-first", text: "use the new API", attachments: [{ type: "image" }] },
    ],
  });

  const { handoffId } = await requestHandoff(a.h, { threadId: thread.id, to: "b" });
  const source = await done(a, handoffId);
  expect((await done(b, handoffId, "destination")).step).toBe("done");

  // Cancelled on A, queued on B in the user's order behind "Continue"; a child task's result stays with A's thread.
  expect(a.t3.threads.get(thread.id)!.runs.filter((run) => run.id.startsWith("q-")).map((run) => run.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
  expect(b.t3.threads.get(`import:claudeAgent:${SID}`)!.messages).toEqual([READY, READY, CONTINUE, "use the new API", "then add tests"]);
  const queued = b.t3.commands.filter((c) => c.type === "message.dispatch" && (c.dispatchMode as { type: string }).type === "queue_after_active");
  expect(queued.map((c) => c.text)).toEqual(["use the new API", "then add tests"]);
  expect(source.state.warnings).toContain("1 attachment on queued messages stayed on a");
});

test("a failure on the destination before import aborts and leaves the source as it was", async () => {
  const r = repos("a", "b");
  const a = await node("a", r.a), b = await node("b", r.b, { server: true });
  pair(a, b);
  writeFileSync(join(r.a, "notes.txt"), "uncommitted\n");
  session(a, r.a, ["hello"]);
  const thread = a.t3.addThread({ projectId: a.project.id, sessionId: SID, branch: "main" });
  // B's T3 Code settings name a Claude home its import does not read, so the import finds nothing.
  b.t3.threads.clear();
  b.t3.homePath = tmp();

  const { handoffId } = await requestHandoff(a.h, { threadId: thread.id, to: "b" });
  const job = await done(a, handoffId);
  expect(job.step).toBe("failed");
  expect(job.error).toContain("import on b: T3 Code on b did not import the Claude session");
  expect(a.t3.threads.get(thread.id)!.archivedAt).toBeNull();
  expect(readFileSync(join(r.a, "notes.txt"), "utf8")).toBe("uncommitted\n");
  expect(existsSync(a.h.dir(handoffId))).toBe(false);
  expect((await done(b, handoffId, "destination")).step).toBe("failed");
  expect(existsSync(b.h.dir(handoffId))).toBe(false);
});

test("a daemon restart resumes a handoff from the step it reached", async () => {
  const r = repos("a", "b");
  const a = await node("a", r.a), b = await node("b", r.b, { server: true });
  pair(a, b);
  session(a, r.a, ["hello"]);
  const thread = a.t3.addThread({ projectId: a.project.id, sessionId: SID, branch: "main" });

  const { handoffId } = await requestHandoff(a.h, { threadId: thread.id, to: "b" });
  await a.h.close(); // the daemon stops mid-handoff
  const restarted = new Handoffs(a.s, a.h.options);
  cleanup.push(() => restarted.close());
  restarted.tick();
  const job = await until(() => { const j = restarted.load("source", handoffId); return j && ["done", "failed"].includes(j.step) && j; }, "resumed job");
  expect(job.error).toBeUndefined();
  expect(b.t3.threads.get(`import:claudeAgent:${SID}`)!.worktreePath).toBeNull();
  expect(restarted.list("source").filter((j) => j.thread === thread.id)).toHaveLength(1);
});

test("a server's T3 Code is connected from the main machine: the pairing link goes over the peer channel", async () => {
  const a = await node("a", tmp()), b = await node("b", tmp(), { server: true });
  pair(a, b);
  disconnectT3(b.s);
  expect(t3State(b.s).connected).toBe(false);

  // The link shows the server's LAN address, as T3 Code does; b redeems it with its own T3 Code over loopback.
  const link = `http://192.168.1.20:${new URL(b.t3.url).port}/pair#token=${b.t3.pairingToken()}`;
  expect(await connectNode(a.h, "b", { pairingUrl: link })).toMatchObject({ connected: true });
  expect(t3State(b.s)).toMatchObject({ connected: true, url: b.t3.url });
  expect(a.s.local("t3:url")).toBe(a.t3.url); // a's own connection is untouched

  await expect(connectNode(a.h, "b", { pairingUrl: link })).rejects.toThrow("single-use");
  await disconnectNode(a.h, "b");
  expect(t3State(b.s).connected).toBe(false);
});

test("the thread list matches T3's sidebar: settled and subagent threads are left out", async () => {
  const a = await node("a", tmp());
  const active = a.t3.addThread({ projectId: a.project.id, sessionId: SID, title: "Active" });
  a.t3.addThread({ projectId: a.project.id, sessionId: "other", title: "Settled", settledOverride: "settled" });
  a.t3.addThread({ projectId: a.project.id, sessionId: "kept", title: "Kept active", settledOverride: "active" });
  a.t3.addThread({ projectId: a.project.id, sessionId: "child", title: "Subagent", subagent: true });
  expect((await localView(a.h)).threads.map((t) => t.title).sort()).toEqual(["Active", "Kept active"]);
  expect((await localView(a.h)).threads.some((t) => t.id === active.id)).toBe(true);
});

test("threads keep T3's sidebar order: pinned by pin key, then dragged threads, unarranged ones newest first", () => {
  const t = (id: string, createdAt: string, extra = {}) => ({ id, createdAt: `2026-10-0${createdAt}T00:00:00Z`, ...extra });
  const order = sidebarOrder([
    t("old", "1"), t("new", "3"), t("dragged-b", "2", { activeOrderKey: "b" }), t("dragged-a", "1", { activeOrderKey: "a" }),
    t("pin-late", "3", { pinnedAt: "x", pinOrderKey: "z" }), t("pin-first", "1", { pinnedAt: "x", pinOrderKey: "a" }),
    t("revived", "1", { unsettledAt: "2026-10-04T00:00:00Z" }),
  ]);
  expect(order.map((x) => x.id)).toEqual(["pin-first", "pin-late", "revived", "new", "old", "dragged-a", "dragged-b"]);
});

test("target selection: the first available server by node id, here, or a node; with the reason when unavailable", async () => {
  const view = (node: string, extra: Partial<NodeThreads> = {}): NodeThreads => ({ node, server: false, online: true, t3: { connected: true }, threads: [], jobs: [], ...extra });
  const views = [
    view("laptop"),
    view("srv-a", { server: true, error: "offline" }),
    view("srv-b", { server: true, t3: { connected: false, url: "http://127.0.0.1:3773" } }),
    view("srv-c", { server: true }),
    view("srv-d", { server: true }),
    view("desk", { t3: { connected: false } }),
  ];
  expect(handoffTargets(views, "laptop")).toEqual([
    { node: "desk", server: false, available: false, reason: "T3 Code not connected" },
    { node: "srv-a", server: true, available: false, reason: "offline" },
    { node: "srv-b", server: true, available: false, reason: "T3 Code token expired; pair T3 Code again there" },
    { node: "srv-c", server: true, available: true },
    { node: "srv-d", server: true, available: true },
  ]);
  const s = new Store(":memory:"); s.setLocal("node", "laptop");
  const h = new Handoffs(s, { claudeDir: tmp(), worktreesDir: tmp(), cloneDir: tmp(), tempDir: tmp() });
  expect(await resolveTarget(h, "laptop", "server", views)).toBe("srv-c");
  // A server's own thread goes to another server.
  expect(await resolveTarget(h, "srv-c", "server", views)).toBe("srv-d");
  expect(await resolveTarget(h, "srv-c", "here", views)).toBe("laptop");
  await expect(resolveTarget(h, "laptop", "here", views)).rejects.toThrow("already runs on laptop");
  await expect(resolveTarget(h, "laptop", "desk", views)).rejects.toThrow("desk: T3 Code not connected");
  await expect(resolveTarget(h, "laptop", "server", views.slice(0, 3))).rejects.toThrow("no server available: srv-a (offline), srv-b (T3 Code token expired");
  await expect(resolveTarget(h, "laptop", "server", [view("laptop")])).rejects.toThrow("no server: mark an always-on node");
});

test("the handoff tools reach local sessions once T3 Code is connected, never a virtual project's public endpoint", async () => {
  const a = await node("a", tmp());
  const gateway = new Gateway(a.s);
  gateway.builtin = () => handoffSource(a.h);
  cleanup.push(() => gateway.close());
  const session = async () => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp?project=*"), { fetch: (url, init) => gateway.handle(new Request(String(url), init)) }));
    cleanup.push(() => client.close());
    return (await client.listTools()).tools.map((t) => t.name);
  };
  expect(await session()).toEqual(["agentgate__handoff_targets", "agentgate__handoff_thread"]);
  saveProject(a.s, "@grok", { mcp: {} });
  const { response } = await gateway.handleRemote("@grok", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), {}, new AbortController().signal);
  expect(JSON.stringify(await response.json())).not.toContain("handoff");
  expect(() => saveProject(a.s, "o/r", { mcp: { agentgate: "x" } })).toThrow("reserved");
  disconnectT3(a.s);
  expect(await session()).toEqual([]);
});

test("a handoff works through the relay alone; the relay sees only sealed calls and cannot replay one", async () => {
  process.env.AGENTGATE_RELAY_ALLOW_HTTP = "1";
  const relay = memoryRelay();
  const calls: { path: string; body: string }[] = [];
  const server = serveRelay(relay, async (req) => {
    if (req.method === "POST" && new URL(req.url).pathname.endsWith("/call")) calls.push({ path: new URL(req.url).pathname, body: await req.clone().text() });
    return undefined;
  });
  cleanup.push(() => server.stop(true));
  const r = repos("a", "b");
  const a = await node("a", r.a), b = await node("b", r.b, { server: true });
  for (const n of [a, b]) for (const m of [a, b]) n.s.put("node", m.name, { id: m.name, alwaysOn: m.server });
  const invite = await createRelay(a.s, `http://127.0.0.1:${server.port}`);
  await joinRelay(b.s, invite);
  await syncAll(a.s);
  for (const n of [a, b]) {
    const channel = new NodeChannel(n.s, relayedRoutes(n.h));
    cleanup.push(() => channel.close());
    await channel.reconcile();
    await until(() => channel.connected, `${n.name}'s relay channel`);
  }

  writeFileSync(join(r.a, "secret-notes.txt"), "the code word is falcon\n");
  session(a, r.a, ["the code word is falcon"]);
  const thread = a.t3.addThread({ projectId: a.project.id, sessionId: SID, branch: "main" });
  const started = await requestHandoff(a.h, { threadId: thread.id });
  expect(started).toMatchObject({ node: "a", to: "b" });
  expect((await done(a, started.handoffId)).error).toBeUndefined();
  expect((await done(b, started.handoffId, "destination")).error).toBeUndefined();
  expect(readFileSync(join(r.b, "secret-notes.txt"), "utf8")).toBe("the code word is falcon\n");
  expect(b.t3.threads.get(`import:claudeAgent:${SID}`)!.archivedAt).toBeNull();
  expect(a.t3.threads.get(thread.id)!.archivedAt).not.toBeNull();

  // Everything went through the relay, and none of it was readable there.
  expect(calls.some((c) => c.path.endsWith("/n/b/call"))).toBe(true);
  expect(calls.every((c) => !c.body.includes("falcon") && !c.body.includes("/handoff/"))).toBe(true);
  // A call the relay replays gets an answer it can't open.
  const keys = await deriveKeys(parseInvite(invite).secret);
  const replay = await fetch(`http://127.0.0.1:${server.port}${calls[0]!.path}`, { method: "POST", headers: { authorization: `Bearer ${keys.authToken}` }, body: calls[0]!.body });
  expect(replay.status).toBe(200);
  expect(await replay.text()).toBe("");
});
