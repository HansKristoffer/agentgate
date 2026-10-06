import { isVirtual, type Project, type PublicProject, type RemoteSummary } from "@agentgate/protocol";
import { REMOTE_LIMITS, relayFrame, sha256Hex, type RemoteResponseFrame } from "@agentgate/protocol/remote";
import type { Gateway } from "./mcp/gateway.ts";
import { b64url, checkRelayUrl, relayUrlDefault, serviceKey } from "./relay.ts";
import { fetchHeaders } from "./runtime.ts";
import type { Store } from "./store.ts";

/**
 * Remote MCP endpoints (docs/internals/remote-mcp.md): a virtual project's tools at a public relay URL for clients
 * like Grok. The serving node keeps a WebSocket open to the relay and answers each request from its gateway.
 */

/** Sync features this daemon understands: 2 keeps remote endpoints intact, 3 knows `tokens` records (llm/token-history.ts).
 * A feature waits until every node reports its protocol. */
export const NODE_PROTOCOL = 3;
const REMOTE_PROTOCOL = 2;

type Remote = NonNullable<Project["remote"]>;
const random = (bytes: number) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
const fresh = (relay: string, servedBy: string, enabled: boolean): Remote => ({ key: random(16), secret: random(32), token: random(32), enabled, servedBy, relay });
export const endpointUrl = (r: Remote) => `${r.relay}/mcp/${r.key}`;

function virtualProject(s: Store, id: string): Project {
  if (!isVirtual(id)) throw new Error("Only virtual projects (@name) have a remote endpoint");
  const p = s.get("project", id);
  if (!p) throw new Error(`no project ${id}`);
  return p;
}

/** Every node record must come from a daemon that keeps `remote` intact; older ones drop it when they edit a project. */
function versionGate(s: Store) {
  const old = s.list("node").filter(n => (n.protocol ?? 0) < REMOTE_PROTOCOL).map(n => n.id);
  if (old.length) throw new Error(`Update agentgate on ${old.join(", ")} first: older versions can't keep remote endpoints in sync`);
}

/** An always-on node is the natural host; otherwise this one. */
function defaultServer(s: Store): string {
  return s.list("node").find(n => n.alwaysOn && (n.protocol ?? 0) >= REMOTE_PROTOCOL)?.id ?? s.nodeId;
}

export function enableRemote(s: Store, id: string, servedBy?: string): { url: string; secret: string } {
  return s.transaction(() => {
    const p = virtualProject(s, id);
    versionGate(s);
    if (servedBy && !s.get("node", servedBy)) throw new Error(`no machine ${servedBy}`);
    const remote: Remote = p.remote
      ? { ...p.remote, enabled: true, servedBy: servedBy ?? p.remote.servedBy }
      : fresh(checkRelayUrl(relayUrlDefault()), servedBy ?? defaultServer(s), true);
    s.put("project", id, { ...p, remote });
    return { url: endpointUrl(remote), secret: remote.secret };
  });
}

export function showRemote(s: Store, id: string) {
  const r = virtualProject(s, id).remote;
  if (!r) throw new Error(`${id} has no remote endpoint; enable it first`);
  return { url: endpointUrl(r), secret: r.secret, enabled: r.enabled, servedBy: r.servedBy };
}

export function disableRemote(s: Store, id: string) {
  const p = virtualProject(s, id);
  if (p.remote) s.put("project", id, { ...p, remote: { ...p.remote, enabled: false } });
}

/** A new secret at the same URL. */
export function rotateSecret(s: Store, id: string): { url: string; secret: string } {
  const p = virtualProject(s, id);
  if (!p.remote) throw new Error(`${id} has no remote endpoint; enable it first`);
  const remote = { ...p.remote, secret: random(32) };
  s.put("project", id, { ...p, remote });
  return { url: endpointUrl(remote), secret: remote.secret };
}

/**
 * A new key, secret and token: a new URL that no removed machine has seen. The old relay object is deleted
 * best-effort (queued, retried by the endpoint manager), since a token another machine knows can't revoke it.
 */
export function regenerate(s: Store, id: string, servedBy?: string): { url: string; secret: string } {
  return s.transaction(() => {
    const p = virtualProject(s, id);
    if (!p.remote) throw new Error(`${id} has no remote endpoint; enable it first`);
    queueDelete(s, p.remote);
    const remote = { ...fresh(p.remote.relay, servedBy ?? p.remote.servedBy, p.remote.enabled) };
    s.put("project", id, { ...p, remote });
    return { url: endpointUrl(remote), secret: remote.secret };
  });
}

/** After unpairing `removed`: every endpoint gets a new URL, and ones it served move here. */
export function regenerateAfterUnpair(s: Store, removed: string): { project: string; url: string }[] {
  return s.list("project").filter(p => p.remote).map(p => {
    const { url } = regenerate(s, p.id, p.remote!.servedBy === removed ? s.nodeId : undefined);
    return { project: p.id, url };
  });
}

/** Deleting a virtual project also deletes its relay endpoint (queued, done by the endpoint manager). */
export function deleteProject(s: Store, id: string) {
  s.transaction(() => {
    const r = s.get("project", id)?.remote;
    if (r) queueDelete(s, r);
    s.del("project", id);
  });
}

function queueDelete(s: Store, r: Remote) {
  const queue = JSON.parse(s.local("remote:delete") ?? "[]") as { relay: string; key: string; token: string }[];
  queue.push({ relay: r.relay, key: r.key, token: r.token });
  s.setLocal("remote:delete", JSON.stringify(queue.slice(-100)));
}

// ---------------------------------------------------------------- serving

interface Conn {
  project: string;
  remote: Remote;
  ws?: WebSocket;
  connected: boolean;
  closed: boolean;
  error?: string;
  failed: string[];
  lastCall?: number;
  backoff: number;
  retry?: ReturnType<typeof setTimeout>;
  ping?: ReturnType<typeof setInterval>;
  lastPong: number;
  inflight: Map<string, AbortController>;
}

const describe = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

/** Keeps one socket per endpoint this node serves and pushes the secret hash the relay checks. */
export class RemoteEndpoints {
  private conns = new Map<string, Conn>();
  private closed = false;

  constructor(private s: Store, private gateway: Gateway, private options: { pingMs?: number; WebSocket?: typeof WebSocket } = {}) { }

  /** Start, restart or stop sockets to match the project records; also retries queued deletions. */
  reconcile() {
    if (this.closed) return;
    const wanted = new Map(this.s.list("project").filter(p => p.remote?.enabled && p.remote.servedBy === this.s.nodeId).map(p => [p.id, p.remote!]));
    for (const [id, c] of this.conns) {
      const next = wanted.get(id);
      if (!next || next.key !== c.remote.key || next.token !== c.remote.token || next.relay !== c.remote.relay) this.stop(id);
      else if (next.secret !== c.remote.secret) { c.remote = next; void this.put(next).catch(e => { c.error = describe(e); }); }
    }
    for (const [id, remote] of wanted) if (!this.conns.has(id)) this.start(id, remote);
    // A disabled endpoint served here: tell the relay, so it refuses requests even from a stale copy.
    for (const p of this.s.list("project")) if (p.remote && !p.remote.enabled && p.remote.servedBy === this.s.nodeId) void this.put(p.remote).catch(() => { });
    void this.drainDeletes();
  }

  /** Live state for the API. */
  summary(p: Project): RemoteSummary | undefined {
    if (!p.remote) return undefined;
    const base = { enabled: p.remote.enabled, servedBy: p.remote.servedBy, url: endpointUrl(p.remote) };
    if (p.remote.servedBy !== this.s.nodeId) return base;
    const c = this.conns.get(p.id);
    return { ...base, connected: !!c?.connected, updating: p.remote.enabled && this.s.local(`remote:pushed:${p.remote.key}`) !== this.pushedValue(p.remote, true), error: c?.error, failedAliases: c?.failed, lastCall: c?.lastCall };
  }

  /** The value stored once the relay acknowledged this secret and state; synchronous so status needn't hash. */
  private pushedValue(r: Remote, enabled: boolean) { return `${r.secret.slice(0, 8)}:${enabled}`; }

  private async put(r: Remote) {
    const marker = this.pushedValue(r, r.enabled);
    if (this.s.local(`remote:pushed:${r.key}`) === marker) return;
    const key = serviceKey(this.s);
    const res = await fetchHeaders(`${r.relay}/e/${r.key}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${r.token}`, "content-type": "application/json", ...(key && { "x-relay-key": key }) },
      body: JSON.stringify({ secretHash: await sha256Hex(r.secret), enabled: r.enabled }),
    }, 10_000);
    await res.body?.cancel();
    if (res.status === 401) throw new Error("the relay refused this endpoint's token; create a new URL");
    if (!res.ok) throw new Error(`the relay answered ${res.status}`);
    this.s.setLocal(`remote:pushed:${r.key}`, marker);
  }

  private start(project: string, remote: Remote) {
    const c: Conn = { project, remote, connected: false, closed: false, failed: [], backoff: 1000, lastPong: 0, inflight: new Map() };
    this.conns.set(project, c);
    void this.connect(c);
  }

  private stop(project: string) {
    const c = this.conns.get(project);
    if (!c) return;
    c.closed = true; this.conns.delete(project);
    clearTimeout(c.retry); clearInterval(c.ping);
    for (const a of c.inflight.values()) a.abort(new Error("endpoint stopped"));
    c.ws?.close();
  }

  private later(c: Conn, error?: string) {
    if (c.closed || this.closed) return;
    if (error) c.error = error;
    c.connected = false;
    clearInterval(c.ping);
    const delay = c.backoff * (0.5 + Math.random());
    c.backoff = Math.min(c.backoff * 2, 60_000);
    c.retry = setTimeout(() => void this.connect(c), delay);
    c.retry.unref?.();
  }

  private async connect(c: Conn) {
    if (c.closed || this.closed) return;
    try { await this.put(c.remote); }
    catch (e) { return this.later(c, describe(e)); }
    if (c.closed || this.closed) return;
    const key = serviceKey(this.s);
    const Socket = this.options.WebSocket ?? WebSocket;
    // Bun's WebSocket accepts headers; the relay authenticates the upgrade with the endpoint token.
    const ws = new Socket(`${c.remote.relay.replace(/^http/, "ws")}/e/${c.remote.key}/connect`, {
      headers: { authorization: `Bearer ${c.remote.token}`, "x-agentgate-node": this.s.nodeId, ...(key && { "x-relay-key": key }) },
    } as unknown as string[]);
    c.ws = ws;
    ws.onopen = () => {
      c.connected = true; c.error = undefined; c.backoff = 1000; c.lastPong = Date.now();
      const pingMs = this.options.pingMs ?? 30_000;
      c.ping = setInterval(() => {
        if (Date.now() - c.lastPong > pingMs * 2) return ws.close();
        try { ws.send("ping"); } catch { /* closing */ }
      }, pingMs);
      c.ping.unref?.();
    };
    ws.onmessage = (e) => {
      if (e.data === "pong") { c.lastPong = Date.now(); return; }
      let frame;
      try { frame = relayFrame.parse(JSON.parse(String(e.data))); } catch { return; }
      if (frame.t === "cancel") return c.inflight.get(frame.id)?.abort(new Error("cancelled by the client"));
      void this.answer(c, ws, frame.id, frame.body, frame.headers);
    };
    ws.onclose = () => {
      if (c.ws !== ws) return;
      for (const a of c.inflight.values()) a.abort(new Error("relay connection closed"));
      // A refused upgrade looks like a close; the next attempt re-pushes the endpoint in case the relay lost it.
      if (!c.connected) this.s.setLocal(`remote:pushed:${c.remote.key}`, undefined);
      this.later(c, c.connected ? undefined : "could not connect to the relay");
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private async answer(c: Conn, ws: WebSocket, id: string, body: string, headers: Record<string, string>) {
    const send = (frame: RemoteResponseFrame) => { try { ws.send(JSON.stringify(frame)); } catch { /* socket closed; the relay already failed it */ } };
    if (c.inflight.size >= REMOTE_LIMITS.inFlight) return send({ t: "res", id, status: 503, headers: {}, body: "", retry: true });
    const abort = new AbortController();
    c.inflight.set(id, abort);
    const started = Date.now();
    let status = 500, label = "request";
    try {
      const message = JSON.parse(body) as { method?: string; params?: { name?: string } };
      label = message.method === "tools/call" ? `tools/call ${message.params?.name ?? ""}` : String(message.method ?? "request");
    } catch { /* the gateway answers with a parse error */ }
    try {
      const { response, failed } = await this.gateway.handleRemote(c.project, body, headers, AbortSignal.any([abort.signal, AbortSignal.timeout(REMOTE_LIMITS.timeoutMs)]));
      const text = await response.text();
      c.failed = failed;
      status = response.status;
      if (text.length > REMOTE_LIMITS.responseBytes) {
        status = 413;
        return send({ t: "res", id, status, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "response too large for the relay (4 MiB)" }, id: null }) });
      }
      const type = response.headers.get("content-type");
      send({ t: "res", id, status, headers: type ? { "content-type": type } : {}, body: text });
    } catch (e) {
      if (abort.signal.aborted) return; // the relay already answered the client
      send({ t: "res", id, status: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "agentgate failed to handle the request" }, id: null }) });
      c.error = describe(e);
    } finally {
      c.inflight.delete(id);
      c.lastCall = Date.now();
      this.s.log("remote", c.project, label.slice(0, 200), status, Date.now() - started);
    }
  }

  private async drainDeletes() {
    const queue = JSON.parse(this.s.local("remote:delete") ?? "[]") as { relay: string; key: string; token: string }[];
    if (!queue.length) return;
    const left: typeof queue = [];
    for (const d of queue) {
      try {
        const key = serviceKey(this.s);
        const res = await fetchHeaders(`${d.relay}/e/${d.key}`, { method: "DELETE", headers: { authorization: `Bearer ${d.token}`, ...(key && { "x-relay-key": key }) } }, 10_000);
        await res.body?.cancel();
        if (!res.ok && res.status !== 404 && res.status !== 401) left.push(d);
      } catch { left.push(d); }
    }
    // Re-read: regenerate may have queued more meanwhile.
    const now = JSON.parse(this.s.local("remote:delete") ?? "[]") as typeof queue;
    const done = new Set(queue.filter(d => !left.includes(d)).map(d => d.key));
    this.s.setLocal("remote:delete", JSON.stringify(now.filter(d => !done.has(d.key))));
  }

  close() {
    this.closed = true;
    for (const id of [...this.conns.keys()]) this.stop(id);
  }
}

/** Projects as the API shows them: endpoint state without key material. */
export function publicProject(p: Project, endpoints: RemoteEndpoints): PublicProject {
  const { remote, ...rest } = p;
  const summary = endpoints.summary(p);
  return summary ? { ...rest, remote: summary } : rest;
}
