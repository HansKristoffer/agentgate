import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
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
  const { server } = await buildShim(tmpdir(), "http://127.0.0.1:1", { AGENTGATE_PROJECT: "o/r" });
  const client = await connectTo(server);
  expect((await client.listTools()).tools).toEqual([]);
  expect(client.getInstructions()).toBe(DAEMON_DOWN);
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

  const shimA = await connectTo((await buildShim(cwd, url, { AGENTGATE_PROJECT: "o/a" })).server);
  const shimB = await connectTo((await buildShim(cwd, url, { AGENTGATE_PROJECT: "o/b" })).server);
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
  await ctx.gateway.close();
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

test("project server toggles: checked servers use their own name, custom prefixes survive, unchecked ones go", async () => {
  const s = new Store(":memory:");
  s.setLocal("node", "t");
  for (const id of ["posthog-lullu", "geysier", "linear"]) s.put("mcp", id, newInstance({ id, url: "https://example.com/mcp" }));
  s.put("project", "o/r", { id: "o/r", mcp: { posthog: "posthog-lullu", linear: "linear" } });
  const a = app(makeCtx(s));
  const body = new URLSearchParams([["present", "1"], ["server", "posthog-lullu"], ["server", "geysier"]]);
  const res = await a.fetch(new Request("http://127.0.0.1:7878/projects/servers?project=o%2Fr", {
    method: "POST", body, headers: { host: "127.0.0.1:7878", origin: "http://127.0.0.1:7878", "content-type": "application/x-www-form-urlencoded" },
  }), { listener: "loopback" });
  expect(res.status).toBe(302);
  expect(s.get("project", "o/r")!.mcp).toEqual({ posthog: "posthog-lullu", geysier: "geysier" });
});
