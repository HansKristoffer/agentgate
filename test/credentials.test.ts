import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
CLAUDE.tokenUrl = `http://127.0.0.1:${oauth.port}`;
afterAll(() => oauth.stop(true));

const MIN = 60_000;
let T = 1_000_000_000_000;
let srv: Store, mac: Store;

function node(name: string) {
  const s = new Store(join(mkdtempSync(join(tmpdir(), "agentgate-test-")), "db"));
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
