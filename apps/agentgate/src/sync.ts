import { Hono } from "hono";
import { recordFromKeys, trimTrailingSlash } from "hanzio";
import { safeEqual } from "hanzio/crypto";
import { z } from "zod";
import { PEER_TOPICS, type Changes, type PeerTopic } from "./changes.ts";
import { defineLocal } from "./local-state.ts";
import { MAX_BODY, fetchHeaders, readBody } from "./runtime.ts";
import { parseEnvelope, PORT, type Rec, type Store } from "./store.ts";

export const PULL_INTERVAL = 15_000;
// 4: byte-bounded pages with explicit continuation, plus validated skill bundles.
export const SYNC_PROTOCOL = 5;
// An origin only: a path or query would let a caller aim `${url}/peer/…` at any route, e.g. this daemon's own API.
const peerUrl = z.string().refine((v) => {
  try {
    const u = new URL(v);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === "/"
    );
  } catch {
    return false;
  }
}, "peer URL must be an HTTP or HTTPS origin, without a path or query");
const joinInput = z.object({
  code: z.string().min(1),
  node: z.string().min(1).max(512),
  url: peerUrl,
  protocol: z.literal(SYNC_PROTOCOL),
});
const batchSchema = z.object({
  protocol: z.literal(SYNC_PROTOCOL),
  records: z.array(z.unknown()).max(100000),
  seq: z.number().int().nonnegative(),
  more: z.boolean().default(false),
  seen: z
    .record(z.string().max(512), z.number().int().nonnegative())
    .refine((seen) => Object.keys(seen).length <= 1000)
    .default({}),
});
// Shown per peer in `/status`; a pull that fails the same way again changes nothing.
const syncError = defineLocal("syncError:", z.string(), { topic: "status" });
const pairUsed = defineLocal("pair:used", z.object({ code: z.string(), node: z.string(), expires: z.number() }));
interface PeerPull {
  work: Promise<number>;
  again: boolean;
}
const pulls = new WeakMap<Store, Map<string, PeerPull>>();
const CODE_TTL = 10 * 60_000;
const WORDS =
  "amber anchor apple arrow basil beacon birch bison cable canyon cedar cobalt comet coral delta dune ember falcon fern fjord flint gecko glacier harbor hazel heron indigo ivory jasper juniper kelp lagoon lantern lemon lilac lotus maple meadow mesa nectar nimbus oak onyx orbit otter pebble pine plume quartz raven reef saffron sequoia sierra slate sparrow spruce tango thistle tundra velvet walnut willow zephyr".split(
    " ",
  );

export interface Peer {
  node: string;
  url: string;
  token: string;
  cursor: number;
  last_seen: number | null;
}

export const peers = (s: Store) => s.db.query<Peer, []>("select * from peers").all();

const randomToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

/** `agentgate pair`: a one-time 7-word code, stored locally so the daemon can check it. */
export function pairCode(s: Store): string {
  const pick = () => WORDS[crypto.getRandomValues(new Uint32Array(1))[0]! % WORDS.length];
  const code = Array.from({ length: 7 }, pick).join("-");
  s.setLocal("pair:code", code);
  s.setLocal("pair:expires", String(s.now() + CODE_TTL));
  return code;
}

/** `agentgate join <url> <code>` on node B. */
export async function join(s: Store, url: string, code: string, selfUrl: string) {
  url = trimTrailingSlash(url);
  peerUrl.parse(url);
  peerUrl.parse(selfUrl);
  const res = await fetchHeaders(`${url}/peer/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, node: s.nodeId, url: selfUrl, protocol: SYNC_PROTOCOL }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`join failed: ${res.status}`);
  }
  const response = JSON.parse(
    new TextDecoder().decode(await readBody(res.body, 1024 * 1024, AbortSignal.timeout(10000))),
  );
  const { node, token } = z
    .object({ node: z.string().min(1), token: z.string().min(32), protocol: z.literal(SYNC_PROTOCOL) })
    .parse(response);
  s.db.run("insert or replace into peers values (?, ?, ?, 0, ?)", [node, url, token, s.now()]);
  await pullPeer(
    s,
    peers(s).find((p) => p.node === node)!,
  );
  return node;
}

/** A node that slept or could not sync for a while holds no fresh news of the others: a holder it has not heard from
 * may well be alive, with tokens newer than its own. Every pull that gets an answer marks a round, and pulls run every
 * PULL_INTERVAL, so a gap between rounds means it was not listening. A failed pull is no round: an awake node whose
 * relay or peers do not answer hears no more than a sleeping one. */
const ROUND_GAP = 60_000;
export function noteSyncRound(s: Store) {
  const last = Number(s.local("sync:round") ?? 0);
  if (s.now() - last > ROUND_GAP) s.setLocal("sync:listeningSince", String(s.now()));
  s.setLocal("sync:round", String(s.now()));
}
/** How long this node has been syncing without a gap; 0 when it is not syncing now. */
export function listeningFor(s: Store): number {
  if (s.now() - Number(s.local("sync:round") ?? 0) > ROUND_GAP) return 0;
  return s.now() - Number(s.local("sync:listeningSince") ?? s.now());
}

/** How long this daemon has been running without a gap, from its sync turns, answered or not: a machine back from
 * sleep or a daemon just started reads 0. */
export function noteSyncTurn(s: Store) {
  if (s.now() - Number(s.local("sync:turn") ?? 0) > ROUND_GAP) s.setLocal("sync:awakeSince", String(s.now()));
  s.setLocal("sync:turn", String(s.now()));
}
export function awakeFor(s: Store): number {
  if (s.now() - Number(s.local("sync:turn") ?? 0) > ROUND_GAP) return 0;
  return s.now() - Number(s.local("sync:awakeSince") ?? s.now());
}

export function lastSeen(s: Store, node: string): number {
  if (node === s.nodeId) return s.now();
  const direct = peers(s).find((p) => p.node === node)?.last_seen ?? 0;
  return Math.max(direct, Number(s.local(`seen:${node}`) ?? 0));
}

/** Pulls from `p` now. A call while that peer's pull runs asks for one more after it, since the poke that caused it may
 * announce a change the running pull read past; the promise settles once that one is done too. */
export function pullPeer(s: Store, p: Peer): Promise<number> {
  let pending = pulls.get(s);
  if (!pending) pulls.set(s, (pending = new Map()));
  const current = pending.get(p.node);
  if (current) {
    current.again = true;
    return current.work;
  }
  const entry: PeerPull = { again: false, work: Promise.resolve(0) };
  entry.work = (async () => {
    let total = 0;
    let peer: Peer | undefined = p;
    try {
      do {
        entry.again = false;
        total += await doPull(s, peer);
        // The row as it is now: the peer may have been re-paired or removed meanwhile.
        peer = entry.again ? peers(s).find((x) => x.node === p.node) : undefined;
      } while (peer);
    } finally {
      // In the same step as the last check of `again`: a promise's .finally() runs later, and a call in between
      // would set `again` on a pull that has already stopped.
      pending.delete(p.node);
    }
    return total;
  })();
  pending.set(p.node, entry);
  return entry.work;
}

async function doPull(s: Store, requested: Peer): Promise<number> {
  let total = 0;
  const signal = AbortSignal.timeout(30_000);
  // Bound each invocation; the next scheduled pull resumes from the committed page cursor.
  for (let page = 0; page < 16; page++) {
    const p = peers(s).find((peer) => peer.node === requested.node);
    if (!p || p.token !== requested.token || p.url !== requested.url) return total;
    const res = await fetchHeaders(`${p.url}/peer/changes?since=${p.cursor}`, {
      headers: { authorization: `Bearer ${p.token}` },
      signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`pull ${p.node}: ${res.status}`);
    }
    const body = batchSchema.parse(
      JSON.parse(new TextDecoder().decode(await readBody(res.body, 16 * 1024 * 1024, signal))),
    );
    // Only the envelope here: `merge` parses a record's data once it knows the record wins.
    const records: Rec[] = body.records.map(parseEnvelope);
    if (
      records.some(
        (r, index) => r.seq === undefined || r.seq > body.seq || r.seq <= (index ? records[index - 1]!.seq! : p.cursor),
      ) ||
      (body.more && (!records.length || body.seq !== records.at(-1)!.seq))
    )
      throw new Error(`pull ${p.node}: invalid change-feed sequence`);
    let validPeer = true;
    total += s.transaction(() => {
      const current = peers(s).find((peer) => peer.node === p.node);
      if (!current || current.token !== p.token || current.url !== p.url || current.cursor !== p.cursor) {
        validPeer = false;
        return 0;
      }
      let taken = 0;
      for (const r of records) if (s.merge(r)) taken++;
      // A peer that rolled its db back (seq < cursor) is re-read from the start next time.
      const cursor = body.seq < p.cursor ? 0 : body.seq;
      s.db.run("update peers set cursor = ?, last_seen = ? where node = ?", [cursor, s.now(), p.node]);
      // Heartbeats heard second-hand, so a node that is paired only through a middle node is not seen as offline.
      for (const [node, at] of Object.entries(body.seen ?? {}))
        if (node !== s.nodeId && at > lastSeen(s, node)) s.setLocal(`seen:${node}`, String(Math.min(at, s.now())));
      syncError.set(s, p.node, undefined);
      noteSyncRound(s);
      return taken;
    });
    if (!validPeer || !body.more || body.seq < p.cursor) return total;
  }
  return total;
}

export async function drainPulls(s: Store) {
  await Promise.allSettled([...(pulls.get(s)?.values() ?? [])].map((p) => p.work));
}

const pullRecordingErrors = (s: Store, p: Peer) =>
  pullPeer(s, p).catch((e) => {
    syncError.set(s, p.node, String(e));
    throw e;
  });

/** Every peer's pull, awaited; errors per peer. */
export async function pullAll(s: Store) {
  const results = await Promise.allSettled(peers(s).map((p) => pullRecordingErrors(s, p)));
  return results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason));
}

/** The daemon's scheduled round: starts a pull from each peer that has none running, and waits for none of them, so a
 * peer whose connection hangs holds back neither the others nor their next round. */
export function startPulls(s: Store) {
  const running = pulls.get(s);
  for (const p of peers(s)) if (!running?.has(p.node)) void pullRecordingErrors(s, p).catch(() => {});
}

export function poke(s: Store) {
  for (const p of peers(s))
    fetch(`${p.url}/peer/poke`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.token}` },
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
}

const TOPICS_WAIT = 25_000;
const topicsAnswer = z.object({
  token: z.string().max(200),
  versions: z.object(recordFromKeys(PEER_TOPICS, () => z.number())),
});

/** While an app waits on this daemon's `/api/changes`, one long-poll to each peer seen in the last minute turns a
 * change to that peer's factory or threads into a local one, so the app shows it within a second. With no app open
 * nothing runs; after the last app leaves, each poll ends with its peer's next answer. Relay-only machines have no
 * such feed; the app's slower board poll covers them. */
export function followPeers(
  s: Store,
  changes: Changes,
  signal: AbortSignal,
  onMove: (node: string, topic: PeerTopic) => void,
) {
  const running = new Set<string>();
  const retryAt = new Map<string, number>();
  // Each peer's last answer, kept between runs, so a change made while no app waited still shows when one returns.
  const known = new Map<string, z.infer<typeof topicsAnswer>>();

  const follow = async (node: string) => {
    try {
      while (changes.appWaiting && !signal.aborted) {
        // The row as it is now: the peer may have been re-paired or removed meanwhile.
        const p = peers(s).find((x) => x.node === node);
        if (!p) return;
        const last = known.get(node);
        const query = last ? `?after=${encodeURIComponent(last.token)}&wait=${TOPICS_WAIT / 1000}` : "";
        const deadline = AbortSignal.any([AbortSignal.timeout(TOPICS_WAIT + 10_000), signal]);
        const res = await fetchHeaders(
          `${p.url}/peer/topics${query}`,
          { headers: { authorization: `Bearer ${p.token}` }, signal: deadline },
          TOPICS_WAIT + 10_000,
        );
        if (res.status === 404) {
          // A release without the feed: ask again later, in case it updated.
          await res.body?.cancel();
          retryAt.set(node, s.now() + 10 * 60_000);
          return;
        }
        if (!res.ok) {
          await res.body?.cancel();
          throw new Error(`topics ${node}: ${res.status}`);
        }
        const body = await readBody(res.body, 64 * 1024, deadline);
        const next = topicsAnswer.parse(JSON.parse(new TextDecoder().decode(body)));
        if (last)
          for (const topic of PEER_TOPICS) if (next.versions[topic] !== last.versions[topic]) onMove(node, topic);
        known.set(node, next);
      }
    } catch {
      if (!signal.aborted) retryAt.set(node, s.now() + PULL_INTERVAL);
    }
  };

  changes.onAppWaiting = () => {
    for (const p of peers(s)) {
      if (running.has(p.node) || s.now() < (retryAt.get(p.node) ?? 0)) continue;
      if (s.now() - lastSeen(s, p.node) > ROUND_GAP) continue;
      running.add(p.node);
      void follow(p.node).finally(() => running.delete(p.node));
    }
  };
}

/** Routes served on the tailnet listener. `changes` serves `/topics`, which daemons follow with followPeers. */
export function peerRoutes(
  s: Store,
  onPoke: (p: Peer) => void = (p) => pullPeer(s, p).catch(() => {}),
  changes?: Changes,
) {
  const app = new Hono<{ Variables: { peer: Peer } }>();

  app.post("/join", async (c) => {
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(await readBody(c.req.raw.body, MAX_BODY, c.req.raw.signal)));
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const parsed = joinInput.safeParse(body);
    if (!parsed.success)
      return c.json({ error: "invalid pairing request; both nodes must use the current agentgate sync protocol" }, 400);
    const { code, node, url } = parsed.data;
    // A joiner whose answer was lost retries with the same code. Until the code would have expired, the node that used
    // it, from the same URL, gets its token again; anyone else is refused as before.
    const used = pairUsed.get(s);
    if (used && safeEqual(used.code, code) && s.now() <= used.expires) {
      const peer = peers(s).find((p) => p.node === node && p.url === url);
      if (used.node !== node || !peer) return c.json({ error: "bad or expired code" }, 403);
      return c.json({ node: s.nodeId, token: peer.token, protocol: SYNC_PROTOCOL });
    }
    const expected = s.local("pair:code");
    if (!expected || code !== expected || s.now() > Number(s.local("pair:expires") ?? 0))
      return c.json({ error: "bad or expired code" }, 403);
    if (node === s.nodeId) return c.json({ error: "node name clashes with this node; run init --name" }, 409);
    if (peers(s).some((p) => p.node === node))
      return c.json({ error: "node is already paired; unpair it before pairing again" }, 409);
    const token = randomToken();
    s.transaction(() => {
      s.setLocal("pair:code", undefined);
      pairUsed.set(s, undefined, { code, node, expires: Number(s.local("pair:expires") ?? 0) });
      s.db.run("insert or replace into peers values (?, ?, ?, 0, ?)", [node, url, token, s.now()]);
    });
    return c.json({ node: s.nodeId, token, protocol: SYNC_PROTOCOL });
  });

  app.use("*", async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer /, "");
    const peer = token ? peers(s).find((p) => safeEqual(p.token, token)) : undefined;
    if (!token || !peer) return c.json({ error: "unauthorized" }, 401);
    c.set("peer", peer);
    await next();
  });

  app.get("/changes", (c) => {
    const cursor = z.coerce
      .number()
      .int()
      .nonnegative()
      .safeParse(c.req.query("since") ?? 0);
    if (!cursor.success) return c.json({ error: "invalid cursor" }, 400);
    const seen: Record<string, number> = { [s.nodeId]: s.now() };
    for (const p of peers(s)) if (p.last_seen) seen[p.node] = p.last_seen;
    for (const [key, value] of s.localPrefixed("seen:")) seen[key.slice(5)] = Math.min(Number(value), s.now());
    return c.json({
      protocol: SYNC_PROTOCOL,
      ...s.changePage(cursor.data),
      seen: Object.fromEntries(Object.entries(seen).slice(0, 1000)),
    });
  });

  if (changes)
    app.get("/topics", async (c) => {
      const wait = Math.min(TOPICS_WAIT, Math.max(0, Number(c.req.query("wait") ?? 0) * 1000 || 0));
      await changes.waitPeer(c.req.query("after"), wait, c.req.raw.signal);
      return c.json(changes.peerSnapshot());
    });

  app.post("/poke", (c) => {
    onPoke(c.get("peer"));
    return c.json({ ok: true });
  });

  return app;
}

export function unpair(s: Store, node: string) {
  s.db.run("delete from peers where node = ?", [node]);
  s.setLocal(`seen:${node}`, undefined);
  syncError.set(s, node, undefined);
}

/** The tailnet address this node listens on, from the Tailscale CLI. */
export async function tailscale(): Promise<{ ip: string; url: string } | undefined> {
  const bin = Bun.which("tailscale") ?? "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  try {
    const child = Bun.spawn([bin, "status", "--json"], { stdout: "pipe", stderr: "ignore" });
    const timeout = setTimeout(() => child.kill(), 5000);
    let out;
    try {
      const text = await new Response(child.stdout).text();
      if ((await child.exited) !== 0) return undefined;
      out = JSON.parse(text);
    } finally {
      clearTimeout(timeout);
    }
    const ip = (out.Self?.TailscaleIPs as string[] | undefined)?.find((a) => a.includes("."));
    if (!ip) return undefined;
    const host = (out.Self?.DNSName as string | undefined)?.replace(/\.$/, "") || ip;
    return { ip, url: `http://${host}:${PORT}` };
  } catch {
    return undefined;
  }
}
