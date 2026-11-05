import { afterAll, afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { app } from "../src/daemon.ts";
import { items } from "../src/factory/db.ts";
import { fetcher } from "../src/factory/folder.ts";
import { handleHook } from "../src/factory/hooks.ts";
import { runTool } from "../src/factory/runtime.ts";
import { Gateway } from "../src/mcp/gateway.ts";
import { Store } from "../src/store.ts";
import { getSecret, setSecret } from "../src/factory/secrets.ts";
import { removeTmp } from "./fixtures/git.ts";
import { factoryNode } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A relay stand-in: records endpoint PUTs, and forwards a delivery to the socket of the endpoint it names. */
function fakeRelay() {
  const puts = new Map<string, { kind?: string; enabled: boolean }>();
  const sockets = new Map<string, ServerWebSocket<{ key: string }>>();
  const replies = new Map<string, (frame: { status: number; body: string }) => void>();
  const server = Bun.serve<{ key: string }>({
    port: 0,
    async fetch(req, srv) {
      const [, , key] = new URL(req.url).pathname.split("/");
      if (req.method === "PUT") {
        puts.set(key!, (await req.json()) as never);
        return Response.json({ ok: true });
      }
      if (srv.upgrade(req, { data: { key: key! } })) return undefined;
      return new Response("no", { status: 404 });
    },
    websocket: {
      open: (ws) => void sockets.set(ws.data.key, ws),
      message(ws, m) {
        if (m === "ping") return void ws.send("pong");
        const frame = JSON.parse(String(m));
        replies.get(frame.id)?.(frame);
      },
    },
  });
  cleanup.push(() => server.stop(true));
  let next = 0;
  /** What the relay does with POST /hook/:key: one frame over that endpoint's socket. */
  const deliver = (key: string, delivery: { headers: Record<string, string>; body: string; query?: string }) => {
    const id = String(++next);
    const reply = new Promise<{ status: number; body: string }>((resolve) => replies.set(id, resolve));
    sockets.get(key)!.send(JSON.stringify({ t: "req", id, ...delivery }));
    return reply;
  };
  return { url: `http://127.0.0.1:${server.port}`, puts, sockets, deliver };
}

const sign = (secret: string, body: string, encoding: "hex" | "base64" = "hex") =>
  createHmac("sha256", secret).update(body).digest(encoding);

async function hookedFactory(sources: (repo: string) => unknown[]) {
  const relay = fakeRelay();
  process.env.AGENTGATE_RELAY_ALLOW_HTTP = "1";
  process.env.AGENTGATE_RELAY_URL = relay.url;
  cleanup.push(() => {
    delete process.env.AGENTGATE_RELAY_URL;
    delete process.env.AGENTGATE_RELAY_ALLOW_HTTP;
  });
  const n = await factoryNode(cleanup, {
    config: (repo) => ({ secrets: ["ALERT_SECRET", "GH_SECRET", "LINEAR_SECRET"], sources: sources(repo) }),
  });
  cleanup.push(() => n.ctx.remote.close());
  setSecret(n.s, "ALERT_SECRET", "alert-signing-key");
  setSecret(n.s, "GH_SECRET", "github-signing-key");
  setSecret(n.s, "LINEAR_SECRET", "linear-signing-key");
  await n.f.loops.find((l) => l.name === "factory-hooks")!.run();
  const hook = (source: string) => JSON.parse(getSecret(n.s, `~hook:${source}`)!) as { key: string };
  return { n, relay, hook };
}

const alerts = (repo: string) => ({
  id: "alerts",
  type: "webhook",
  repo,
  signature: { header: "X-Alert-Signature", encoding: "base64", prefix: "v1=", secret: "secret:ALERT_SECRET" },
  title: "{{body.alert.name}} on {{query.env}}",
  body: "{{body.alert.details}} (from {{headers.user-agent}})",
  dedupe: "{{body.alert.id}}",
});

test("each webhook-capable source gets a hook URL kept as a ~hook secret, shown by GET /api/factory and the CLI but not by /factory or factory_status", async () => {
  const { n, relay, hook } = await hookedFactory((repo) => [
    alerts(repo),
    { id: "bugs", type: "github", repo, label: "factory", webhook: { secret: "secret:GH_SECRET" } },
    { id: "polled", type: "github", repo, label: "factory" },
  ]);
  expect(getSecret(n.s, "~hook:polled")).toBeUndefined();
  const keys = [hook("alerts").key, hook("bugs").key];
  await n.until(() => keys.every((key) => relay.sockets.has(key)), "both hook sockets");
  for (const key of keys) expect(relay.puts.get(key)).toMatchObject({ kind: "hook", enabled: true });

  n.f.sources.set("github", { type: "github", poll: async () => [] });
  await n.intake();
  const [alertsUrl, bugsUrl] = keys.map((key) => `${relay.url}/hook/${key}`) as [string, string];
  const urls = [alertsUrl, bugsUrl];
  const api = (await (await n.api("/api/factory")).json()) as {
    sources: { id: string; webhook?: unknown; lastPollAt?: number }[];
  };
  // One row per source: the webhook's part merges into the controller's, which reported the poll.
  expect(api.sources.map((s) => [s.id, s.webhook, typeof s.lastPollAt])).toEqual([
    ["alerts", { configured: true, url: alertsUrl }, "undefined"],
    ["bugs", { configured: true, url: bugsUrl }, "number"],
    ["polled", undefined, "number"],
  ]);
  expect((await n.command("status")).output.join("\n")).toContain(alertsUrl);

  n.s.put("node", "a", { ...n.s.get("node", "a")!, healthDashboard: true });
  const page = await (await n.api("/factory")).text();
  expect(page).toContain('"configured":true');
  const status = String(await runTool(n.f, "factory_status", {}, { node: "a" }));
  expect(status).toContain("webhook configured");
  for (const url of urls) {
    expect(page).not.toContain(url);
    expect(status).not.toContain(url);
  }
});

test("a signed delivery through the relay becomes one held item; a bad signature gets 401 and a repeated dedupe key within the window adds nothing", async () => {
  const { n, relay, hook } = await hookedFactory((repo) => [alerts(repo)]);
  const { key } = hook("alerts");
  await n.until(() => relay.sockets.has(key), "the hook socket");
  const body = JSON.stringify({ alert: { id: "a-1", name: "Disk full", details: "/var is at 99%" } });
  const delivery = (payload: string, signature = `v1=${sign("alert-signing-key", payload, "base64")}`) =>
    relay.deliver(key, {
      headers: { "x-alert-signature": signature, "user-agent": "pager/2", "content-type": "application/json" },
      body: payload,
      query: "env=prod",
    });

  expect((await delivery(body, `v1=${sign("wrong-key", body, "base64")}`)).status).toBe(401);
  expect((await delivery(body, "")).status).toBe(401);
  expect(items.list(n.s)).toEqual([]);

  expect((await delivery(body)).status).toBe(202);
  expect(items.list(n.s).map((i) => [i.source, i.phase, i.title, i.snapshot])).toEqual([
    [
      "alerts",
      "held",
      "Disk full on prod",
      { title: "Disk full on prod", body: "/var is at 99% (from pager/2)", dedupe: "a-1" },
    ],
  ]);

  n.advance(59 * 60_000);
  expect(JSON.parse((await delivery(body)).body)).toEqual({ ok: true, duplicate: true });
  expect(items.list(n.s)).toHaveLength(1);
  n.advance(2 * 60_000);
  expect((await delivery(body)).status).toBe(202);
  expect(items.list(n.s)).toHaveLength(2);
});

test("a valid GitHub or Linear delivery polls that source now and adds no item itself", async () => {
  const { n } = await hookedFactory((repo) => [
    { id: "bugs", type: "github", repo, label: "factory", webhook: { secret: "secret:GH_SECRET" } },
    {
      id: "tickets",
      type: "linear",
      repo,
      team: "ENG",
      label: "factory",
      apiKey: "secret:LINEAR_SECRET",
      webhook: { secret: "secret:LINEAR_SECRET" },
    },
  ]);
  const polled: string[] = [];
  for (const type of ["github", "linear"] as const)
    n.f.sources.set(type, { type, poll: async (source) => (polled.push(source.id), []) });
  const body = JSON.stringify({ action: "opened" });
  const deliver = (source: string, headers: Record<string, string>) =>
    handleHook(n.f, source, new Request("http://hook.invalid/", { method: "POST", headers, body }));

  expect((await deliver("bugs", { "x-hub-signature-256": `sha256=${sign("wrong", body)}` })).status).toBe(401);
  expect((await deliver("bugs", { "x-hub-signature-256": `sha256=${sign("github-signing-key", body)}` })).status).toBe(
    202,
  );
  expect((await deliver("tickets", { "linear-signature": sign("linear-signing-key", body) })).status).toBe(202);
  await n.until(() => polled.length === 2, "both polls");
  expect(polled.sort()).toEqual(["bugs", "tickets"]);
  expect(items.list(n.s)).toEqual([]);
});

test("a source removed from the folder loses its URL: the ~hook secret goes and the relay endpoint is deleted", async () => {
  const { n, relay, hook } = await hookedFactory((repo) => [alerts(repo)]);
  const { key } = hook("alerts");
  await n.until(() => relay.sockets.has(key), "the hook socket");
  const commit = "b".repeat(40);
  const dir = join(fetcher.root, commit);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "factory.yaml"),
    JSON.stringify({ version: 1, name: "acme", repositories: { [n.repo]: {} } }),
  );
  fetcher.fetch = async () => ({ commit, dir });
  expect((await n.command("reload")).code).toBe(0);

  await n.f.loops.find((l) => l.name === "factory-hooks")!.run();
  expect(getSecret(n.s, "~hook:alerts")).toBeUndefined();
  expect(JSON.parse(n.s.local("remote:delete")!)).toEqual([expect.objectContaining({ key })]);
  await n.until(() => relay.sockets.get(key)?.readyState === WebSocket.CLOSED, "the hook socket to close");
});

test("no listener serves a hook: a signed delivery to the daemon's own routes adds nothing", async () => {
  const { n, hook } = await hookedFactory((repo) => [alerts(repo)]);
  const handler = app(n.ctx);
  const body = JSON.stringify({ alert: { id: "a-1", name: "Disk full" } });
  const post = (path: string, listener: "loopback" | "tailnet") =>
    handler.fetch(
      new Request(`http://127.0.0.1:7878${path}`, {
        method: "POST",
        headers: { host: "127.0.0.1:7878", "x-alert-signature": `v1=${sign("alert-signing-key", body, "base64")}` },
        body,
      }),
      { listener },
    );
  expect((await post(`/hook/${hook("alerts").key}`, "loopback")).status).toBe(404);
  expect((await post(`/hook/${hook("alerts").key}`, "tailnet")).status).toBe(404);
  expect((await post("/api/factory/hooks/alerts", "loopback")).status).toBe(404);
  expect(items.list(n.s)).toEqual([]);
});

test("an MCP request over 256 KiB is refused even though relay frames may carry a 1 MiB webhook", async () => {
  const s = new Store(":memory:");
  const gateway = new Gateway(s);
  cleanup.push(() => gateway.close().then(() => s.close()));
  const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", pad: "x".repeat(300 * 1024) });
  const { response } = await gateway.handleRemote("@grok", big, {}, new AbortController().signal);
  expect(response.status).toBe(413);
});
