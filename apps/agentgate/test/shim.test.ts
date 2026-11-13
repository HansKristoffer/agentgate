import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer, WebStandardStreamableHTTPServerTransport, type Server } from "@modelcontextprotocol/server";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, makeCtx } from "../src/daemon.ts";
import { aliasesFor, connect, parseRemote, toolName } from "../src/mcp/gateway.ts";
import { renameInstance } from "../src/ops/servers.ts";
import { DAEMON_DOWN, buildShim } from "../src/mcp/shim.ts";
import { fromPreset, newInstance, preset } from "../src/mcp/templates.ts";
import { Store } from "../src/store.ts";
import { T3_THREAD_META_KEY } from "@agentgate/protocol";

test("git remotes normalise to owner/repo", () => {
  expect(parseRemote("git@github.com:Lullu-ai/lullu.git")).toBe("Lullu-ai/lullu");
  expect(parseRemote("https://github.com/Geysier/gey-mono")).toBe("Geysier/gey-mono");
  expect(parseRemote("https://github.com/Geysier/gey-mono.git/\n")).toBe("Geysier/gey-mono");
  expect(parseRemote("ssh://git@github.com:22/Serpier/serpier-mono.git")).toBe("Serpier/serpier-mono");
  expect(parseRemote("https://x-access-token:abc@github.com/o/r.git")).toBe("o/r");
  expect(parseRemote("not a remote")).toBeUndefined();
});

test("aliases merge with * unless the repo turns defaults off", () => {
  const s = new Store(":memory:");
  s.put("project", "*", { id: "*", mcp: { github: "github-main", docs: "context7" } });
  s.put("project", "o/r", { id: "o/r", mcp: { posthog: "posthog-r", docs: "docs-r" } });
  expect(aliasesFor(s, "o/r")).toEqual({ github: "github-main", docs: "docs-r", posthog: "posthog-r" });
  expect(aliasesFor(s, "other/repo")).toEqual({ github: "github-main", docs: "context7" });
  s.put("project", "o/r", { ...s.get("project", "o/r")!, inheritDefaults: false });
  expect(aliasesFor(s, "o/r")).toEqual({ posthog: "posthog-r", docs: "docs-r" });
  expect(aliasesFor(s, "O/R")).toEqual({ posthog: "posthog-r", docs: "docs-r" }); // GitHub names are case-insensitive
});

test("long tool names are shortened to 64 characters, distinctly", () => {
  const a = toolName("posthog_legacy", "x".repeat(80));
  const b = toolName("posthog_legacy", "x".repeat(79) + "y");
  expect(a.length).toBeLessThanOrEqual(64);
  expect(a).not.toBe(b);
  expect(toolName("posthog", "query")).toBe("posthog__query");
});

async function connectTo(server: Server) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("a daemon that is down gives an empty but valid server", async () => {
  const { server, close } = await buildShim(tmpdir(), "http://127.0.0.1:1", { AGENTGATE_PROJECT: "o/r" });
  const client = await connectTo(server);
  expect((await client.listTools()).tools).toEqual([]);
  expect(client.getInstructions()).toBe(DAEMON_DOWN);
  await client.close();
  await close();
});

// End to end: two fake "PostHog" upstreams, a daemon, and a shim per repo.
const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => servers.forEach((x) => x.stop(true)));

function fakeUpstream(projectName: string) {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const mcp = new McpServer({ name: "fake", version: "0" }, { instructions: `Data for ${projectName}` });
      mcp.registerTool("whoami", { description: "which project" }, async () => ({
        content: [{ type: "text", text: `${projectName}:${req.headers.get("x-posthog-project-id")}` }],
      }));
      const t = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await mcp.connect(t);
      return t.handleRequest(req);
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/mcp`;
}

test("each repo reaches its own instance under the same alias; * servers reach both; mapping changes notify", async () => {
  const s = new Store(":memory:");
  s.setLocal("node", "t");
  const add = (id: string, url: string, projectId: string) =>
    s.put("mcp", id, newInstance({ id, url, headers: { "x-posthog-project-id": projectId } }));
  add("posthog-a", fakeUpstream("A"), "1");
  add("posthog-b", fakeUpstream("B"), "2");
  add("docs", fakeUpstream("docs"), "0");
  s.put("project", "*", { id: "*", mcp: { docs: "docs" } });
  s.put("project", "o/a", { id: "o/a", mcp: { posthog: "posthog-a" } });
  s.put("project", "o/b", { id: "o/b", mcp: { posthog: "posthog-b" } });

  const ctx = makeCtx(s);
  const a = app(ctx);
  const daemon = Bun.serve({ port: 0, fetch: (req) => a.fetch(req, { listener: "loopback" }) });
  servers.push(daemon);
  const url = `http://127.0.0.1:${daemon.port}`;
  const cwd = mkdtempSync(join(tmpdir(), "agentgate-shim-"));

  const call = async (c: Client, name: string) =>
    ((await c.callTool({ name, arguments: {} })).content as { text: string }[])[0]!.text;

  const containerA = await buildShim(cwd, url, { AGENTGATE_PROJECT: "o/a" });
  const containerB = await buildShim(cwd, url, { AGENTGATE_PROJECT: "o/b" });
  const shimA = await connectTo(containerA.server);
  const shimB = await connectTo(containerB.server);
  expect((await shimA.listTools()).tools.map((t) => t.name)).toEqual(["docs__whoami", "posthog__whoami"]);
  expect(await call(shimA, "posthog__whoami")).toBe("A:1");
  expect(await call(shimB, "posthog__whoami")).toBe("B:2");
  expect(await call(shimB, "docs__whoami")).toBe("docs:0");
  expect(shimA.getInstructions()).toContain("## posthog\nData for A");

  // A mapping change reaches the running session.
  const changed = new Promise<void>((r) => shimA.setNotificationHandler("notifications/tools/list_changed", () => r()));
  s.put("project", "o/a", { id: "o/a", mcp: { posthog: "posthog-a", analytics: "posthog-b" } });
  ctx.gateway.toolsChanged();
  await changed;
  expect((await shimA.listTools()).tools.map((t) => t.name)).toContain("analytics__whoami");
  await shimA.close();
  await shimB.close();
  await containerA.close();
  await containerB.close();
  await ctx.gateway.close();
  s.close();
  rmSync(cwd, { recursive: true, force: true });
});

test("a mapping change reaches a session that sat idle longer than the handshake deadline", async () => {
  const s = new Store(":memory:");
  s.setLocal("node", "t");
  s.put("mcp", "docs", newInstance({ id: "docs", url: fakeUpstream("docs") }));
  s.put("project", "o/r", { id: "o/r", mcp: { docs: "docs" } });
  const ctx = makeCtx(s),
    handler = app(ctx);
  const daemon = Bun.serve({ port: 0, fetch: (req) => handler.fetch(req, { listener: "loopback" }) });
  const shim = await buildShim(
    tmpdir(),
    `http://127.0.0.1:${daemon.port}`,
    { AGENTGATE_PROJECT: "o/r" },
    { handshakeMs: 200, reconnectMs: 60_000 },
  );
  const client = await connectTo(shim.server);
  try {
    // The deadline is a real timer on the notification stream's request, so only real time passing exercises it.
    await Bun.sleep(500);
    const changed = new Promise<void>((r) =>
      client.setNotificationHandler("notifications/tools/list_changed", () => r()),
    );
    s.put("project", "o/r", { id: "o/r", mcp: { docs: "docs", more: "docs" } });
    ctx.gateway.toolsChanged();
    await changed;
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("more__whoami");
  } finally {
    await client.close();
    await shim.close();
    await ctx.gateway.close();
    daemon.stop(true);
    s.close();
  }
});

test("a call after the daemon forgot the session succeeds on the first try", async () => {
  const gateway = await gatewayWith(countingUpstream(0).url);
  const container = await gateway.shim();
  const client = await connectTo(container.server);
  try {
    expect((await client.callTool({ name: "brain__caller" })).isError).not.toBe(true);
    gateway.s.now = () => Date.now() + 31 * 60_000;
    await gateway.ctx.gateway.maintain();
    expect((await client.callTool({ name: "brain__caller" })).isError).not.toBe(true);
  } finally {
    await client.close();
    await container.close();
    await gateway.done();
  }
});

test("the shim polls for the daemon only while it has no connection to it", async () => {
  const s = new Store(":memory:");
  s.setLocal("node", "n");
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserve") });
  const port = reserve.port!;
  reserve.stop(true);
  const shim = await buildShim(tmpdir(), `http://127.0.0.1:${port}`, { AGENTGATE_PROJECT: "*" }, { reconnectMs: 10 });
  const client = await connectTo(shim.server);
  const reconnected = new Promise<void>((r) =>
    client.setNotificationHandler("notifications/tools/list_changed", () => r()),
  );
  const ctx = makeCtx(s),
    handler = app(ctx);
  let reads = 0;
  const daemon = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (req) => {
      if (new URL(req.url).pathname === "/api/shim") reads++;
      return handler.fetch(req, { listener: "loopback" });
    },
  });
  try {
    // Nothing but the timer asks for the daemon here.
    await reconnected;
    // Ten poll intervals pass while connected: the reconnect read the configuration once, the timer never.
    await Bun.sleep(100);
    expect(reads).toBe(1);
  } finally {
    await client.close();
    await shim.close();
    await ctx.gateway.close();
    daemon.stop(true);
    s.close();
  }
});

test("a stdio server that ignores its closed stdin is gone after the shim is told to stop", async () => {
  const s = new Store(":memory:");
  s.setLocal("node", "n");
  const cwd = mkdtempSync(join(tmpdir(), "agentgate-exit-")),
    pidFile = join(cwd, "pid");
  // The fixture server, kept alive by a timer after stdin closes.
  const server = `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1 << 30);
await import(${JSON.stringify(join(import.meta.dir, "fixtures", "mcp.ts"))});`;
  s.put(
    "mcp",
    "stubborn",
    newInstance({ id: "stubborn", command: process.execPath, args: ["-e", server], mode: "perSession" }),
  );
  s.put("project", "*", { id: "*", mcp: { stubborn: "stubborn" } });
  const ctx = makeCtx(s),
    handler = app(ctx);
  const daemon = Bun.serve({ port: 0, fetch: (req) => handler.fetch(req, { listener: "loopback" }) });
  const shimModule = join(import.meta.dir, "..", "src", "mcp", "shim.ts");
  const shim = Bun.spawn(
    [
      process.execPath,
      "-e",
      `await (await import(${JSON.stringify(shimModule)})).runShim("http://127.0.0.1:${daemon.port}")`,
    ],
    { cwd, env: { ...process.env, AGENTGATE_PROJECT: "*" }, stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );
  let pid: number | undefined;
  try {
    // The shim answers its client only after its per-session servers started.
    shim.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      })}\n`,
    );
    await shim.stdin.flush();
    const reader = shim.stdout.getReader();
    for (let out = ""; !out.includes('"id":1');) out += new TextDecoder().decode((await reader.read()).value);
    reader.releaseLock();
    pid = Number(await Bun.file(pidFile).text());
    shim.kill("SIGTERM");
    await shim.exited;
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    shim.kill("SIGKILL");
    try {
      if (pid) process.kill(pid, "SIGKILL");
    } catch {}
    await ctx.gateway.close();
    daemon.stop(true);
    s.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

/** An upstream that counts its tools/list requests, answers them after `delayMs`, and echoes who called. */
function countingUpstream(delayMs: number) {
  const seen = { lists: 0 };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = req.method === "POST" ? await req.clone().text() : "";
      if (body.includes('"tools/list"')) {
        seen.lists++;
        await Bun.sleep(delayMs);
      }
      const mcp = new McpServer({ name: "counting", version: "0" });
      mcp.registerTool("caller", { description: "who called" }, async (ctx) => ({
        content: [{ type: "text", text: JSON.stringify(ctx.mcpReq._meta?.["dev.agentgate/client"] ?? null) }],
      }));
      const t = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await mcp.connect(t);
      return t.handleRequest(req);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/mcp`, seen };
}

async function gatewayWith(upstreamUrl: string) {
  const s = new Store(":memory:");
  s.setLocal("node", "t");
  s.put("mcp", "brain", newInstance({ id: "brain", url: upstreamUrl }));
  s.put("project", "o/r", { id: "o/r", mcp: { brain: "brain" } });
  const ctx = makeCtx(s);
  const a = app(ctx);
  const daemon = Bun.serve({ port: 0, fetch: (req) => a.fetch(req, { listener: "loopback" }) });
  servers.push(daemon);
  const cwd = mkdtempSync(join(tmpdir(), "agentgate-shim-"));
  const shim = (env: Record<string, string> = {}) =>
    buildShim(cwd, `http://127.0.0.1:${daemon.port}`, { AGENTGATE_PROJECT: "o/r", ...env });
  const done = async () => {
    await ctx.gateway.close();
    s.close();
    rmSync(cwd, { recursive: true, force: true });
  };
  return { s, ctx, shim, done };
}

test("sessions list each upstream's tools once, and parallel first calls share that listing", async () => {
  const upstream = countingUpstream(300);
  const gateway = await gatewayWith(upstream.url);

  const first = await gateway.shim();
  const firstClient = await connectTo(first.server);
  const calls = await Promise.all(
    Array.from({ length: 10 }, () => firstClient.callTool({ name: "brain__caller", arguments: {} })),
  );
  expect(calls.every((call) => !call.isError)).toBe(true);
  expect((await firstClient.listTools()).tools.map((tool) => tool.name)).toEqual(["brain__caller"]);

  const second = await gateway.shim();
  const secondClient = await connectTo(second.server);
  expect((await secondClient.listTools()).tools.map((tool) => tool.name)).toEqual(["brain__caller"]);

  expect(upstream.seen.lists).toBe(1);

  await firstClient.close();
  await secondClient.close();
  await first.close();
  await second.close();
  await gateway.done();
});

test("forwarded calls carry the client that made them", async () => {
  const upstream = countingUpstream(0);
  const gateway = await gatewayWith(upstream.url);
  const container = await gateway.shim();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", title: "Claude Code", version: "2.1.0" });
  await Promise.all([container.server.connect(a), client.connect(b)]);

  const result = await client.callTool({ name: "brain__caller", arguments: {} });
  const caller = JSON.parse((result.content as { text: string }[])[0]!.text);
  expect(caller).toEqual({ name: "claude-code", title: "Claude Code", version: "2.1.0" });

  await client.close();
  await container.close();
  await gateway.done();
});

test("a T3 Code thread's calls name the thread, unless the call already names one", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const mcp = new McpServer({ name: "thread", version: "0" });
      mcp.registerTool("thread", { description: "which thread called" }, async (ctx) => ({
        content: [{ type: "text", text: String(ctx.mcpReq._meta?.[T3_THREAD_META_KEY]) }],
      }));
      const t = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await mcp.connect(t);
      return t.handleRequest(req);
    },
  });
  servers.push(upstream);
  const gateway = await gatewayWith(`http://127.0.0.1:${upstream.port}/mcp`);
  const container = await gateway.shim({ T3CODE_THREAD_ID: "thread-1" });
  const client = await connectTo(container.server);
  const thread = async (_meta?: Record<string, unknown>) =>
    ((await client.callTool({ name: "brain__thread", arguments: {}, _meta })).content as { text: string }[])[0]!.text;

  expect(await thread()).toBe("thread-1");
  expect(await thread({ [T3_THREAD_META_KEY]: "thread-2" })).toBe("thread-2");

  await client.close();
  await container.close();
  await gateway.done();
});

test("renaming a server moves its repo mappings; an alias equal to the old name follows", () => {
  const s = new Store(":memory:");
  s.put("mcp", "posthog", newInstance({ id: "posthog", url: "https://mcp.posthog.com/mcp" }));
  s.put("project", "*", { id: "*", mcp: { posthog: "posthog" } });
  s.put("project", "o/r", { id: "o/r", mcp: { analytics: "posthog" } });
  renameInstance(s, "posthog", "posthog-lullu");
  expect(s.get("mcp", "posthog")).toBeUndefined();
  expect(s.get("mcp", "posthog-lullu")!.id).toBe("posthog-lullu");
  expect(s.get("project", "*")!.mcp).toEqual({ "posthog-lullu": "posthog-lullu" });
  expect(s.get("project", "o/r")!.mcp).toEqual({ analytics: "posthog-lullu" });
  expect(() => renameInstance(s, "posthog-lullu", "bad name")).toThrow();
});

test("JSON project updates preserve explicit custom prefixes and remove excluded mappings", async () => {
  const s = new Store(":memory:");
  s.setLocal("node", "t");
  for (const id of ["posthog-lullu", "geysier", "linear"])
    s.put("mcp", id, newInstance({ id, url: "https://example.com/mcp" }));
  s.put("project", "o/r", { id: "o/r", mcp: { posthog: "posthog-lullu", linear: "linear" } });
  const ctx = makeCtx(s);
  const a = app(ctx);
  const body = JSON.stringify({
    id: "o/r",
    // As the app's form sends it: a prefix it dropped is named with null.
    mcp: { posthog: "posthog-lullu", geysier: "geysier", linear: null },
    inheritDefaults: true,
  });
  const res = await a.fetch(
    new Request("http://127.0.0.1:7878/api/ops/project%20set", {
      method: "POST",
      body,
      headers: { host: "127.0.0.1:7878", "content-type": "application/json" },
    }),
    { listener: "loopback" },
  );
  expect(res.status).toBe(200);
  expect(s.get("project", "o/r")!.mcp).toEqual({ posthog: "posthog-lullu", geysier: "geysier" });
  await ctx.gateway.close();
  s.close();
});

test("active MCP calls survive idle sweeps and cached tools acquire a new connection after idle close", async () => {
  const s = new Store(":memory:");
  s.setLocal("node", "test");
  s.put("mcp", "fake", newInstance({ id: "fake", url: fakeUpstream("idle") }));
  s.put("project", "*", { id: "*", mcp: { fake: "fake" } });
  const ctx = makeCtx(s),
    handler = app(ctx);
  const daemon = Bun.serve({ port: 0, fetch: (req) => handler.fetch(req, { listener: "loopback" }) });
  const shim = await buildShim(tmpdir(), `http://127.0.0.1:${daemon.port}`, { AGENTGATE_PROJECT: "*" });
  const client = await connectTo(shim.server);
  try {
    await client.listTools();
    const before = ctx.gateway.upstreams.get("fake")?.state;
    let time = Date.now();
    s.now = () => time;
    for (let i = 0; i < 3; i++) {
      time += 9 * 60000;
      await client.callTool({ name: "fake__whoami" });
      await ctx.gateway.maintain();
      expect(ctx.gateway.upstreams.get("fake")?.state).toBe(before);
    }
    time += 11 * 60000;
    await ctx.gateway.maintain();
    expect(ctx.gateway.upstreams.get("fake")).toBeUndefined();
    const result = await client.callTool({ name: "fake__whoami" });
    expect(result.isError).not.toBe(true);
    expect(ctx.gateway.upstreams.get("fake")?.state).not.toBe(before);
    s.put("project", "*", { id: "*", mcp: {} });
    const removed = await client.callTool({ name: "fake__whoami" });
    expect(removed.isError).toBe(true);
  } finally {
    await client.close();
    await shim.close();
    await ctx.gateway.close();
    daemon.stop(true);
    s.close();
  }
});

test("one hung server does not cost a new session the daemon and every other server", async () => {
  // Answers nothing until the test ends.
  const answer = Promise.withResolvers<Response>();
  const hung = Bun.serve({ port: 0, fetch: () => answer.promise });
  servers.push(hung);
  const s = new Store(":memory:");
  s.setLocal("node", "n");
  s.put("mcp", "good", newInstance({ id: "good", url: fakeUpstream("good") }));
  s.put("mcp", "hung", newInstance({ id: "hung", url: `http://127.0.0.1:${hung.port}/mcp` }));
  s.put("project", "*", { id: "*", mcp: { good: "good", hung: "hung" } });
  const ctx = makeCtx(s),
    handler = app(ctx),
    daemon = Bun.serve({ port: 0, fetch: (req) => handler.fetch(req, { listener: "loopback" }) });
  const shim = await buildShim(
    tmpdir(),
    `http://127.0.0.1:${daemon.port}`,
    { AGENTGATE_PROJECT: "*" },
    { reconnectMs: 60_000 },
  );
  const client = await connectTo(shim.server);
  try {
    expect(client.getInstructions()).toContain("Data for good");
  } finally {
    answer.resolve(new Response("gone", { status: 503 }));
    await client.close();
    await shim.close();
    await ctx.gateway.close();
    daemon.stop(true);
    s.close();
  }
});

test("a web page cannot reach the MCP endpoint, and a project is recorded only for a real session", async () => {
  const s = new Store(":memory:");
  s.setLocal("node", "n");
  const ctx = makeCtx(s),
    handler = app(ctx);
  const get = (headers: Record<string, string>, project = "evil/spam") =>
    handler.fetch(
      new Request(`http://127.0.0.1:7878/mcp?project=${project}`, { headers: { host: "127.0.0.1:7878", ...headers } }),
      { listener: "loopback" },
    );
  try {
    expect((await get({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await get({ origin: "https://evil.example" })).status).toBe(403);
    expect((await get({}, "not a project")).status).toBe(400);
    await get({}); // a GET without a session starts none
    expect(s.get("project", "evil/spam")).toBeUndefined();
  } finally {
    await ctx.gateway.close();
    s.close();
  }
});

test("a running shim recovers when the daemon starts late and restarts", async () => {
  const s = new Store(":memory:");
  s.setLocal("node", "n");
  s.put("mcp", "fake", newInstance({ id: "fake", url: fakeUpstream("recovered") }));
  s.put("project", "*", { id: "*", mcp: { fake: "fake" } });
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserve") });
  const port = reserve.port!;
  reserve.stop(true);
  const shim = await buildShim(tmpdir(), `http://127.0.0.1:${port}`, { AGENTGATE_PROJECT: "*" }, { reconnectMs: 20 });
  const client = await connectTo(shim.server);
  expect((await client.listTools()).tools).toEqual([]);
  let ctx = makeCtx(s),
    handler = app(ctx);
  let daemon = Bun.serve({ hostname: "127.0.0.1", port, fetch: (req) => handler.fetch(req, { listener: "loopback" }) });
  const untilTools = async () => {
    for (let i = 0; i < 100; i++) {
      if ((await client.listTools()).tools.length) return;
      await Bun.sleep(20);
    }
    throw new Error("shim did not recover");
  };
  try {
    await untilTools();
    await ctx.gateway.close();
    daemon.stop(true);
    ctx = makeCtx(s);
    handler = app(ctx);
    daemon = Bun.serve({ hostname: "127.0.0.1", port, fetch: (req) => handler.fetch(req, { listener: "loopback" }) });
    await untilTools();
    expect((await client.callTool({ name: "fake__whoami" })).isError).not.toBe(true);
  } finally {
    await client.close();
    await shim.close();
    await ctx.gateway.close();
    daemon.stop(true);
    s.close();
  }
});

test("per-session children use each worktree, reconcile mappings, and forward cancellation/progress", async () => {
  const s = new Store(":memory:");
  s.setLocal("node", "test");
  const cwd = mkdtempSync(join(tmpdir(), "agentgate-child-"));
  s.put(
    "mcp",
    "local",
    newInstance({
      id: "local",
      command: process.execPath,
      args: [join(import.meta.dir, "fixtures", "mcp.ts")],
      mode: "perSession",
    }),
  );
  s.put("project", "*", { id: "*", mcp: { local: "local" } });
  const ctx = makeCtx(s),
    handler = app(ctx);
  const daemon = Bun.serve({ port: 0, fetch: (req) => handler.fetch(req, { listener: "loopback" }) });
  const shim = await buildShim(cwd, `http://127.0.0.1:${daemon.port}`, { AGENTGATE_PROJECT: "*" });
  const client = await connectTo(shim.server);
  try {
    const result = await client.callTool({ name: "local__cwd" });
    expect((result.content as { text: string }[])[0]!.text).toBe(realpathSync(cwd));
    const abort = new AbortController();
    let progress = false;
    const slow = client.callTool(
      { name: "local__slow" },
      {
        signal: abort.signal,
        onprogress: () => {
          progress = true;
          abort.abort();
        },
      },
    );
    await expect(slow).rejects.toThrow();
    expect(progress).toBe(true);
    for (let i = 0; i < 100 && !(await Bun.file(join(cwd, "cancelled")).exists()); i++) await Bun.sleep(10);
    expect(await Bun.file(join(cwd, "cancelled")).text()).toBe("yes");
    s.put("project", "*", { id: "*", mcp: {} });
    ctx.gateway.toolsChanged();
    expect((await client.listTools()).tools).toEqual([]);
  } finally {
    await client.close();
    await shim.close();
    await ctx.gateway.close();
    daemon.stop(true);
    s.close();
  }
});

test("a per-session server that fails to start is not started again on every reconcile, until its config changes", async () => {
  const s = new Store(":memory:");
  s.setLocal("node", "n");
  const cwd = mkdtempSync(join(tmpdir(), "agentgate-failing-")),
    starts = join(cwd, "starts");
  const failing = (n: number) =>
    newInstance({ id: "failing", command: "/bin/sh", args: ["-c", `echo ${n} >> ${starts}`], mode: "perSession" });
  s.put("mcp", "failing", failing(1));
  s.put("project", "*", { id: "*", mcp: { failing: "failing" } });
  const ctx = makeCtx(s),
    handler = app(ctx);
  const daemon = Bun.serve({ port: 0, fetch: (req) => handler.fetch(req, { listener: "loopback" }) });
  const shim = await buildShim(cwd, `http://127.0.0.1:${daemon.port}`, { AGENTGATE_PROJECT: "*" }, { reconnectMs: 10 });
  const client = await connectTo(shim.server);
  const tried = async () => (await Bun.file(starts).text()).trim().split("\n");
  try {
    for (let i = 0; i < 20; i++) await client.listTools();
    expect(await tried()).toEqual(["1"]);
    s.put("mcp", "failing", failing(2));
    await client.listTools();
    expect(await tried()).toEqual(["1", "2"]);
  } finally {
    await client.close();
    await shim.close();
    await ctx.gateway.close();
    daemon.stop(true);
    s.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("shared long tools stay open during idle sweeps and carry cancellation/progress through both gateways", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agentgate-shared-")),
    cancelled = join(cwd, "cancelled");
  const s = new Store(":memory:");
  s.setLocal("node", "n");
  const instance = newInstance({
    id: "shared",
    command: process.execPath,
    args: [join(import.meta.dir, "fixtures", "mcp.ts")],
  });
  instance.env = { AGENTGATE_CANCEL_FILE: cancelled };
  s.put("mcp", "shared", instance);
  s.put("project", "*", { id: "*", mcp: { shared: "shared" } });
  const ctx = makeCtx(s),
    handler = app(ctx);
  const daemon = Bun.serve({ port: 0, fetch: (req) => handler.fetch(req, { listener: "loopback" }) });
  const shim = await buildShim(cwd, `http://127.0.0.1:${daemon.port}`, { AGENTGATE_PROJECT: "*" });
  const client = await connectTo(shim.server);
  let progressed!: () => void;
  const progress = new Promise<void>((r) => (progressed = r));
  const abort = new AbortController();
  try {
    await client.listTools();
    const task = client.callTool(
      { name: "shared__slow" },
      {
        signal: abort.signal,
        onprogress: () => progressed(),
      },
    );
    await progress;
    expect(ctx.gateway.upstreams.get("shared")?.calls).toBe(1);
    s.now = () => Date.now() + 31 * 60000;
    await ctx.gateway.maintain();
    expect(ctx.gateway.upstreams.get("shared")?.state.kind).toBe("connected");
    abort.abort();
    await expect(task).rejects.toThrow();
    for (let i = 0; i < 100 && !(await Bun.file(cancelled).exists()); i++) await Bun.sleep(10);
    expect(await Bun.file(cancelled).text()).toBe("yes");
  } finally {
    await client.close();
    await shim.close();
    await ctx.gateway.close();
    daemon.stop(true);
    s.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the Infisical preset signs in with the shared machine identity", async () => {
  const s = new Store(":memory:");
  // The preset's server, with the fixture standing in for `npx -y @infisical/mcp`.
  const inst = {
    ...fromPreset(preset("infisical")!),
    command: process.execPath,
    args: [join(import.meta.dir, "fixtures", "mcp.ts")],
  };
  await expect(connect(inst, undefined, s)).rejects.toThrow("set an Infisical machine identity first");
  s.put("login", "infisical-identity", {
    id: "infisical-identity",
    from: "a",
    account: "client-1",
    clientSecret: "secret-1",
    siteUrl: "https://eu.infisical.com",
  });
  const client = await connect(inst, undefined, s);
  try {
    const env = async (name: string) =>
      ((await client.callTool({ name: "env", arguments: { name } })).content as { text: string }[])[0]!.text;
    expect(await env("INFISICAL_UNIVERSAL_AUTH_CLIENT_ID")).toBe("client-1");
    expect(await env("INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET")).toBe("secret-1");
    expect(await env("INFISICAL_HOST_URL")).toBe("https://eu.infisical.com");
  } finally {
    await client.close();
  }
});
