import { CHANNEL_LIMITS, MiB, channelResponseFrame, relayNode } from "@agentgate/protocol/relay";
import { sameHash, Window } from "./group.ts";

/**
 * A group's node channel: a member calls another member, and the call is forwarded over the WebSocket the target
 * keeps open. Bodies are sealed by the daemons; the relay checks only the group token and sizes, and stores nothing.
 * Runs on Durable Objects (index.ts) and in-process for Bun tests (test/memory.ts), which supply the sockets.
 */

export interface ChannelSocket { readonly node: string; readonly since: number; send(text: string): void; close(code: number, reason: string): void }
interface ChannelLimits { requestsPerMinute: number; mibPerMinute: number; failedAuthPerMinute: number }
interface ChannelDeps {
  /** Open sockets of this group's nodes. */
  sockets(): ChannelSocket[];
  /** Whether the token hash belongs to this group (asked of the group object once, then remembered). */
  checkAuth(authHash: string, ipHash: string): Promise<boolean>;
  limits: ChannelLimits;
  now?: () => number;
}
interface Pending { socket: ChannelSocket; resolve: (r: Response) => void; timer: ReturnType<typeof setTimeout> }

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const BODY_DEADLINE_MS = 30_000;

/** Bytes per minute, like Window counts requests. */
class Budget {
  private start = 0;
  private used = 0;
  take(bytes: number, limit: number, now: number): number | undefined {
    if (now - this.start >= 60_000) {
      this.start = now;
      this.used = 0;
    }
    if (this.used + bytes > limit) return Math.max(1, Math.ceil((this.start + 60_000 - now) / 1000));
    this.used += bytes;
    return undefined;
  }
}

export class ChannelCore {
  private authHash?: string;
  private pending = new Map<string, Pending>();
  private requests = new Window();
  private failures = new Window();
  private bytes = new Budget();

  constructor(private deps: ChannelDeps) { }
  private now() { return (this.deps.now ?? Date.now)(); }

  /** Undefined when the token is this group's; otherwise the refusal. */
  async authorize(authHash: string, ipHash: string): Promise<Response | undefined> {
    if (this.authHash && sameHash(this.authHash, authHash)) return undefined;
    if (!this.authHash && await this.deps.checkAuth(authHash, ipHash)) { this.authHash = authHash; return undefined; }
    const limited = this.failures.hit(this.deps.limits.failedAuthPerMinute, this.now());
    return limited ? json(429, { error: "too many failed attempts" }, { "retry-after": String(limited) }) : json(401, { error: "unauthorized" });
  }

  /** The newest open socket of a node. A node's new connection closes its older ones. */
  socket(node: string): ChannelSocket | undefined {
    let best: ChannelSocket | undefined;
    for (const s of this.deps.sockets()) if (s.node === node && (!best || s.since > best.since)) best = s;
    return best;
  }

  /** Validate a connect before the adapter accepts the socket; closes the node's older sockets. */
  connect(node: string): Response | undefined {
    if (!relayNode.safeParse(node).success) return json(400, { error: "invalid node", code: "shape" });
    for (const s of this.deps.sockets()) if (s.node === node) s.close(4000, "replaced by a newer connection");
    return undefined;
  }

  async call(req: Request, target: string): Promise<Response> {
    const now = this.now();
    const limited = this.requests.hit(this.deps.limits.requestsPerMinute, now);
    if (limited) return json(429, { error: "too many calls for this group", code: "rate" }, { "retry-after": String(limited) });
    if (!relayNode.safeParse(target).success) return json(400, { error: "invalid node", code: "shape" });
    const socket = this.socket(target);
    if (!socket) return json(503, { error: "that machine is not connected to the relay", code: "offline" });
    const inFlight = [...this.pending.values()].filter((p) => p.socket === socket).length;
    if (inFlight >= CHANNEL_LIMITS.inFlight) return json(503, { error: "too many calls in flight", code: "busy" }, { "retry-after": "1" });

    const body = await readBounded(req, CHANNEL_LIMITS.bodyBytes);
    if (body === undefined) return json(413, { error: "call too large", code: "size" });
    const budget = this.bytes.take(body.length, this.deps.limits.mibPerMinute * MiB, now);
    if (budget) return json(429, { error: "too much data for this group", code: "rate" }, { "retry-after": String(budget) });
    const id = crypto.randomUUID();
    const response = new Promise<Response>((resolve) => {
      // Never replayed after a timeout or a dropped socket: the target may already have acted on it.
      const timer = setTimeout(() => this.settle(id, json(504, { error: "that machine did not answer in time", code: "timeout" })), CHANNEL_LIMITS.timeoutMs);
      this.pending.set(id, { socket, resolve, timer });
    });
    req.signal?.addEventListener("abort", () => {
      if (!this.pending.has(id)) return;
      try {
        socket.send(JSON.stringify({ t: "cancel", id }));
      } catch {
        // The socket is already gone; its close fails the call.
      }
      this.settle(id, json(499, { error: "caller closed the call" }));
    });
    try { socket.send(JSON.stringify({ t: "req", id, body })); }
    catch { this.settle(id, json(502, { error: "that machine disconnected", code: "offline" })); }
    return response;
  }

  /** A frame from a node's socket. False when the socket must be closed. */
  message(socket: ChannelSocket, text: string): boolean {
    if (text.length > CHANNEL_LIMITS.bodyBytes + 1024) return false;
    let frame;
    try {
      frame = channelResponseFrame.parse(JSON.parse(text));
    } catch {
      return false;
    }
    const p = this.pending.get(frame.id);
    if (!p || p.socket !== socket) return true; // late, cancelled, or answered on another socket
    if (this.bytes.take(frame.body.length, this.deps.limits.mibPerMinute * MiB, this.now())) {
      this.settle(frame.id, json(429, { error: "too much data for this group", code: "rate" }, { "retry-after": "60" }));
      return true;
    }
    this.settle(frame.id, new Response(frame.body, { status: 200, headers: { "content-type": "text/plain", "cache-control": "no-store" } }));
    return true;
  }

  closed(socket: ChannelSocket) {
    for (const [id, p] of this.pending) if (p.socket === socket) this.settle(id, json(502, { error: "that machine disconnected", code: "offline" }));
  }

  private settle(id: string, res: Response) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer); this.pending.delete(id); p.resolve(res);
  }
}

async function readBounded(req: Request, max: number): Promise<string | undefined> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return undefined;
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = setTimeout(() => { void reader.cancel(); }, BODY_DEADLINE_MS);
  try {
    for (; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); return undefined; }
      chunks.push(value);
    }
  } finally { clearTimeout(deadline); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(bytes);
}
