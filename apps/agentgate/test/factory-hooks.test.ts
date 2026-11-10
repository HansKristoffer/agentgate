import { afterAll, afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { app } from "../src/daemon.ts";
import { items } from "../src/factory/db.ts";
import { fetcher } from "../src/factory/folder.ts";
import { handleHook, http } from "../src/factory/hooks.ts";
import { preflight } from "../src/factory/preflight.ts";
import { Gateway } from "../src/mcp/gateway.ts";
import { Store } from "../src/store.ts";
import { getSecret, setSecret } from "../src/factory/secrets.ts";
import { removeTmp } from "./fixtures/git.ts";
import { factoryNode, postOp, terminal } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
const realFetch = http.fetch;
afterEach(() => void (http.fetch = realFetch));
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A relay stand-in: records endpoint PUTs, and forwards a delivery to the socket of the endpoint it names. A GET on
 * `/hook/:key` answers 405 like a relay that routes hooks, or 404 like one from before them while `old` is set. */
function fakeRelay() {
  const state = { old: false };
  const puts = new Map<string, { kind?: string; enabled: boolean }>();
  const deletes: string[] = [];
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
      if (req.method === "DELETE") {
        deletes.push(key!);
        return Response.json({ ok: true });
      }
      if (srv.upgrade(req, { data: { key: key! } })) return undefined;
      if (req.method === "GET" && req.url.includes("/hook/") && !state.old)
        return new Response("method not allowed", { status: 405 });
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
  return { url: `http://127.0.0.1:${server.port}`, puts, deletes, sockets, deliver, state };
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
    config: (repo) => ({ sources: sources(repo) }),
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
  const reachable = { configured: true, relayServes: true, connected: true };
  expect(api.sources.map((s) => [s.id, s.webhook, typeof s.lastPollAt])).toEqual([
    ["alerts", { ...reachable, url: alertsUrl }, "undefined"],
    ["bugs", { ...reachable, url: bugsUrl }, "number"],
    ["polled", undefined, "number"],
  ]);
  expect((await n.command("status")).output.join("\n")).toContain(alertsUrl);

  n.s.put("node", "a", { ...n.s.get("node", "a")!, healthDashboard: true });
  const page = await (await n.api("/factory")).text();
  expect(page).toContain('"configured":true');
  const tool = await (await n.ctx.gateway.builtin!()).client.callTool({ name: "factory_status", arguments: {} });
  const status = JSON.parse((tool.content as { text: string }[])[0]!.text) as string;
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
  // The dedupe key is agentgate's, so it stays out of the snapshot a thread reads as untrusted data.
  expect(items.list(n.s).map((i) => [i.source, i.phase, i.title, i.snapshot, i.dedupe])).toEqual([
    [
      "alerts",
      "held",
      "Disk full on prod",
      { title: "Disk full on prod", body: "/var is at 99% (from pager/2)" },
      "a-1",
    ],
  ]);

  // The key blocks while its item is open, and for the window after the item finished.
  n.advance(2 * 60 * 60_000);
  expect(JSON.parse((await delivery(body)).body)).toEqual({ ok: true, duplicate: true });
  expect((await n.command("reject", items.list(n.s)[0]!.key)).code).toBe(0);
  n.advance(59 * 60_000);
  expect(JSON.parse((await delivery(body)).body)).toEqual({ ok: true, duplicate: true });
  expect(items.list(n.s)).toHaveLength(1);
  n.advance(2 * 60_000);
  expect((await delivery(body)).status).toBe(202);
  expect(items.list(n.s)).toHaveLength(2);
});

test("a delivery to a source that takes items without approval is held while intake is paused", async () => {
  const { n } = await hookedFactory((repo) => [{ ...alerts(repo), intake: "auto" }]);
  const deliver = (id: string) => {
    const body = JSON.stringify({ alert: { id, name: `Alert ${id}`, details: "-" } });
    const headers = { "x-alert-signature": `v1=${sign("alert-signing-key", body, "base64")}` };
    return handleHook(n.f, "alerts", new Request("http://hook.invalid/?env=prod", { method: "POST", headers, body }));
  };
  await n.command("pause");
  expect((await deliver("paused")).status).toBe(202);
  await n.command("resume");
  expect((await deliver("running")).status).toBe(202);
  expect(items.list(n.s).map((i) => [i.dedupe, i.phase === "held"])).toEqual([
    ["paused", true],
    ["running", false],
  ]);
});

test("a source with only takes the deliveries whose value it names and answers the rest without an item, as Sentry's issue actions need", async () => {
  const { n } = await hookedFactory((repo) => [
    {
      id: "sentry",
      type: "webhook",
      repo,
      title: "{{body.data.issue.title}}",
      dedupe: "{{body.data.issue.id}}-{{body.action}}",
      only: { value: "{{body.action}}", in: ["created", "unresolved"] },
    },
  ]);
  const deliver = async (action: string) => {
    const body = JSON.stringify({ action, data: { issue: { id: "42", title: "TypeError in checkout" } } });
    const res = await handleHook(n.f, "sentry", new Request("http://hook.invalid/", { method: "POST", body }));
    return { status: res.status, body: await res.json() };
  };
  expect(await deliver("created")).toMatchObject({ status: 202 });
  expect(await deliver("assigned")).toEqual({ status: 200, body: { ok: true, ignored: true } });
  expect(await deliver("resolved")).toEqual({ status: 200, body: { ok: true, ignored: true } });
  // A regression after the fix is new work, though the issue is the same.
  expect(await deliver("unresolved")).toMatchObject({ status: 202 });
  expect(items.list(n.s).map((i) => i.dedupe)).toEqual(["42-created", "42-unresolved"]);
});

test("a source with 20 deliveries waiting for approval refuses the next with 429 until one is approved or rejected", async () => {
  const { n } = await hookedFactory((repo) => [alerts(repo)]);
  const deliver = (id: number) => {
    const body = JSON.stringify({ alert: { id: `a-${id}`, name: `Alert ${id}`, details: "-" } });
    const headers = { "x-alert-signature": `v1=${sign("alert-signing-key", body, "base64")}` };
    return handleHook(n.f, "alerts", new Request("http://hook.invalid/?env=prod", { method: "POST", headers, body }));
  };
  for (let i = 1; i <= 20; i++) expect((await deliver(i)).status).toBe(202);
  expect((await deliver(21)).status).toBe(429);
  expect((await deliver(22)).status).toBe(429);
  expect(items.list(n.s)).toHaveLength(20);
  const notes = n.f.events.recent(50).filter((e) => e.text.startsWith("Deliveries to alerts are refused"));
  expect(notes).toHaveLength(1);

  expect((await n.command("reject", items.list(n.s)[0]!.key)).code).toBe(0);
  expect((await deliver(23)).status).toBe(202);
  expect(items.list(n.s, { open: true })).toHaveLength(20);
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

test("when the factory moves to another machine, this one closes its hook socket but leaves the URL at the relay for the next", async () => {
  const { n, relay, hook } = await hookedFactory((repo) => [alerts(repo)]);
  const { key } = hook("alerts");
  await n.until(() => relay.sockets.has(key), "the hook socket");
  n.s.put("setting", "settings", { ...n.s.settings(), factory: { ...n.s.settings().factory!, node: "b" } });
  n.ctx.remote.reconcile();
  await n.until(() => relay.sockets.get(key)?.readyState === WebSocket.CLOSED, "the hook socket to close");
  await Bun.sleep(50); // a queued deletion is sent without being awaited
  expect(relay.deletes).toEqual([]);
  expect(getSecret(n.s, "~hook:alerts")).toBeDefined();
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

test("source test renders a delivery through the source's templates and says whether it would be added, adding nothing", async () => {
  const { n } = await hookedFactory((repo) => [
    alerts(repo),
    {
      id: "sentry",
      type: "webhook",
      repo,
      title: "{{body.data.issue.title}}",
      dedupe: "{{body.data.issue.id}}",
      only: { value: "{{body.action}}", in: ["created", "unresolved"] },
    },
  ]);
  const body = JSON.stringify({ alert: { id: "a-1", name: "Disk full", details: "/var is at 99%" } });
  const tried = await terminal(
    n.f,
    ["source", "test", "alerts", "--query", "env=prod", "--header", "User-Agent: pager/2"],
    body,
  );
  expect(tried).toEqual({
    code: 0,
    output: [
      "Signature: X-Alert-Signature, with ALERT_SECRET. A dry run does not check it; --send signs it.",
      "Title: Disk full on prod",
      "Dedupe key: a-1",
      "It would be added, waiting for your approval.",
      "Nothing was added.",
      "",
      "Body:",
      "/var is at 99% (from pager/2)",
    ],
  });

  const assigned = JSON.stringify({ action: "assigned", data: { issue: { id: "42", title: "TypeError" } } });
  const json = await terminal(n.f, ["source", "test", "sentry", "--json"], assigned);
  expect(JSON.parse(json.output[0]!)).toEqual({
    source: "sentry",
    rendered: { title: "TypeError", body: assigned, dedupe: "42", only: { value: "assigned", kept: false } },
    refused: 'only takes created, unresolved, and its value is "assigned"',
  });
  expect((await terminal(n.f, ["source", "test", "sentry"], assigned)).output).toContain(
    'It would not be added: only takes created, unresolved, and its value is "assigned".',
  );
  // Without stdin there is nothing to try.
  expect((await terminal(n.f, ["source", "test", "sentry"])).code).toBe(2);
  expect(items.list(n.s)).toEqual([]);
});

test("source test --send posts the delivery to the source's URL signed with its secret, and prints the answer", async () => {
  const { n, relay, hook } = await hookedFactory((repo) => [alerts(repo)]);
  const sent: { url: string; headers: Headers; body: string }[] = [];
  http.fetch = async (url, init) => {
    sent.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body) });
    return Response.json({ ok: true, item: "alerts-abc123" }, { status: 202 });
  };
  const body = JSON.stringify({ alert: { id: "a-1", name: "Disk full" } });
  const result = await terminal(n.f, ["source", "test", "alerts", "--send", "--query", "env=prod"], body);
  expect(result).toEqual({ code: 0, output: ['The URL answered 202: {"ok":true,"item":"alerts-abc123"}'] });
  expect(sent).toHaveLength(1);
  expect(sent[0]!.url).toBe(`${relay.url}/hook/${hook("alerts").key}?env=prod`);
  expect(sent[0]!.body).toBe(body);
  expect(sent[0]!.headers.get("x-alert-signature")).toBe(`v1=${sign("alert-signing-key", body, "base64")}`);
  expect(sent[0]!.headers.get("content-type")).toBe("application/json");
  // The delivery went out; nothing was added here by the command itself.
  expect(items.list(n.s)).toEqual([]);
});

test("deliver takes a delivery on loopback as the URL would, held or started per the source's intake, and dedupes a repeat", async () => {
  const { n } = await hookedFactory((repo) => [alerts(repo), { ...alerts(repo), id: "pager", intake: "auto" }]);
  const body = JSON.stringify({ alert: { id: "a-1", name: "Disk full", details: "-" } });
  // No signature: the loopback caller is this machine.
  const held = await terminal(n.f, ["deliver", "alerts", "--query", "env=prod"], body);
  expect(held.code).toBe(0);
  expect(held.output[0]).toMatch(/^Added alerts-\w{6}, waiting for your approval\.$/);
  expect(await terminal(n.f, ["deliver", "alerts", "--query", "env=prod"], body)).toEqual({
    code: 0,
    output: ["A duplicate: an item with its dedupe key is open or finished recently. Nothing added."],
  });
  const started = await terminal(n.f, ["deliver", "pager", "--query", "env=prod"], body);
  expect(started.output[0]).toMatch(/^Added pager-\w{6}\.$/);
  expect(items.list(n.s).map((i) => [i.source, i.title, i.phase === "held"])).toEqual([
    ["alerts", "Disk full on prod", true],
    ["pager", "Disk full on prod", false],
  ]);
});

test("deliver is refused over the tailnet, while source test answers there", async () => {
  const { n } = await hookedFactory((repo) => [alerts(repo)]);
  n.s.setLocal("adminToken", "admin-token");
  const input = { id: "alerts", body: JSON.stringify({ alert: { name: "x" } }) };
  const op = (name: string, listener: "loopback" | "tailnet") =>
    postOp(n.ctx, name, input, listener, { authorization: "Bearer admin-token" });
  const refused = await op("deliver", "tailnet");
  expect({ status: refused.status, body: await refused.json() }).toEqual({
    status: 403,
    body: { error: "This operation requires a local connection" },
  });
  expect((await op("source test", "tailnet")).status).toBe(200);
  expect(items.list(n.s)).toEqual([]);
});

test("the webhooks check fails with its fix when the relay does not serve /hook, and passes when it does", async () => {
  const { n, relay, hook } = await hookedFactory((repo) => [alerts(repo)]);
  await n.until(() => relay.sockets.has(hook("alerts").key), "the hook socket");
  const check = async () => (await preflight(n.f, { fresh: false })).find((c) => c.id === "webhooks");
  await n.until(async () => (await check())?.state === "ok", "the check to pass");

  relay.state.old = true;
  n.advance(5 * 60_000);
  await n.f.loops.find((l) => l.name === "factory-hooks")!.run();
  const failing = await check();
  expect(failing).toMatchObject({ state: "fail" });
  expect(failing!.detail).toContain("answers 404 on /hook");
  expect(failing!.fix).toContain("agentgate factory deliver <id>");
  // Neither the URL nor its key is in a check, which the token-less page shows.
  expect(JSON.stringify(failing)).not.toContain(hook("alerts").key);
  const api = (await (await n.api("/api/factory")).json()) as { sources: { webhook?: { relayServes?: boolean } }[] };
  expect(api.sources[0]!.webhook?.relayServes).toBe(false);

  relay.state.old = false;
  await n.f.loops.find((l) => l.name === "factory-hooks")!.run();
  expect(await check()).toMatchObject({ state: "ok" });
});

test("the board shows each webhook's last delivery and how it was answered", async () => {
  const { n, relay, hook } = await hookedFactory((repo) => [alerts(repo)]);
  const { key } = hook("alerts");
  await n.until(() => relay.sockets.has(key), "the hook socket");
  const board = async () =>
    (await (await n.api("/api/factory")).json()) as {
      sources: { webhook?: { lastDelivery?: { at: number; status: number } } }[];
    };
  expect((await board()).sources[0]!.webhook?.lastDelivery).toBeUndefined();
  expect((await n.command("status")).output.join("\n")).toContain("no delivery yet");

  const body = JSON.stringify({ alert: { id: "a-1", name: "Disk full" } });
  const headers = { "x-alert-signature": `v1=${sign("alert-signing-key", body, "base64")}` };
  expect((await relay.deliver(key, { headers, body, query: "env=prod" })).status).toBe(202);
  expect((await board()).sources[0]!.webhook?.lastDelivery).toEqual({ at: n.s.now(), status: 202 });
  expect((await n.command("status")).output.join("\n")).toContain("last delivery just now (202)");
});
