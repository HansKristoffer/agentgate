import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@agentgate/protocol/remote";
import { app, makeCtx } from "../src/daemon.ts";
import { Gateway } from "../src/mcp/gateway.ts";
import { newInstance } from "../src/mcp/templates.ts";
import { saveProject } from "../src/operations.ts";
import { enableRemote, regenerateAfterUnpair, RemoteEndpoints, rotateSecret } from "../src/remote.ts";
import { writeSkillMd } from "../src/skills.ts";
import { exportBackup, Store } from "../src/store.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function upstream(name: string) {
  const server = Bun.serve({
    port: 0, fetch: async (req) => {
      const mcp = new McpServer({ name, version: "0" }, { instructions: `Tools of ${name}` });
      mcp.registerTool("whoami", { description: "who" }, async () => ({ content: [{ type: "text", text: name }] }));
      const t = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await mcp.connect(t);
      return t.handleRequest(req);
    },
  });
  cleanup.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}/mcp`;
}

function store() {
  const s = new Store(":memory:");
  s.setLocal("node", "mac");
  s.put("node", "mac", { id: "mac", protocol: 2 });
  cleanup.push(() => s.close());
  return s;
}

const rpc = (method: string, params: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
const INIT = rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "grok", version: "1" } });

test("virtual projects list servers explicitly, reserve the skills prefix and never inherit * defaults", () => {
  const s = store();
  s.put("mcp", "docs", newInstance({ id: "docs", url: "https://docs.example/mcp" }));
  s.put("project", "*", { id: "*", mcp: { docs: "docs" } });
  expect(saveProject(s, "@grok", { mcp: {} }).inheritDefaults).toBe(false);
  expect(saveProject(s, "@grok", { inheritDefaults: true }).inheritDefaults).toBe(false);
  expect(() => saveProject(s, "@grok", { mcp: { skills: "docs" } })).toThrow("reserved");
  expect(() => saveProject(s, "@Bad Name", {})).toThrow();
});

test("a virtual project answers stateless JSON requests with its servers and skill tools", async () => {
  const s = store();
  s.put("mcp", "linear", newInstance({ id: "linear", url: upstream("linear") }));
  s.put("mcp", "fs", newInstance({ id: "fs", command: "npx", args: ["x"], mode: "perSession" }));
  writeSkillMd(s, "release-notes", "---\nname: release-notes\ndescription: Write release notes\n---\nUse the changelog.\n");
  writeSkillMd(s, "secret-skill", "---\nname: secret-skill\ndescription: not assigned\n---\nHidden.\n");
  s.put("skill", "release-notes", { ...s.get("skill", "release-notes")!, files: [...s.get("skill", "release-notes")!.files, { path: "template.md", data: Buffer.from("# Template").toString("base64") }] });
  saveProject(s, "@grok", { mcp: { linear: "linear", fs: "fs" }, skills: ["release-notes"] });
  const gateway = new Gateway(s);
  cleanup.push(() => gateway.close());
  const call = async (body: string) => {
    const { response, failed } = await gateway.handleRemote("@grok", body, {}, new AbortController().signal);
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : undefined, failed };
  };

  const init = await call(INIT);
  expect(init.status).toBe(200);
  expect(init.json.result.instructions).toContain("Tools of linear");
  expect(init.json.result.instructions).toContain("skills__list");
  expect((await call(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).status).toBe(202);
  const tools = (await call(rpc("tools/list"))).json.result.tools.map((t: { name: string }) => t.name);
  expect(tools).toEqual(["linear__whoami", "skills__list", "skills__read"]); // perSession servers can't be served
  expect((await call(rpc("tools/call", { name: "linear__whoami", arguments: {} }))).json.result.content[0].text).toBe("linear");

  const text = async (name: string, args: Record<string, unknown>) => {
    const r = (await call(rpc("tools/call", { name, arguments: args }))).json.result;
    return { error: !!r.isError, text: r.content[0].text as string };
  };
  expect(JSON.parse((await text("skills__list", {})).text)).toEqual({ skills: [{ id: "release-notes", description: "Write release notes" }] });
  const md = await text("skills__read", { id: "release-notes" });
  expect(md.text).toContain("Use the changelog.");
  expect(md.text).toContain("template.md");
  expect((await text("skills__read", { id: "release-notes", path: "template.md" })).text).toBe("# Template");
  expect((await text("skills__read", { id: "secret-skill" })).error).toBe(true);
  expect((await text("skills__read", { id: "release-notes", path: "../x" })).error).toBe(true);
  // Unassigning takes effect on the next call.
  saveProject(s, "@grok", { skills: [] });
  expect((await text("skills__read", { id: "release-notes" })).error).toBe(true);

  expect((await call(`[${INIT}]`)).status).toBe(400);
  expect((await call("{")).status).toBe(400);
});

test("aborting a remote request cancels the upstream tool call", async () => {
  const s = store();
  const dir = mkdtempSync(join(tmpdir(), "agentgate-remote-")), cancelled = join(dir, "cancelled");
  const inst = newInstance({ id: "slow", command: process.execPath, args: [join(import.meta.dir, "fixtures", "mcp.ts")] });
  inst.env = { AGENTGATE_CANCEL_FILE: cancelled };
  s.put("mcp", "slow", inst);
  saveProject(s, "@grok", { mcp: { slow: "slow" } });
  const gateway = new Gateway(s);
  cleanup.push(() => gateway.close());
  const abort = new AbortController();
  await gateway.handleRemote("@grok", rpc("tools/list"), {}, abort.signal);
  const pending = gateway.handleRemote("@grok", rpc("tools/call", { name: "slow__slow", arguments: {} }), {}, abort.signal);
  await Bun.sleep(500);
  abort.abort();
  await expect(pending).rejects.toBeDefined();
  for (let i = 0; i < 50 && !existsSync(cancelled); i++) await Bun.sleep(100);
  expect(existsSync(cancelled)).toBe(true);
});

test("enabling waits for every node's version; status and backups never show endpoint keys", async () => {
  const s = store();
  saveProject(s, "@grok", {});
  s.put("node", "old", { id: "old" });
  expect(() => enableRemote(s, "@grok")).toThrow("Update agentgate on old");
  s.put("node", "old", { id: "old", protocol: 2, alwaysOn: true });
  const { url, secret } = enableRemote(s, "@grok");
  expect(url).toMatch(/\/mcp\/[A-Za-z0-9_-]{22}$/);
  expect(s.get("project", "@grok")!.remote!.servedBy).toBe("old"); // always-on nodes serve by default
  expect(() => enableRemote(s, "o/r")).toThrow("virtual");

  const ctx = makeCtx(s), handler = app(ctx);
  cleanup.push(async () => { ctx.remote.close(); ctx.skills.close(); ctx.imports.close(); await ctx.gateway.close(); });
  const get = (path: string, listener: "loopback" | "tailnet" = "loopback") =>
    handler.fetch(new Request(`http://127.0.0.1:7878${path}`, { headers: { host: "127.0.0.1:7878", authorization: "Bearer t" } }), { listener });
  s.setLocal("adminToken", "t");
  const status = await (await get("/api/status")).text();
  expect(status).not.toContain(secret);
  expect(status).not.toContain(s.get("project", "@grok")!.remote!.token);
  expect(JSON.parse(status).projects.find((p: { id: string }) => p.id === "@grok").remote).toMatchObject({ enabled: true, servedBy: "old", url });
  expect((await get("/api/projects/remote?id=@grok", "tailnet")).status).toBe(403);
  expect(await (await get("/api/projects/remote?id=@grok")).json()).toMatchObject({ url, secret });
  expect(JSON.stringify(exportBackup(s, false))).not.toContain(secret);

  // Unpairing the serving machine gives a new URL served here.
  const [moved] = regenerateAfterUnpair(s, "old");
  expect(moved!.url).not.toBe(url);
  expect(s.get("project", "@grok")!.remote!.servedBy).toBe("mac");
  expect(JSON.parse(s.local("remote:delete")!)).toHaveLength(1);
});

/** A relay stand-in: records PUTs and hands the test the node's socket. */
function fakeRelay() {
  const puts: { key: string; auth: string; body: { secretHash: string; enabled: boolean } }[] = [];
  const upgrades: { auth: string | null; node: string | null }[] = [];
  let socket: import("bun").ServerWebSocket<unknown> | undefined;
  const frames: any[] = [], waiters: (() => void)[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (req.method === "PUT") { puts.push({ key: url.pathname.split("/")[2]!, auth: req.headers.get("authorization")!, body: await req.json() as never }); return Response.json({ ok: true }); }
      if (url.pathname.endsWith("/connect")) {
        upgrades.push({ auth: req.headers.get("authorization"), node: req.headers.get("x-agentgate-node") });
        if (srv.upgrade(req)) return undefined;
      }
      return new Response("no", { status: 404 });
    },
    websocket: {
      open(ws) { socket = ws; },
      message(_, m) { if (m === "ping") return void socket?.send("pong"); frames.push(JSON.parse(String(m))); waiters.splice(0).forEach(w => w()); },
    },
  });
  cleanup.push(() => server.stop(true));
  const next = async () => { while (!frames.length) await new Promise<void>(r => waiters.push(r)); return frames.shift(); };
  const connected = async () => { while (!socket) await Bun.sleep(10); return socket; };
  return { url: `http://127.0.0.1:${server.port}`, puts, upgrades, next, connected };
}

test("the serving node pushes the secret hash, answers requests over its socket and re-pushes a new secret", async () => {
  process.env.AGENTGATE_RELAY_ALLOW_HTTP = "1";
  const relay = fakeRelay();
  process.env.AGENTGATE_RELAY_URL = relay.url;
  cleanup.push(() => { delete process.env.AGENTGATE_RELAY_URL; delete process.env.AGENTGATE_RELAY_ALLOW_HTTP; });
  const s = store();
  s.put("mcp", "linear", newInstance({ id: "linear", url: upstream("linear") }));
  saveProject(s, "@grok", { mcp: { linear: "linear" } });
  const { secret } = enableRemote(s, "@grok");
  const remote = s.get("project", "@grok")!.remote!;
  const gateway = new Gateway(s), endpoints = new RemoteEndpoints(s, gateway);
  cleanup.push(async () => { endpoints.close(); await gateway.close(); });
  endpoints.reconcile();
  const ws = await relay.connected();
  expect(relay.upgrades[0]).toEqual({ auth: `Bearer ${remote.token}`, node: "mac" });
  expect(relay.puts[0]).toEqual({ key: remote.key, auth: `Bearer ${remote.token}`, body: { secretHash: await sha256Hex(secret), enabled: true } });

  ws.send(JSON.stringify({ t: "req", id: "1", headers: {}, body: rpc("tools/call", { name: "linear__whoami", arguments: {} }) }));
  const res = await relay.next();
  expect(res).toMatchObject({ t: "res", id: "1", status: 200, headers: { "content-type": "application/json" } });
  expect(JSON.parse(res.body).result.content[0].text).toBe("linear");
  expect(s.db.query("select provider, account, model from request_log where provider = 'remote'").get()).toEqual({ provider: "remote", account: "@grok", model: "tools/call linear__whoami" });

  const rotated = rotateSecret(s, "@grok");
  endpoints.reconcile();
  for (let i = 0; i < 50 && relay.puts.length < 2; i++) await Bun.sleep(20);
  expect(relay.puts[1]!.body.secretHash).toBe(await sha256Hex(rotated.secret));
  expect(endpoints.summary(s.get("project", "@grok")!)).toMatchObject({ connected: true, updating: false });
});
