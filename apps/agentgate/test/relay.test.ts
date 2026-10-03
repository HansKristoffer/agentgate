import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as path } from "node:path";
import { Hono } from "hono";
import { memoryRelay } from "../../relay/test/memory.ts";
import { app, makeCtx } from "../src/daemon.ts";
import {
  RelayBusy, cleanupRelay, createRelay, deriveKeys, entryKey, joinRelay, leaveRelay, open, parseInvite, parseJoin,
  reconcileRelay, relayInvite, relayStatus, relaySync, rotateRelay, seal, setServiceKey, stopRelay, syncAll, via, withRelay,
} from "../src/relay.ts";
import { Store } from "../src/store.ts";
import { join, peerRoutes, peers, pullPeer } from "../src/sync.ts";
import { SYNC_PROTOCOL } from "../src/sync.ts";

const dir = mkdtempSync(path(tmpdir(), "agentgate-relay-"));
const stores: Store[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
beforeAll(() => { process.env.AGENTGATE_RELAY_ALLOW_HTTP = "1"; });
afterEach(async () => {
  for (const s of stores.splice(0)) { await stopRelay(s); try { s.close(); } catch { } }
  for (const x of servers.splice(0)) x.stop(true);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function node(name: string, file?: string) {
  const s = new Store(file ?? ":memory:");
  s.setLocal("node", name);
  if (!s.get("node", name)) s.put("node", name, { id: name });
  stores.push(s);
  return s;
}
const file = (name: string) => path(dir, `${name}-${crypto.randomUUID()}.db`);
/** A copy of the database file, as a backup restore would leave it. */
function snapshot(s: Store) {
  s.db.run("pragma wal_checkpoint(truncate)");
  const copy = file("restore");
  copyFileSync(s.db.filename, copy);
  return copy;
}

type Mode = "ok" | "down" | "drop" | "failDelete" | "hang";
/** The in-process relay over real HTTP, behind a proxy that can fail in chosen ways. */
function relay(overrides: Parameters<typeof memoryRelay>[0] = {}) {
  const r = memoryRelay(overrides);
  const ctl = { mode: "ok" as Mode, beforePush: undefined as undefined | (() => void), pushes: 0, blocked: undefined as string | undefined };
  const server = Bun.serve({
    port: 0, idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (ctl.mode === "down" || (ctl.blocked && url.pathname.includes(ctl.blocked))) return new Response("down", { status: 503 });
      if (ctl.mode === "hang") return new Promise<Response>(() => { });
      if (ctl.mode === "failDelete" && req.method === "DELETE") return Response.json({ error: "boom" }, { status: 500 });
      if (url.pathname.endsWith("/push")) { ctl.pushes++; ctl.beforePush?.(); }
      const res = await r.app.fetch(req);
      if (ctl.mode === "drop" && url.pathname.endsWith("/push")) { ctl.mode = "ok"; return new Response("lost", { status: 502 }); }
      return res;
    },
  });
  servers.push(server);
  return { ...r, ctl, url: `http://127.0.0.1:${server.port}` };
}
const sync = (s: Store) => relaySync(s, { force: true });
const groupOf = async (invite: string) => (await deriveKeys(parseInvite(invite).secret)).groupId;
const head = (r: ReturnType<typeof relay>, grp: string) => Number((r.groups.get(grp)!.sql.db.query("select v from meta where k = 'head'").get() as { v: number }).v);

function seed(s: Store) {
  s.put("account", "acc", { id: "acc", provider: "claude", label: "work" });
  s.put("credential", "acc", { accountId: "acc", accessToken: "sk-ant-secret-token", refreshToken: "rt-secret-refresh", expiresAt: Date.now() + 3_600_000, holder: s.nodeId });
  s.put("mcp", "posthog", { id: "posthog", template: "custom-http", transport: "http", url: "https://mcp.example/mcp", headers: { authorization: "Bearer mcp-secret-header" } });
}

test("crypto vectors are pinned", async () => {
  const secret = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
  const keys = await deriveKeys(secret);
  expect(keys.groupId).toBe(VECTORS.groupId);
  expect(keys.authToken).toBe(VECTORS.authToken);
  expect(await entryKey(keys, "account", "acc")).toBe(VECTORS.entryKey);
  const aad = { groupId: keys.groupId, generation: "0".repeat(32), node: "a", key: VECTORS.entryKey, pusherSeq: 1 };
  const blob = await seal(keys, aad, '{"x":1}', new Uint8Array(12));
  expect(blob).toBe(VECTORS.blob);
  expect(await open(keys, aad, blob)).toBe('{"x":1}');
  for (const changed of [{ pusherSeq: 2 }, { node: "b" }, { generation: "1".repeat(32) }, { key: "x".repeat(43) }])
    expect(open(keys, { ...aad, ...changed }, blob)).rejects.toThrow();
});

test("invites and pairing commands are validated without echoing secrets", () => {
  const invite = `agr1.${Buffer.from("https://relay.example").toString("base64url")}.${"A".repeat(43)}`;
  expect(parseInvite(invite).url).toBe("https://relay.example");
  expect(parseJoin(`agentgate join ${invite}`)).toEqual({ invite, force: false });
  expect(parseJoin(`agentpool join ${invite} --force`)).toEqual({ invite, force: true });
  expect(parseJoin("agentgate join http://mac.tail.ts.net:7878 amber-anchor-apple-arrow-basil-beacon-birch")).toEqual({ url: "http://mac.tail.ts.net:7878", code: "amber-anchor-apple-arrow-basil-beacon-birch" });
  for (const bad of [`${invite}; rm -rf /`, `agentgate join ${invite} extra`, "agentgate join", "join ftp://x a-b-c-d-e-f-g", `${invite.slice(0, -1)}!`]) {
    const error = (() => { try { parseJoin(bad); } catch (e) { return String(e); } })();
    expect(error).toBeDefined();
    expect(error).not.toContain("AAAA");
  }
  const http = `agr1.${Buffer.from("http://relay.example").toString("base64url")}.${"A".repeat(43)}`;
  delete process.env.AGENTGATE_RELAY_ALLOW_HTTP;
  expect(() => parseInvite(http)).toThrow("HTTPS");
  process.env.AGENTGATE_RELAY_ALLOW_HTTP = "1";
  for (const url of ["https://u:p@relay.example", "https://relay.example/?q=1", "https://relay.example/#f"])
    expect(() => parseInvite(`agr1.${Buffer.from(url).toString("base64url")}.${"A".repeat(43)}`)).toThrow();
});

test("records, credentials and tombstones converge; the relay stores only ciphertext", async () => {
  const r = relay();
  const a = node("a"), b = node("b");
  seed(a);
  const invite = await createRelay(a, r.url);
  expect(relayStatus(a)).toMatchObject({ reconciling: false, pushError: undefined });
  await joinRelay(b, invite);
  for (const [kind, id] of [["account", "acc"], ["credential", "acc"], ["mcp", "posthog"]] as const) expect(b.get(kind, id)).toEqual(a.get(kind, id) as never);

  b.del("mcp", "posthog");
  await sync(b); await sync(a);
  expect(a.get("mcp", "posthog")).toBeUndefined();
  expect(a.record("mcp", "posthog")!.deleted).toBe(1);

  const grp = await groupOf(invite);
  const dump = JSON.stringify(r.groups.get(grp)!.sql.db.query("select * from entries").all());
  for (const secret of ["sk-ant-secret-token", "rt-secret-refresh", "mcp-secret-header", "\"acc\"", "credential", "account", "posthog"]) expect(dump).not.toContain(secret);
  expect(via(a, "b")).toEqual(["relay"]);
  expect(Number(a.local("seen:b"))).toBeGreaterThan(0);
});

test("relay policy payloads are versioned and incompatible encrypted records never merge", async () => {
  const r = relay(), a = node("a"), b = node("b");
  seed(a); a.put("account", "acc", { ...a.get("account", "acc")!, policy: { retryLimit: 0, excludeModels: ["opus"] } });
  const invite = await createRelay(a, r.url), keys = await deriveKeys(parseInvite(invite).secret);
  const db = r.groups.get(keys.groupId)!.sql.db;
  const entry = db.query("select key,blob,pusher_seq from entries where node='a' and key=?").get(await entryKey(keys, "account", "acc")) as { key: string; blob: string; pusher_seq: number };
  const aad = { groupId: keys.groupId, generation: relayStatus(a)!.generation!, node: "a", key: entry.key, pusherSeq: entry.pusher_seq };
  const payload = JSON.parse(await open(keys, aad, entry.blob)); expect(payload.protocol).toBe(SYNC_PROTOCOL); expect(JSON.parse(payload.record.data).policy.retryLimit).toBe(0);
  db.run("update entries set blob=? where key=?", [await seal(keys, aad, JSON.stringify(payload.record)), entry.key]);
  await joinRelay(b, invite); expect(b.get("account", "acc")).toBeUndefined(); expect(relayStatus(b)?.skipped).toBe(1);
  db.run("update entries set blob=? where key=?", [entry.blob, entry.key]); await reconcileRelay(b); expect(b.get("account", "acc")?.policy?.retryLimit).toBe(0);
});

test("echo terminates", async () => {
  const r = relay();
  const a = node("a"), b = node("b");
  seed(a);
  await joinRelay(b, await createRelay(a, r.url));
  a.put("account", "acc", { id: "acc", provider: "claude", label: "renamed" });
  for (let i = 0; i < 3; i++) { await sync(a); await sync(b); }
  const before = [a.seq(), b.seq()];
  await sync(a); await sync(b); await sync(a);
  expect([a.seq(), b.seq()]).toEqual(before);
  expect(b.get("account", "acc")!.label).toBe("renamed");
});

test("authentication: a wrong token is rejected and a different invite reaches a different group", async () => {
  const r = relay();
  const a = node("a");
  seed(a);
  const invite = await createRelay(a, r.url);
  const grp = await groupOf(invite);
  const res = await fetch(`${r.url}/g/${grp}/nodes`, { headers: { authorization: `Bearer ${"Z".repeat(43)}` } });
  expect(res.status).toBe(401);
  const other = node("x");
  const otherInvite = await createRelay(other, r.url);
  expect(await groupOf(otherInvite)).not.toBe(grp);
  expect(other.get("account", "acc")).toBeUndefined();
});

test("tampered entries are skipped without advancing replay state, and the diagnostic persists", async () => {
  const r = relay();
  const a = node("a"), b = node("b");
  seed(a);
  const invite = await createRelay(a, r.url);
  const grp = await groupOf(invite);
  const db = r.groups.get(grp)!.sql.db;
  // Swap two blobs between keys, and bump one counter: all three fail authentication.
  const rows = db.query("select key, blob, pusher_seq from entries where node = 'a' order by seq").all() as { key: string; blob: string; pusher_seq: number }[];
  db.run("update entries set blob = ? where key = ?", [rows[1]!.blob, rows[0]!.key]);
  db.run("update entries set blob = ? where key = ?", [rows[0]!.blob, rows[1]!.key]);
  db.run("update entries set pusher_seq = pusher_seq + 5 where key = ?", [rows[2]!.key]);
  await joinRelay(b, invite);
  expect(relayStatus(b)!.skipped).toBe(3);
  const counters = b.db.query("select count(*) as n from relay_counters where node = 'a'").get() as { n: number };
  expect(counters.n).toBe(rows.length - 3);
  await sync(b);
  expect(relayStatus(b)!.skipped).toBe(3); // a later clean page does not clear it
  // A forged higher counter can't be recovered by its owner: that is a reported conflict, not silent loss.
  expect(reconcileRelay(a)).rejects.toThrow("counter conflict");
  await Bun.sleep(10);
  db.run("update entries set pusher_seq = pusher_seq - 5 where key = ?", [rows[2]!.key]);
  // With an honest relay again, a re-uploads everything; a full re-read on b clears the diagnostic.
  await reconcileRelay(a);
  await reconcileRelay(b);
  expect(relayStatus(b)!.skipped).toBeUndefined();
  expect(b.get("credential", "acc")).toEqual(a.get("credential", "acc")!);
});

test("restoring a whole database (and the clock) recovers newer records and counters from the relay", async () => {
  const r = relay();
  const aFile = file("a");
  const a = node("a", aFile), b = node("b");
  seed(a);
  await joinRelay(b, await createRelay(a, r.url));
  const backup = snapshot(a);
  a.put("account", "acc", { id: "acc", provider: "claude", label: "after-backup" });
  await sync(a); await sync(b);
  await stopRelay(a); a.close();

  // The restored database has older records and older counters; its own checkpoint looks fine.
  const restored = node("a", backup);
  restored.now = () => Date.now() - 86_400_000;
  expect(restored.get("account", "acc")!.label).toBe("work");
  await sync(restored);
  expect(restored.get("account", "acc")!.label).toBe("after-backup");
  expect(relayStatus(restored)).toMatchObject({ pushError: undefined, reconciling: false });
  restored.put("project", "o/r", { id: "o/r", mcp: {} });
  await sync(restored); await sync(b);
  expect(relayStatus(restored)!.pushError).toBeUndefined();
  expect(b.get("project", "o/r")).toBeDefined();
});

test("a wiped group is repopulated from surviving nodes, tombstones included", async () => {
  const r = relay();
  const a = node("a"), b = node("b");
  seed(a);
  const invite = await createRelay(a, r.url);
  await joinRelay(b, invite);
  a.del("mcp", "posthog");
  await sync(a); await sync(b);
  const grp = await groupOf(invite);
  const oldGen = relayStatus(a)!.generation;
  // Recreate the group and push past the old cursor, so only the generation tells them apart.
  expect((await fetch(`${r.url}/g/${grp}`, { method: "DELETE", headers: { authorization: `Bearer ${(await deriveKeys(parseInvite(invite).secret)).authToken}` } })).status).toBe(200);
  const c = node("c");
  c.put("setting", "settings", { threshold: 50 });
  await joinRelay(c, invite);
  for (let i = 0; i < 20; i++) c.put("project", `p/${i}`, { id: `p/${i}`, mcp: {} });
  await sync(c);
  await sync(a); await sync(a);
  expect(relayStatus(a)!.generation).not.toBe(oldGen);
  await sync(b); await sync(b); await sync(c);
  expect(c.record("mcp", "posthog")!.deleted).toBe(1);
  expect(c.get("credential", "acc")).toEqual(a.get("credential", "acc")!);
  expect(b.get("project", "p/19")).toBeDefined();
});

test("mixed group: a Tailscale pair and a relay pair converge through the middle node", async () => {
  const r = relay();
  const a = node("a"), b = node("b"), c = node("c");
  const server = Bun.serve({ port: 0, fetch: new Hono().route("/peer", peerRoutes(a, () => { })).fetch });
  servers.push(server);
  a.db.run("insert into peers values ('b', 'http://unused', 'tok', 0, null)");
  b.db.run("insert into peers values ('a', ?, 'tok', 0, null)", [`http://127.0.0.1:${server.port}`]);
  await joinRelay(c, await createRelay(b, r.url));
  a.put("account", "from-a", { id: "from-a", provider: "codex", label: "a's" });
  await pullPeer(b, peers(b)[0]!);
  await sync(b); await sync(c);
  expect(c.get("account", "from-a")!.label).toBe("a's");
  expect(via(b, "a")).toEqual(["tailnet"]);
  expect(via(b, "c")).toEqual(["relay"]);
});

test("large stores page and chunk without omissions, including writes made during an upload", async () => {
  const r = relay();
  const a = node("a"), b = node("b");
  a.transaction(() => { for (let i = 0; i < 1300; i++) a.put("project", `o/r${i}`, { id: `o/r${i}`, mcp: {} }); });
  r.ctl.beforePush = () => { if (r.ctl.pushes === 1) a.put("account", "late", { id: "late", provider: "claude", label: "written mid-upload" }); };
  const invite = await createRelay(a, r.url);
  expect(r.ctl.pushes).toBeGreaterThanOrEqual(3);
  await sync(a);
  await joinRelay(b, invite);
  expect(b.list("project").length).toBe(1300);
  expect(b.get("account", "late")).toBeDefined();
  expect(relayStatus(a)!.pushed).toBe(a.seq());
});

test("a lost push response is retried byte for byte without a second write", async () => {
  const r = relay();
  const a = node("a");
  const invite = await createRelay(a, r.url);
  const grp = await groupOf(invite);
  a.put("account", "acc", { id: "acc", provider: "claude", label: "x" });
  r.ctl.mode = "drop";
  await sync(a);
  expect(relayStatus(a)!.pushError).toBeDefined();
  const stored = head(r, grp);
  const body = (a.db.query("select body from relay_pending").get() as { body: string }).body;
  await sync(a);
  expect(head(r, grp)).toBe(stored); // identical retry: a no-op on the relay
  expect(relayStatus(a)!.pushError).toBeUndefined();
  expect(a.db.query("select count(*) as n from relay_pending").get()).toEqual({ n: 0 });
  expect(body).toContain('"node":"a"');
});

test("a crash after persisting a chunk resumes after restart without counter conflicts", async () => {
  const r = relay();
  const aFile = file("a");
  const a = node("a", aFile), b = node("b");
  const invite = await createRelay(a, r.url);
  a.put("account", "acc", { id: "acc", provider: "claude", label: "x" });
  r.ctl.mode = "drop"; // accepted by the relay, response lost: then the process dies
  await sync(a);
  const copy = snapshot(a);
  const restarted = node("a", copy);
  await sync(restarted);
  expect(relayStatus(restarted)!.pushError).toBeUndefined();
  await joinRelay(b, invite);
  expect(b.get("account", "acc")!.label).toBe("x");
});

test("rotation resumes the same invite after interruption; failed cleanup stays visible", async () => {
  const r = relay();
  const aFile = file("a");
  const a = node("a", aFile), b = node("b");
  seed(a);
  const old = await createRelay(a, r.url);
  await joinRelay(b, old);
  r.ctl.mode = "down";
  expect(rotateRelay(a)).rejects.toThrow();
  await Bun.sleep(10);
  const pendingInvite = JSON.parse(a.local("relay:rotation")!).invite as string;
  expect(relayInvite(a)).toBe(old); // not switched before seeding succeeds
  expect(relayStatus(a)!.rotating).toBe(true);

  // A restart (another process on the same file) resumes the same rotation from the daemon loop.
  const copy = snapshot(a);
  const restarted = node("a", copy);
  r.ctl.mode = "failDelete";
  await sync(restarted);
  expect(relayInvite(restarted)).toBe(pendingInvite);
  expect(relayStatus(restarted)).toMatchObject({ rotating: false, cleanupPending: true });

  // The original process resumes the same rotation too, and returns the same command.
  const result = await rotateRelay(a);
  expect(result.command).toBe(`agentgate join ${pendingInvite}`);
  expect(result.cleanupPending).toBe(true);

  // The new group works; retained machines rejoin it.
  await leaveRelay(b);
  await joinRelay(b, pendingInvite);
  a.put("account", "acc", { id: "acc", provider: "claude", label: "after rotation" });
  await sync(a); await sync(b);
  expect(b.get("account", "acc")!.label).toBe("after rotation");

  r.ctl.mode = "ok";
  expect((await cleanupRelay(a, false)).cleanupPending).toBe(false);
  const oldGroup = await groupOf(old);
  expect((await fetch(`${r.url}/g/${oldGroup}/nodes`, { headers: { authorization: `Bearer ${(await deriveKeys(parseInvite(old).secret)).authToken}` } })).status).toBe(404);
});

test("a pending rotation never uploads to the old group, even after a restart", async () => {
  const r = relay();
  const a = node("a", file("a")), b = node("b");
  const old = await createRelay(a, r.url);
  await joinRelay(b, old);
  r.ctl.mode = "down";
  await expect(rotateRelay(a)).rejects.toThrow();
  r.ctl.mode = "ok";
  r.ctl.blocked = await groupOf(JSON.parse(a.local("relay:rotation")!).invite); // the new group stays unreachable
  b.put("account", "fromB", { id: "fromB", provider: "claude", label: "b" });
  await sync(b);
  a.put("credential", "acc", { accountId: "acc", accessToken: "changed-during-rotation", refreshToken: "rt", expiresAt: Date.now() + 3_600_000, holder: "a" });
  const restarted = node("a", snapshot(a));
  const before = head(r, await groupOf(old));
  await sync(restarted);
  expect(relayStatus(restarted)!.rotating).toBe(true);
  expect(head(r, await groupOf(old))).toBe(before);
  expect(restarted.get("account", "fromB")).toBeDefined(); // downloads continue
});

test("constant local writes cannot keep the upload from reaching the download", async () => {
  const r = relay();
  const a = node("a"), b = node("b");
  const invite = await createRelay(a, r.url);
  await joinRelay(b, invite);
  b.put("account", "fromB", { id: "fromB", provider: "claude", label: "b" });
  await sync(b);
  let i = 0;
  r.ctl.beforePush = () => { const id = `o/w${i++}`; a.put("project", id, { id, mcp: {} }); };
  a.put("project", "o/first", { id: "o/first", mcp: {} });
  const start = r.ctl.pushes;
  await sync(a);
  r.ctl.beforePush = undefined;
  expect(r.ctl.pushes - start).toBe(1);
  expect(a.get("account", "fromB")).toBeDefined();
});

test("a queued wipe does not delete a group that was rejoined", async () => {
  const r = relay();
  const a = node("a");
  const invite = await createRelay(a, r.url);
  r.ctl.mode = "down";
  expect((await leaveRelay(a, true)).cleanupPending).toBe(true);
  r.ctl.mode = "ok";
  await joinRelay(a, invite, true);
  expect((await cleanupRelay(a, false)).cleanupPending).toBe(false);
  const { authToken } = await deriveKeys(parseInvite(invite).secret);
  expect((await fetch(`${r.url}/g/${await groupOf(invite)}/nodes`, { headers: { authorization: `Bearer ${authToken}` } })).status).toBe(200);
  expect(relayInvite(a)).toBe(invite);
});

test("a failed leave --wipe does not restore membership", async () => {
  const r = relay();
  const a = node("a");
  await createRelay(a, r.url);
  r.ctl.mode = "down";
  expect((await leaveRelay(a, true)).cleanupPending).toBe(true);
  await sync(a);
  expect(relayInvite(a)).toBeUndefined();
  expect(relayStatus(a)).toMatchObject({ url: "", cleanupPending: true });
  r.ctl.mode = "ok";
  await sync(a); // cleanup retries are backed off; force one
  expect((await cleanupRelay(a, false)).cleanupPending).toBe(false);
  expect(relayStatus(a)).toBeUndefined();
});

test("rotation cannot revoke a removed machine's Tailscale path", async () => {
  const r = relay();
  const a = node("a"), b = node("b"), c = node("c");
  seed(a);
  const invite = await createRelay(a, r.url);
  await joinRelay(b, invite);
  await joinRelay(c, invite);
  const server = Bun.serve({ port: 0, fetch: new Hono().route("/peer", peerRoutes(b, () => { })).fetch });
  servers.push(server);
  b.db.run("insert into peers values ('c', 'http://unused', 'tok', 0, null)");
  c.db.run("insert into peers values ('b', ?, 'tok', 0, null)", [`http://127.0.0.1:${server.port}`]);
  await sync(a); // a now sees c through the relay

  // Remove c through the API: the relay path forces a rotation, which is local-only.
  const ctx = makeCtx(a); const handler = app(ctx);
  a.setLocal("adminToken", "admin");
  const remote = await handler.fetch(new Request("http://x/api/nodes/c", { method: "DELETE", headers: { authorization: "Bearer admin" } }), { listener: "tailnet" });
  expect(remote.status).toBe(403);
  const removed = await handler.fetch(new Request("http://127.0.0.1/api/nodes/c", { method: "DELETE", headers: { host: "127.0.0.1" } }), { listener: "loopback" });
  const body = await removed.json() as { rotated: boolean; command: string };
  expect(body.rotated).toBe(true);
  await ctx.gateway.close();

  await leaveRelay(b);
  await joinRelay(b, body.command.split(" ").at(-1)!);
  a.put("account", "acc", { id: "acc", provider: "claude", label: "secret after rotation" });
  await sync(a); await sync(b);
  await sync(c);
  expect(c.get("account", "acc")!.label).not.toBe("secret after rotation"); // the old group is cut off
  await pullPeer(c, peers(c)[0]!);
  expect(c.get("account", "acc")!.label).toBe("secret after rotation"); // ...but Tailscale still reaches it
});

test("syncAll delivers newer credentials over the relay; a rejected upload does not block downloads", async () => {
  const r = relay();
  const a = node("a"), b = node("b");
  seed(a);
  const invite = await createRelay(a, r.url);
  await joinRelay(b, invite);
  const grp = await groupOf(invite);
  r.groups.get(grp)!.core["deps"].config.maxGroupBytes = Number((r.groups.get(grp)!.sql.db.query("select v from meta where k = 'bytes'").get() as { v: number }).v) + 20_000;
  b.put("mcp", "huge", { id: "huge", template: "custom-http", transport: "http", url: "https://x", headers: { pad: "p".repeat(60_000) } });
  await sync(b);
  expect(relayStatus(b)!.pushError).toContain("storage");
  a.put("credential", "acc", { ...a.get("credential", "acc")!, accessToken: "sk-ant-refreshed" });
  await sync(a);
  expect(await syncAll(b)).toEqual([]);
  expect(b.get("credential", "acc")!.accessToken).toBe("sk-ant-refreshed");
  expect(relayStatus(b)).toMatchObject({ pushError: expect.stringContaining("storage"), pullError: undefined });
});

test("an oversized record blocks the upload checkpoint and is reported", async () => {
  const r = relay();
  const a = node("a");
  await createRelay(a, r.url);
  const before = relayStatus(a)!.pushed;
  a.put("mcp", "big", { id: "big", template: "custom-http", transport: "http", url: "https://x", headers: { pad: "p".repeat(1_200_000) } });
  await sync(a);
  expect(relayStatus(a)!.pushError).toContain("mcp big");
  expect(relayStatus(a)!.pushed).toBe(before);
});

test("a deployment key is required, configured separately, and never exposed", async () => {
  const r = relay({ relayKey: "deploy-secret" });
  const a = node("a");
  expect(createRelay(a, r.url)).rejects.toThrow("service key");
  await Bun.sleep(10);
  expect(relayInvite(a)).toBeUndefined();
  setServiceKey(a, "deploy-secret");
  const invite = await createRelay(a, r.url);
  expect(invite).not.toContain("deploy-secret");
  expect(JSON.stringify(relayStatus(a))).not.toContain("deploy-secret");
  const ctx = makeCtx(a);
  const status = await (await app(ctx).fetch(new Request("http://127.0.0.1/api/status", { headers: { host: "127.0.0.1" } }), { listener: "loopback" })).text();
  await ctx.gateway.close();
  expect(status).not.toContain("deploy-secret");
  expect(status).not.toContain(invite.split(".")[2]!);
});

test("API: pairing methods, single-field join, and loopback-only secrets", async () => {
  const r = relay();
  const a = node("a"), b = node("b");
  seed(a);
  a.setLocal("adminToken", "admin");
  const ctxA = makeCtx(a), ctxB = makeCtx(b);
  const call = (handler: ReturnType<typeof app>, path: string, body?: unknown, listener: "loopback" | "tailnet" = "loopback") =>
    handler.fetch(new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { host: "127.0.0.1", authorization: "Bearer admin", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), { listener });
  const handlerA = app(ctxA), handlerB = app(ctxB);
  expect((await call(handlerA, "/api/nodes/pair", { method: "relay", relayUrl: r.url }, "tailnet")).status).toBe(403);
  expect(relayInvite(a)).toBeUndefined();
  const paired = await (await call(handlerA, "/api/nodes/pair", { method: "relay", relayUrl: r.url })).json() as { command: string };
  expect(paired.command).toStartWith("agentgate join agr1.");
  const bad = await call(handlerB, "/api/nodes/join", { command: `${paired.command} && curl evil` });
  expect(bad.status).toBe(400);
  expect(await bad.text()).not.toContain(paired.command.split(".")[2]!);
  expect((await call(handlerB, "/api/nodes/join", { command: paired.command })).status).toBe(200);
  expect(b.get("account", "acc")).toBeDefined();
  expect((await call(handlerA, "/api/relay/rotate", undefined, "tailnet")).status).toBe(403);
  // A Tailscale join URL is an origin: it cannot be aimed at this daemon's own routes.
  for (const url of ["http://127.0.0.1:7878/api/relay/rotate?x=", "http://127.0.0.1:7878/api/relay/rotate#", "http://127.0.0.1:7878/api"])
    expect(join(a, url, "amber-anchor-apple-arrow-basil-beacon-birch", "http://127.0.0.1:7879")).rejects.toThrow("origin");
  await sync(a);
  const status = await (await handlerA.fetch(new Request("http://127.0.0.1/api/status", { headers: { host: "127.0.0.1" } }), { listener: "loopback" })).json() as any;
  expect(status.relay).toMatchObject({ url: r.url, hosted: false, reconciling: false });
  expect(status.nodes.find((n: any) => n.id === "b")?.via).toEqual(["relay"]);
  await ctxA.gateway.close(); await ctxB.gateway.close();
});

test("relay work is serialized: leave waits for in-flight work, other processes hit the shared lease, shutdown cancels", async () => {
  const r = relay();
  const aFile = file("a");
  const a = node("a", aFile);
  await createRelay(a, r.url);
  a.put("account", "acc", { id: "acc", provider: "claude", label: "x" });
  r.ctl.beforePush = () => Bun.sleepSync(100);
  const inFlight = relaySync(a, { force: true });
  await leaveRelay(a);
  await inFlight;
  for (const key of ["relay:invite", "relay:pushed", "relay:cursor", "relay:generation"]) expect(a.local(key)).toBeUndefined();

  const other = node("a", aFile); // a second process on the same database
  let release!: () => void;
  const held = withRelay(a, () => new Promise<void>((resolve) => { release = resolve; }));
  await Bun.sleep(20);
  expect(withRelay(other, async () => 1, 0)).rejects.toBeInstanceOf(RelayBusy);
  release(); await held;
  expect(await withRelay(other, async () => 2, 1000)).toBe(2);

  const c = node("c");
  await createRelay(c, r.url);
  r.ctl.mode = "hang";
  c.put("account", "acc", { id: "acc", provider: "claude", label: "y" });
  const hanging = relaySync(c, { force: true });
  const started = Date.now();
  await stopRelay(c);
  await hanging;
  expect(Date.now() - started).toBeLessThan(2000);
});

/** Published in docs/operations.md; cross-checked against Node's crypto.hkdfSync / createCipheriv. */
const VECTORS = {
  groupId: "8f6ba714a69c73f1fbdcd8efe342493a",
  authToken: "ZxB1Uo3DlItacW62HpLUewhYoxYs8G2M_1fl8d29AnE",
  entryKey: "NNCRaladXbAr90_nFfOrCIEaQCc_oJCok1Y_XxZsqY0",
  blob: "AAAAAAAAAAAAAAAAKBuJeHcyQw_EGr_uWJywDTfraf7zwOQ",
};
