import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// The node channel on real workerd: the group token gates it, a call goes over the target's socket and back, and a
// dropped socket fails the call instead of replaying it.
const T = "C".repeat(43);
const group = "c".repeat(32);

const create = () => exports.default.fetch(`https://relay.test/g/${group}`, {
  method: "POST", headers: { authorization: `Bearer ${T}`, "content-type": "application/json" }, body: JSON.stringify({ protocol: 1 }),
});
const call = (node: string, body: string, token = T) => exports.default.fetch(`https://relay.test/g/${group}/n/${node}/call`, {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" }, body,
});
const upgrade = (node: string, token = T) =>
  exports.default.fetch(`https://relay.test/g/${group}/n/${node}/connect`, { headers: { upgrade: "websocket", authorization: `Bearer ${token}` } });
async function connect(node: string) {
  const res = await upgrade(node);
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const frames: any[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener("message", (e) => { frames.push(JSON.parse(e.data as string)); waiters.splice(0).forEach((w) => w()); });
  const next = async () => { while (!frames.length) await new Promise<void>((r) => waiters.push(r)); return frames.shift(); };
  return { ws, next };
}

describe("node channel", () => {
  it("forwards a member's call over the target's socket and returns the sealed answer", async () => {
    expect((await create()).status).toBe(200);
    expect((await upgrade("b", "X".repeat(43))).status).toBe(401);
    expect((await call("b", "sealed")).status).toBe(503); // nobody connected yet
    const b = await connect("b");
    const pending = call("b", "sealed-call");
    const req = await b.next();
    expect(req).toMatchObject({ t: "req", body: "sealed-call" });
    b.ws.send(JSON.stringify({ t: "res", id: req.id, body: "sealed-answer" }));
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("sealed-answer");
    expect((await call("b", "x", "Y".repeat(43))).status).toBe(401);
    b.ws.close();
  });

  it("a newer connection replaces the old one, and a dropped socket fails its call", async () => {
    await create();
    const old = await connect("srv");
    const fresh = await connect("srv");
    const pending = call("srv", "first");
    const req = await fresh.next();
    expect(req.body).toBe("first");
    fresh.ws.close();
    expect((await pending).status).toBe(502);
    old.ws.close();
  });
});
