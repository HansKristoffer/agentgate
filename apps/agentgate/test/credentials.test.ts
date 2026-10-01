import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Credentials, NeedsLogin } from "../src/credentials.ts";
import { CLAUDE, claude } from "../src/llm/claude.ts";
import { Store } from "../src/store.ts";

// Fake OAuth endpoint that rotates refresh tokens: each one works exactly once.
let valid = new Set<string>();
let refreshes = 0;
let n = 0;
const oauth = Bun.serve({
  port: 0,
  async fetch(req) {
    const { refresh_token } = (await req.json()) as { refresh_token: string };
    if (!valid.delete(refresh_token)) return Response.json({ error: "invalid_grant" }, { status: 400 });
    refreshes++;
    const rt = `rt-${++n}`;
    valid.add(rt);
    return Response.json({ access_token: `at-${n}`, refresh_token: rt, expires_in: 8 * 3600 });
  },
});
const originalTokenUrl = CLAUDE.tokenUrl;
CLAUDE.tokenUrl = `http://127.0.0.1:${oauth.port}`;
afterAll(() => { oauth.stop(true); CLAUDE.tokenUrl = originalTokenUrl; });

const MIN = 60_000;
let T = 1_000_000_000_000;
let srv: Store, mac: Store;
const tempDirs: string[] = [];
afterEach(() => { srv?.close(); mac?.close(); for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function node(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-test-")); tempDirs.push(dir);
  const s = new Store(join(dir, "db"));
  s.setLocal("node", name);
  s.now = () => T;
  return s;
}
/** Copy everything from one store into another, like a pull. */
const pull = (into: Store, from: Store) => {
  for (const r of from.changes(0).records) into.merge(r);
  into.db.run("insert or replace into peers values (?, 'http://x', 't', 0, ?)", [from.nodeId, T]);
};
const credsFor = (s: Store, peer: () => Store) => new Credentials(s, (p, rt) => claude.refresh(rt), async () => pull(s, peer()));

beforeEach(() => {
  valid = new Set(["rt-0"]);
  refreshes = 0;
  n = 0;
  srv = node("srv");
  mac = node("mac");
  mac.put("node", "mac", { id: "mac" });
  mac.put("node", "srv", { id: "srv", alwaysOn: true });
  mac.put("account", "a", { id: "a", provider: "claude", label: "a" });
  mac.put("credential", "a", { accountId: "a", accessToken: "at-0", refreshToken: "rt-0", expiresAt: T + 20 * MIN, holder: "mac" });
  pull(srv, mac);
  pull(mac, srv);
});

test("only the holder refreshes", async () => {
  expect((await credsFor(srv, () => mac).token("a")).accessToken).toBe("at-0");
  expect(refreshes).toBe(0);
  const c = await credsFor(mac, () => srv).token("a");
  expect(refreshes).toBe(1);
  expect(c.refreshToken).toBe(mac.get("credential", "a")!.refreshToken); // saved before use
});

test("a non-holder takes over when the holder is silent and the token is about to expire", async () => {
  T += 12 * MIN; // 8 min left, holder last seen 12 min ago
  const c = await credsFor(srv, () => mac).token("a");
  expect(refreshes).toBe(1);
  expect(c.holder).toBe("srv");
  expect(srv.get("credential", "a")!.holder).toBe("srv");
});

test("no takeover while the holder is still seen", async () => {
  T += 12 * MIN;
  srv.db.run("update peers set last_seen = ? where node = 'mac'", [T - 30_000]);
  await credsFor(srv, () => mac).token("a");
  expect(refreshes).toBe(0);
});

test("the alwaysOn node reclaims the holder role without refreshing", async () => {
  mac.put("credential", "a", { ...mac.get("credential", "a")!, expiresAt: T + 3 * 3600_000 });
  pull(srv, mac);
  await credsFor(srv, () => mac).tick();
  expect(srv.get("credential", "a")!.holder).toBe("srv");
  expect(refreshes).toBe(0);
  pull(mac, srv);
  expect(mac.get("credential", "a")!.holder).toBe("srv");
});

test("invalid_grant pulls from peers and uses the newer copy", async () => {
  await credsFor(mac, () => srv).refresh("a"); // mac rotates rt-0 → rt-1; srv still has rt-0
  const c = await credsFor(srv, () => mac).refresh("a");
  expect(c.refreshToken).toBe("rt-1");
  expect(srv.get("credential", "a")!.needsLogin).toBeFalsy();
});

test("invalid_grant with no newer copy marks the account needsLogin", async () => {
  valid.clear();
  expect(credsFor(mac, () => srv).refresh("a")).rejects.toBeInstanceOf(NeedsLogin);
  await Bun.sleep(20);
  expect(mac.get("credential", "a")!.needsLogin).toBe(true);
});

test("simultaneous forced refreshes across independent stores rotate exactly once", async () => {
  const second = new Store(mac.db.filename!); second.now = () => T;
  const [a, b] = await Promise.all([credsFor(mac, () => srv).refresh("a"), credsFor(second, () => srv).refresh("a")]);
  expect(refreshes).toBe(1); expect(a.accessToken).toBe(b.accessToken); second.close();
});

test("forced 401 refresh on a non-holder requests its live holder instead of rotating", async () => {
  const c = credsFor(srv, () => mac);
  await expect(c.refresh("a")).rejects.toThrow("waiting for the credential holder");
  expect(refreshes).toBe(0); expect(srv.get("refreshRequest", "credential:a")).toBeDefined();
  pull(mac, srv); await credsFor(mac, () => srv).tick(); pull(srv, mac);
  expect(refreshes).toBe(1); expect((await c.token("a")).accessToken).toBe(mac.get("credential", "a")!.accessToken);
});

test("a late refresh cannot overwrite a new login or recreate deleted credentials", async () => {
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r);
  const c = new Credentials(mac, async () => { entered(); await gate; return { accessToken: "late", refreshToken: "late-rt", expiresAt: T + MIN }; }, async () => { });
  const task = c.refresh("a"); await started;
  mac.put("credential", "a", { ...mac.get("credential", "a")!, accessToken: "new-login", refreshToken: "new-rt" });
  release(); expect((await task).accessToken).toBe("new-login");
  let resolve!: () => void; const wait = new Promise<void>(r => resolve = r);
  const deleting = new Credentials(mac, async () => { await wait; return { accessToken: "lost", refreshToken: "lost", expiresAt: T + MIN }; }, async () => { });
  const late = deleting.refresh("a"); mac.del("credential", "a"); resolve(); await expect(late).rejects.toBeInstanceOf(NeedsLogin);
  expect(mac.get("credential", "a")).toBeUndefined();
});

test("a transient proactive refresh failure retains a valid token and reports health", async () => {
  const c = new Credentials(mac, async () => { throw new Error("network failure with private details"); }, async () => { });
  expect((await c.token("a")).accessToken).toBe("at-0");
  expect(mac.get("credential", "a")?.needsLogin).toBeFalsy(); expect(mac.local("refreshError:credential:a")).not.toContain("private details");
  mac.put("credential", "a", { ...mac.get("credential", "a")!, expiresAt: T - 1 });
  await expect(c.token("a")).rejects.toThrow("token refresh failed");
});

test("offline takeover survives two complete token cycles and the returning node catches up", async () => {
  T += 21 * MIN; const remote = new Credentials(srv, async (_, rt) => ({ ...await claude.refresh(rt), expiresAt: T + 8 * 60 * MIN }), async () => pull(srv, mac));
  const first = await remote.token("a"); expect(first.holder).toBe("srv"); expect(refreshes).toBe(1);
  T += 8 * 60 * MIN; const second = await remote.token("a"); expect(second.accessToken).not.toBe(first.accessToken); expect(refreshes).toBe(2);
  pull(mac, srv); expect((await credsFor(mac, () => srv).token("a")).accessToken).toBe(second.accessToken); expect(refreshes).toBe(2); expect(mac.get("credential", "a")?.needsLogin).toBeFalsy();
});

test("two Bun processes sharing a database cannot independently rotate the same token", async () => {
  let rotations = 0;
  const endpoint = Bun.serve({ port: 0, async fetch() { rotations++; await Bun.sleep(150); return Response.json({ access_token: "process-access", refresh_token: "process-refresh", expires_in: 3600 }); } });
  const worker = () => Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "refresh.ts"), mac.db.filename!, `http://127.0.0.1:${endpoint.port}`], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const children = [worker(), worker()];
  try {
    const results = await Promise.all(children.map(async child => ({ exit: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() })));
    expect(results.map(r => r.exit)).toEqual([0, 0]); expect(results.map(r => r.stdout.trim())).toEqual(["process-access", "process-access"]); expect(rotations).toBe(1);
  } finally { children.forEach(c => c.kill()); endpoint.stop(true); }
});
