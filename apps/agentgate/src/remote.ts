import { isVirtual, type PublicProject, type RemoteSummary } from "@agentgate/protocol";
import { randomToken } from "hanzio/crypto";
import { exponentialBackoff } from "hanzio";
import {
  REMOTE_LIMITS,
  relayFrame,
  sha256Hex,
  type remoteRequestFrame,
  type RemoteResponseFrame,
} from "@agentgate/protocol/remote";
import { z } from "zod";
import { defineLocal } from "./local-state.ts";
import type { Gateway } from "./mcp/gateway.ts";
import { RelaySocket } from "./relay-socket.ts";
import { checkRelayUrl, relayUrl, serviceKeyFor } from "./relay.ts";
import { fetchHeaders, serialTask } from "./runtime.ts";
import { nodesBelow, requireNodeProtocol, sent, type Data, type Project, type Store } from "./store.ts";

/**
 * Remote endpoints (docs/internals/remote-mcp.md): a virtual project's tools at a public relay URL for clients like
 * Grok. The serving node keeps a WebSocket open to the relay and answers each request from its gateway.
 */

/** Sync features this daemon understands: 2 keeps remote endpoints intact, 3 knows `tokens` records (llm/token-history.ts),
 * 4 knows `login` records, 5 the Infisical machine identity login (logins.ts), 6 checkout files on project records
 * (checkout-files.ts), 7 the health dashboard setting on node records, since removed, 8 and 9 the software factory, since
 * removed, 10 the
 * `opencode` login (logins.ts), 11 the global AGENTS.md on Global defaults (agents-md.ts), 12 the `antigravity` login
 * (logins.ts). A feature waits until every node reports its protocol. */
export const NODE_PROTOCOL = 12;
const REMOTE_PROTOCOL = 2;

type Remote = NonNullable<Project["remote"]>;
const fresh = (relay: string, servedBy: string, enabled: boolean): Remote => ({
  key: randomToken(16),
  secret: randomToken(32),
  token: randomToken(32),
  enabled,
  servedBy,
  relay,
});
export const endpointUrl = (r: Remote) => `${r.relay}/mcp/${r.key}`;

function virtualProject(s: Store, id: string): Project {
  if (!isVirtual(id)) throw new Error("Only virtual projects (@name) have a remote endpoint");
  const p = s.get("project", id);
  if (!p) throw new Error(`no project ${id}`);
  return p;
}

/** An always-on node is the natural host; otherwise this one. */
function defaultServer(s: Store): string {
  const old = nodesBelow(s, REMOTE_PROTOCOL);
  return s.list("node").find((n) => n.alwaysOn && !old.includes(n.id))?.id ?? s.nodeId;
}

export function enableRemote(s: Store, id: string, servedBy?: string): { url: string; secret: string } {
  return s.transaction(() => {
    const p = virtualProject(s, id);
    requireNodeProtocol(s, REMOTE_PROTOCOL, "can't keep remote endpoints in sync");
    if (servedBy && !s.get("node", servedBy)) throw new Error(`no machine ${servedBy}`);
    const remote: Remote = p.remote
      ? { ...p.remote, enabled: true, servedBy: servedBy ?? p.remote.servedBy }
      : fresh(checkRelayUrl(relayUrl(s)), servedBy ?? defaultServer(s), true);
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
  const remote = { ...p.remote, secret: randomToken(32) };
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
    const remote = fresh(p.remote.relay, servedBy ?? p.remote.servedBy, p.remote.enabled);
    s.put("project", id, { ...p, remote });
    return { url: endpointUrl(remote), secret: remote.secret };
  });
}

/** After unpairing `removed`: every endpoint gets a new URL, and ones it served move here. */
export function regenerateAfterUnpair(s: Store, removed: string): { project: string; url: string }[] {
  return s
    .list("project")
    .filter((p) => p.remote)
    .map((p) => {
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

const deletes = defineLocal(
  "remote:delete",
  z.array(
    z.object({
      relay: z.string(),
      key: z.string(),
      token: z.string(),
      // Absent on entries queued before retries backed off, and on new ones: those go out on the next pass.
      attempts: z.number().optional(),
      nextAt: z.number().optional(),
    }),
  ),
);

/** Deletes a relay endpoint best-effort: the endpoint manager retries until the relay confirms. */
export function queueDelete(s: Store, r: { relay: string; key: string; token: string }) {
  const queue = deletes.get(s) ?? [];
  queue.push({ relay: r.relay, key: r.key, token: r.token });
  deletes.set(s, undefined, queue.slice(-100));
}

type RequestFrame = z.infer<typeof remoteRequestFrame>;

interface Conn {
  /** The project id. */
  id: string;
  remote: Remote;
  socket?: RelaySocket;
  connected: boolean;
  error?: string;
  failed: string[];
  lastCall?: number;
  /** Secret pushes in order, so an older one can never land after a newer one. */
  pushing?: Promise<void>;
}

/** A refusal from the relay, worded here: the only error text status shows as it is. */
class EndpointError extends Error {}

/** Status text for a failed push or request. Any other error's text can carry a URL, a header or an upstream server's
 * answer, so it is named by kind only. */
function describe(e: unknown, failed: string) {
  if (e instanceof EndpointError) return e.message;
  if (e instanceof Error && e.name === "TimeoutError") return `${failed}: timed out`;
  return failed;
}
const PUSH_FAILED = "could not reach the relay";
const REQUEST_FAILED = "a request failed";

/** Keeps one socket per endpoint this node serves and pushes the secret hash the relay checks. */
export class RemoteEndpoints {
  private conns = new Map<string, Conn>();
  private closed = false;

  constructor(
    private s: Store,
    private gateway: Gateway,
  ) {}

  /** Start, restart or stop sockets to match the project records; also retries queued deletions. */
  reconcile() {
    if (this.closed) return;
    const projects = this.s.list("project");
    const wanted = new Map<string, Remote>(
      projects.filter((p) => p.remote?.enabled && p.remote.servedBy === this.s.nodeId).map((p) => [p.id, p.remote!]),
    );
    const used = (key: string) => projects.some((p) => p.remote?.key === key);
    for (const [id, c] of this.conns) {
      const next = wanted.get(id);
      if (!next || next.key !== c.remote.key || next.token !== c.remote.token || next.relay !== c.remote.relay) {
        this.stop(id);
        // No record names this endpoint any more. A start before the change arrived may have recreated it on the relay.
        if (!used(c.remote.key)) queueDelete(this.s, c.remote);
      } else if (next.secret !== c.remote.secret && !c.connected) {
        // Restarted below, e.g. after a deletion.
        this.stop(id);
      } else if (c.connected) {
        // Until the relay acknowledges a new secret it still accepts the old one, so a failed push is retried on every
        // pass; `put` sends nothing once the relay has it.
        c.remote = next;
        c.pushing = (c.pushing ?? Promise.resolve()).then(() =>
          this.put(next).catch((e) => {
            this.report(c, c.connected, describe(e, PUSH_FAILED));
          }),
        );
      }
    }

    for (const [id, next] of wanted) {
      if (!this.conns.has(id)) this.start(id, next);
    }

    // A key range rather than LIKE, which ignores case and so cannot use the primary key. ';' sorts right after ':'.
    const deletedMarkers = this.s.db
      .query<{ key: string }, []>("select key from local where key >= 'remote:deleted:' and key < 'remote:deleted;'")
      .all();
    for (const row of deletedMarkers) {
      if (!used(row.key.slice("remote:deleted:".length))) this.s.setLocal(row.key, undefined);
    }

    // A disabled endpoint served here: tell the relay, so it refuses requests even from a stale copy.
    for (const p of projects) {
      if (p.remote && !p.remote.enabled && p.remote.servedBy === this.s.nodeId) void this.put(p.remote).catch(() => {});
    }

    void this.drainDeletes().catch((e) => console.error(`remote: endpoint deletions failed: ${e?.name ?? "error"}`));
  }

  /** Live state for the API. */
  summary(p: Project): RemoteSummary | undefined {
    if (!p.remote) return undefined;
    const base = { enabled: p.remote.enabled, servedBy: p.remote.servedBy, url: endpointUrl(p.remote) };
    if (p.remote.servedBy !== this.s.nodeId) return base;
    const c = this.conns.get(p.id);
    return {
      ...base,
      connected: !!c?.connected,
      updating: p.remote.enabled && this.s.local(`remote:pushed:${p.remote.key}`) !== this.pushedValue(p.remote, true),
      error: c?.error,
      failedAliases: c?.failed,
      lastCall: c?.lastCall,
    };
  }

  /** The value stored once the relay acknowledged this secret and state; synchronous so status needn't hash. */
  private pushedValue(r: Remote, enabled: boolean) {
    return `${r.secret.slice(0, 8)}:${enabled}`;
  }

  private async put(r: Remote) {
    // The relay deleted this endpoint (another machine made a new URL or deleted the project): pushing it again would
    // recreate it with the old token, so wait for the record to change.
    if (this.s.local(`remote:deleted:${r.key}`) === r.secret.slice(0, 8)) {
      throw new EndpointError("the relay deleted this endpoint; create a new URL");
    }

    const marker = this.pushedValue(r, r.enabled);
    if (this.s.local(`remote:pushed:${r.key}`) === marker) return;
    const key = serviceKeyFor(this.s, r.relay);
    const res = await fetchHeaders(
      `${r.relay}/e/${r.key}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${r.token}`,
          "content-type": "application/json",
          ...(key && { "x-relay-key": key }),
        },
        body: JSON.stringify({
          secretHash: await sha256Hex(r.secret),
          enabled: r.enabled,
        }),
      },
      10_000,
    );
    await res.body?.cancel();
    if (res.status === 401) throw new EndpointError("the relay refused this endpoint's token; create a new URL");
    if (!res.ok) throw new EndpointError(`the relay answered ${res.status}`);
    this.s.setLocal(`remote:pushed:${r.key}`, marker);
  }

  private start(id: string, remote: Remote) {
    const c: Conn = { id, remote, connected: false, failed: [] };
    this.conns.set(id, c);
    c.socket = this.connect(c);
  }

  private stop(id: string) {
    const c = this.conns.get(id);
    if (!c) return;
    this.conns.delete(id);
    c.socket?.stop("endpoint stopped");
  }

  /** Status shows each endpoint's connection and error: mark it changed when either moves, not on every retry. */
  private report(c: Conn, connected: boolean, error: string | undefined) {
    if (c.connected === connected && c.error === error) return;
    c.connected = connected;
    c.error = error;
    this.s.bump("status");
  }

  /** A stopped endpoint's socket reports nothing, as the store may be closing with the daemon. */
  private connect(c: Conn) {
    const socket: RelaySocket = new RelaySocket({
      dial: async () => {
        await this.put(c.remote);
        const key = serviceKeyFor(this.s, c.remote.relay);
        // The relay authenticates the upgrade with the endpoint token. Bun reads headers from the options object, which
        // its typings declare as a protocols list, hence the cast.
        return new WebSocket(`${c.remote.relay.replace(/^http/, "ws")}/e/${c.remote.key}/connect`, {
          headers: {
            authorization: `Bearer ${c.remote.token}`,
            "x-agentgate-node": this.s.nodeId,
            ...(key && { "x-relay-key": key }),
          },
        } as unknown as string[]);
      },
      onOpen: () => this.report(c, true, undefined),
      onMessage: (data, ws) => {
        let frame;
        try {
          frame = relayFrame.parse(JSON.parse(data));
        } catch {
          return;
        }
        if (frame.t === "cancel") return socket.inflight.get(frame.id)?.abort(new Error("cancelled by the client"));
        void this.answer(c, ws, socket.inflight, frame);
      },
      onDown: (down) => {
        if ("error" in down) return void this.report(c, false, describe(down.error, PUSH_FAILED));
        // Close codes from apps/relay/src/remote.ts.
        if (down.code === 4001) {
          this.s.setLocal(`remote:deleted:${c.remote.key}`, c.remote.secret.slice(0, 8));
          return void this.report(c, false, "the relay deleted this endpoint; create a new URL");
        }
        if (down.code === 4000) {
          // Another connection took the endpoint, e.g. a second machine serving it: reconnecting at once would only
          // take it back and start a duel.
          this.report(c, false, "another connection took over this endpoint");
          return 30_000;
        }
        if (down.upFor !== undefined) return void this.report(c, false, c.error);
        // A refused upgrade looks like a close; the next attempt re-pushes the endpoint in case the relay lost it.
        this.s.setLocal(`remote:pushed:${c.remote.key}`, undefined);
        this.report(c, false, "could not connect to the relay");
        return undefined;
      },
    });
    return socket;
  }

  private async answer(c: Conn, ws: WebSocket, inflight: Map<string, AbortController>, frame: RequestFrame) {
    const { id } = frame;
    const send = (frame: RemoteResponseFrame) => {
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        /* socket closed; the relay already failed it */
      }
    };
    if (inflight.size >= REMOTE_LIMITS.inFlight) {
      return send({ t: "res", id, status: 503, headers: {}, body: "", retry: true });
    }

    const abort = new AbortController();
    inflight.set(id, abort);
    const started = Date.now();
    const failure = (status: number, code: number, message: string): RemoteResponseFrame => ({
      t: "res",
      id,
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    });
    let status = 500;
    let label = "request";
    try {
      const message = JSON.parse(frame.body) as { method?: string; params?: { name?: string } };
      label =
        message.method === "tools/call"
          ? `tools/call ${message.params?.name ?? ""}`
          : String(message.method ?? "request");
    } catch {
      /* the gateway answers with a parse error */
    }
    try {
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(REMOTE_LIMITS.timeoutMs)]);
      const answered = await this.gateway.handleRemote(c.id, frame.body, frame.headers, signal);
      const response = answered.response;
      c.failed = answered.failed;
      const text = await response.text();
      status = response.status;
      if (text.length > REMOTE_LIMITS.responseBytes) {
        status = 413;
        return send(failure(status, -32000, "response too large for the relay (4 MiB)"));
      }
      const type = response.headers.get("content-type");
      send({ t: "res", id, status, headers: type ? { "content-type": type } : {}, body: text });
    } catch (e) {
      if (abort.signal.aborted) return; // the relay already answered the client
      send(failure(500, -32603, "agentgate failed to handle the request"));
      this.report(c, c.connected, describe(e, REQUEST_FAILED));
    } finally {
      inflight.delete(id);
      c.lastCall = Date.now();
      this.s.log("remote", c.id, label.slice(0, 200), status, Date.now() - started);
    }
  }

  /** One pass at a time: a slow relay would otherwise pile up a pass per reconcile. */
  private drainDeletes = serialTask(async () => {
    const queue = (deletes.get(this.s) ?? []).filter((d) => (d.nextAt ?? 0) <= this.s.now());
    if (!queue.length) return;
    const left: typeof queue = [];
    for (const d of queue) {
      try {
        const key = serviceKeyFor(this.s, d.relay);
        const res = await fetchHeaders(
          `${d.relay}/e/${d.key}`,
          { method: "DELETE", headers: { authorization: `Bearer ${d.token}`, ...(key && { "x-relay-key": key }) } },
          10_000,
        );
        await res.body?.cancel();
        if (!res.ok && res.status !== 404 && res.status !== 401) left.push(d);
      } catch {
        left.push(d);
      }
    }
    // Re-read: regenerate may have queued more meanwhile. A relay that keeps failing is asked less often, up to hourly.
    const now = deletes.get(this.s) ?? [];
    const done = new Set(queue.filter((d) => !left.includes(d)).map((d) => d.key));

    const failed = new Map(
      left.map((d) => {
        const attempts = (d.attempts ?? 0) + 1;
        const wait = exponentialBackoff(attempts, { baseMs: 30_000, maxMs: 3_600_000, jitter: false });
        return [d.key, { ...d, attempts, nextAt: this.s.now() + wait }];
      }),
    );
    deletes.set(
      this.s,
      undefined,
      now.filter((d) => !done.has(d.key)).map((d) => failed.get(d.key) ?? d),
    );
  });

  close() {
    this.closed = true;
    for (const id of [...this.conns.keys()]) this.stop(id);
  }
}

/** Projects as the API shows them: endpoint state without key material. */
export function publicProject(p: Project, endpoints: RemoteEndpoints): PublicProject {
  const { remote, files, ...rest } = sent<Data<"project">>(p);
  const summary = endpoints.summary(p);
  const shown = files && { files: files.filter((f) => !f.deleted).map(({ path, updatedAt }) => ({ path, updatedAt })) };
  return {
    ...rest,
    ...shown,
    ...(summary && { remote: summary }),
  };
}
