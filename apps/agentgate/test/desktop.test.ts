import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP, add, addedSince, cancelAdd, capture, files, forget, gateway, host, mode, pollDesktopLogin, readLogin, status, use } from "../src/desktop.ts";
import { Store } from "../src/store.ts";

// Chromium's cookie schema as Claude Desktop 2.19675 ships it (structure only; values below are fake).
const SCHEMA = `CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,has_cross_site_ancestor INTEGER NOT NULL);
CREATE UNIQUE INDEX cookies_unique_index ON cookies(host_key, top_frame_site_key, has_cross_site_ancestor, name, path, source_scheme, source_port);
INSERT INTO meta VALUES ('version', '24');`;
const toChrome = (ms: number) => (ms + 11_644_473_600_000) * 1000;
const DAY = 86_400_000;

let dir: string, s: Store, running: boolean, events: string[];
const original = { ...DESKTOP }, originalHost = { ...host }, originalFiles = { ...files };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentgate-desktop-"));
  Object.assign(DESKTOP, { data: join(dir, "Claude"), data3p: join(dir, "Claude-3p"), backups: join(dir, "backups") });
  mkdirSync(DESKTOP.data); mkdirSync(DESKTOP.data3p);
  new Database(join(DESKTOP.data, "Cookies")).exec(SCHEMA);
  writeFileSync(join(DESKTOP.data3p, "claude_desktop_config.json"), JSON.stringify({ enterpriseConfig: {}, other: 1 }));
  running = true; events = [];
  Object.assign(host, {
    installed: () => true, running: () => running, version: () => "2.19675.0",
    quit: async () => { events.push("quit"); running = false; },
    open: () => { events.push("open"); running = true; },
  });
  s = new Store(":memory:"); s.setLocal("node", "test");
});
afterEach(() => { Object.assign(DESKTOP, original); Object.assign(host, originalHost); Object.assign(files, originalFiles); s.close(); rmSync(dir, { recursive: true, force: true }); });

/** Pretend the user signed in to Desktop with `uuid`. */
function signIn(uuid: string, extra: Record<string, string> = {}) {
  const db = new Database(join(DESKTOP.data, "Cookies"));
  const insert = db.query("insert or replace into cookies values (?, ?, '', ?, '', ?, '/', ?, 1, 1, 0, 1, 1, 1, 0, 2, 443, 0, 0, 0)");
  for (const [host, name, value] of [[".claude.ai", "sessionKey", uuid], ["claude.ai", "lastActiveOrg", uuid], ...Object.entries(extra).map(([n, v]) => [".claude.ai", n, v])])
    insert.run(0, host!, name!, Buffer.from(`enc:${value}`), toChrome(Date.now() + 30 * DAY));
  insert.run(0, ".example.com", "keep", Buffer.from("other site"), toChrome(Date.now() + DAY));
  db.close();
  writeFileSync(join(DESKTOP.data, "config.json"), JSON.stringify({ locale: "da", lastKnownAccountUuid: uuid, "oauth:tokenCacheV2": `token:${uuid}` }));
}
const cookieNames = () => (new Database(join(DESKTOP.data, "Cookies")).query("select host_key || ' ' || name as n from cookies order by n").all() as { n: string }[]).map((r) => r.n);
const config = () => JSON.parse(readFileSync(join(DESKTOP.data, "config.json"), "utf8"));
const config3p = () => JSON.parse(readFileSync(join(DESKTOP.data3p, "claude_desktop_config.json"), "utf8"));

test("capture → add → sign in → use switches accounts and keeps everything else", async () => {
  signIn("aaaa", { extraA: "1" });
  expect(capture(s)).toBe("aaaa");

  await add(s);
  expect(readLogin()).toBeUndefined();                              // signed out on this Mac only
  expect(cookieNames()).toEqual([".example.com keep"]);              // other sites untouched
  expect(config().locale).toBe("da");                                // other settings untouched
  expect(await pollDesktopLogin(s)).toBeUndefined();                 // still waiting for the user

  // The user signs in to another account; the daemon saves it.
  rmSync(join(DESKTOP.data, "Cookies")); new Database(join(DESKTOP.data, "Cookies")).exec(SCHEMA); signIn("bbbb");
  expect(await pollDesktopLogin(s)).toBe("bbbb");
  expect(s.local("desktop:pendingAdd")).toBeUndefined();

  events = [];
  await use(s, "aaaa");
  expect(events).toEqual(["quit", "open"]);
  expect(config().lastKnownAccountUuid).toBe("aaaa");
  expect(config()["oauth:tokenCacheV2"]).toBe("token:aaaa");
  expect(cookieNames()).toEqual([".claude.ai extraA", ".claude.ai sessionKey", ".example.com keep", "claude.ai lastActiveOrg"]);

  // Switching away saved bbbb's latest login, so going back works.
  await use(s, "bbbb");
  expect(config().lastKnownAccountUuid).toBe("bbbb");
  expect(cookieNames()).not.toContain(".claude.ai extraA");
  const st = status(s);
  expect(st.current?.accountUuid).toBe("bbbb");
  expect(st.logins.map((l) => l.accountUuid)).toEqual(["aaaa", "bbbb"]);
  expect(st.signedOut).toBe(false);
});

test("refuses expired logins and logins from a different cookie format, without touching Desktop", async () => {
  signIn("aaaa"); capture(s);
  const saved = JSON.parse(s.local("desktop:login:aaaa")!);
  s.setLocal("desktop:login:old", JSON.stringify({ ...saved, accountUuid: "old", sessionExpiresAt: Date.now() - 1 }));
  s.setLocal("desktop:login:new", JSON.stringify({ ...saved, accountUuid: "new", cookieSchema: "99" }));
  events = [];
  await expect(use(s, "old")).rejects.toThrow("expired");
  expect(events).toEqual([]);
  await expect(use(s, "new")).rejects.toThrow("stores logins differently");
  expect(events).toEqual([]);                                         // checked before quitting Desktop
  expect(config().lastKnownAccountUuid).toBe("aaaa");                 // unchanged
  expect(status(s).logins.find((l) => l.accountUuid === "new")?.problem).toBeTruthy();
  await expect(use(s, "missing")).rejects.toThrow("No saved");
  forget(s, "old"); expect(status(s).logins.map((l) => l.accountUuid)).toEqual(["aaaa", "new"]);
});

test("gateway mode points Desktop's third-party profile at the pool and back, keeping other configurations", async () => {
  const lib = join(DESKTOP.data3p, "configLibrary"); mkdirSync(lib);
  writeFileSync(join(lib, "_meta.json"), JSON.stringify({ appliedId: "theirs", entries: [{ id: "theirs", name: "Work gateway" }], extra: true }));
  writeFileSync(join(lib, "theirs.json"), JSON.stringify({ inferenceProvider: "gateway", inferenceGatewayBaseUrl: "https://gw.example.com" }));
  expect(mode()).toBe("signed-in");

  await gateway(s, true);
  expect(mode()).toBe("pool");
  expect(config3p()).toMatchObject({ deploymentMode: "3p", other: 1 });
  const meta = JSON.parse(readFileSync(join(lib, "_meta.json"), "utf8"));
  expect(meta.extra).toBe(true);
  expect(meta.entries.map((e: any) => e.name)).toEqual(["Work gateway", "Agentgate"]);
  expect(JSON.parse(readFileSync(join(lib, `${meta.appliedId}.json`), "utf8")).inferenceGatewayBaseUrl).toEndWith("/anthropic");
  await gateway(s, true); // repeatable: one entry, same id
  expect(JSON.parse(readFileSync(join(lib, "_meta.json"), "utf8")).entries).toHaveLength(2);

  // Using a signed-in account turns gateway mode off.
  signIn("aaaa"); capture(s); await use(s, "aaaa");
  expect(config3p().deploymentMode).toBe("1p");
  expect(mode()).toBe("signed-in");

  writeFileSync(join(lib, "_meta.json"), JSON.stringify({ ...meta, appliedId: "theirs" }));
  writeFileSync(join(DESKTOP.data3p, "claude_desktop_config.json"), JSON.stringify({ deploymentMode: "3p" }));
  expect(mode()).toBe("other-gateway");
});

test("detects a sign-out done in Desktop and an unknown account", async () => {
  signIn("aaaa"); capture(s);
  writeFileSync(join(DESKTOP.data, "config.json"), JSON.stringify({ locale: "da" }));
  expect(status(s).signedOut).toBe(true);
  signIn("cccc");
  const st = status(s);
  expect(st.signedOut).toBe(false);
  expect(st.current).toMatchObject({ accountUuid: "cccc", saved: false });
});

test("a pending add expires and the first change backs up Desktop's files once", async () => {
  signIn("aaaa");
  await add(s);
  const backup = s.local("desktop:backup")!;
  expect(readFileSync(join(backup, "config.json"), "utf8")).toContain("aaaa");
  s.setLocal("desktop:pendingAdd", JSON.stringify({ since: Date.now() - 11 * 60_000 }));
  signIn("bbbb");
  expect(await pollDesktopLogin(s)).toBeUndefined();
  expect(s.local("desktop:pendingAdd")).toBeUndefined();
  await gateway(s, true);
  expect(s.local("desktop:backup")).toBe(backup);
});

test("a login saved by another major Desktop version is refused before anything changes", async () => {
  signIn("aaaa"); capture(s);
  const saved = JSON.parse(s.local("desktop:login:aaaa")!);
  s.setLocal("desktop:login:old", JSON.stringify({ ...saved, accountUuid: "old", desktopVersion: "1.9.0" }));
  s.setLocal("desktop:login:patch", JSON.stringify({ ...saved, accountUuid: "patch", desktopVersion: "2.1.0" }));
  await gateway(s, true); events = [];
  await expect(use(s, "old")).rejects.toThrow("Claude Desktop 1.9.0");
  expect(events).toEqual([]);
  expect(mode()).toBe("pool");                                        // a refused switch leaves pool mode on
  const st = status(s);
  expect(st.logins.find((l) => l.accountUuid === "old")?.problem).toContain("1.9.0");
  expect(st.logins.find((l) => l.accountUuid === "patch")?.problem).toBeUndefined(); // a minor update is fine
});

test("a failed config write puts the old cookies back, so Desktop never mixes two accounts", async () => {
  signIn("bbbb"); capture(s);
  signIn("aaaa", { extraA: "1" }); capture(s);
  files.write = (file, content) => { if (file.endsWith("config.json")) throw new Error("disk full"); originalFiles.write(file, content); };
  await expect(use(s, "bbbb")).rejects.toThrow("disk full");
  expect(events).toContain("open");
  expect(config().lastKnownAccountUuid).toBe("aaaa");
  expect(cookieNames()).toContain(".claude.ai extraA");
  expect(readLogin()?.accountUuid).toBe("aaaa");
});

test("switching to the account Desktop already uses keeps its newest login", async () => {
  signIn("aaaa"); capture(s);
  await gateway(s, true);
  // Desktop refreshed its tokens and cookies since the login was saved.
  signIn("aaaa", { refreshed: "1" });
  writeFileSync(join(DESKTOP.data, "config.json"), JSON.stringify({ ...config(), "oauth:tokenCacheV2": "token:aaaa:new" }));
  await use(s, "aaaa");
  expect(config()["oauth:tokenCacheV2"]).toBe("token:aaaa:new");
  expect(cookieNames()).toContain(".claude.ai refreshed");
  expect(mode()).toBe("signed-in");
  expect(JSON.parse(s.local("desktop:login:aaaa")!).config["oauth:tokenCacheV2"]).toBe("token:aaaa:new");
});

test("a sign-in Agentgate can't read is never erased", async () => {
  signIn("bbbb"); capture(s);
  signIn("aaaa");
  const { lastKnownAccountUuid: _, ...rest } = config();
  writeFileSync(join(DESKTOP.data, "config.json"), JSON.stringify(rest)); // e.g. Desktop has not written the account id yet
  const before = cookieNames();
  await expect(add(s)).rejects.toThrow("can't read yet");
  await expect(use(s, "bbbb")).rejects.toThrow("can't read yet");
  expect(cookieNames()).toEqual(before);
  expect(config()["oauth:tokenCacheV2"]).toBe("token:aaaa");
  expect(events.at(-1)).toBe("open");
});

test("the backup includes cookie changes still in the write-ahead log", async () => {
  const live = new Database(join(dir, "wal-src"));
  live.exec("pragma journal_mode = wal; pragma wal_autocheckpoint = 0;"); live.exec(SCHEMA);
  live.run("insert into cookies values (0, '.claude.ai', '', 'inWal', '', x'00', '/', 0, 1, 1, 0, 1, 1, 1, 0, 2, 443, 0, 0, 0)");
  // Copy the files while the connection still holds the change in the WAL, like after a crash.
  for (const ext of ["", "-wal"]) writeFileSync(join(DESKTOP.data, `Cookies${ext}`), readFileSync(join(dir, `wal-src${ext}`)));
  live.close();
  writeFileSync(join(DESKTOP.data, "config.json"), "{}");
  await gateway(s, true);
  const backup = new Database(join(s.local("desktop:backup")!, "Cookies"), { readonly: true });
  expect(backup.query("select name from cookies").all()).toEqual([{ name: "inWal" }]);
  backup.close();
});

test("no change is made after another process took over the switch lock", async () => {
  signIn("bbbb"); capture(s);
  signIn("aaaa"); capture(s);
  host.quit = async () => { running = false; s.setLocal("desktop:switch", JSON.stringify({ owner: "other", expires: Date.now() + 60_000 })); };
  events = [];
  await expect(use(s, "bbbb")).rejects.toThrow("started meanwhile");
  expect(config().lastKnownAccountUuid).toBe("aaaa");
  expect(events).not.toContain("open"); // the other process owns Desktop now
  expect(JSON.parse(s.local("desktop:switch")!).owner).toBe("other");
});

test("connecting one account but signing in to another keeps the login and says so", async () => {
  for (const [id, uuid, email] of [["claude-work", "aaaa", "work@example.com"], ["claude-home", "bbbb", "home@example.com"]]) {
    s.put("account", id!, { id: id!, provider: "claude", label: id!, email, enabled: true, priority: 0 });
    s.put("credential", id!, { accountId: id!, accessToken: "t", refreshToken: "r", expiresAt: Date.now() + DAY, accountUuid: uuid, holder: "test" });
  }
  signIn("cccc");
  await add(s, "work@example.com");
  signIn("bbbb");
  expect(await pollDesktopLogin(s)).toBe("bbbb");
  expect(status(s).addMismatch).toMatchObject({ expected: "work@example.com", accountUuid: "bbbb", email: "home@example.com" });
  cancelAdd(s);
  expect(status(s).addMismatch).toBeUndefined();

  await add(s, "work@example.com");
  expect(status(s).addMismatch).toBeUndefined();
  signIn("aaaa");
  expect(await pollDesktopLogin(s)).toBe("aaaa");
  expect(status(s).addMismatch).toBeUndefined();
});

test("saving a sign-in waits while another process is switching", async () => {
  signIn("aaaa"); await add(s);
  signIn("bbbb");
  s.setLocal("desktop:switch", JSON.stringify({ owner: "other", expires: Date.now() + 60_000 }));
  expect(await pollDesktopLogin(s)).toBeUndefined();
  expect(() => capture(s)).toThrow("in progress");
  expect(s.local("desktop:pendingAdd")).toBeDefined();
  s.setLocal("desktop:switch", undefined);
  const since = Date.now();
  expect(await pollDesktopLogin(s)).toBe("bbbb");
  expect(addedSince(s, since)).toBe("bbbb");      // a waiting CLI sees the daemon saved it
  expect(addedSince(s, Date.now() + 1)).toBeUndefined();
});

test("a switch interrupted by a crash is never saved mixed, and the next switch finishes it", async () => {
  signIn("aaaa"); capture(s);
  signIn("bbbb", { extraB: "1" }); capture(s);
  // Crash halfway from bbbb to aaaa: aaaa's cookies are in, config.json is still bbbb's.
  const db = new Database(join(DESKTOP.data, "Cookies"));
  db.run("delete from cookies where name = 'extraB'"); db.close();
  signIn("aaaa");
  writeFileSync(join(DESKTOP.data, "config.json"), JSON.stringify({ locale: "da", lastKnownAccountUuid: "bbbb", "oauth:tokenCacheV2": "token:bbbb" }));
  s.setLocal("desktop:switching", JSON.stringify({ target: "aaaa" }));
  s.setLocal("desktop:pendingAdd", JSON.stringify({ since: Date.now() }));

  expect(() => capture(s)).toThrow("interrupted");
  expect(await pollDesktopLogin(s)).toBeUndefined();
  expect(JSON.parse(s.local("desktop:login:bbbb")!).config["oauth:tokenCacheV2"]).toBe("token:bbbb"); // untouched

  await use(s, "bbbb");
  expect(s.local("desktop:switching")).toBeUndefined();
  expect(config()).toMatchObject({ lastKnownAccountUuid: "bbbb", "oauth:tokenCacheV2": "token:bbbb" });
  expect(cookieNames()).toContain(".claude.ai extraB");
  const a = JSON.parse(s.local("desktop:login:aaaa")!);  // re-saved only after the switch was finished
  expect(a.config["oauth:tokenCacheV2"]).toBe("token:aaaa");
});

test("a failed gateway change keeps the user's own gateway selected", async () => {
  const lib = join(DESKTOP.data3p, "configLibrary"); mkdirSync(lib);
  writeFileSync(join(lib, "_meta.json"), JSON.stringify({ appliedId: "theirs", entries: [{ id: "theirs" }] }));
  writeFileSync(join(lib, "theirs.json"), JSON.stringify({ inferenceProvider: "gateway", inferenceGatewayBaseUrl: "https://gw.example.com" }));
  writeFileSync(join(DESKTOP.data3p, "claude_desktop_config.json"), JSON.stringify({ deploymentMode: "3p" }));
  expect(mode()).toBe("other-gateway");
  files.write = (file, content) => { if (file.endsWith("claude_desktop_config.json")) throw new Error("disk full"); originalFiles.write(file, content); };
  await expect(gateway(s, true)).rejects.toThrow("disk full");
  expect(mode()).toBe("other-gateway");
  expect(JSON.parse(readFileSync(join(lib, "_meta.json"), "utf8")).appliedId).toBe("theirs");
  expect(s.local("desktop:gatewayBefore")).toBeUndefined();

  // A crash after selecting agentgate: the next change puts the user's gateway back first.
  files.write = originalFiles.write;
  const meta = readFileSync(join(lib, "_meta.json"), "utf8"), conf = readFileSync(join(DESKTOP.data3p, "claude_desktop_config.json"), "utf8");
  s.setLocal("desktop:gatewayBefore", JSON.stringify([conf, meta]));
  writeFileSync(join(lib, "_meta.json"), JSON.stringify({ appliedId: "ours", entries: [] }));
  signIn("aaaa"); capture(s);
  await use(s, "aaaa"); // turns gateway mode off; the restore ran first
  expect(JSON.parse(readFileSync(join(lib, "_meta.json"), "utf8")).appliedId).toBe("theirs");
  expect(s.local("desktop:gatewayBefore")).toBeUndefined();
});
