import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Remote MCP endpoints on real workerd: hashes set by the node, one hibernatable socket, no replay.
const TOKEN = "T".repeat(43), SECRET = "S".repeat(43);
const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), b => b.toString(16).padStart(2, "0")).join("");
const keyOf = (i: number) => `key${String(i).padStart(19, "0")}`;

const put = async (key: string, update: { secretHash?: string; enabled?: boolean }, token = TOKEN) => exports.default.fetch(`https://relay.test/e/${key}`, {
  method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ secretHash: update.secretHash ?? await sha(SECRET), enabled: update.enabled ?? true }),
});
const mcp = (key: string, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" }, secret = SECRET) => exports.default.fetch(`https://relay.test/mcp/${key}`, {
  method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "mcp-protocol-version": "2025-06-18" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
async function connect(key: string, token = TOKEN) {
  const res = await exports.default.fetch(`https://relay.test/e/${key}/connect`, { headers: { upgrade: "websocket", authorization: `Bearer ${token}`, "x-agentgate-node": "srv" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const frames: any[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener("message", (e) => { frames.push(JSON.parse(e.data as string)); waiters.splice(0).forEach(w => w()); });
  const next = async () => { while (!frames.length) await new Promise<void>(r => waiters.push(r)); return frames.shift(); };
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
    node.ws.send(JSON.stringify({ t: "res", id: req.id, status: 200, headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}' }));
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
    const closed = new Promise<void>(r => first.ws.addEventListener("close", () => r()));
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
    const closed = new Promise<void>(r => node.ws.addEventListener("close", () => r()));
    expect((await exports.default.fetch(`https://relay.test/e/${key}`, { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    await closed;
    expect((await mcp(key)).status).toBe(404);

    const idle = keyOf(5);
    await put(idle, {});
    const stub = env.ENDPOINTS.getByName(idle);
    await runInDurableObject(stub, (_, state) => { state.storage.sql.exec("update meta set lastActive = 0"); });
    await runDurableObjectAlarm(stub);
    expect((await mcp(idle)).status).toBe(404);
  });
});
