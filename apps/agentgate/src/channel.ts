import { CHANNEL_LIMITS, MiB, channelRelayFrame } from "@agentgate/protocol/relay";
import { z } from "zod";
import { b64url, deriveKeys, parseInvite, relayInvite, serviceKey, type Keys } from "./relay.ts";
import { fetchHeaders, readBody } from "./runtime.ts";
import type { Store } from "./store.ts";

/**
 * Calls between relay group members (thread handoff, docs/internals/relay.md#node-channel). The relay forwards a
 * call over the WebSocket the target keeps open and stores nothing. Each call and reply is sealed with the group's
 * key; the authenticated data binds both nodes, the call id and its time, so the relay can neither read, alter,
 * redirect nor replay one. Group membership is the trust: a member holds every credential already.
 */

/** Upload chunk size for handoff files, over Tailscale and the relay: one sealed call stays under the relay's body limit. */
export const CHANNEL_CHUNK = MiB;
/** How far a call's time may be from ours; ids seen within it are refused. */
const SKEW = 5 * 60_000;
const MAX_PLAIN = Math.floor(CHANNEL_LIMITS.bodyBytes * 3 / 4) - 4096;

interface Group { url: string; keys: Keys; serviceKey?: string }
async function group(s: Store): Promise<Group | undefined> {
  const invite = relayInvite(s);
  if (!invite) return undefined;
  const parsed = parseInvite(invite);
  return { url: parsed.url, keys: await deriveKeys(parsed.secret), serviceKey: serviceKey(s) };
}

class ChannelError extends Error { constructor(message: string, readonly status = 0) { super(message); } }
const envelopeSchema = z.object({ v: z.literal(1), from: z.string().min(1).max(512), id: z.string().uuid(), ts: z.number().int(), box: z.string().min(1) }).strict();
const metaSchema = z.object({
  method: z.string().max(16).optional(),
  path: z.string().max(4096).optional(),
  status: z.number().int().optional(),
  type: z.string().max(200).optional(),
}).strict();

const aad = (kind: "req" | "res", groupId: string, from: string, to: string, id: string, ts: number) =>
  new TextEncoder().encode(JSON.stringify([2, kind, groupId, from, to, id, ts]));

/** A sealed message: a JSON line of metadata, then the raw body. */
async function seal(keys: Keys, data: Uint8Array<ArrayBuffer>, meta: object, body: Uint8Array): Promise<string> {
  const head = new TextEncoder().encode(`${JSON.stringify(meta)}\n`);
  const plain = new Uint8Array(head.length + body.length);
  plain.set(head); plain.set(body, head.length);
  if (plain.length > MAX_PLAIN) throw new ChannelError("too large for the relay", 413);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: data }, keys.enc, plain));
  const out = new Uint8Array(12 + ct.length);
  out.set(nonce); out.set(ct, 12);
  return b64url(out);
}
async function open(keys: Keys, data: Uint8Array<ArrayBuffer>, box: string): Promise<{ meta: z.infer<typeof metaSchema>; body: Uint8Array }> {
  const bytes = new Uint8Array(Buffer.from(box, "base64url"));
  if (bytes.length < 28) throw new ChannelError("sealed message too short");
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: data }, keys.enc, bytes.subarray(12)));
  const nl = plain.indexOf(10);
  if (nl < 0) throw new ChannelError("sealed message has no header");
  return { meta: metaSchema.parse(JSON.parse(new TextDecoder().decode(plain.subarray(0, nl)))), body: plain.subarray(nl + 1) };
}

/** One call to `node` through the relay, answered like a fetch to its `/peer` routes. */
export async function relayCall(s: Store, node: string, path: string, init: { method: string; body?: Uint8Array; type?: string; timeout: number }): Promise<Response> {
  const g = await group(s);
  if (!g) throw new ChannelError(`${node} is not paired with ${s.nodeId} over Tailscale or a relay`);
  const id = crypto.randomUUID();
  const ts = s.now();
  const meta = { method: init.method, path, ...(init.type && { type: init.type }) };
  const box = await seal(g.keys, aad("req", g.keys.groupId, s.nodeId, node, id, ts), meta, init.body ?? new Uint8Array());

  let res: Response;
  try {
    res = await fetchHeaders(`${g.url}/g/${g.keys.groupId}/n/${encodeURIComponent(node)}/call`, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(init.timeout),
      headers: { authorization: `Bearer ${g.keys.authToken}`, "content-type": "text/plain", ...(g.serviceKey && { "x-relay-key": g.serviceKey }) },
      body: JSON.stringify({ v: 1, from: s.nodeId, id, ts, box }),
    }, init.timeout);
  } catch {
    throw new ChannelError("could not reach the relay");
  }
  const text = new TextDecoder().decode(await readBody(res.body, CHANNEL_LIMITS.bodyBytes + 64 * 1024, AbortSignal.timeout(init.timeout)));
  if (res.status !== 200) throw relayFailure(res.status, text, node);

  let reply;
  try {
    reply = await open(g.keys, aad("res", g.keys.groupId, s.nodeId, node, id, ts), text);
  } catch {
    throw new ChannelError(`${node} refused the call; are both machines in the same relay group?`);
  }
  return new Response(reply.body, { status: reply.meta.status ?? 500, headers: reply.meta.type ? { "content-type": reply.meta.type } : {} });
}

/** The relay's own refusal, as a message for the user. Its body is a known code at most, never shown raw. */
function relayFailure(status: number, text: string, node: string) {
  let code: string | undefined;
  try {
    code = JSON.parse(text).code;
  } catch {
    // An answer without a code is described by its status.
  }
  if (status === 404) return new ChannelError("the relay does not support handoffs yet; update it", 404);
  if (code === "offline") return new ChannelError(`${node} is not reachable through the relay (offline, or T3 Code is not connected there)`, 503);
  if (code === "timeout") return new ChannelError(`${node} did not answer through the relay in time`, 504);
  if (status === 429) return new ChannelError("the relay is rate limiting handoffs; try again in a minute", 429);
  if (status === 413) return new ChannelError("too large for the relay", 413);
  return new ChannelError(`the relay answered ${status}`, status);
}

/** Keeps this node reachable for calls through the relay while it is in a relay group (also before T3 Code is
 * connected, so another machine can set that up), and answers each call with `handler` (the handoff peer routes),
 * as the authenticated sender. */
export class NodeChannel {
  private ws?: WebSocket;
  private target?: string;
  private retry?: ReturnType<typeof setTimeout>;
  private ping?: ReturnType<typeof setInterval>;
  private backoff = 1000;
  private lastPong = 0;
  private inflight = new Map<string, AbortController>();
  private closed = false;
  connected = false;

  constructor(private s: Store, private handler: (from: string, req: Request) => Promise<Response>, private options: { pingMs?: number } = {}) { }

  /** Open, reopen or close the socket to match the relay group and whether this node can take handoffs. */
  async reconcile() {
    if (this.closed) return;
    const g = await group(this.s).catch(() => undefined);
    const target = g && `${g.url}/g/${g.keys.groupId}/n/${encodeURIComponent(this.s.nodeId)}/connect`;
    if (target === this.target) return;
    this.stop();
    this.target = target;
    if (g) this.connect(g);
  }

  private stop() {
    clearTimeout(this.retry); clearInterval(this.ping);
    for (const a of this.inflight.values()) a.abort(new Error("channel closed"));
    const ws = this.ws;
    this.ws = undefined;
    this.connected = false;
    ws?.close();
  }

  private later(g: Group) {
    if (this.closed) return;
    this.connected = false;
    clearInterval(this.ping);
    const delay = this.backoff * (0.5 + Math.random());
    this.backoff = Math.min(this.backoff * 2, 60_000);
    this.retry = setTimeout(() => this.connect(g), delay);
    this.retry.unref?.();
  }

  private connect(g: Group) {
    if (this.closed) return;
    // Bun's WebSocket accepts headers; the relay authenticates the upgrade with the group token.
    const ws = new WebSocket(this.target!.replace(/^http/, "ws"), {
      headers: { authorization: `Bearer ${g.keys.authToken}`, ...(g.serviceKey && { "x-relay-key": g.serviceKey }) },
    } as unknown as string[]);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.backoff = 1000;
      this.lastPong = Date.now();
      const pingMs = this.options.pingMs ?? 30_000;
      this.ping = setInterval(() => {
        if (Date.now() - this.lastPong > pingMs * 2) return ws.close();
        try {
          ws.send("ping");
        } catch {
          // Closing; onclose reconnects.
        }
      }, pingMs);
      this.ping.unref?.();
    };
    ws.onmessage = (e) => {
      if (e.data === "pong") { this.lastPong = Date.now(); return; }
      let frame;
      try {
        frame = channelRelayFrame.parse(JSON.parse(String(e.data)));
      } catch {
        return; // not a frame this version understands
      }
      if (frame.t === "cancel") return this.inflight.get(frame.id)?.abort(new Error("cancelled by the caller"));
      void this.answer(g, ws, frame.id, frame.body);
    };
    ws.onclose = () => { if (this.ws === ws) this.later(g); };
    ws.onerror = () => { /* onclose follows */ };
  }

  private async answer(g: Group, ws: WebSocket, frameId: string, body: string) {
    const send = (box: string) => {
      try {
        ws.send(JSON.stringify({ t: "res", id: frameId, body: box }));
      } catch {
        // The socket closed; the relay already failed the call.
      }
    };
    // An unreadable, stale, replayed or self-addressed call gets an answer the caller can't open: no oracle for the relay.
    const refuse = () => send("");

    let env;
    try {
      env = envelopeSchema.parse(JSON.parse(body));
    } catch {
      return refuse();
    }
    const now = this.s.now();
    const me = this.s.nodeId;
    if (env.from === me || Math.abs(now - env.ts) > SKEW) return refuse();

    const sealedFor = (kind: "req" | "res") => aad(kind, g.keys.groupId, env.from, me, env.id, env.ts);
    let call;
    try {
      call = await open(g.keys, sealedFor("req"), env.box);
    } catch {
      return refuse();
    }
    // Recorded only once authentic, so a hostile relay can't fill the store with ids.
    if (!this.fresh(env.id, now)) return refuse();

    const abort = new AbortController();
    this.inflight.set(frameId, abort);
    const reply = await this.handle(env.from, call, abort.signal).finally(() => this.inflight.delete(frameId));
    if (abort.signal.aborted) return;

    const tooLarge = { status: 413, type: "application/json", body: new TextEncoder().encode(JSON.stringify({ error: "the answer is too large for the relay" })) };
    const box = await seal(g.keys, sealedFor("res"), { status: reply.status, type: reply.type }, reply.body)
      .catch(() => seal(g.keys, sealedFor("res"), { status: tooLarge.status, type: tooLarge.type }, tooLarge.body));
    send(box);
  }

  /** Run one opened call through the peer routes; a failure becomes a 500 answer. */
  private async handle(from: string, call: Awaited<ReturnType<typeof open>>, signal: AbortSignal) {
    const method = call.meta.method ?? "GET";
    try {
      const res = await this.handler(from, new Request(`http://relay.invalid${call.meta.path ?? "/"}`, {
        method, signal,
        headers: call.meta.type ? { "content-type": call.meta.type } : {},
        body: method === "GET" || method === "DELETE" ? undefined : call.body,
      }));
      return { status: res.status, type: res.headers.get("content-type") ?? undefined, body: new Uint8Array(await res.arrayBuffer()) };
    } catch {
      return { status: 500, type: "application/json", body: new TextEncoder().encode(JSON.stringify({ error: "request failed" })) };
    }
  }

  /** Refuse a call id seen within the skew window. Kept in the store so a restart does not reopen the window. */
  private fresh(id: string, now: number): boolean {
    return this.s.transaction(() => {
      this.s.db.run("delete from local where key like 'channelSeen:%' and cast(value as integer) < ?", [now]);
      if (this.s.local(`channelSeen:${id}`)) return false;
      this.s.setLocal(`channelSeen:${id}`, String(now + 2 * SKEW));
      return true;
    });
  }

  close() {
    this.closed = true;
    this.stop();
  }
}
