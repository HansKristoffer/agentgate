import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { relayApp } from "../src/app.ts";

// Remote MCP endpoints on real workerd: hashes set by the node, one hibernatable socket, no replay.
const TOKEN = "T".repeat(43),
  SECRET = "S".repeat(43);
const sha = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
const keyOf = (i: number) => `key${String(i).padStart(19, "0")}`;

const put = async (
  key: string,
  update: { secretHash?: string; enabled?: boolean; kind?: "mcp" | "hook" },
  token = TOKEN,
) =>
  exports.default.fetch(`https://relay.test/e/${key}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      secretHash: update.secretHash ?? (await sha(SECRET)),
      enabled: update.enabled ?? true,
      ...(update.kind && { kind: update.kind }),
    }),
  });
const mcp = (key: string, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" }, secret = SECRET) =>
  exports.default.fetch(`https://relay.test/mcp/${key}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
async function connect(key: string, token = TOKEN) {
  const res = await exports.default.fetch(`https://relay.test/e/${key}/connect`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${token}`, "x-agentgate-node": "srv" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const frames: any[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener("message", (e) => {
    frames.push(JSON.parse(e.data as string));
    waiters.splice(0).forEach((w) => w());
  });
  const next = async () => {
    while (!frames.length) await new Promise<void>((r) => waiters.push(r));
    return frames.shift();
  };
  return { ws, next };
}

describe("remote MCP endpoints", () => {
  it("forwards an authenticated request over the node's socket and returns its answer", async () => {
    const key = keyOf(1);
    expect((await put(key, {})).status).toBe(200);
    expect((await mcp(key)).status).toBe(503); // no machine connected yet
    const node = await connect(key);
    const pending = mcp(key);
    const req = await node.next();
    expect(req).toMatchObject({ t: "req", headers: { "mcp-protocol-version": "2025-06-18" } });
    expect(JSON.parse(req.body)).toMatchObject({ method: "tools/list" });
    expect(req.headers.authorization).toBeUndefined(); // the relay checked the secret; it isn't forwarded
    node.ws.send(
      JSON.stringify({
        t: "res",
        id: req.id,
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}',
      }),
    );
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: { tools: [] } });
    // Notifications: an empty 202 stays empty.
    const note = mcp(key, { jsonrpc: "2.0", method: "notifications/initialized" });
    const n = await node.next();
    node.ws.send(JSON.stringify({ t: "res", id: n.id, status: 202, headers: {}, body: "" }));
    expect((await note).status).toBe(202);
    node.ws.close();
  });

  it("rejects wrong secrets, disabled endpoints, batches and other methods; only the node's token can change it", async () => {
    const key = keyOf(2);
    await put(key, {});
    const node = await connect(key);
    expect((await mcp(key, undefined, "X".repeat(43))).status).toBe(401);
    expect((await mcp(key, "[]")).status).toBe(400);
    expect((await exports.default.fetch(`https://relay.test/mcp/${key}`)).status).toBe(405);
    expect((await put(key, { enabled: false }, "Y".repeat(43))).status).toBe(401);
    expect((await put(key, { enabled: false })).status).toBe(200);
    expect((await mcp(key)).status).toBe(403);
    // A new secret takes effect at the relay immediately.
    await put(key, { secretHash: await sha("N".repeat(43)) });
    expect((await mcp(key)).status).toBe(401);
    node.ws.close();
  });

  it("a newer connection replaces the old one, and dropped or timed-out requests are not replayed", async () => {
    const key = keyOf(3);
    await put(key, {});
    const first = await connect(key);
    const pending = mcp(key);
    await first.next();
    const closed = new Promise<void>((r) => first.ws.addEventListener("close", () => r()));
    const second = await connect(key); // closes the first socket
    await closed;
    expect((await pending).status).toBe(502);
    const again = mcp(key);
    const req = await second.next();
    second.ws.send(JSON.stringify({ t: "res", id: req.id, status: 200, headers: {}, body: "{}" }));
    expect((await again).status).toBe(200);
    second.ws.close();
  });

  it("deleting closes the socket and frees the key; idle endpoints expire", async () => {
    const key = keyOf(4);
    await put(key, {});
    const node = await connect(key);
    const closed = new Promise<void>((r) => node.ws.addEventListener("close", () => r()));
    expect(
      (
        await exports.default.fetch(`https://relay.test/e/${key}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(200);
    await closed;
    expect((await mcp(key)).status).toBe(404);

    const idle = keyOf(5);
    await put(idle, {});
    const stub = env.ENDPOINTS.getByName(idle);
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec("update meta set lastActive = 0");
    });
    await runDurableObjectAlarm(stub);
    expect((await mcp(idle)).status).toBe(404);
  });
});

describe("webhook endpoints", () => {
  const hook = (key: string, body: BodyInit = "{}", headers: Record<string, string> = {}, query = "") =>
    exports.default.fetch(`https://relay.test/hook/${key}${query}`, { method: "POST", headers, body });
  const answer = (node: Awaited<ReturnType<typeof connect>>, id: string, status: number, body: string) =>
    node.ws.send(JSON.stringify({ t: "res", id, status, headers: { "content-type": "text/plain" }, body }));

  it("forwards a delivery with the headers its sender signed, and returns the node's answer", async () => {
    const key = keyOf(10);
    expect((await put(key, { kind: "hook" })).status).toBe(200);
    expect((await hook(key)).status).toBe(503); // no machine connected, and nothing is queued for it
    const node = await connect(key);
    const body = '\uFEFF{"action":"opened","title":"Grüße"}';
    const pending = hook(
      key,
      body,
      {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=0123abcd",
        "linear-signature": "4567ef",
        "x-custom-thing": "Kept As Sent",
        cookie: "session=1",
        connection: "keep-alive, x-per-hop",
        "x-per-hop": "1",
        "keep-alive": "timeout=5",
        te: "trailers",
        "proxy-authorization": "Basic x",
        "x-agentgate-op": "connect",
      },
      "?source=ci&x=1",
    );
    const req = await node.next();
    expect(req.body).toBe(body); // byte for byte, byte-order mark included
    expect(req.query).toBe("source=ci&x=1");
    expect(req.headers).toMatchObject({
      "x-hub-signature-256": "sha256=0123abcd",
      "linear-signature": "4567ef",
      "x-custom-thing": "Kept As Sent",
      "content-type": "application/json",
    });
    for (const name of ["cookie", "connection", "x-per-hop", "keep-alive", "te", "proxy-authorization", "host"])
      expect(req.headers[name]).toBeUndefined();
    expect(Object.keys(req.headers).filter((n) => n.startsWith("x-agentgate-"))).toEqual([]);
    answer(node, req.id, 202, "queued");
    const res = await pending;
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("queued");
    node.ws.close();
  });

  it("needs no bearer or relay key, while MCP keeps its bearer and kinds never cross", async () => {
    // A self-hosted relay with RELAY_KEY: managing endpoints needs it, the public routes do not.
    const app = relayApp({
      group: () => {
        throw new Error("unused");
      },
      endpoint: (key) => env.ENDPOINTS.getByName(key),
      relayKey: "service-key",
    });
    const send = (path: string, init: RequestInit = {}) => app.fetch(new Request(`https://relay.test${path}`, init));
    const hookKey = keyOf(11),
      mcpKey = keyOf(12);
    expect((await put(hookKey, { kind: "hook" })).status).toBe(200);
    expect((await put(mcpKey, {})).status).toBe(200);
    expect((await put(hookKey, {})).status).toBe(409); // a published URL keeps its kind
    const node = await connect(hookKey);

    const pending = send(`/hook/${hookKey}`, { method: "POST", body: "{}" });
    const req = await node.next();
    answer(node, req.id, 200, "ok");
    expect((await pending).status).toBe(200);

    expect((await send(`/mcp/${mcpKey}`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await send(`/hook/${mcpKey}`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await mcp(hookKey)).status).toBe(404); // the endpoint's secret does not open a hook as MCP
    expect((await exports.default.fetch(`https://relay.test/hook/${hookKey}`)).status).toBe(405);
    expect((await hook(hookKey, "x".repeat(1024 * 1024 + 1))).status).toBe(413);
    expect((await hook(hookKey, new Uint8Array([0x7b, 0xff, 0x7d]))).status).toBe(415);
    node.ws.close();
  });

  it("endpoints stored before kinds existed stay MCP endpoints", async () => {
    const key = keyOf(13);
    await runInDurableObject(env.ENDPOINTS.getByName(key), async (_, state) => {
      state.storage.sql.exec(
        "create table meta (key text, tokenHash text, secretHash text, enabled integer, lastActive integer, admitted integer)",
      );
      state.storage.sql.exec(
        "insert into meta values (?, ?, ?, 1, ?, 1)",
        key,
        await sha(TOKEN),
        await sha(SECRET),
        Date.now(),
      );
    });
    expect((await mcp(key)).status).toBe(503); // admitted and authenticated; no machine connected
    expect((await hook(key)).status).toBe(404);
    expect((await put(key, { enabled: false })).status).toBe(200);
    expect((await mcp(key)).status).toBe(403);
  });
});
