import { Hono } from "hono";
import { PORT, type Rec, type Store } from "./store.ts";

export const PULL_INTERVAL = 15_000;
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
  const res = await fetch(`${url}/peer/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, node: s.nodeId, url: selfUrl }),
  });
  if (!res.ok) throw new Error(`join failed: ${res.status} ${await res.text()}`);
  const { node, token } = (await res.json()) as { node: string; token: string };
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
  const res = await fetch(`${p.url}/peer/changes?since=${p.cursor}`, {
    headers: { authorization: `Bearer ${p.token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`pull ${p.node}: ${res.status}`);
  const body = (await res.json()) as { records: Rec[]; seq: number; seen: Record<string, number> };
  let taken = 0;
  for (const r of body.records) if (s.merge(r)) taken++;
  // A peer that rolled its db back (seq < cursor) is re-read from the start next time.
  const cursor = body.seq < p.cursor ? 0 : body.seq;
  s.db.run("update peers set cursor = ?, last_seen = ? where node = ?", [cursor, s.now(), p.node]);
  // Heartbeats heard second-hand, so a node that is paired only through a middle node is not seen as offline.
  for (const [node, at] of Object.entries(body.seen ?? {}))
    if (node !== s.nodeId && at > lastSeen(s, node)) s.setLocal(`seen:${node}`, String(at));
  return taken;
}

export async function pullAll(s: Store) {
  const results = await Promise.allSettled(peers(s).map((p) => pullPeer(s, p)));
  return results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason));
}

export function poke(s: Store) {
  for (const p of peers(s))
    fetch(`${p.url}/peer/poke`, { method: "POST", headers: { authorization: `Bearer ${p.token}` }, signal: AbortSignal.timeout(5000) }).catch(() => {});
}

/** Routes served on the tailnet listener. */
export function peerRoutes(s: Store, onPoke: (p: Peer) => void = (p) => pullPeer(s, p).catch(() => {})) {
  const app = new Hono<{ Variables: { peer: Peer } }>();

  app.post("/join", async (c) => {
    const { code, node, url } = await c.req.json<{ code: string; node: string; url: string }>();
    const expected = s.local("pair:code");
    if (!expected || code !== expected || s.now() > Number(s.local("pair:expires") ?? 0)) return c.json({ error: "bad or expired code" }, 403);
    if (node === s.nodeId) return c.json({ error: "node name clashes with this node; run init --name" }, 409);
    s.setLocal("pair:code", undefined);
    const token = randomToken();
    s.db.run("insert or replace into peers values (?, ?, ?, 0, ?)", [node, url, token, s.now()]);
    return c.json({ node: s.nodeId, token });
  });

  app.use("*", async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer /, "");
    const peer = peers(s).find((p) => p.token === token);
    if (!token || !peer) return c.json({ error: "unauthorized" }, 401);
    c.set("peer", peer);
    await next();
  });

  app.get("/changes", (c) => {
    const seen: Record<string, number> = { [s.nodeId]: s.now() };
    for (const p of peers(s)) if (p.last_seen) seen[p.node] = p.last_seen;
    return c.json({ ...s.changes(Number(c.req.query("since") ?? 0)), seen });
  });

  app.post("/poke", (c) => {
    onPoke(c.get("peer"));
    return c.json({ ok: true });
  });

  return app;
}

export function unpair(s: Store, node: string) {
  s.db.run("delete from peers where node = ?", [node]);
}

/** The tailnet address this node listens on, from the Tailscale CLI. */
export async function tailscale(): Promise<{ ip: string; url: string } | undefined> {
  const bin = Bun.which("tailscale") ?? "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  try {
    const out = await Bun.$`${bin} status --json`.quiet().json();
    const ip = (out.Self?.TailscaleIPs as string[] | undefined)?.find((a) => a.includes("."));
    if (!ip) return undefined;
    const host = (out.Self?.DNSName as string | undefined)?.replace(/\.$/, "") || ip;
    return { ip, url: `http://${host}:${PORT}` };
  } catch {
    return undefined;
  }
}
