import { afterAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { type Rec, Store } from "../src/store.ts";
import { pairCode, peerRoutes, peers, pullPeer } from "../src/sync.ts";

function node(name: string) {
  const s = new Store(":memory:");
  s.setLocal("node", name);
  return s;
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => servers.forEach((x) => x.stop(true)));

function listen(s: Store) {
  const app = new Hono().route("/peer", peerRoutes(s, () => { }));
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

test("merge order: rev, then updated_at, then node", () => {
  const s = node("a");
  s.put("setting", "settings", { threshold: 90 });
  const cur = s.record("setting", "settings")!;
  const at = (over: Partial<Rec>, threshold: number) => ({ ...cur, ...over, data: JSON.stringify({ threshold }) });
  expect(s.merge(at({ rev: 0 }, 1))).toBe(false);
  expect(s.merge(at({ updated_at: cur.updated_at - 1 }, 2))).toBe(false);
  expect(s.merge(at({ node: "0" }, 3))).toBe(false);
  expect(s.merge(at({ node: "b" }, 4))).toBe(true); // same rev and time, higher node name
  expect(s.merge(at({ rev: 2, updated_at: 1 }, 5))).toBe(true);
  expect(s.settings().threshold).toBe(5);
});

test("tombstones propagate and remain after 30 days to prevent resurrection", () => {
  const a = node("a");
  const b = node("b");
  a.put("mcp", "x", { id: "x", template: "custom-http", transport: "http", url: "http://x" });
  const stale = a.changes(0).records.find(r => r.kind === "mcp")!;
  for (const r of a.changes(0).records) b.merge(r);
  a.del("mcp", "x");
  for (const r of a.changes(0).records) b.merge(r);
  expect(b.get("mcp", "x")).toBeUndefined();
  expect(b.record("mcp", "x")!.deleted).toBe(1);
  b.now = () => Date.now() + 31 * 86400_000;
  b.purgeTombstones();
  expect(b.record("mcp", "x")!.deleted).toBe(1);
  expect(b.merge(stale)).toBe(false);
});

test("pairing, pull from since=0, and passing records on through a middle node", async () => {
  const a = node("a");
  const b = node("b");
  const c = node("c");
  const urlA = listen(a);
  const urlB = listen(b);
  a.put("account", "acc", { id: "acc", provider: "claude", label: "work" });

  // Pair b with a through the join endpoint.
  const code = pairCode(a);
  const res = await fetch(`${urlA}/peer/join`, { method: "POST", body: JSON.stringify({ code, node: "b", url: urlB, protocol: 2 }) });
  const { token } = (await res.json()) as { token: string };
  b.db.run("insert into peers values ('a', ?, ?, 0, null)", [urlA, token]);
  expect((await fetch(`${urlA}/peer/join`, { method: "POST", body: JSON.stringify({ code, node: "x", url: urlB, protocol: 2 }) })).status).toBe(403); // one-time

  await pullPeer(b, peers(b)[0]!);
  expect(b.get("account", "acc")!.label).toBe("work");

  // c is paired only with b, and still gets a's record (and a's heartbeat).
  const tokC = "c-token";
  b.db.run("insert into peers values ('c', 'http://unused', ?, 0, null)", [tokC]);
  c.db.run("insert into peers values ('b', ?, ?, 0, null)", [urlB, tokC]);
  await pullPeer(c, peers(c)[0]!);
  expect(c.get("account", "acc")!.label).toBe("work");
  expect(Number(c.local("seen:a"))).toBeGreaterThan(0);

  // An edit on c flows back to a.
  c.put("account", "acc", { ...c.get("account", "acc")!, label: "renamed" });
  b.db.run("update peers set url = ? where node = 'c'", [listen(c)]);
  await pullPeer(b, peers(b).find((p) => p.node === "c")!);
  a.db.run("insert or replace into peers values ('b', ?, ?, 0, null)", [urlB, token]);
  await pullPeer(a, peers(a).find((p) => p.node === "b")!);
  expect(a.get("account", "acc")!.label).toBe("renamed");

  expect((await fetch(`${urlA}/peer/changes?since=0`)).status).toBe(401);
});

test("a malformed peer batch changes neither records nor cursor", async () => {
  const s = node("local");
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ protocol: 2, seq: 2, records: [{ kind: "account", id: "a", rev: 1, node: "peer", updated_at: 1, deleted: 0, seq: 1, data: '{"id":"a","provider":"claude","label":"a"}' }, { kind: "setting", id: "settings", rev: 1, node: "peer", updated_at: 1, deleted: 0, seq: 2, data: '{"threshold":1000}' }] }) });
  s.db.run("insert into peers values ('peer', ?, 'token', 0, null)", [`http://127.0.0.1:${server.port}`]);
  try { await expect(pullPeer(s, peers(s)[0]!)).rejects.toThrow(); expect(s.get("account", "a")).toBeUndefined(); expect(peers(s)[0]!.cursor).toBe(0); expect(s.seq()).toBe(0); } finally { server.stop(true); s.close(); }
});

test("peer cursor validation and protocol mismatch fail cleanly", async () => {
  const s = node("local"), url = listen(s); s.db.run("insert into peers values ('p', 'http://unused', 'token', 0, null)");
  expect((await fetch(`${url}/peer/changes?since=NaN`, { headers: { authorization: "Bearer token" } })).status).toBe(400);
  expect((await fetch(`${url}/peer/join`, { method: "POST", body: JSON.stringify({ protocol: 1, node: "old", url: "http://x", code: pairCode(s) }) })).status).toBe(400);
});
