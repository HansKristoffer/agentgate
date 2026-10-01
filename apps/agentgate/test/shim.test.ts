import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, makeCtx } from "../src/daemon.ts";
import { aliasesFor, parseRemote, renameInstance, toolName } from "../src/mcp/gateway.ts";
import { DAEMON_DOWN, buildShim } from "../src/mcp/shim.ts";
import { newInstance } from "../src/mcp/templates.ts";
import { Store } from "../src/store.ts";

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

async function connectTo(server: import("@modelcontextprotocol/sdk/server/index.js").Server) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("a daemon that is down gives an empty but valid server", async () => {
  const { server, close } = await buildShim(tmpdir(), "http://127.0.0.1:1", { AGENTGATE_PROJECT: "o/r" });
  const client = await connectTo(server);
  expect((await client.listTools()).tools).toEqual([]);
  expect(client.getInstructions()).toBe(DAEMON_DOWN); await client.close(); await close();
});

// End to end: two fake "PostHog" upstreams, a daemon, and a shim per repo.
const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => servers.forEach((x) => x.stop(true)));

function fakeUpstream(projectName: string) {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const mcp = new McpServer({ name: "fake", version: "0" }, { instructions: `Data for ${projectName}` });
      mcp.registerTool("whoami", { description: "which project" }, async () => ({ content: [{ type: "text", text: `${projectName}:${req.headers.get("x-posthog-project-id")}` }] }));
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
  const add = (id: string, url: string, projectId: string) => s.put("mcp", id, newInstance({ id, url, headers: { "x-posthog-project-id": projectId } }));
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

  const call = async (c: Client, name: string) => ((await c.callTool({ name, arguments: {} })).content as { text: string }[])[0]!.text;

  const containerA = await buildShim(cwd, url, { AGENTGATE_PROJECT: "o/a" });
  const containerB = await buildShim(cwd, url, { AGENTGATE_PROJECT: "o/b" });
  const shimA = await connectTo(containerA.server);
  const shimB = await connectTo(containerB.server);
  expect((await shimA.listTools()).tools.map((t) => t.name)).toEqual(["docs__whoami", "posthog__whoami"]);
  expect(await call(shimA, "posthog__whoami")).toBe("A:1");
  expect(await call(shimB, "posthog__whoami")).toBe("B:2");
  expect(await call(shimB, "docs__whoami")).toBe("docs:0");
  expect(shimA.getInstructions()).toContain("## posthog\nData for A");
  expect(s.get("project", "o/a")!.seenOn).toBe("t");

  // A mapping change reaches the running session.
  const changed = new Promise<void>((r) => shimA.setNotificationHandler(ToolListChangedNotificationSchema, () => r()));
  s.put("project", "o/a", { id: "o/a", mcp: { posthog: "posthog-a", analytics: "posthog-b" } });
  ctx.gateway.toolsChanged();
  await changed;
  expect((await shimA.listTools()).tools.map((t) => t.name)).toContain("analytics__whoami");
  await shimA.close(); await shimB.close(); await containerA.close(); await containerB.close();
  await ctx.gateway.close(); s.close(); rmSync(cwd, { recursive: true, force: true });
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
  for (const id of ["posthog-lullu", "geysier", "linear"]) s.put("mcp", id, newInstance({ id, url: "https://example.com/mcp" }));
  s.put("project", "o/r", { id: "o/r", mcp: { posthog: "posthog-lullu", linear: "linear" } });
  const ctx = makeCtx(s);
  const a = app(ctx);
  const body = JSON.stringify({ id: "o/r", mcp: { posthog: "posthog-lullu", geysier: "geysier" }, inheritDefaults: true });
  const res = await a.fetch(new Request("http://127.0.0.1:7878/api/projects", {
    method: "PUT", body, headers: { host: "127.0.0.1:7878", "content-type": "application/json" },
  }), { listener: "loopback" });
  expect(res.status).toBe(200);
  expect(s.get("project", "o/r")!.mcp).toEqual({ posthog: "posthog-lullu", geysier: "geysier" });
  await ctx.gateway.close(); s.close();
});

test("active MCP calls survive idle sweeps and cached tools acquire a new connection after idle close", async () => {
  const s = new Store(":memory:"); s.setLocal("node", "test");
  s.put("mcp", "fake", newInstance({ id: "fake", url: fakeUpstream("idle") })); s.put("project", "*", { id: "*", mcp: { fake: "fake" } });
  const ctx = makeCtx(s), handler = app(ctx); const daemon = Bun.serve({ port: 0, fetch: req => handler.fetch(req, { listener: "loopback" }) });
  const shim = await buildShim(tmpdir(), `http://127.0.0.1:${daemon.port}`, { AGENTGATE_PROJECT: "*" }); const client = await connectTo(shim.server);
  try {
    await client.listTools(); const before = ctx.gateway.upstreams.get("fake")?.client;
    let time = Date.now(); s.now = () => time;
    for (let i = 0; i < 3; i++) { time += 9 * 60000; await client.callTool({ name: "fake__whoami" }); await ctx.gateway.closeIdle(); expect(ctx.gateway.upstreams.get("fake")?.client).toBe(before); }
    time += 11 * 60000; await ctx.gateway.closeIdle(); expect(ctx.gateway.upstreams.get("fake")).toBeUndefined();
    const result = await client.callTool({ name: "fake__whoami" }); expect(result.isError).not.toBe(true); expect(ctx.gateway.upstreams.get("fake")?.client).not.toBe(before);
    s.put("project", "*", { id: "*", mcp: {} }); const removed = await client.callTool({ name: "fake__whoami" }); expect(removed.isError).toBe(true);
  } finally { await client.close(); await shim.close(); await ctx.gateway.close(); daemon.stop(true); s.close(); }
});

test("a running shim recovers when the daemon starts late and restarts", async () => {
  const s = new Store(":memory:"); s.setLocal("node", "n"); s.put("mcp", "fake", newInstance({ id: "fake", url: fakeUpstream("recovered") })); s.put("project", "*", { id: "*", mcp: { fake: "fake" } });
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserve") }); const port = reserve.port!; reserve.stop(true);
  const shim = await buildShim(tmpdir(), `http://127.0.0.1:${port}`, { AGENTGATE_PROJECT: "*" }, { reconnectMs: 20 }); const client = await connectTo(shim.server);
  expect((await client.listTools()).tools).toEqual([]);
  let ctx = makeCtx(s), handler = app(ctx); let daemon = Bun.serve({ hostname: "127.0.0.1", port, fetch: req => handler.fetch(req, { listener: "loopback" }) });
  const untilTools = async () => { for (let i = 0; i < 100; i++) { if ((await client.listTools()).tools.length) return; await Bun.sleep(20); } throw new Error("shim did not recover"); };
  try { await untilTools(); await ctx.gateway.close(); daemon.stop(true); ctx = makeCtx(s); handler = app(ctx); daemon = Bun.serve({ hostname: "127.0.0.1", port, fetch: req => handler.fetch(req, { listener: "loopback" }) }); await untilTools(); expect((await client.callTool({ name: "fake__whoami" })).isError).not.toBe(true); }
  finally { await client.close(); await shim.close(); await ctx.gateway.close(); daemon.stop(true); s.close(); }
});

test("per-session children use each worktree, reconcile mappings, and forward cancellation/progress", async () => {
  const s = new Store(":memory:"); s.setLocal("node", "test");
  const cwd = mkdtempSync(join(tmpdir(), "agentgate-child-"));
  s.put("mcp", "local", newInstance({ id: "local", command: process.execPath, args: [join(import.meta.dir, "fixtures", "mcp.ts")], mode: "perSession" })); s.put("project", "*", { id: "*", mcp: { local: "local" } });
  const ctx = makeCtx(s), handler = app(ctx); const daemon = Bun.serve({ port: 0, fetch: req => handler.fetch(req, { listener: "loopback" }) });
  const shim = await buildShim(cwd, `http://127.0.0.1:${daemon.port}`, { AGENTGATE_PROJECT: "*" }); const client = await connectTo(shim.server);
  try {
    const result = await client.callTool({ name: "local__cwd" }); expect((result.content as { text: string }[])[0]!.text).toBe(realpathSync(cwd));
    const abort = new AbortController(); let progress = false;
    const slow = client.callTool({ name: "local__slow" }, undefined, { signal: abort.signal, onprogress: () => { progress = true; abort.abort(); } });
    await expect(slow).rejects.toThrow(); expect(progress).toBe(true);
    for (let i = 0; i < 100 && !(await Bun.file(join(cwd, "cancelled")).exists()); i++) await Bun.sleep(10);
    expect(await Bun.file(join(cwd, "cancelled")).text()).toBe("yes");
    s.put("project", "*", { id: "*", mcp: {} }); ctx.gateway.toolsChanged(); expect((await client.listTools()).tools).toEqual([]);
  } finally { await client.close(); await shim.close(); await ctx.gateway.close(); daemon.stop(true); s.close(); }
});

test("shared long tools stay open during idle sweeps and carry cancellation/progress through both gateways", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agentgate-shared-")), cancelled = join(cwd, "cancelled");
  const s = new Store(":memory:"); s.setLocal("node", "n");
  const instance = newInstance({ id: "shared", command: process.execPath, args: [join(import.meta.dir, "fixtures", "mcp.ts")] }); instance.env = { AGENTGATE_CANCEL_FILE: cancelled };
  s.put("mcp", "shared", instance); s.put("project", "*", { id: "*", mcp: { shared: "shared" } });
  const ctx = makeCtx(s), handler = app(ctx); const daemon = Bun.serve({ port: 0, fetch: req => handler.fetch(req, { listener: "loopback" }) });
  const shim = await buildShim(cwd, `http://127.0.0.1:${daemon.port}`, { AGENTGATE_PROJECT: "*" }); const client = await connectTo(shim.server);
  let progressed!: () => void; const progress = new Promise<void>(r => progressed = r); const abort = new AbortController();
  try {
    await client.listTools(); const task = client.callTool({ name: "shared__slow" }, undefined, { signal: abort.signal, onprogress: () => progressed() });
    await progress; expect(ctx.gateway.upstreams.get("shared")?.calls).toBe(1);
    s.now = () => Date.now() + 31 * 60000; await ctx.gateway.closeIdle(); expect(ctx.gateway.upstreams.get("shared")?.client).toBeDefined();
    abort.abort(); await expect(task).rejects.toThrow();
    for (let i = 0; i < 100 && !(await Bun.file(cancelled).exists()); i++) await Bun.sleep(10);
    expect(await Bun.file(cancelled).text()).toBe("yes");
  } finally { await client.close(); await shim.close(); await ctx.gateway.close(); daemon.stop(true); s.close(); rmSync(cwd, { recursive: true, force: true }); }
});
