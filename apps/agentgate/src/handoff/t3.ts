import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { T3NodeState } from "@agentgate/protocol";
import { z } from "zod";
import { fetchHeaders, readBody } from "../runtime.ts";
import type { Store } from "../store.ts";

/** A minimal client for the T3 Code server on this machine (loopback HTTP and its Effect RPC WebSocket).
 * Talks to unmodified upstream T3 Code; the shapes below are the fields of its contracts we use. */

/** T3's ORCHESTRATION_PROTOCOL_VERSION. It changed once in T3's history; a mismatch fails loudly. */
const T3_PROTOCOL = 2;
const PROTOCOL_HEADER = "x-t3-orchestration-protocol";
/** Bearer tokens live 30 days with no refresh token; ask for a new pairing a few days ahead. */
const REPAIR_AHEAD = 3 * 86_400_000;

export class T3Error extends Error { }

const run = z.object({ id: z.string(), status: z.string(), userMessageId: z.string().optional() }).passthrough();
const threadShell = z.object({
  id: z.string(), projectId: z.string(), title: z.string(), providerInstanceId: z.string(),
  branch: z.string().nullable(), worktreePath: z.string().nullable(), status: z.string(),
  archivedAt: z.string().nullable(), updatedAt: z.string(),
  /** "settled" moves a thread to T3's Settled section; absent on older servers. */
  settledOverride: z.enum(["settled", "active"]).nullable().optional(),
  latestUserMessageAt: z.string().nullable().optional(),
  activityRunStartedAt: z.string().nullable().optional(),
  /** Sidebar order (pins and drag order); optional on older servers. */
  createdAt: z.string(),
  unsettledAt: z.string().nullable().optional(),
  pinnedAt: z.string().nullable().optional(),
  pinOrderKey: z.string().nullable().optional(),
  activeOrderKey: z.string().nullable().optional(),
  /** A subagent thread is a delegated child of another thread; T3 nests it under its parent. */
  lineage: z.object({ relationshipToParent: z.string().nullable().optional() }).passthrough().optional(),
}).passthrough();
const projectShell = z.object({
  id: z.string(), title: z.string(), workspaceRoot: z.string(),
  scripts: z.array(z.object({ command: z.string(), runOnWorktreeCreate: z.boolean() }).passthrough()).default([]),
  repositoryIdentity: z.object({ canonicalKey: z.string().optional(), displayName: z.string().optional(), name: z.string().optional() }).passthrough().nullable().optional(),
}).passthrough();
const shellSchema = z.object({ threads: z.array(threadShell), projects: z.array(projectShell) }).passthrough();
const projectionSchema = z.object({
  thread: z.object({
    id: z.string(), projectId: z.string(), title: z.string(), providerInstanceId: z.string(),
    modelSelection: z.record(z.string(), z.unknown()), runtimeMode: z.string(), interactionMode: z.string(),
    branch: z.string().nullable(), worktreePath: z.string().nullable(), activeProviderThreadId: z.string().nullable(), archivedAt: z.string().nullable(),
    settledOverride: z.enum(["settled", "active"]).nullable().optional(),
  }).passthrough(),
  runs: z.array(run),
  providerThreads: z.array(z.object({
    id: z.string(), driver: z.string(),
    nativeThreadRef: z.object({ nativeId: z.string().nullable(), strength: z.string() }).nullable(),
    /** Claude's background commands, monitors and agents, which outlive the turn that started them. */
    pendingBackgroundTasks: z.array(z.object({ kind: z.string().optional(), description: z.string().optional() }).passthrough()).optional(),
  }).passthrough()),
}).passthrough();
export type Call = <T = unknown>(method: string, payload: unknown) => Promise<T>;

/** Run states that still hold the thread. */
export const ACTIVE = new Set(["preparing", "starting", "running", "waiting"]);
export const TERMINAL = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);

export class T3 {
  constructor(readonly url: string, private token: string, readonly node: string) { }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const signal = AbortSignal.timeout(30_000);
    const res = await fetchHeaders(`${this.url}${path}`, {
      ...init, signal, redirect: "manual",
      headers: { authorization: `Bearer ${this.token}`, [PROTOCOL_HEADER]: String(T3_PROTOCOL), ...init.headers },
    }).catch(() => { throw new T3Error(`T3 Code on ${this.node} is not reachable at ${this.url}`); });
    const text = new TextDecoder().decode(await readBody(res.body, 64 * 1024 * 1024, signal));

    if (res.status === 426 || text.includes("orchestration_protocol_incompatible")) {
      throw new T3Error(`T3 Code on ${this.node} uses a newer protocol; update agentgate`);
    }
    if (res.status === 401 || res.status === 403) throw new T3Error(`T3 Code on ${this.node} rejected agentgate's token; pair it again`);
    if (!res.ok) throw new T3Error(`T3 Code on ${this.node} answered ${res.status} for ${path}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new T3Error(`T3 Code on ${this.node} sent an unreadable answer for ${path}`);
    }
  }

  async shell() {
    return shellSchema.parse(await this.request("/api/orchestration/shell"));
  }

  /** One short-lived WebSocket for a batch of RPC calls. */
  async rpc<T>(fn: (call: Call) => Promise<T>): Promise<T> {
    const { ticket } = z.object({ ticket: z.string() }).parse(await this.request("/api/auth/websocket-ticket", { method: "POST" }));
    const query = new URLSearchParams({ wsTicket: ticket, orchestrationProtocol: String(T3_PROTOCOL) });
    const ws = new WebSocket(`${this.url.replace(/^http/, "ws")}/ws?${query}`);
    const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const failAll = (error: Error) => {
      for (const p of pending.values()) p.reject(error);
      pending.clear();
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new T3Error(`T3 Code on ${this.node} did not open a WebSocket`)), 10_000);
        ws.onopen = () => {
          clearTimeout(timer);
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new T3Error(`T3 Code on ${this.node} refused the WebSocket`));
        };
      }).catch(async (error) => {
        // An upgrade refused for the protocol shows up only on an HTTP read.
        await this.shell();
        throw error;
      });
      ws.onclose = () => failAll(new T3Error(`T3 Code on ${this.node} closed the WebSocket`));
      ws.onmessage = (event) => {
        let frame: { _tag?: string; requestId?: string; exit?: { _tag: string; value?: unknown; cause?: unknown } };
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          return; // not an RPC frame
        }
        if (frame._tag === "Ping") return ws.send(JSON.stringify({ _tag: "Pong" }));
        if (frame._tag !== "Exit" || !frame.requestId) return;
        const p = pending.get(frame.requestId);
        if (!p) return;
        pending.delete(frame.requestId);
        if (frame.exit?._tag === "Success") p.resolve(frame.exit.value);
        else p.reject(new T3Error(`T3 Code on ${this.node}: ${causeText(frame.exit?.cause)}`));
      };

      let next = 0;
      const call: Call = <R>(method: string, payload: unknown) => new Promise<R>((resolve, reject) => {
        const id = String(++next);
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new T3Error(`T3 Code on ${this.node} did not answer ${method}`));
        }, 120_000);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v as R); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        ws.send(JSON.stringify({ _tag: "Request", id, tag: method, payload, headers: [] }));
      });
      return await fn(call);
    } finally {
      ws.close();
    }
  }
}

/** Effect RPC failures carry a cause list of `{ _tag: "Fail", error }` / `{ _tag: "Die", defect }`. */
function causeText(cause: unknown): string {
  const parts = (Array.isArray(cause) ? cause : [cause]).map((c) => {
    const e = (c as { error?: unknown; defect?: unknown })?.error ?? (c as { defect?: unknown })?.defect ?? c;
    if (typeof e === "string") return e;
    const o = e as { message?: unknown; _tag?: unknown };
    if (typeof o?.message === "string") return o.message;
    return typeof o?._tag === "string" ? o._tag : "request failed";
  });
  return parts.join("; ") || "request failed";
}

export const dispatch = (call: Call, command: Record<string, unknown>) =>
  call("orchestration.dispatchCommand", { ...command, commandId: crypto.randomUUID() });
export const projection = async (call: Call, threadId: string) =>
  projectionSchema.parse(await call("orchestration.getThreadProjection", { threadId }));

/** What connecting takes: T3's pairing link, or its URL and the token `t3 pair` prints. */
export const connectInput = z.union([
  z.object({ pairingUrl: z.string().min(1).max(4096) }).strict(),
  z.object({ url: z.string().min(1).max(2048), token: z.string().min(1).max(4096) }).strict(),
]);
export const pairing = (input: z.infer<typeof connectInput>) => "pairingUrl" in input ? parsePairing(input.pairingUrl) : input;

/** `http://host:port/pair#token=XXXX`, the pairing link from T3 Code's Settings → Connections. */
export function parsePairing(link: string): { url: string; token: string } {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    throw new T3Error("expected a T3 Code pairing link like http://127.0.0.1:3773/pair#token=…");
  }
  const token = new URLSearchParams(u.hash.slice(1)).get("token") ?? u.searchParams.get("token");
  if (!token) throw new T3Error("the pairing link has no token");
  return { url: u.origin, token };
}

/** Where to reach the T3 Code on this machine for a link. T3 only shows pairing links with network access on, so a
 * link usually names this machine's LAN address: the same port on loopback reaches the same server, and the token
 * never crosses the network. Loopback only: the daemon talks to its own T3. */
function loopback(link: string): string {
  const u = new URL(link);
  if (["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return u.origin;
  if (u.protocol !== "http:" || !u.port) throw new T3Error("connect agentgate to the T3 Code server on this machine: use its pairing link, or --url http://127.0.0.1:<port>");
  return `http://127.0.0.1:${u.port}`;
}

/** Exchange a single-use pairing token for a 30-day bearer token. */
export async function connectT3(s: Store, input: { url: string; token: string }) {
  const url = loopback(input.url);

  const res = await fetchHeaders(`${url}/oauth/token`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: input.token,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: `agentgate ${s.nodeId}`,
    }),
  }).catch(() => { throw new T3Error(`T3 Code is not reachable at ${url}`); });
  const text = new TextDecoder().decode(await readBody(res.body, 1024 * 1024, AbortSignal.timeout(15_000)));
  if (res.status === 400 || res.status === 401) throw new T3Error("T3 Code rejected the pairing token; it is single-use and expires, so create a new pairing link");
  if (!res.ok) throw new T3Error(`T3 Code answered ${res.status} to the pairing`);

  const token = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() }).parse(JSON.parse(text));
  const label = await fetchHeaders(`${url}/.well-known/t3/environment`, { signal: AbortSignal.timeout(5000) })
    .then(async (r) => r.ok ? z.object({ label: z.string() }).passthrough().parse(await r.json()).label : undefined, () => undefined);
  s.transaction(() => {
    s.setLocal("t3:url", url);
    s.setLocal("t3:token", token.access_token);
    s.setLocal("t3:expiresAt", String(s.now() + token.expires_in * 1000));
    s.setLocal("t3:label", label);
  });

  // Check the protocol now rather than at the first handoff.
  await new T3(url, token.access_token, s.nodeId).shell();
  return t3State(s);
}

export function disconnectT3(s: Store) {
  s.transaction(() => {
    for (const key of ["url", "token", "expiresAt", "label"]) s.setLocal(`t3:${key}`, undefined);
  });
}

export function t3State(s: Store): T3NodeState {
  const url = s.local("t3:url");
  if (!url || !s.local("t3:token")) return { connected: false };
  const expiresAt = Number(s.local("t3:expiresAt") ?? 0);
  const projectSyncError = s.local("t3:projectSyncError");
  return { connected: s.now() < expiresAt, url, label: s.local("t3:label"), expiresAt, repair: s.now() > expiresAt - REPAIR_AHEAD, ...(projectSyncError && { projectSyncError }) };
}

/** This node's T3 client, or an error that says how to connect. */
export function t3Client(s: Store): T3 {
  const state = t3State(s);
  if (!state.url) throw new T3Error(`T3 Code is not connected on ${s.nodeId}; run agentgate t3 connect <pairing link> there`);
  if (!state.connected) throw new T3Error(`agentgate's T3 Code token on ${s.nodeId} expired; pair T3 Code again there`);
  return new T3(state.url, s.local("t3:token")!, s.nodeId);
}

function real(path: string) {
  const absolute = resolve(path.replace(/^~(?=\/|$)/, homedir()));
  try {
    return realpathSync(absolute);
  } catch {
    return absolute; // a home that does not exist yet compares by its path
  }
}

/** Claude provider instances and their homes, from T3's settings: `providerInstances` entries plus the legacy
 * default instance `claudeAgent`. The home is `homePath`, a CLAUDE_CONFIG_DIR environment variable, or else Claude's
 * default home (`defaultHome`, normally ~/.claude). */
export async function claudeHomes(call: Call, defaultHome: string): Promise<[string, string][]> {
  const instance = z.object({
    driver: z.string(),
    config: z.object({ homePath: z.string().optional() }).passthrough().optional(),
    environment: z.array(z.object({ name: z.string(), value: z.string().optional() })).optional(),
  }).passthrough();
  const settings = z.object({
    providerInstances: z.record(z.string(), instance).optional(),
    providers: z.object({ claudeAgent: z.object({ homePath: z.string().optional() }).passthrough().optional() }).passthrough().optional(),
  }).passthrough();
  const config = z.object({ settings }).passthrough().parse(await call("server.getConfig", {}));

  const homes: [string, string | undefined][] = Object.entries(config.settings.providerInstances ?? {})
    .filter(([, i]) => i.driver === "claudeAgent")
    .map(([id, i]) => [id, i.config?.homePath || i.environment?.find((v) => v.name === "CLAUDE_CONFIG_DIR")?.value]);
  if (!homes.some(([id]) => id === "claudeAgent")) homes.push(["claudeAgent", config.settings.providers?.claudeAgent?.homePath]);
  return homes.map(([id, home]) => [id, real(home || defaultHome)]);
}

/** The Claude provider instance a thread runs with here, and the home its sessions live in: `instanceId` when this
 * T3 Code has it, else the default instance. Imported threads are named after the instance. */
export async function claudeInstance(call: Call, instanceId: string | undefined, defaultHome: string) {
  const homes = await claudeHomes(call, defaultHome);
  const [id, home] = homes.find(([i]) => i === instanceId) ?? homes.find(([i]) => i === "claudeAgent")!;
  return { instanceId: id, home };
}
