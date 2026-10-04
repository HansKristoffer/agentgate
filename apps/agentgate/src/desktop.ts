import type { DesktopLogin, DesktopMode, DesktopStatus } from "@agentgate/protocol";
import { Database } from "bun:sqlite";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./files.ts";
import { claudeStatus } from "./setup.ts";
import { CONFIG_DIR, liveOnly, LOCAL_URL, type Store } from "./store.ts";

/** Claude Desktop's undocumented storage, kept in one place (docs/internals/claude-desktop.md). Mutable so tests can use fixtures.
 * Cookie and token values are encrypted with this Mac's Keychain key; they are copied as they are, never decrypted. */
const REAL_DATA = join(homedir(), "Library/Application Support/Claude");
export const DESKTOP = {
  app: "/Applications/Claude.app",
  /** The signed-in profile. */
  data: REAL_DATA,
  /** The third-party ("gateway") profile Desktop switches to with deploymentMode 3p. */
  data3p: join(homedir(), "Library/Application Support/Claude-3p"),
  backups: join(CONFIG_DIR, "desktop-backup"),
  hosts: ["claude.ai", "claude.com", "anthropic.com"],
  keys: ["oauth:tokenCache", "oauth:tokenCacheV2", "lastKnownAccountUuid"],
  quitTimeout: 15_000,
};

/** Process control, replaced in tests. */
export const host = {
  installed: () => process.platform === "darwin" && existsSync(DESKTOP.app),
  running: () => Bun.spawnSync(["/usr/bin/pgrep", "-x", "Claude"]).exitCode === 0,
  async quit() {
    Bun.spawnSync(["/usr/bin/osascript", "-e", 'quit app "Claude"']);
    for (const end = Date.now() + DESKTOP.quitTimeout; Date.now() < end; await Bun.sleep(250)) if (!host.running()) return;
    // Never force-kill: Desktop may be asking about unsaved work.
    throw new Error("Claude Desktop did not quit. Quit it yourself and try again.");
  },
  open() {
    // `open` hands the caller's environment to the app; give Desktop a clean one so no agent or session variables leak into it.
    Bun.spawn(["/usr/bin/open", "-a", DESKTOP.app], { env: { HOME: homedir(), USER: userInfo().username, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdio: ["ignore", "ignore", "ignore"] });
  },
  version(): string | undefined {
    const r = Bun.spawnSync(["/usr/bin/plutil", "-extract", "CFBundleShortVersionString", "raw", join(DESKTOP.app, "Contents/Info.plist")]);
    return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
  },
};

type Row = Record<string, string | number | null | { b64: string }>;
interface Login {
  accountUuid: string;
  capturedAt: number;
  desktopVersion?: string;
  cookieSchema: string;
  sessionExpiresAt?: number;
  cookies: Row[];
  config: Record<string, unknown>;
}

const MIN = 60_000;
const ADD_TIMEOUT = 10 * MIN;
const key = (uuid: string) => `desktop:login:${uuid}`;
const cookiesFile = () => join(DESKTOP.data, "Cookies");
const configFile = () => join(DESKTOP.data, "config.json");
const gatewayFile = () => join(DESKTOP.data3p, "claude_desktop_config.json");
const libraryDir = () => join(DESKTOP.data3p, "configLibrary");
const gatewayUrl = () => `${LOCAL_URL}/anthropic`;

function readJson(file: string): Record<string, any> {
  if (!existsSync(file)) return {};
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${file}: expected an object`);
  return value;
}
/** File writes, replaced in tests to simulate a failing disk. */
export const files = { write: atomicWrite };
const writeJson = (file: string, value: unknown) => files.write(file, JSON.stringify(value, null, 2));

/** `host_key` is exactly one of the hosts or a subdomain of it ("notclaude.ai" does not match). */
function hostFilter() {
  return { where: `(${DESKTOP.hosts.map(() => "host_key = ? or host_key like ?").join(" or ")})`, params: DESKTOP.hosts.flatMap((h) => [h, `%.${h}`]) };
}

function openCookies(readonly: boolean) {
  if (!existsSync(cookiesFile())) throw new Error("Claude Desktop has no cookie store yet; open it and sign in once");
  const db = new Database(cookiesFile(), readonly ? { readonly: true } : undefined);
  db.run("pragma busy_timeout = 5000");
  return db;
}
const schemaOf = (db: Database) => String((db.query("select value from meta where key = 'version'").get() as { value: unknown } | null)?.value ?? "");

/** Chromium stores times as microseconds since 1601. */
const chromeTime = (t: unknown) => (typeof t === "number" && t > 0 ? Math.floor(t / 1000) - 11_644_473_600_000 : undefined);

/** The login Desktop has now, or undefined when it is signed out. Safe while Desktop runs. */
export function readLogin(): Login | undefined {
  const config = readJson(configFile());
  const accountUuid = config.lastKnownAccountUuid;
  if (typeof accountUuid !== "string" || !accountUuid) return undefined;
  const db = openCookies(true);
  try {
    const { where, params } = hostFilter();
    const raw = db.query(`select * from cookies where ${where}`).all(...params) as Record<string, unknown>[];
    // No session cookie yet: Chromium flushes cookies to disk up to ~30 s after a sign-in.
    const session = raw.find((r) => r.name === "sessionKey") ?? raw.find((r) => String(r.name).startsWith("sessionKey"));
    if (!session) return undefined;
    const cookies = raw.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? { b64: Buffer.from(v).toString("base64") } : v as string | number | null])));
    return {
      accountUuid, capturedAt: Date.now(), desktopVersion: host.version(), cookieSchema: schemaOf(db), sessionExpiresAt: chromeTime(session.expires_utc), cookies,
      config: Object.fromEntries(DESKTOP.keys.filter((k) => k in config).map((k) => [k, config[k]])),
    };
  } finally { db.close(); }
}

const currentSchema = () => { const db = openCookies(true); try { return schemaOf(db); } finally { db.close(); } };
const major = (v: string | undefined) => v?.split(".")[0];

/** Why a saved login cannot go back into this Desktop, or undefined when it can.
 * ponytail: same major version, not the exact build — Desktop updates often, and the cookie schema check catches storage changes. */
function incompatible(login: Login, schema: string, version = host.version()): string | undefined {
  if (login.cookieSchema !== schema) return "Saved with a Claude Desktop that stores logins differently; connect this account again";
  if (login.desktopVersion && version && major(login.desktopVersion) !== major(version)) return `Saved with Claude Desktop ${login.desktopVersion}; connect this account again`;
}

/** Desktop holds login data readLogin cannot use, e.g. a sign-in still being written to disk. Replacing it would lose it. */
function unreadable(): boolean {
  const config = readJson(configFile());
  if (DESKTOP.keys.some((k) => k !== "lastKnownAccountUuid" && config[k])) return true;
  const db = openCookies(true);
  try {
    const { where, params } = hostFilter();
    return !!db.query(`select 1 from cookies where (${where}) and name like 'sessionKey%' limit 1`).get(...params);
  } finally { db.close(); }
}

/** Replace Desktop's claude.ai cookies and token keys. Desktop must not be running.
 * Cookies and tokens must always belong to the same account, so a failed config write puts the old cookies back. */
function writeLogin(login: Login | undefined) {
  if (host.running()) throw new Error("Claude Desktop is still running");
  const config = readJson(configFile()); // a broken config.json stops the switch before anything changes
  const db = openCookies(false);
  try {
    if (login) { const problem = incompatible(login, schemaOf(db)); if (problem) throw new Error(problem); }
    const { where, params } = hostFilter();
    const before = db.query(`select * from cookies where ${where}`).all(...params) as Record<string, unknown>[];
    const replace = (rows: Record<string, unknown>[]) => db.transaction(() => {
      // Accounts carry different cookie sets, so delete them all before inserting (not an upsert by name).
      db.query(`delete from cookies where ${where}`).run(...params);
      for (const row of rows) {
        const cols = Object.keys(row);
        db.query(`insert into cookies (${cols.map((c) => `"${c.replace(/"/g, "")}"`).join(",")}) values (${cols.map(() => "?").join(",")})`)
          .run(...cols.map((c) => { const v = row[c] as any; return v instanceof Uint8Array ? v : v && typeof v === "object" ? Buffer.from(v.b64, "base64") : v ?? null; }));
      }
    }).immediate();
    replace(login?.cookies ?? []);
    for (const k of DESKTOP.keys) delete config[k];
    try { writeJson(configFile(), { ...config, ...login?.config }); }
    catch (e) { replace(before); throw e; }
  } finally { db.close(); }
}

/** One copy of everything this module touches, taken before its first change. */
function backupOnce(s: Store) {
  if (s.local("desktop:backup")) return;
  const dir = join(DESKTOP.backups, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(DESKTOP.backups, 0o700);
  // VACUUM INTO, not a file copy: changes still in Cookies-wal (e.g. after a crash) belong in the backup too.
  if (existsSync(cookiesFile())) { const db = openCookies(true); try { db.run("vacuum into ?", [join(dir, "Cookies")]); } finally { db.close(); } }
  for (const [from, to] of [[configFile(), "config.json"], [DESKTOP.data3p, "Claude-3p"]] as const)
    if (existsSync(from)) cpSync(from, join(dir, to), { recursive: true });
  s.setLocal("desktop:backup", dir);
}

function saved(s: Store, uuid: string): Login | undefined {
  const raw = s.local(key(uuid));
  return raw ? JSON.parse(raw) : undefined;
}

/** The pool account for a Claude account uuid, if it is in the pool. */
function poolAccount(s: Store, uuid: string) {
  const id = s.list("credential").find((c) => c.accountUuid === uuid)?.accountId;
  return id ? s.get("account", id) : undefined;
}

function save(s: Store, login: Login) {
  s.setLocal(key(login.accountUuid), JSON.stringify(login));
  s.setLocal("desktop:current", login.accountUuid);
  return login.accountUuid;
}

function log(s: Store, uuid: string | undefined, note: string) {
  s.log("claude-desktop", (uuid && poolAccount(s, uuid)?.id) ?? "", "", 0, 0, note);
}
const nameOf = (s: Store, uuid: string) => poolAccount(s, uuid)?.label ?? poolAccount(s, uuid)?.email ?? uuid.slice(0, 8);

const LEASE = "desktop:switch";
/** Set while Desktop's cookies and config.json are being replaced: they may belong to two accounts until it is cleared. */
const JOURNAL = "desktop:switching";
const INTERRUPTED = "An earlier Claude Desktop switch was interrupted. Switch accounts once in Agentgate to finish it.";

/** Run synchronous `fn` with the switch lock held; undefined when another process holds it. Saving a login goes through here. */
function locked<T>(s: Store, fn: () => T): T | undefined {
  const owner = crypto.randomUUID();
  if (!s.acquireLease(LEASE, owner, 2 * MIN)) return undefined;
  try { return fn(); } finally { s.releaseLease(LEASE, owner); }
}

/** Replace Desktop's login, recording the switch first so a crash between the cookie and config writes can be finished later. */
function switchLogin(s: Store, target: string | null) {
  s.setLocal(JOURNAL, JSON.stringify({ target }));
  // An error leaves Desktop consistent (writeLogin rolls back), so only a crash leaves the record behind.
  try { writeLogin(target ? saved(s, target) : undefined); } finally { s.setLocal(JOURNAL, undefined); }
}

/** Run `fn` with Desktop quit, then reopen it. One switch at a time, across the CLI and the daemon. */
async function withDesktopClosed<T>(s: Store, fn: () => T | Promise<T>): Promise<T> {
  if (DESKTOP.data === REAL_DATA) liveOnly("Changing Claude Desktop");
  if (!host.installed()) throw new Error("Claude Desktop is not installed on this Mac");
  const owner = crypto.randomUUID();
  const lock = () => s.acquireLease(LEASE, owner, 2 * MIN);
  if (!lock()) throw new Error("Another Claude Desktop change is in progress");
  let mine = true;
  try {
    if (host.running()) await host.quit();
    try {
      backupOnce(s);
      // A large first backup can outlast the lease; never change Desktop after another process took it over.
      if (!(mine = lock())) throw new Error("Another Claude Desktop change started meanwhile; nothing was changed");
      // Undo a gateway change and finish a login switch that a crash left halfway, before anything reads Desktop's files.
      const gatewayBefore = s.local(GATEWAY_JOURNAL);
      if (gatewayBefore) restoreGateway(s, JSON.parse(gatewayBefore));
      const journal = s.local(JOURNAL);
      if (journal) {
        const { target } = JSON.parse(journal) as { target: string | null };
        // The login being left was saved before the crash; if the target can't go back in (e.g. after a Desktop update), sign out on this Mac.
        try { switchLogin(s, target); } catch { s.setLocal(JOURNAL, journal); switchLogin(s, null); }
      }
      return await fn();
    } finally {
      // Reopen even after a failure, so Desktop is never left closed; but not once another process owns it.
      if (mine && (mine = lock())) host.open();
    }
  } finally { if (mine) s.releaseLease(LEASE, owner); }
}

/** Save the login Desktop has now. */
export function capture(s: Store): string {
  const uuid = locked(s, () => {
    if (s.local(JOURNAL)) throw new Error(INTERRUPTED);
    const login = readLogin();
    if (!login) throw new Error("Claude Desktop is not signed in (or has not saved its sign-in yet; wait a few seconds)");
    return save(s, login);
  });
  if (!uuid) throw new Error("A Claude Desktop change is in progress; try again in a moment");
  log(s, uuid, `saved Claude Desktop login for ${nameOf(s, uuid)}`);
  return uuid;
}

/** Save the login Desktop is about to leave. Refuses when Desktop has one that cannot be saved, instead of erasing it. */
function saveOutgoing(s: Store): Login | undefined {
  const current = readLogin();
  if (current) { save(s, current); return current; }
  if (unreadable()) throw new Error("Claude Desktop has a sign-in Agentgate can't read yet, so nothing was changed. If you just signed in, wait half a minute and try again.");
}

/** A saved login that can go into this Desktop now, or an error saying why not. */
function usable(s: Store, uuid: string): Login {
  const login = saved(s, uuid);
  if (!login) throw new Error("No saved Claude Desktop login for that account; connect it first");
  if (login.sessionExpiresAt && login.sessionExpiresAt <= Date.now()) throw new Error("That saved login has expired; connect the account again");
  const problem = incompatible(login, currentSchema());
  if (problem) throw new Error(problem);
  return login;
}

/** Switch Desktop to a saved login. The login it leaves is saved first, so switching back always works. */
export async function use(s: Store, uuid: string): Promise<void> {
  usable(s, uuid); // check before quitting Desktop
  await withDesktopClosed(s, () => {
    const current = saveOutgoing(s);
    // Already on this account (e.g. leaving pool mode): its login on disk is the newest; restoring the saved copy would put back old tokens.
    if (current?.accountUuid !== uuid) { usable(s, uuid); switchLogin(s, uuid); }
    setGatewayMode(s, false);
    s.setLocal("desktop:current", uuid);
    cancelAdd(s);
  });
  log(s, uuid, `switched Claude Desktop to ${nameOf(s, uuid)}`);
}

/** Sign Desktop out on this Mac only (no request to Anthropic, so saved logins stay valid) and wait for the next sign-in. */
export async function add(s: Store, expected?: string): Promise<void> {
  await withDesktopClosed(s, () => {
    saveOutgoing(s);
    switchLogin(s, null);
    setGatewayMode(s, false);
    s.setLocal("desktop:current", undefined);
    cancelAdd(s);
    s.setLocal("desktop:pendingAdd", JSON.stringify({ since: Date.now(), expected }));
  });
}

/** Stop waiting for a sign-in, and dismiss a "signed in with a different account" notice. */
export function cancelAdd(s: Store) { s.setLocal("desktop:pendingAdd", undefined); s.setLocal("desktop:addMismatch", undefined); }

/** The user was asked to sign in as `expected` (an email) but signed in as `uuid`. Unknown when neither account is in the pool. */
function mismatch(s: Store, expected: string, uuid: string): boolean {
  const e = expected.toLowerCase();
  const wanted = s.list("account").find((a) => a.provider === "claude" && a.email?.toLowerCase() === e);
  const wantedUuid = wanted && s.get("credential", wanted.id)?.accountUuid;
  if (wantedUuid) return wantedUuid !== uuid;
  const got = poolAccount(s, uuid)?.email?.toLowerCase();
  return !!got && got !== e;
}

/** Called every few seconds by the daemon (and the CLI while it waits): save the login once the user has signed in. */
export async function pollDesktopLogin(s: Store): Promise<string | undefined> {
  if (!s.local("desktop:pendingAdd")) return undefined;
  // Under the switch lock: mid-switch, Desktop's files can hold one account's cookies and another's tokens.
  const uuid = locked(s, () => {
    const raw = s.local("desktop:pendingAdd");
    if (!raw || s.local(JOURNAL)) return undefined;
    const pending = JSON.parse(raw) as { since: number; expected?: string };
    if (Date.now() - pending.since > ADD_TIMEOUT) { cancelAdd(s); return undefined; }
    const login = readLogin();
    if (!login) return undefined;
    cancelAdd(s);
    // A different account than asked for is still a real sign-in: keep it, and say so.
    if (pending.expected && mismatch(s, pending.expected, login.accountUuid))
      s.setLocal("desktop:addMismatch", JSON.stringify({ expected: pending.expected, accountUuid: login.accountUuid }));
    // Whoever saved it (the daemon or a waiting CLI), the other can tell the add finished.
    s.setLocal("desktop:lastAdd", JSON.stringify({ accountUuid: login.accountUuid, at: Date.now() }));
    return save(s, login);
  });
  if (uuid) log(s, uuid, `connected ${nameOf(s, uuid)} to Claude Desktop`);
  return uuid;
}

/** The account the last add saved, if it finished after `since`. */
export function addedSince(s: Store, since: number): string | undefined {
  const raw = s.local("desktop:lastAdd");
  const last = raw ? (JSON.parse(raw) as { accountUuid: string; at: number }) : undefined;
  return last && last.at >= since ? last.accountUuid : undefined;
}

export function forget(s: Store, uuid: string) {
  if (!s.local(key(uuid))) throw new Error("No saved Claude Desktop login for that account");
  s.setLocal(key(uuid), undefined);
}

/** Write the gateway profile's mode. Desktop must not be running. A failed write puts the user's previous gateway setup back. */
const GATEWAY_JOURNAL = "desktop:gatewayBefore";
const gatewayPaths = () => [gatewayFile(), join(libraryDir(), "_meta.json")];

/** Put the gateway files back as recorded before a change that failed or was cut short by a crash. */
function restoreGateway(s: Store, before: (string | null)[]) {
  gatewayPaths().forEach((f, i) => { const b = before[i]; if (typeof b === "string") atomicWrite(f, b); else rmSync(f, { force: true }); });
  s.setLocal(GATEWAY_JOURNAL, undefined);
}

function setGatewayMode(s: Store, on: boolean) {
  const before = gatewayPaths().map((f) => (existsSync(f) ? readFileSync(f, "utf8") : null));
  s.setLocal(GATEWAY_JOURNAL, JSON.stringify(before));
  try { writeGatewayMode(s, on); }
  catch (e) { restoreGateway(s, before); throw e; }
  s.setLocal(GATEWAY_JOURNAL, undefined);
}

function writeGatewayMode(s: Store, on: boolean) {
  const config = readJson(gatewayFile());
  if (on) {
    const id = s.local("desktop:gatewayEntry") ?? crypto.randomUUID();
    s.setLocal("desktop:gatewayEntry", id);
    writeJson(join(libraryDir(), `${id}.json`), { inferenceProvider: "gateway", inferenceGatewayBaseUrl: gatewayUrl(), inferenceGatewayApiKey: "agentgate", inferenceGatewayAuthScheme: "bearer" });
    // Keep any other configurations the user has; only add ours and select it.
    const meta = readJson(join(libraryDir(), "_meta.json"));
    const entries = (Array.isArray(meta.entries) ? meta.entries : []).filter((e: any) => e?.id !== id);
    writeJson(join(libraryDir(), "_meta.json"), { ...meta, appliedId: id, entries: [...entries, { id, name: "Agentgate", provider: "gateway" }] });
    writeJson(gatewayFile(), { ...config, deploymentMode: "3p" });
  } else if (config.deploymentMode === "3p") writeJson(gatewayFile(), { ...config, deploymentMode: "1p" });
}

/** Gateway mode: Desktop's Code tab sends its requests through the pool. */
export async function gateway(s: Store, on: boolean): Promise<void> {
  await withDesktopClosed(s, () => setGatewayMode(s, on));
  log(s, undefined, on ? "Claude Desktop now uses the pool (gateway mode)" : "Claude Desktop uses its own sign-in again");
}

export function mode(): DesktopMode {
  const config = readJson(gatewayFile());
  if (config.deploymentMode !== "3p") return "signed-in";
  try {
    const meta = readJson(join(libraryDir(), "_meta.json"));
    const entry = readJson(join(libraryDir(), `${String(meta.appliedId).replace(/[/\\]/g, "")}.json`));
    return entry.inferenceGatewayBaseUrl === gatewayUrl() ? "pool" : "other-gateway";
  } catch { return "other-gateway"; }
}

export function status(s: Store): DesktopStatus {
  const { routing, mcp } = claudeStatus();
  const base = { routing, mcp, logins: [] as DesktopLogin[], signedOut: false };
  if (!host.installed()) return { ...base, available: false, running: false, mode: "signed-in" };
  const now = Date.now();
  const version = host.version();
  let schema = "";
  try { schema = currentSchema(); } catch { }
  const who = (uuid: string) => { const a = poolAccount(s, uuid); return { accountUuid: uuid, accountId: a?.id, label: a?.label, email: a?.email }; };
  const logins = s.localPrefixed("desktop:login:").map(([, raw]) => {
    const l = JSON.parse(raw) as Login;
    const expired = !!l.sessionExpiresAt && l.sessionExpiresAt <= now;
    return { ...who(l.accountUuid), capturedAt: l.capturedAt, sessionExpiresAt: l.sessionExpiresAt, expired, problem: schema ? incompatible(l, schema, version) : undefined };
  });
  let current: DesktopStatus["current"];
  let signedIn = false;
  try {
    const uuid = readJson(configFile()).lastKnownAccountUuid;
    signedIn = !!readLogin();
    if (signedIn && typeof uuid === "string") current = { ...who(uuid), saved: logins.some((l) => l.accountUuid === uuid) };
  } catch { }
  const pending = s.local("desktop:pendingAdd");
  const wrong = s.local("desktop:addMismatch");
  let m: DesktopMode = "signed-in";
  try { m = mode(); } catch { }
  return {
    ...base, available: true, version, running: host.running(), mode: m, current, logins,
    pendingAdd: pending ? JSON.parse(pending) : undefined,
    addMismatch: wrong ? (({ expected, accountUuid }) => ({ expected, ...who(accountUuid) }))(JSON.parse(wrong)) : undefined,
    // Desktop was on an account agentgate put there and now has none: the user signed out in Desktop.
    signedOut: m === "signed-in" && !signedIn && !pending && !!s.local("desktop:current"),
  };
}
