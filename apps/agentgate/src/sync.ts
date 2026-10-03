import { Hono } from "hono";
import { z } from "zod";
import { fetchHeaders, readBody } from "./runtime.ts";
import { parseRecord, PORT, type Rec, type Store } from "./store.ts";

export const PULL_INTERVAL = 15_000;
// 4: byte-bounded pages with explicit continuation, plus validated skill bundles.
export const SYNC_PROTOCOL = 4;
// An origin only: a path or query would let a caller aim `${url}/peer/…` at any route, e.g. this daemon's own API.
const peerUrl = z.string().refine(v => {
  try {
    const u = new URL(v);
    return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash && u.pathname === "/";
  } catch { return false; }
}, "peer URL must be an HTTP or HTTPS origin, without a path or query");
const joinInput = z.object({ code: z.string().min(1), node: z.string().min(1).max(512), url: peerUrl, protocol: z.literal(SYNC_PROTOCOL) });
const batchSchema = z.object({ protocol: z.literal(SYNC_PROTOCOL), records: z.array(z.unknown()).max(100000), seq: z.number().int().nonnegative(), more: z.boolean().default(false), seen: z.record(z.string().max(512), z.number().int().nonnegative()).refine(seen => Object.keys(seen).length <= 1000).default({}) });
const pulls = new WeakMap<Store, Map<string, Promise<number>>>();
const CODE_TTL = 10 * 60_000;
const WORDS = "amber anchor apple arrow basil beacon birch bison cable canyon cedar cobalt comet coral delta dune ember falcon fern fjord flint gecko glacier harbor hazel heron indigo ivory jasper juniper kelp lagoon lantern lemon lilac lotus maple meadow mesa nectar nimbus oak onyx orbit otter pebble pine plume quartz raven reef saffron sequoia sierra slate sparrow spruce tango thistle tundra velvet walnut willow zephyr".split(" ");

export interface Peer {
  node: string;
  url: string;
  token: string;
  cursor: number;
  last_seen: number | null;
}

export const peers = (s: Store) => s.db.query("select * from peers").all() as Peer[];

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
  url = url.replace(/\/$/, "");
  peerUrl.parse(url); peerUrl.parse(selfUrl);
  const res = await fetchHeaders(`${url}/peer/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, node: s.nodeId, url: selfUrl, protocol: SYNC_PROTOCOL }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`join failed: ${res.status}`); }
  const response = JSON.parse(new TextDecoder().decode(await readBody(res.body, 1024 * 1024, AbortSignal.timeout(10000))));
  const { node, token } = z.object({ node: z.string().min(1), token: z.string().min(32), protocol: z.literal(SYNC_PROTOCOL) }).parse(response);
  s.db.run("insert or replace into peers values (?, ?, ?, 0, ?)", [node, url, token, s.now()]);
  await pullPeer(s, peers(s).find((p) => p.node === node)!);
  return node;
}

export function lastSeen(s: Store, node: string): number {
  if (node === s.nodeId) return s.now();
  const direct = peers(s).find((p) => p.node === node)?.last_seen ?? 0;
  return Math.max(direct, Number(s.local(`seen:${node}`) ?? 0));
}

export async function pullPeer(s: Store, p: Peer): Promise<number> {
  let pending = pulls.get(s);
  if (!pending) pulls.set(s, pending = new Map());
  const existing = pending.get(p.node);
  if (existing) return existing;
  const work = doPull(s, p).finally(() => pending!.delete(p.node));
  pending.set(p.node, work);
  return work;
}

async function doPull(s: Store, requested: Peer): Promise<number> {
  let total = 0;
  const signal = AbortSignal.timeout(30_000);
  // Bound each invocation; the next scheduled pull resumes from the committed page cursor.
  for (let page = 0; page < 16; page++) {
    const p = peers(s).find(peer => peer.node === requested.node);
    if (!p || p.token !== requested.token || p.url !== requested.url) return total;
    const res = await fetchHeaders(`${p.url}/peer/changes?since=${p.cursor}`, {
      headers: { authorization: `Bearer ${p.token}` },
      signal,
    });
    if (!res.ok) { await res.body?.cancel(); throw new Error(`pull ${p.node}: ${res.status}`); }
    const body = batchSchema.parse(JSON.parse(new TextDecoder().decode(await readBody(res.body, 16 * 1024 * 1024, signal))));
    const records: Rec[] = body.records.map(parseRecord);
    if (records.some((r, index) => r.seq === undefined || r.seq > body.seq || r.seq <= (index ? records[index - 1]!.seq! : p.cursor))
      || (body.more && (!records.length || body.seq !== records.at(-1)!.seq))) throw new Error(`pull ${p.node}: invalid change-feed sequence`);
    let validPeer = true;
    total += s.transaction(() => {
      const current = peers(s).find(peer => peer.node === p.node);
      if (!current || current.token !== p.token || current.url !== p.url || current.cursor !== p.cursor) { validPeer = false; return 0; }
      let taken = 0;
      for (const r of records) if (s.merge(r)) taken++;
      // A peer that rolled its db back (seq < cursor) is re-read from the start next time.
      const cursor = body.seq < p.cursor ? 0 : body.seq;
      s.db.run("update peers set cursor = ?, last_seen = ? where node = ?", [cursor, s.now(), p.node]);
      // Heartbeats heard second-hand, so a node that is paired only through a middle node is not seen as offline.
      for (const [node, at] of Object.entries(body.seen ?? {}))
        if (node !== s.nodeId && at > lastSeen(s, node)) s.setLocal(`seen:${node}`, String(Math.min(at, s.now())));
      s.setLocal(`syncError:${p.node}`, undefined);
      return taken;
    });
    if (!validPeer || !body.more || body.seq < p.cursor) return total;
  }
  return total;
}

export async function drainPulls(s: Store) { await Promise.allSettled(pulls.get(s)?.values() ?? []); }

export async function pullAll(s: Store) {
  const results = await Promise.allSettled(peers(s).map((p) => pullPeer(s, p).catch(e => {
    s.setLocal(`syncError:${p.node}`, String(e)); throw e;
  })));
  return results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason));
}

export function poke(s: Store) {
  for (const p of peers(s))
    fetch(`${p.url}/peer/poke`, { method: "POST", headers: { authorization: `Bearer ${p.token}` }, signal: AbortSignal.timeout(5000) }).catch(() => { });
}

/** Routes served on the tailnet listener. */
export function peerRoutes(s: Store, onPoke: (p: Peer) => void = (p) => pullPeer(s, p).catch(() => { })) {
  const app = new Hono<{ Variables: { peer: Peer } }>();

  app.post("/join", async (c) => {
    let body: unknown; try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    const parsed = joinInput.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid pairing request; both nodes must use the current agentgate sync protocol" }, 400);
    const { code, node, url } = parsed.data;
    const expected = s.local("pair:code");
    if (!expected || code !== expected || s.now() > Number(s.local("pair:expires") ?? 0)) return c.json({ error: "bad or expired code" }, 403);
    if (node === s.nodeId) return c.json({ error: "node name clashes with this node; run init --name" }, 409);
    if (peers(s).some(p => p.node === node)) return c.json({ error: "node is already paired; unpair it before pairing again" }, 409);
    const token = randomToken();
    s.transaction(() => {
      s.setLocal("pair:code", undefined);
      s.db.run("insert or replace into peers values (?, ?, ?, 0, ?)", [node, url, token, s.now()]);
    });
    return c.json({ node: s.nodeId, token, protocol: SYNC_PROTOCOL });
  });

  app.use("*", async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer /, "");
    const peer = peers(s).find((p) => p.token === token);
    if (!token || !peer) return c.json({ error: "unauthorized" }, 401);
    c.set("peer", peer);
    await next();
  });

  app.get("/changes", (c) => {
    const cursor = z.coerce.number().int().nonnegative().safeParse(c.req.query("since") ?? 0);
    if (!cursor.success) return c.json({ error: "invalid cursor" }, 400);
    const seen: Record<string, number> = { [s.nodeId]: s.now() };
    for (const p of peers(s)) if (p.last_seen) seen[p.node] = p.last_seen;
    for (const row of s.db.query("select key, value from local where key like 'seen:%'").all() as { key: string; value: string }[]) seen[row.key.slice(5)] = Math.min(Number(row.value), s.now());
    return c.json({ protocol: SYNC_PROTOCOL, ...s.changePage(cursor.data), seen: Object.fromEntries(Object.entries(seen).slice(0, 1000)) });
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
  s.setLocal(`syncError:${node}`, undefined);
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
      if (await child.exited !== 0) return undefined;
      out = JSON.parse(text);
    } finally { clearTimeout(timeout); }
    const ip = (out.Self?.TailscaleIPs as string[] | undefined)?.find((a) => a.includes("."));
    if (!ip) return undefined;
    const host = (out.Self?.DNSName as string | undefined)?.replace(/\.$/, "") || ip;
    return { ip, url: `http://${host}:${PORT}` };
  } catch {
    return undefined;
  }
}
