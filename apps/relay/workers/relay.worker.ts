import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Real workerd + SQLite-backed Durable Objects: transactions, retries, pagination, admission and recreation.
const T = "A".repeat(43);
const key = (i: number) => `k${String(i).padStart(42, "0")}`;
const blob = (i: number | string) => `${i}`.padEnd(40, "b");
const hex = (i: number) => i.toString(16).padStart(32, "0");

async function call(group: string, method: string, path = "", body?: unknown, ip = "198.51.100.1") {
  const res = await exports.default.fetch(`https://relay.test/g/${group}${path}`, {
    method, headers: { authorization: `Bearer ${T}`, "cf-connecting-ip": ip, ...(body ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

describe("relay on Durable Objects", () => {
  it("pushes atomically, retries idempotently and paginates", async () => {
    const g = hex(1);
    const { generation } = (await call(g, "POST", "", { protocol: 1 })).body;
    const entries = Array.from({ length: 500 }, (_, i) => ({ key: key(i), pusherSeq: 1, blob: blob(i) }));
    expect((await call(g, "POST", "/push", { protocol: 1, generation, node: "a", entries })).body.headSeq).toBe(500);
    expect((await call(g, "POST", "/push", { protocol: 1, generation, node: "a", entries })).body.headSeq).toBe(500);
    const conflict = await call(g, "POST", "/push", { protocol: 1, generation, node: "a", entries: [{ key: key(900), pusherSeq: 1, blob: blob(900) }, { key: key(1), pusherSeq: 1, blob: blob("x") }] });
    expect(conflict.status).toBe(409);
    await call(g, "POST", "/push", { protocol: 1, generation, node: "a", entries: entries.map((e) => ({ ...e, key: key(e.pusherSeq * 1000 + Number(e.key.slice(1))) })) });
    let since = 0, total = 0;
    for (; ;) {
      const page = (await call(g, "GET", `/changes?generation=${generation}&since=${since}&node=b`)).body;
      total += page.entries.length; since = page.nextCursor;
      if (!page.more) break;
    }
    expect(total).toBe(1000);
    expect(since).toBe(1000); // the conflicting batch wrote nothing
  });

  it("caps live groups and recreates deleted storage with a new generation", async () => {
    // Storage is shared by the tests in this file: fill the remaining slots of RELAY_MAX_GROUPS.
    const admission = env.ADMISSION.get(env.ADMISSION.idFromName("global"));
    const free = 6 - await admission.count();
    for (let i = 0; i < free; i++) expect((await call(hex(10 + i), "POST", "", { protocol: 1 }, `203.0.113.${i}`)).status).toBe(200);
    expect((await call(hex(20), "POST", "", { protocol: 1 }, "203.0.113.50")).status).toBe(507);
    const before = (await call(hex(10), "POST", "", { protocol: 1 })).body.generation;
    expect((await call(hex(10), "DELETE")).status).toBe(200);
    expect((await call(hex(10), "GET", "/nodes")).status).toBe(404);
    const after = await call(hex(10), "POST", "", { protocol: 1 }, "203.0.113.60");
    expect(after.status).toBe(200);
    expect(after.body.generation).not.toBe(before);
    expect((await call(hex(10), "DELETE")).status).toBe(200);
  });

  it("requests for unknown groups write no storage", async () => {
    const g = hex(40);
    expect((await call(g, "GET", "/nodes")).status).toBe(404);
    const stub = env.GROUPS.get(env.GROUPS.idFromName(g));
    expect(await runInDurableObject(stub, (_, state) => state.storage.sql.exec("select name from sqlite_master where name = 'meta'").toArray())).toEqual([]);
  });

  it("expires idle groups from the alarm", async () => {
    const g = hex(30);
    await call(g, "POST", "", { protocol: 1 }, "203.0.113.70");
    const stub = env.GROUPS.get(env.GROUPS.idFromName(g));
    await runInDurableObject(stub, (_, state) => { state.storage.sql.exec("update meta set v = 0 where k = 'lastActive'"); });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await call(g, "GET", "/nodes")).status).toBe(404);
  });
});
