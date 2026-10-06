import {
  RELAY_LIMITS, RELAY_PROTOCOL, changesResponse, checkPage, errorResponse, groupState, nodesResponse,
  type ChangesResponse, type RelayEnvelope,
} from "@agentgate/protocol/relay";
import { fetchHeaders, readBody } from "./runtime.ts";
import { parseRecord, type Rec, type Store } from "./store.ts";
import { lastSeen, noteSyncRound, peers, pullAll, SYNC_PROTOCOL } from "./sync.ts";

/**
 * Sync through a relay that only stores ciphertext (docs/internals/relay.md). Each node upserts its
 * sealed change feed into a group mailbox and pulls everyone else's entries since a cursor.
 */

/** The hosted relay, used when neither --relay-url nor AGENTGATE_RELAY_URL is given. */
export const DEFAULT_RELAY_URL: string = "https://agentgate-relay.hanskristoffer.dk";
export function relayUrlDefault() {
  const url = process.env.AGENTGATE_RELAY_URL || DEFAULT_RELAY_URL;
  if (!url) throw new RelayError("No hosted relay is configured yet. Pass --relay-url <url> or set AGENTGATE_RELAY_URL to your own relay.");
  return url;
}

// ---------------------------------------------------------------- invite and crypto

const SALT = new TextEncoder().encode("agentgate-relay-v1");
const INVITE = /^agr1\.([A-Za-z0-9_-]{1,2800})\.([A-Za-z0-9_-]{43})$/;
export class RelayError extends Error { constructor(message: string, readonly status = 0, readonly code?: string, readonly retryAfter?: number) { super(message); } }

export const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64url = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(text, "base64url"));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** HTTPS only, no credentials, query or fragment; plain HTTP is a local-development opt-in. */
export function checkRelayUrl(input: string): string {
  let u: URL;
  try { u = new URL(input); } catch { throw new RelayError("The relay URL is not a valid URL"); }
  const http = u.protocol === "http:" && process.env.AGENTGATE_RELAY_ALLOW_HTTP === "1";
  if (u.protocol !== "https:" && !http) throw new RelayError("The relay URL must use HTTPS");
  if (u.username || u.password || u.search || u.hash) throw new RelayError("The relay URL must not contain credentials, a query or a fragment");
  return u.toString().replace(/\/$/, "");
}

export interface Invite { text: string; url: string; secret: Uint8Array<ArrayBuffer> }
/** Never echoes the input: an invite is a master key. */
export function parseInvite(text: string): Invite {
  const m = text.trim().match(INVITE);
  if (!m) throw new RelayError("That is not a valid relay invite (it should start with agr1.)");
  let url: string;
  try { url = new TextDecoder("utf-8", { fatal: true }).decode(unb64url(m[1]!)); } catch { throw new RelayError("That is not a valid relay invite"); }
  return { text: text.trim(), url: checkRelayUrl(url), secret: unb64url(m[2]!) };
}

export function makeInvite(url: string): string {
  return `agr1.${b64url(new TextEncoder().encode(checkRelayUrl(url)))}.${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export interface Keys { groupId: string; authToken: string; enc: CryptoKey; mac: CryptoKey }
const keyCache = new Map<string, Promise<Keys>>();

export function deriveKeys(secret: Uint8Array<ArrayBuffer>): Promise<Keys> {
  const cacheKey = hex(secret);
  let keys = keyCache.get(cacheKey);
  if (!keys) {
    keys = (async () => {
      const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
      const bits = async (label: string, bytes: number) => new Uint8Array(await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: SALT, info: new TextEncoder().encode(`agentgate-relay-v1/${label}`) }, base, bytes * 8));
      return {
        groupId: hex(await bits("group", 16)),
        authToken: b64url(await bits("auth", 32)),
        enc: await crypto.subtle.importKey("raw", await bits("enc", 32), "AES-GCM", false, ["encrypt", "decrypt"]),
        mac: await crypto.subtle.importKey("raw", await bits("mac", 32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      };
    })();
    keyCache.set(cacheKey, keys);
  }
  return keys;
}

export async function entryKey(keys: Keys, kind: string, id: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", keys.mac, new TextEncoder().encode(`${kind}\0${id}`))));
}

export interface Aad { groupId: string; generation: string; node: string; key: string; pusherSeq: number }
const aad = (a: Aad) => new TextEncoder().encode(JSON.stringify([1, a.groupId, a.generation, a.node, a.key, a.pusherSeq]));

export async function seal(keys: Keys, a: Aad, plaintext: string, nonce = crypto.getRandomValues(new Uint8Array(12))): Promise<string> {
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(a) }, keys.enc, new TextEncoder().encode(plaintext)));
  const out = new Uint8Array(12 + ct.length);
  out.set(nonce); out.set(ct, 12);
  return b64url(out);
}

export async function open(keys: Keys, a: Aad, blob: string): Promise<string> {
  const bytes = unb64url(blob);
  if (bytes.length < 28) throw new RelayError("sealed entry too short");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: aad(a) }, keys.enc, bytes.subarray(12));
  return new TextDecoder().decode(pt);
}

// ---------------------------------------------------------------- node-local state

/** "active" is the group in use; "rot" is a replacement group being seeded by a rotation. */
type Target = "active" | "rot";
type Field = "invite" | "generation" | "pushed" | "cursor" | "phase" | "readCursor" | "pushError" | "pullError" | "skipped";
const k = (t: Target, f: Field) => t === "active" ? `relay:${f}` : `relay:rot:${f}`;
const get = (s: Store, t: Target, f: Field) => s.local(k(t, f));
const num = (s: Store, t: Target, f: Field) => Number(get(s, t, f) ?? 0);
const put = (s: Store, t: Target, f: Field, v: string | number | undefined) => s.setLocal(k(t, f), v === undefined ? undefined : String(v));
const FIELDS: Field[] = ["invite", "generation", "pushed", "cursor", "phase", "readCursor", "pushError", "pullError", "skipped"];

interface Cleanup { invite: string; serviceKey?: string; attempts: number; nextAt: number }
const cleanups = (s: Store): Cleanup[] => JSON.parse(s.local("relay:cleanup") ?? "[]");
const setCleanups = (s: Store, list: Cleanup[]) => s.setLocal("relay:cleanup", list.length ? JSON.stringify(list.slice(-20)) : undefined);
export const serviceKey = (s: Store) => process.env.AGENTGATE_RELAY_KEY || s.local("relay:serviceKey") || undefined;

function tables(s: Store) {
  s.db.run("create table if not exists relay_counters (grp text not null, generation text not null, node text not null, key text not null, counter integer not null, primary key (grp, generation, node, key))");
  // At most one unacknowledged chunk per group: its exact request body, resent byte for byte.
  s.db.run("create table if not exists relay_pending (grp text primary key, generation text not null, checkpoint integer not null, body text not null)");
}

const counter = (s: Store, grp: string, gen: string, node: string, key: string) =>
  (s.db.query("select counter from relay_counters where grp = ? and generation = ? and node = ? and key = ?").get(grp, gen, node, key) as { counter: number } | null)?.counter ?? 0;
const setCounter = (s: Store, grp: string, gen: string, node: string, key: string, value: number) =>
  s.db.run("insert into relay_counters values (?, ?, ?, ?, ?) on conflict (grp, generation, node, key) do update set counter = max(counter, excluded.counter)", [grp, gen, node, key, value]);
const pending = (s: Store, grp: string) => s.db.query("select * from relay_pending where grp = ?").get(grp) as { generation: string; checkpoint: number; body: string } | null;
const dropGroup = (s: Store, grp: string) => { s.db.run("delete from relay_pending where grp = ?", [grp]); s.db.run("delete from relay_counters where grp = ?", [grp]); };

// ---------------------------------------------------------------- coordination

interface Runtime { queue: Promise<unknown>; abort: AbortController; owner: string; started: Set<string>; backoff: Map<string, { until: number; failures: number }>; wanted?: { push: boolean; pull: boolean; force: boolean }; running?: Promise<void> }
const runtimes = new WeakMap<Store, Runtime>();
function rt(s: Store): Runtime {
  let r = runtimes.get(s);
  if (!r) { tables(s); runtimes.set(s, r = { queue: Promise.resolve(), abort: new AbortController(), owner: crypto.randomUUID(), started: new Set(), backoff: new Map() }); }
  return r;
}

export class RelayBusy extends Error { }

/**
 * Every relay mutation, from the daemon, API or CLI, runs here: serialized in this process and
 * under a renewable lease shared with other processes using the same database.
 */
export function withRelay<T>(s: Store, fn: (signal: AbortSignal) => Promise<T>, wait = 60_000): Promise<T> {
  const r = rt(s);
  const run = r.queue.then(async () => {
    const deadline = Date.now() + wait;
    while (!s.acquireLease("relay-lease", r.owner, 60_000)) {
      if (Date.now() >= deadline) throw new RelayBusy("Another agentgate process is syncing with the relay; try again shortly");
      await Bun.sleep(200);
    }
    const renew = setInterval(() => s.acquireLease("relay-lease", r.owner, 60_000), 10_000);
    renew.unref?.();
    try { return await fn(r.abort.signal); }
    finally { clearInterval(renew); s.releaseLease("relay-lease", r.owner); }
  });
  r.queue = run.catch(() => { });
  return run;
}

/** Shutdown: cancel network work, then wait for the queue so nothing touches a closed store. */
export async function stopRelay(s: Store) {
  const r = runtimes.get(s);
  if (!r) return;
  r.abort.abort();
  await r.running?.catch(() => { });
  await r.queue.catch(() => { });
}

// ---------------------------------------------------------------- transport

interface Conn { invite: Invite; keys: Keys; serviceKey?: string }
async function conn(s: Store, invite: string, key = serviceKey(s)): Promise<Conn> {
  const parsed = parseInvite(invite);
  return { invite: parsed, keys: await deriveKeys(parsed.secret), serviceKey: key };
}

async function call(c: Conn, method: string, path: string, body: unknown, signal: AbortSignal): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${c.keys.authToken}` };
  if (c.serviceKey) headers["x-relay-key"] = c.serviceKey;
  if (body !== undefined) headers["content-type"] = "application/json";
  const timeout = AbortSignal.timeout(30_000);
  const both = AbortSignal.any([signal, timeout]);
  let res: Response;
  try {
    res = await fetchHeaders(`${c.invite.url}/g/${c.keys.groupId}${path}`, { method, headers, body: typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: both }, 15_000);
  } catch (e) {
    if (signal.aborted) throw e;
    throw new RelayError("Could not reach the relay");
  }
  if (res.status >= 300 && res.status < 400) { await res.body?.cancel(); throw new RelayError("The relay answered with a redirect; refusing to follow it", res.status); }
  let json: any;
  try { json = JSON.parse(new TextDecoder().decode(await readBody(res.body, RELAY_LIMITS.messageBytes + 64 * 1024, both))); }
  catch (e) { if (signal.aborted) throw e; throw new RelayError(`The relay returned an unreadable response (${res.status})`, res.status); }
  if (res.status >= 400) {
    const err = errorResponse.safeParse(json);
    const retry = Number(res.headers.get("retry-after"));
    // Sanitized: status and a known code only, never a raw body.
    const code = err.success ? err.data.code : undefined;
    throw new RelayError(describe(res.status, code), res.status, err.success && err.data.resetRequired ? "reset" : code, Number.isFinite(retry) && retry > 0 ? retry : undefined);
  }
  return { status: res.status, json };
}

function describe(status: number, code?: string) {
  if (status === 401 && code === "relayKey") return "The relay requires a service key (AGENTGATE_RELAY_KEY)";
  if (status === 401) return "The relay rejected this invite";
  if (status === 404) return "The relay group no longer exists";
  if (status === 409 && code === "counter") return "Relay counter conflict";
  if (status === 409 && code === "tooManyNodes") return `A relay group holds at most ${RELAY_LIMITS.nodes} machines`;
  if (status === 409) return "The relay group was reset";
  if (status === 413) return "A request was too large for the relay";
  if (status === 429) return "The relay is rate limiting this machine";
  if (status === 503 && code === "disabled") return "This relay is not accepting new groups";
  if (status === 507) return code === "full" ? "This relay is full" : "The relay group is out of storage";
  return `The relay returned ${status}`;
}

const isReset = (e: unknown) => e instanceof RelayError && (e.status === 404 || e.code === "reset");

// ---------------------------------------------------------------- sync steps

/** The identity of a configuration: completions check it before committing anything. */
const identity = (s: Store, t: Target) => `${get(s, t, "invite") ?? ""}|${get(s, t, "generation") ?? ""}`;

/** The group was wiped, expired or replaced: start over against whatever is there now. */
function resetTarget(s: Store, t: Target, grp: string) {
  s.transaction(() => {
    for (const f of ["generation", "pushed", "cursor", "readCursor"] as const) put(s, t, f, undefined);
    put(s, t, "phase", "read");
    s.db.run("delete from relay_pending where grp = ?", [grp]);
  });
}

interface Decoded { node: string; key: string; pusherSeq: number; rec?: Rec }
async function decode(s: Store, c: Conn, generation: string, page: ChangesResponse): Promise<{ decoded: Decoded[]; skipped: number }> {
  const decoded: Decoded[] = [];
  let skipped = 0;
  for (const e of page.entries) {
    try {
      const payload = JSON.parse(await open(c.keys, { groupId: c.keys.groupId, generation, node: e.node, key: e.key, pusherSeq: e.pusherSeq }, e.blob));
      if (payload.protocol !== SYNC_PROTOCOL || !payload.record) throw new Error("incompatible encrypted sync payload; update paired nodes and reconcile");
      const rec = parseRecord(payload.record);
      if (await entryKey(c.keys, rec.kind, rec.id) !== e.key) throw new Error("entry key mismatch");
      decoded.push({ node: e.node, key: e.key, pusherSeq: e.pusherSeq, rec });
    } catch { skipped++; }
  }
  return { decoded, skipped };
}

function noteSkipped(s: Store, t: Target, skipped: number) {
  if (!skipped) return;
  const prev = JSON.parse(get(s, t, "skipped") ?? '{"count":0}') as { count: number };
  put(s, t, "skipped", JSON.stringify({ count: prev.count + skipped, at: s.now() }));
}

/** Heartbeats are availability hints from the relay: clamped, bounded, never proof of anything. */
function noteSeen(s: Store, seen: Record<string, number>) {
  for (const [node, at] of Object.entries(seen).slice(0, RELAY_LIMITS.nodes)) {
    if (node === s.nodeId) continue;
    const t = Math.min(at, s.now());
    s.setLocal(`relaySeen:${node}`, String(t));
    if (t > lastSeen(s, node)) s.setLocal(`seen:${node}`, String(t));
  }
}

/** Fetch, decrypt and validate one page outside the store transaction; then commit it atomically. */
async function pullPage(s: Store, t: Target, c: Conn, signal: AbortSignal, full: boolean): Promise<boolean> {
  const before = identity(s, t);
  const generation = get(s, t, "generation")!;
  const since = num(s, t, full ? "readCursor" : "cursor");
  const q = new URLSearchParams({ generation, since: String(since), node: s.nodeId, includeSelf: full ? "1" : "0" });
  const { json } = await call(c, "GET", `/changes?${q}`, undefined, signal);
  const page = changesResponse.safeParse(json);
  if (!page.success || page.data.generation !== generation) throw new RelayError("The relay returned an invalid page");
  const problem = checkPage(page.data, since);
  if (problem) throw new RelayError(`The relay returned an invalid page (${problem})`);
  const { decoded, skipped } = await decode(s, c, generation, page.data);
  s.transaction(() => {
    if (identity(s, t) !== before) throw new RelayError("relay configuration changed");
    for (const d of decoded) {
      // Replay protection per (group, generation, node, key): only strictly newer counters count.
      if (d.pusherSeq <= counter(s, c.keys.groupId, generation, d.node, d.key)) continue;
      setCounter(s, c.keys.groupId, generation, d.node, d.key, d.pusherSeq);
      s.merge(d.rec!);
    }
    put(s, t, full ? "readCursor" : "cursor", page.data.nextCursor);
    noteSkipped(s, t, skipped);
    noteSeen(s, page.data.seen);
    noteSyncRound(s);
    put(s, t, "pullError", undefined);
  });
  return page.data.more;
}

/**
 * Upload the change feed after `pushed` in chunks. Each chunk's counters and exact body are
 * persisted before sending, so a lost response is retried byte for byte and a crash never reuses
 * a counter for different ciphertext. The checkpoint never passes the snapshot a chunk came from.
 */
async function pushLoop(s: Store, t: Target, c: Conn, signal: AbortSignal) {
  // A pending rotation means the old secret is being retired: nothing new goes to the old group.
  if (t === "active" && s.local("relay:rotation")) return;
  const grp = c.keys.groupId;
  // Stop at what exists now, so constant local writes cannot keep this loop from reaching the pull.
  const target = s.seq();
  for (; ;) {
    signal.throwIfAborted();
    const generation = get(s, t, "generation")!;
    let chunk = pending(s, grp);
    if (chunk && chunk.generation !== generation) { s.db.run("delete from relay_pending where grp = ?", [grp]); chunk = null; }
    if (!chunk) {
      const pushed = num(s, t, "pushed");
      if (pushed > s.seq()) { put(s, t, "phase", "read"); throw new RelayError("Local history moved backwards; reconciling with the relay"); }
      if (pushed >= target) return;
      const snapshot = s.changes(pushed);
      if (snapshot.seq === pushed) return;
      const before = identity(s, t);
      const entries: RelayEnvelope[] = [];
      const counters: [string, number][] = [];
      let bytes = 256 + s.nodeId.length * 6;
      for (const r of snapshot.records) {
        const key = await entryKey(c.keys, r.kind, r.id);
        const pusherSeq = counter(s, grp, generation, s.nodeId, key) + 1;
        const { seq: _, ...plain } = r;
        const blob = await seal(c.keys, { groupId: grp, generation, node: s.nodeId, key, pusherSeq }, JSON.stringify({ protocol: SYNC_PROTOCOL, record: plain }));
        if (Math.floor(blob.length * 3 / 4) > RELAY_LIMITS.blobBytes) {
          if (entries.length) break; // send what fits; the next chunk starts with this record and stops there
          throw new RelayError(`${r.kind} ${r.id} is larger than the relay's 1 MiB record limit; uploads are blocked until it shrinks`, 0, "oversize");
        }
        const length = JSON.stringify({ key, pusherSeq, blob }).length + 1;
        if (entries.length && (entries.length === RELAY_LIMITS.pushEntries || bytes + length > RELAY_LIMITS.messageBytes)) break;
        entries.push({ key, pusherSeq, blob }); counters.push([key, pusherSeq]); bytes += length;
      }
      const checkpoint = entries.length === snapshot.records.length ? snapshot.seq : snapshot.records[entries.length - 1]!.seq!;
      const body = JSON.stringify({ protocol: RELAY_PROTOCOL, generation, node: s.nodeId, entries });
      s.transaction(() => {
        if (identity(s, t) !== before) throw new RelayError("relay configuration changed");
        for (const [key, value] of counters) setCounter(s, grp, generation, s.nodeId, key, value);
        s.db.run("insert or replace into relay_pending values (?, ?, ?, ?)", [grp, generation, checkpoint, body]);
      });
      chunk = { generation, checkpoint, body };
    }
    const sent = identity(s, t);
    try { await call(c, "POST", "/push", chunk.body, signal); }
    catch (e) {
      // A counter this node no longer knows about is on the relay (e.g. after a restore): re-read first.
      if (e instanceof RelayError && e.code === "counter") s.transaction(() => { s.db.run("delete from relay_pending where grp = ?", [grp]); put(s, t, "phase", "read"); });
      throw e;
    }
    s.transaction(() => {
      if (identity(s, t) !== sent || pending(s, grp)?.body !== chunk!.body) throw new RelayError("relay configuration changed");
      put(s, t, "pushed", chunk!.checkpoint);
      s.db.run("delete from relay_pending where grp = ?", [grp]);
    });
  }
}

/**
 * Full reconciliation: read every entry (this node's included) to recover newer records and
 * counters, then upload the whole store. Runs on startup, join, rotation and after any reset,
 * because a restored database restores its own checkpoints too.
 */
async function reconcile(s: Store, t: Target, c: Conn, signal: AbortSignal, budget = 200) {
  if (get(s, t, "phase") !== "upload") {
    const { json } = await call(c, "POST", "", { protocol: RELAY_PROTOCOL }, signal);
    const state = groupState.parse(json);
    if (state.generation !== get(s, t, "generation")) s.transaction(() => {
      put(s, t, "generation", state.generation);
      for (const f of ["pushed", "cursor", "readCursor"] as const) put(s, t, f, 0);
      s.db.run("delete from relay_pending where grp = ?", [c.keys.groupId]);
    });
    if (!num(s, t, "readCursor")) put(s, t, "skipped", undefined); // a full re-read retries skipped entries
    for (let more = true; more;) {
      if (budget-- <= 0) return false;
      more = await pullPage(s, t, c, signal, true);
    }
    s.transaction(() => {
      // Pending chunks predate the recovered counters; the full upload below supersedes them.
      s.db.run("delete from relay_pending where grp = ?", [c.keys.groupId]);
      put(s, t, "cursor", num(s, t, "readCursor"));
      put(s, t, "pushed", 0);
      put(s, t, "phase", "upload");
    });
  }
  await pushLoop(s, t, c, signal);
  s.transaction(() => { put(s, t, "phase", "done"); put(s, t, "pushError", undefined); });
  return true;
}

function backoff(r: Runtime, slot: string, e: unknown) {
  const b = r.backoff.get(slot) ?? { until: 0, failures: 0 };
  b.failures++;
  const base = e instanceof RelayError && e.retryAfter ? e.retryAfter * 1000 : Math.min(15_000 * 2 ** (b.failures - 1), 10 * 60_000);
  b.until = Date.now() + base * (0.75 + Math.random() * 0.5);
  r.backoff.set(slot, b);
}
const ready = (r: Runtime, slot: string, force: boolean) => force || (r.backoff.get(slot)?.until ?? 0) <= Date.now();
const succeeded = (r: Runtime, slot: string) => r.backoff.delete(slot);
const message = (e: unknown) => e instanceof RelayError || e instanceof RelayBusy ? e.message : "Relay sync failed";

/** Reconcile if needed, then push and pull independently. Errors are kept per direction. */
async function syncTarget(s: Store, t: Target, signal: AbortSignal, want: { push: boolean; pull: boolean; force: boolean }) {
  const r = rt(s);
  const invite = get(s, t, "invite");
  if (!invite) return;
  const c = await conn(s, invite);
  // A new process (or configuration) always re-reads everything before uploading: a restored
  // database cannot be detected by comparing values stored inside it.
  if (!r.started.has(`${t}|${invite}`)) {
    s.transaction(() => { put(s, t, "phase", "read"); put(s, t, "readCursor", 0); });
    r.started.add(`${t}|${invite}`);
  }
  const slot = (d: string) => `${t}|${d}`;
  if (get(s, t, "phase") !== "done" && ready(r, slot("reconcile"), want.force)) {
    try { if (await reconcile(s, t, c, signal)) succeeded(r, slot("reconcile")); }
    catch (e) {
      if (signal.aborted) throw e;
      backoff(r, slot("reconcile"), e);
      if (isReset(e)) resetTarget(s, t, c.keys.groupId);
      put(s, t, get(s, t, "phase") === "upload" ? "pushError" : "pullError", message(e));
    }
  }
  if (want.push && get(s, t, "phase") === "done" && ready(r, slot("push"), want.force)) {
    try { await pushLoop(s, t, c, signal); put(s, t, "pushError", undefined); succeeded(r, slot("push")); }
    catch (e) {
      if (signal.aborted) throw e;
      backoff(r, slot("push"), e);
      if (isReset(e)) resetTarget(s, t, c.keys.groupId);
      put(s, t, "pushError", message(e));
    }
  }
  // Pulls continue while an upload is blocked, so newer credentials still arrive.
  if (want.pull && get(s, t, "phase") !== "read" && get(s, t, "generation") && ready(r, slot("pull"), want.force)) {
    try {
      for (let pages = 0, more = true; more && pages < 20; pages++) more = await pullPage(s, t, c, signal, false);
      succeeded(r, slot("pull"));
    } catch (e) {
      if (signal.aborted) throw e;
      backoff(r, slot("pull"), e);
      if (isReset(e)) resetTarget(s, t, c.keys.groupId);
      put(s, t, "pullError", message(e));
    }
  }
}

async function runCleanups(s: Store, signal: AbortSignal, force = false) {
  // A group rejoined after its wipe was queued is in use again: drop the job instead of deleting it.
  const live = [get(s, "active", "invite"), get(s, "rot", "invite")];
  if (cleanups(s).some((j) => live.includes(j.invite))) setCleanups(s, cleanups(s).filter((j) => !live.includes(j.invite)));
  for (const job of cleanups(s)) {
    if (!force && job.nextAt > s.now()) continue;
    let done = false;
    try { await call(await conn(s, job.invite, job.serviceKey), "DELETE", "", undefined, signal); done = true; }
    catch (e) { if (signal.aborted) throw e; done = e instanceof RelayError && e.status === 404; }
    s.transaction(() => {
      const list = cleanups(s);
      const i = list.findIndex((j) => j.invite === job.invite);
      if (i < 0) return;
      if (done) list.splice(i, 1);
      else { list[i]!.attempts++; list[i]!.nextAt = s.now() + Math.min(60_000 * 2 ** list[i]!.attempts, 6 * 3_600_000); }
      setCleanups(s, list);
    });
  }
}

/** Seed the replacement group, then switch to it in one transaction. Resumable after a crash. */
async function rotationStep(s: Store, signal: AbortSignal, force = false) {
  const rotation = s.local("relay:rotation");
  if (!rotation) return;
  const newInvite = (JSON.parse(rotation) as { invite: string }).invite;
  if (get(s, "rot", "invite") !== newInvite) put(s, "rot", "invite", newInvite);
  await syncTarget(s, "rot", signal, { push: false, pull: false, force });
  if (get(s, "rot", "phase") !== "done") throw new RelayError(get(s, "rot", "pushError") ?? get(s, "rot", "pullError") ?? "The new relay group is not ready yet");
  const active = get(s, "active", "invite");
  const oldGroup = active ? (await conn(s, active)).keys.groupId : undefined;
  s.transaction(() => {
    const old = get(s, "active", "invite");
    for (const f of FIELDS) { put(s, "active", f, get(s, "rot", f)); put(s, "rot", f, undefined); }
    s.setLocal("relay:rotation", undefined);
    if (old) setCleanups(s, [...cleanups(s).filter((j) => j.invite !== old), { invite: old, serviceKey: serviceKey(s), attempts: 0, nextAt: 0 }]);
    clearSeen(s);
    if (oldGroup) dropGroup(s, oldGroup);
  });
  rt(s).started.add(`active|${newInvite}`); // seeded by a full reconciliation just now
}

function clearSeen(s: Store) {
  for (const row of s.db.query("select key from local where key like 'relaySeen:%'").all() as { key: string }[]) s.setLocal(row.key, undefined);
}

// ---------------------------------------------------------------- public operations

/**
 * The relay half of a sync turn. Concurrent callers coalesce into at most one queued run. In the
 * daemon `wait` is 0: if a CLI command holds the lease, this turn is skipped.
 */
export function relaySync(s: Store, want: { push?: boolean; pull?: boolean; force?: boolean } = {}): Promise<void> {
  const r = rt(s);
  const w = { push: want.push ?? true, pull: want.pull ?? true, force: !!want.force };
  r.wanted = r.wanted ? { push: r.wanted.push || w.push, pull: r.wanted.pull || w.pull, force: r.wanted.force || w.force } : w;
  if (r.running) return r.running;
  r.running = (async () => {
    while (r.wanted && !r.abort.signal.aborted) {
      const run = r.wanted; r.wanted = undefined;
      if (!s.local("relay:invite") && !s.local("relay:cleanup") && !s.local("relay:rotation")) continue;
      await withRelay(s, async (signal) => {
        try { await rotationStep(s, signal, run.force); } catch (e) { if (signal.aborted) throw e; }
        await syncTarget(s, "active", signal, run);
        await runCleanups(s, signal);
      }, 0).catch((e) => { if (!(e instanceof RelayBusy) && !r.abort.signal.aborted) console.error(`relay: ${message(e)}`); });
    }
  })().finally(() => { r.running = undefined; });
  return r.running;
}

/** Tailscale pulls and the relay, with independent errors. Used for credential recovery too. */
export async function syncAll(s: Store): Promise<string[]> {
  const [tailnet, relay] = await Promise.allSettled([pullAll(s), relaySync(s, { push: false })]);
  const errors = tailnet.status === "fulfilled" ? tailnet.value : [String(tailnet.reason)];
  if (relay.status === "rejected") errors.push(message(relay.reason));
  const pullError = get(s, "active", "pullError");
  if (pullError) errors.push(pullError);
  return errors;
}

/** `pair --relay`: create a group on first use, or return the existing invite. */
export function createRelay(s: Store, url?: string): Promise<string> {
  return withRelay(s, async (signal) => {
    const existing = get(s, "active", "invite");
    if (existing) return existing;
    const invite = makeInvite(url ?? relayUrlDefault());
    s.transaction(() => { for (const f of FIELDS) put(s, "active", f, undefined); put(s, "active", "invite", invite); put(s, "active", "phase", "read"); });
    const c = await conn(s, invite);
    try { await call(c, "POST", "", { protocol: RELAY_PROTOCOL }, signal); }
    catch (e) { s.transaction(() => { for (const f of FIELDS) put(s, "active", f, undefined); }); throw e; }
    rt(s).started.add(`active|${invite}`);
    try { await reconcile(s, "active", c, signal); }
    catch (e) { if (signal.aborted) throw e; put(s, "active", "pushError", message(e)); }
    return invite;
  });
}

/** `join agr1.…`: refuse a name already in the group, then reconcile fully. */
export function joinRelay(s: Store, text: string, force = false): Promise<{ node: string }> {
  const invite = parseInvite(text);
  return withRelay(s, async (signal) => {
    const existing = get(s, "active", "invite");
    if (existing === invite.text) return { node: s.nodeId };
    if (existing) throw new RelayError("This machine already uses a relay. Run `agentgate relay leave` first.");
    const c = await conn(s, invite.text);
    try {
      const { json } = await call(c, "GET", "/nodes", undefined, signal);
      if (!force && nodesResponse.parse(json).nodes.some((n) => n.node === s.nodeId))
        throw new RelayError(`A machine named ${s.nodeId} already uses this relay. Rename this machine (\`agentgate init --name <other>\`), or pass --force if it is this same machine rejoining.`);
    } catch (e) { if (!(e instanceof RelayError && e.status === 404)) throw e; }
    s.transaction(() => { for (const f of FIELDS) put(s, "active", f, undefined); put(s, "active", "invite", invite.text); put(s, "active", "phase", "read"); });
    rt(s).started.add(`active|${invite.text}`);
    try { await reconcile(s, "active", c, signal); }
    catch (e) { if (signal.aborted) throw e; put(s, "active", "pushError", message(e)); throw e; }
    return { node: s.nodeId };
  });
}

/** Full read and upload now; also retries entries that were skipped. */
export function reconcileRelay(s: Store): Promise<void> {
  return withRelay(s, async (signal) => {
    const invite = get(s, "active", "invite");
    if (!invite) throw new RelayError("This machine does not use a relay");
    s.transaction(() => { put(s, "active", "phase", "read"); put(s, "active", "readCursor", 0); });
    rt(s).started.add(`active|${invite}`);
    while (!(await reconcile(s, "active", await conn(s, invite), signal)));
  });
}

/**
 * Rotation: seed a new group, switch, then delete the old group as cleanup. A repeated call or a
 * restart resumes the pending rotation rather than generating another invite.
 */
export function rotateRelay(s: Store): Promise<{ command: string; cleanupPending: boolean }> {
  return withRelay(s, async (signal) => {
    const active = get(s, "active", "invite");
    if (!s.local("relay:rotation")) {
      if (!active) throw new RelayError("This machine does not use a relay");
      const invite = makeInvite(parseInvite(active).url);
      s.transaction(() => {
        for (const f of FIELDS) put(s, "rot", f, undefined);
        put(s, "rot", "invite", invite); put(s, "rot", "phase", "read");
        s.setLocal("relay:rotation", JSON.stringify({ invite, startedAt: s.now() }));
      });
    }
    await rotationStep(s, signal, true);
    await runCleanups(s, signal, true);
    return { command: `agentgate join ${get(s, "active", "invite")}`, cleanupPending: cleanups(s).length > 0 };
  });
}

/** Stop using the relay here. `wipe` queues deletion of the group; a failure never re-enables sync. */
export function leaveRelay(s: Store, wipe = false): Promise<{ cleanupPending: boolean }> {
  return withRelay(s, async (signal) => {
    const groups = await Promise.all((["active", "rot"] as const).map((t) => get(s, t, "invite")).filter(Boolean).map(async (i) => ({ invite: i!, grp: (await conn(s, i!)).keys.groupId })));
    s.transaction(() => {
      if (wipe) setCleanups(s, [...cleanups(s).filter((j) => !groups.some((g) => g.invite === j.invite)), ...groups.map((g) => ({ invite: g.invite, serviceKey: serviceKey(s), attempts: 0, nextAt: 0 }))]);
      for (const t of ["active", "rot"] as const) for (const f of FIELDS) put(s, t, f, undefined);
      s.setLocal("relay:rotation", undefined);
      for (const g of groups) dropGroup(s, g.grp);
      clearSeen(s);
    });
    if (wipe) await runCleanups(s, signal, true);
    return { cleanupPending: cleanups(s).length > 0 };
  });
}

export function cleanupRelay(s: Store, abandon: boolean): Promise<{ cleanupPending: boolean }> {
  return withRelay(s, async (signal) => {
    if (abandon) setCleanups(s, []);
    else await runCleanups(s, signal, true);
    return { cleanupPending: cleanups(s).length > 0 };
  });
}

export function setServiceKey(s: Store, key: string | undefined) {
  s.setLocal("relay:serviceKey", key || undefined);
}

export const relayInvite = (s: Store) => get(s, "active", "invite");
export const usesRelay = (s: Store) => !!get(s, "active", "invite") || !!s.local("relay:rotation");

/** Sanitized status: never the invite, the service key or a raw relay response. */
export function relayStatus(s: Store) {
  const invite = get(s, "active", "invite");
  if (!invite && !s.local("relay:cleanup")) return undefined;
  let url = "";
  try { url = invite ? parseInvite(invite).url : ""; } catch { }
  const skipped = get(s, "active", "skipped");
  return {
    url,
    hosted: !!url && url === DEFAULT_RELAY_URL,
    generation: get(s, "active", "generation"),
    cursor: num(s, "active", "cursor"),
    pushed: num(s, "active", "pushed"),
    reconciling: !!invite && get(s, "active", "phase") !== "done",
    rotating: !!s.local("relay:rotation"),
    cleanupPending: cleanups(s).length > 0,
    pushError: get(s, "active", "pushError"),
    pullError: get(s, "active", "pullError"),
    skipped: skipped ? (JSON.parse(skipped) as { count: number }).count : undefined,
  };
}

/** Observed paths to a node, not proof of membership. */
export function via(s: Store, node: string): ("tailnet" | "relay")[] {
  const out: ("tailnet" | "relay")[] = [];
  if (peers(s).some((p) => p.node === node)) out.push("tailnet");
  if (s.local(`relaySeen:${node}`)) out.push("relay");
  return out;
}

/** Nodes seen through the relay; used to tell relay unpairs from Tailscale ones. */
export const relayNodes = (s: Store) =>
  (s.db.query("select key, value from local where key like 'relaySeen:%'").all() as { key: string; value: string }[]).map((r) => ({ node: r.key.slice(10), lastSeen: Number(r.value) }));

/** The name a pairing command gives the other machine: shell-safe, and not an existing node's (two machines would share records). */
export function newNodeName(s: Store, name: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new RelayError("Use lowercase letters, digits and dashes for the machine name");
  if (s.get("node", name)) throw new RelayError(`A machine named ${name} already exists`);
  return name;
}

/** One line for a fresh machine: install.sh installs agentgate, then runs init (named `name`, else the hostname), `join <args>`, the service and `setup --primary`. */
export const installAndJoin = (args: string, name?: string) =>
  `curl -fsSL https://raw.githubusercontent.com/HansKristoffer/agentgate/main/install.sh | ${name ? `AGENTGATE_NAME=${name} ` : ""}sh -s -- join ${args}`;

/**
 * Parse a pasted `agentgate join …` or `installAndJoin` line into either pairing method. Tokens are
 * matched directly, never run through a shell, and errors never echo the input (it may hold an invite).
 */
export function parseJoin(text: string): { invite: string; force: boolean } | { url: string; code: string } {
  if (text.length > 4096) throw new RelayError("That pairing command is too long");
  const all = text.trim().split(/\s+/).filter(Boolean), at = all.indexOf("join");
  const tokens = at < 0 ? all : all.slice(at + 1);
  const force = tokens.includes("--force");
  const rest = tokens.filter((t) => t !== "--force");
  if (rest.length === 1 && rest[0]!.startsWith("agr1.")) return { invite: parseInvite(rest[0]!).text, force };
  if (rest.length === 2 && !force && /^[a-z]+(-[a-z]+){6}$/.test(rest[1]!)) {
    let u: URL | undefined;
    try { u = new URL(rest[0]!); } catch { }
    if (u && (u.protocol === "http:" || u.protocol === "https:")) return { url: rest[0]!, code: rest[1]! };
  }
  throw new RelayError("Paste the whole `agentgate join …` command from the other machine");
}
