import { expect, test } from "bun:test";
import { RELAY_LIMITS, checkPage, type ChangesResponse } from "@agentgate/protocol/relay";
import { memoryRelay } from "./memory.ts";

const G = "0123456789abcdef0123456789abcdef";
const T = "A".repeat(43);
const key = (i: number) => `k${String(i).padStart(42, "0")}`;
const blob = (i: number | string, size = 40) => `${i}`.padEnd(size, "b");

const tables = (relay: ReturnType<typeof memoryRelay>, group: string) =>
  relay.groups.get(group)!.sql.db.query("select name from sqlite_master where type = 'table'").all();

function client(relay = memoryRelay(), token = T, group = G, extra: Record<string, string> = {}) {
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await relay.fetch(`https://relay.test/g/${group}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}), ...extra, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any, headers: res.headers };
  };
  const create = () => call("POST", "", { protocol: 1 });
  const push = (generation: string, node: string, entries: { key: string; pusherSeq: number; blob: string }[]) =>
    call("POST", "/push", { protocol: 1, generation, node, entries });
  const changes = (q: Record<string, string | number>) => call("GET", `/changes?${new URLSearchParams(Object.entries(q).map(([k, v]): [string, string] => [k, String(v)]))}`);
  return { relay, call, create, push, changes };
}

test("create, authenticate, and keep the generation", async () => {
  const c = client();
  expect((await c.call("GET", "/nodes")).status).toBe(404); // reads never create groups
  expect(tables(c.relay, G)).toEqual([]); // ...or any storage
  const made = await c.create();
  expect(made.status).toBe(200);
  expect(made.body.generation).toMatch(/^[0-9a-f]{32}$/);
  expect((await c.create()).body.generation).toBe(made.body.generation);
  const intruder = client(c.relay, "B".repeat(43));
  expect((await intruder.create()).status).toBe(401);
  expect((await intruder.call("GET", "/nodes")).status).toBe(401);
  expect((await c.call("GET", "/nodes", undefined, { authorization: "Bearer short" })).status).toBe(401);
  expect((await client(c.relay, T, "nothex").create()).status).toBe(400);
  expect((await c.call("POST", "", { protocol: 2 })).status).toBe(400);
});

test("upserts: identical retries are no-ops, lower or reused counters conflict, batches are atomic", async () => {
  const c = client();
  const { generation } = (await c.create()).body;
  const first = await c.push(generation, "a", [{ key: key(1), pusherSeq: 1, blob: blob(1) }]);
  expect(first.body.headSeq).toBe(1);
  expect((await c.push(generation, "a", [{ key: key(1), pusherSeq: 1, blob: blob(1) }])).body.headSeq).toBe(1);
  expect((await c.push(generation, "a", [{ key: key(1), pusherSeq: 1, blob: blob("x") }])).status).toBe(409);
  // The conflicting entry rolls back the valid one before it.
  const mixed = await c.push(generation, "a", [{ key: key(2), pusherSeq: 1, blob: blob(2) }, { key: key(1), pusherSeq: 1, blob: blob("y") }]);
  expect(mixed.body.code).toBe("counter");
  const all = await c.changes({ generation, since: 0, node: "b" });
  expect(all.body.entries.map((e: any) => e.key)).toEqual([key(1)]);
  expect((await c.push(generation, "a", [{ key: key(1), pusherSeq: 2, blob: blob(3) }])).body.headSeq).toBe(2);
  expect((await c.push("f".repeat(32), "a", [{ key: key(1), pusherSeq: 3, blob: blob(3) }])).body.resetRequired).toBe(true);
  expect((await c.push(generation, "a", [{ key: key(4), pusherSeq: 1, blob: blob(4) }, { key: key(4), pusherSeq: 2, blob: blob(4) }])).status).toBe(400);
});

test("pagination covers everything, excludes the caller, and survives concurrent upserts", async () => {
  const c = client();
  const { generation } = (await c.create()).body;
  for (let i = 0; i < 1200; i += 400) await c.push(generation, "a", Array.from({ length: 400 }, (_, j) => ({ key: key(i + j), pusherSeq: 1, blob: blob(i + j) })));
  await c.push(generation, "b", [{ key: key(0), pusherSeq: 1, blob: blob("b0") }]); // a caller-only sequence at the head
  const seen = new Map<string, string>();
  let since = 0, pages = 0;
  for (; ;) {
    const page = (await c.changes({ generation, since, node: "b" })).body as ChangesResponse;
    expect(checkPage(page, since)).toBeUndefined();
    for (const e of page.entries) { expect(e.node).toBe("a"); seen.set(e.key, e.blob); }
    since = page.nextCursor; pages++;
    // An entry already read is replaced between pages: it moves forward and is read again.
    if (pages === 1) await c.push(generation, "a", [{ key: key(5), pusherSeq: 2, blob: blob("moved") }]);
    if (!page.more) break;
  }
  expect(pages).toBe(2);
  expect(seen.size).toBe(1200);
  expect(seen.get(key(5))).toBe(blob("moved"));
  expect(since).toBe(1202); // includes b's own sequence
  const self = (await c.changes({ generation, since: 0, node: "b", includeSelf: 1 })).body;
  expect(self.entries.some((e: any) => e.node === "b")).toBe(false); // b's entry is on a later page
  expect((await c.changes({ generation, since: 9999, node: "b" })).body.resetRequired).toBe(true);
  expect((await c.changes({ since: 5, node: "b" })).status).toBe(409);
  expect((await c.changes({ since: 0, node: "b" })).status).toBe(200);
  expect(self.seen).toEqual({ a: expect.any(Number), b: expect.any(Number) });
});

test("pages stay under the byte limit", async () => {
  const c = client();
  const { generation } = (await c.create()).body;
  const big = Math.ceil(RELAY_LIMITS.blobBytes * 4 / 3) - 10;
  for (let i = 0; i < 12; i++) await c.push(generation, "a", [{ key: key(i), pusherSeq: 1, blob: blob(i, big) }]);
  let since = 0, count = 0, pages = 0;
  for (; ;) {
    const res = await c.relay.fetch(`https://relay.test/g/${G}/changes?generation=${generation}&since=${since}&node=b`, { headers: { authorization: `Bearer ${T}` } });
    const text = await res.text();
    expect(text.length).toBeLessThanOrEqual(RELAY_LIMITS.messageBytes);
    const page = JSON.parse(text) as ChangesResponse;
    count += page.entries.length; since = page.nextCursor; pages++;
    if (!page.more) break;
  }
  expect(count).toBe(12);
  expect(pages).toBeGreaterThan(1);
});

test("pages count UTF-8 bytes, not characters", async () => {
  const c = client();
  const { generation } = (await c.create()).body;
  const node = "界".repeat(512);
  for (let i = 0; i < 1000; i += 500) await c.push(generation, node, Array.from({ length: 500 }, (_, j) => ({ key: key(i + j), pusherSeq: 1, blob: blob(i + j, 6900) })));
  let since = 0, count = 0;
  for (; ;) {
    const res = await c.relay.fetch(`https://relay.test/g/${G}/changes?generation=${generation}&since=${since}&node=b`, { headers: { authorization: `Bearer ${T}` } });
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeLessThanOrEqual(RELAY_LIMITS.messageBytes);
    const page = JSON.parse(new TextDecoder().decode(bytes)) as ChangesResponse;
    count += page.entries.length; since = page.nextCursor;
    if (!page.more) break;
  }
  expect(count).toBe(1000);
});

test("an interrupted create is removed by its alarm, which frees the slot", async () => {
  let now = 1_000_000;
  const relay = memoryRelay({ now: () => now, maxGroups: 1 });
  const reserve = relay.admission.reserve.bind(relay.admission);
  relay.admission.reserve = async (id, ip) => { await reserve(id, ip); throw new Error("worker stopped"); };
  const c = client(relay);
  expect((await c.create()).status).toBe(500);
  relay.admission.reserve = reserve;
  expect(relay.admission.count()).toBe(1);
  expect((await c.call("GET", "/nodes")).status).toBe(404); // never admitted
  const g = relay.groups.get(G)!;
  now = g.alarm!;
  await g.core.alarm();
  expect(relay.admission.count()).toBe(0);
  expect(tables(relay, G)).toEqual([]);
  expect((await client(relay, T, "f".repeat(32)).create()).status).toBe(200);
});

test("a retried create resumes an interrupted one", async () => {
  const relay = memoryRelay();
  const reserve = relay.admission.reserve.bind(relay.admission);
  relay.admission.reserve = async (id, ip) => { await reserve(id, ip); throw new Error("worker stopped"); };
  const c = client(relay);
  await c.create();
  relay.admission.reserve = reserve;
  expect((await client(relay, "B".repeat(43)).create()).status).toBe(401);
  expect((await c.create()).status).toBe(200);
  expect((await c.call("GET", "/nodes")).status).toBe(200);
  expect(relay.admission.count()).toBe(1);
});

test("quota rejects a batch without partial writes; oversize bodies get 413", async () => {
  const c = client(memoryRelay({ maxGroupBytes: 1000 }));
  const { generation } = (await c.create()).body;
  const res = await c.push(generation, "a", Array.from({ length: 20 }, (_, i) => ({ key: key(i), pusherSeq: 1, blob: blob(i) })));
  expect(res.status).toBe(507);
  expect((await c.changes({ generation, since: 0, node: "b" })).body.entries).toEqual([]);
  const huge = await c.relay.fetch(`https://relay.test/g/${G}/push`, { method: "POST", headers: { authorization: `Bearer ${T}`, "content-type": "application/json" }, body: "x".repeat(RELAY_LIMITS.messageBytes + 1) });
  expect(huge.status).toBe(413);
});

test("node identities are bounded", async () => {
  const c = client();
  const { generation } = (await c.create()).body;
  for (let i = 0; i < RELAY_LIMITS.nodes; i++) expect((await c.changes({ generation, since: 0, node: `n${i}` })).status).toBe(200);
  expect((await c.changes({ generation, since: 0, node: "one-too-many" })).body.code).toBe("tooManyNodes");
  expect((await c.changes({ generation, since: 0, node: "n0" })).status).toBe(200);
});

test("deletion releases the admission slot and recreation gets a new generation", async () => {
  const c = client(memoryRelay({ maxGroups: 1 }));
  const before = (await c.create()).body.generation;
  await c.push(before, "a", [{ key: key(1), pusherSeq: 1, blob: blob(1) }]);
  expect((await client(c.relay, T, "f".repeat(32)).create()).status).toBe(507);
  expect(tables(c.relay, "f".repeat(32))).toEqual([]); // a refused create keeps nothing
  expect((await c.call("DELETE", "")).status).toBe(200);
  expect(c.relay.admission.count()).toBe(0);
  expect((await c.call("GET", "/nodes")).status).toBe(404);
  const after = (await c.create()).body;
  expect(after.generation).not.toBe(before);
  expect((await c.changes({ generation: before, since: 1, node: "b" })).body).toMatchObject({ resetRequired: true, generation: after.generation });
});

test("admission: per-address limit, operator switch", async () => {
  const relay = memoryRelay({ groupsPerIpPerDay: 2 });
  const hex = (i: number) => String(i).repeat(32);
  expect((await client(relay, T, hex(1)).create()).status).toBe(200);
  expect((await client(relay, T, hex(2)).create()).status).toBe(200);
  const third = await client(relay, T, hex(3)).create();
  expect(third.status).toBe(429);
  expect(third.headers.get("retry-after")).toBe("3600");
  expect((await client(relay, T, hex(4), { "cf-connecting-ip": "203.0.113.9" }).create()).status).toBe(200);
  expect((await client(relay, T, hex(1)).create()).status).toBe(200); // existing groups are unaffected
  const closed = memoryRelay({ newGroupsDisabled: true });
  expect((await client(closed).create()).status).toBe(503);
});

test("retention: an idle group is deleted by its alarm and the slot is released", async () => {
  let now = 1_000_000;
  const relay = memoryRelay({ now: () => now, retentionMs: 10_000 });
  const c = client(relay);
  await c.create();
  const g = relay.groups.get(G)!;
  expect(g.alarm).toBe(now + 10_000);
  now += 5_000;
  await g.core.alarm();
  expect((await c.call("GET", "/nodes")).status).toBe(200); // not yet idle
  now += 10_001;
  await g.core.alarm();
  expect(relay.admission.count()).toBe(0);
  expect((await c.call("GET", "/nodes")).status).toBe(404);
});

test("rate limits: per group requests and failed authentication", async () => {
  const c = client(memoryRelay({ groupRequestsPerMinute: 3, failedAuthPerMinute: 1 }));
  await c.create();
  await c.call("GET", "/nodes");
  await c.call("GET", "/nodes");
  const limited = await c.call("GET", "/nodes");
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  const d = client(memoryRelay({ failedAuthPerMinute: 1 }));
  await d.create();
  const bad = client(d.relay, "B".repeat(43));
  expect((await bad.call("GET", "/nodes")).status).toBe(401);
  expect((await bad.call("GET", "/nodes")).status).toBe(429);
});

test("a deployment key is required on every route when configured", async () => {
  const relay = memoryRelay({ relayKey: "service-key" });
  expect((await client(relay).create()).status).toBe(401);
  expect(relay.admission.count()).toBe(0);
  const keyed = client(relay, T, G, { "x-relay-key": "service-key" });
  expect((await keyed.create()).status).toBe(200);
  expect((await client(relay).call("GET", "/nodes")).status).toBe(401);
});
