import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { T3NodeState, T3PairingLink } from "@agentgate/protocol";
import { z } from "zod";
import { defineLocal } from "../local-state.ts";
import { fetchHeaders, readBody } from "../runtime.ts";
import type { Store } from "../store.ts";

/** A minimal client for the T3 Code server on this machine (loopback HTTP and its Effect RPC WebSocket).
 * Talks to unmodified upstream T3 Code; the shapes below are the fields of its contracts we use. */

/** T3's ORCHESTRATION_PROTOCOL_VERSION. It changed once in T3's history; a mismatch fails loudly. */
const T3_PROTOCOL = 2;
const PROTOCOL_HEADER = "x-t3-orchestration-protocol";
/** Bearer tokens live 30 days with no refresh token; ask for a new pairing a few days ahead. */
const REPAIR_AHEAD = 3 * 86_400_000;
const STREAM_PING_MS = 15_000;

const hostedSegment = (id: string) =>
  encodeURIComponent(id).replace(/[.!~*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** The link T3 gives MCP clients outside it (its shared `hostedThreadLink`): app.t3.codes offers the desktop app, the
 * mobile app or itself, so it opens a thread on any machine from any machine. A T3 Code started with
 * `T3CODE_HOSTED_APP_URL` links to that host instead; agentgate cannot see the setting and keeps app.t3.codes. */
export const hostedThreadLink = (environmentId: string, threadId: string) =>
  `https://app.t3.codes/threads/${hostedSegment(environmentId)}/${hostedSegment(threadId)}`;

export class T3Error extends Error {}
/** T3 Code refused a call because agentgate's token lacks a permission. Newer T3 Code splits permissions finer (in
 * October 2026 cloning moved to `source-control:write`) and never widens a token it issued, so only a new pairing helps. */
export class T3PermissionError extends T3Error {}

const run = z
  .object({
    id: z.string(),
    status: z.string(),
    userMessageId: z.string().optional(),
    ordinal: z.number().optional(),
    queuePosition: z.number().nullable().optional(),
  })
  .passthrough();
const threadShell = z
  .object({
    id: z.string(),
    projectId: z.string(),
    title: z.string(),
    providerInstanceId: z.string(),
    branch: z.string().nullable(),
    worktreePath: z.string().nullable(),
    status: z.string(),
    archivedAt: z.string().nullable(),
    updatedAt: z.string(),
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
  })
  .passthrough();
const projectShell = z
  .object({
    id: z.string(),
    title: z.string(),
    workspaceRoot: z.string(),
    scripts: z.array(z.object({ command: z.string(), runOnWorktreeCreate: z.boolean() }).passthrough()).default([]),
    repositoryIdentity: z
      .object({ canonicalKey: z.string().optional(), displayName: z.string().optional(), name: z.string().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
const shellSchema = z.object({ threads: z.array(threadShell), projects: z.array(projectShell) }).passthrough();
const projectionSchema = z
  .object({
    thread: z
      .object({
        id: z.string(),
        projectId: z.string(),
        title: z.string(),
        providerInstanceId: z.string(),
        modelSelection: z.record(z.string(), z.unknown()),
        runtimeMode: z.string(),
        interactionMode: z.string(),
        branch: z.string().nullable(),
        worktreePath: z.string().nullable(),
        activeProviderThreadId: z.string().nullable(),
        archivedAt: z.string().nullable(),
        settledOverride: z.enum(["settled", "active"]).nullable().optional(),
      })
      .passthrough(),
    runs: z.array(run),
    /** Server-made messages (notifications, delegated results) carry `notification` or `delegatedCompletion`. */
    messages: z
      .array(
        z
          .object({
            id: z.string(),
            text: z.string(),
            attachments: z.array(z.unknown()).default([]),
            notification: z.unknown().optional(),
            delegatedCompletion: z.unknown().optional(),
          })
          .passthrough(),
      )
      .default([]),
    providerThreads: z.array(
      z
        .object({
          id: z.string(),
          driver: z.string(),
          nativeThreadRef: z.object({ nativeId: z.string().nullable(), strength: z.string() }).nullable(),
          /** Claude's background commands, monitors and agents, which outlive the turn that started them. */
          pendingBackgroundTasks: z
            .array(z.object({ kind: z.string().optional(), description: z.string().optional() }).passthrough())
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type Call = <T = unknown>(method: string, payload: unknown) => Promise<T>;

/** Run states that still hold the thread. */
export const ACTIVE = new Set(["preparing", "starting", "running", "waiting"]);
/** A thread whose turn is going or about to: the active states, and a turn queued behind one. T3 counts `waiting` as
 * active too, as the turn waits on background work such as a command or a subagent; a thread that waits on a person
 * has a pending request instead. */
export const isWorkingStatus = (status: string) => ACTIVE.has(status) || status === "queued";
export const TERMINAL = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);

export class T3 {
  constructor(
    readonly url: string,
    private token: string,
    readonly node: string,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const signal = AbortSignal.timeout(30_000);
    const res = await fetchHeaders(`${this.url}${path}`, {
      ...init,
      signal,
      redirect: "manual",
      headers: { authorization: `Bearer ${this.token}`, [PROTOCOL_HEADER]: String(T3_PROTOCOL), ...init.headers },
    }).catch(() => {
      throw new T3Error(`T3 Code on ${this.node} is not reachable at ${this.url}`);
    });
    const text = new TextDecoder().decode(await readBody(res.body, 64 * 1024 * 1024, signal));

    if (res.status === 426 || text.includes("orchestration_protocol_incompatible")) {
      throw new T3Error(`T3 Code on ${this.node} uses a newer protocol; update agentgate`);
    }
    if (res.status === 401 || res.status === 403)
      throw new T3Error(`T3 Code on ${this.node} rejected agentgate's token; pair it again`);
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

  /** The id T3's thread links name this T3 Code by. */
  async environmentId() {
    const environment = z.object({ environmentId: z.string().min(1) }).passthrough();
    return environment.parse(await this.request("/.well-known/t3/environment")).environmentId;
  }

  /** A WebSocket to T3's Effect RPC endpoint, opened with a single-use ticket. */
  private async open() {
    const { ticket } = z
      .object({ ticket: z.string() })
      .parse(await this.request("/api/auth/websocket-ticket", { method: "POST" }));
    const query = new URLSearchParams({ wsTicket: ticket, orchestrationProtocol: String(T3_PROTOCOL) });
    const ws = new WebSocket(`${this.url.replace(/^http/, "ws")}/ws?${query}`);
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
    } catch (error) {
      ws.close();
      throw error;
    }
    return ws;
  }

  /** One short-lived WebSocket for a batch of RPC calls. */
  async rpc<T>(fn: (call: Call) => Promise<T>): Promise<T> {
    const ws = await this.open();
    const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const failAll = (error: Error) => {
      for (const p of pending.values()) p.reject(error);
      pending.clear();
    };

    try {
      ws.onclose = () => failAll(new T3Error(`T3 Code on ${this.node} closed the WebSocket`));
      ws.onmessage = (event) => {
        const frame = parseFrame(event.data);
        if (frame?._tag === "Ping") return ws.send(JSON.stringify({ _tag: "Pong" }));
        if (frame?._tag !== "Exit" || !frame.requestId) return;
        const p = pending.get(frame.requestId);
        if (!p) return;
        pending.delete(frame.requestId);
        if (frame.exit?._tag === "Success") p.resolve(frame.exit.value);
        else p.reject(failure(this.node, frame.exit?.cause));
      };

      let next = 0;
      const call: Call = <R>(method: string, payload: unknown) =>
        new Promise<R>((resolve, reject) => {
          const id = String(++next);
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new T3Error(`T3 Code on ${this.node} did not answer ${method}`));
          }, 120_000);
          pending.set(id, {
            resolve: (v) => {
              clearTimeout(timer);
              resolve(v as R);
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
          });
          ws.send(JSON.stringify({ _tag: "Request", id, tag: method, payload, headers: [] }));
        });
      return await fn(call);
    } finally {
      ws.close();
    }
  }

  /** Read one of T3's streaming RPCs, such as `orchestration.subscribeShell`, on its own WebSocket until T3 ends it,
   * the socket drops or `signal` aborts. T3 sends the next chunk only after the last one is acknowledged, so each is
   * acknowledged once `onValues` has taken it. T3 never pings a client, so a ping that goes unanswered for a whole
   * interval ends the stream instead of leaving it hanging on a dead connection. */
  async stream(method: string, payload: unknown, onValues: (values: unknown[]) => void, signal: AbortSignal) {
    signal.throwIfAborted();
    const ws = await this.open();
    const id = "1";
    let ping: ReturnType<typeof setInterval> | undefined;
    let onAbort = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort);
        if (signal.aborted) return onAbort(); // aborted while the socket opened
        let heard = true;
        ping = setInterval(() => {
          if (!heard) return reject(new T3Error(`T3 Code on ${this.node} stopped answering ${method}`));
          heard = false;
          ws.send(JSON.stringify({ _tag: "Ping" }));
        }, STREAM_PING_MS);
        ws.onclose = () => reject(new T3Error(`T3 Code on ${this.node} closed the WebSocket`));
        ws.onerror = () => reject(new T3Error(`T3 Code on ${this.node} broke the WebSocket`));
        ws.onmessage = (event) => {
          heard = true;
          const frame = parseFrame(event.data);
          if (frame?._tag === "Ping") return ws.send(JSON.stringify({ _tag: "Pong" }));
          if (frame?.requestId !== id) return;
          if (frame._tag === "Chunk") {
            try {
              onValues(Array.isArray(frame.values) ? frame.values : []);
            } catch (error) {
              return reject(error);
            }
            ws.send(JSON.stringify({ _tag: "Ack", requestId: id }));
          } else if (frame._tag === "Exit") {
            if (frame.exit?._tag === "Success") resolve();
            else reject(failure(this.node, frame.exit?.cause));
          }
        };
        ws.send(JSON.stringify({ _tag: "Request", id, tag: method, payload, headers: [] }));
      });
    } finally {
      clearInterval(ping);
      signal.removeEventListener("abort", onAbort);
      ws.close();
    }
  }
}

type Frame = {
  _tag?: string;
  requestId?: string;
  values?: unknown;
  exit?: { _tag: string; value?: unknown; cause?: unknown };
};
function parseFrame(data: unknown): Frame | undefined {
  try {
    return JSON.parse(String(data));
  } catch {
    return undefined; // not an RPC frame
  }
}

function failure(node: string, cause: unknown) {
  const denied = (Array.isArray(cause) ? cause : [cause])
    .map((c) => (c as { error?: { _tag?: unknown; requiredPermission?: unknown; requiredScope?: unknown } })?.error)
    .find((e) => e?._tag === "EnvironmentAuthorizationError");
  if (denied) {
    const permission = String(denied.requiredPermission ?? denied.requiredScope);
    return new T3PermissionError(
      `T3 Code on ${node} has not given agentgate the ${permission} permission; pair it again: Connect T3 Code under Machines on the T3 Code page, or agentgate t3 connect on ${node}`,
    );
  }
  return new T3Error(`T3 Code on ${node}: ${causeText(cause)}`);
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

/** What connecting takes: T3's pairing link, its URL and the token `t3 pair` prints, or `create` to have this machine's
 * T3 Code create the link itself. */
export const connectInput = z.union([
  z.object({ pairingUrl: z.string().min(1).max(4096) }).strict(),
  z.object({ url: z.string().min(1).max(2048), token: z.string().min(1).max(4096) }).strict(),
  z.object({ create: z.literal(true) }).strict(),
]);
export async function connectWith(s: Store, input: z.infer<typeof connectInput>) {
  if ("create" in input) {
    const { bin, link } = await pair(s, { label: `agentgate ${s.nodeId}` });
    return connectT3(s, parsePairing(link.url), bin);
  }
  return connectT3(s, "pairingUrl" in input ? parsePairing(input.pairingUrl) : input);
}

/** The `t3` of the T3 Code server that runs from `home`, T3's own folder (normally ~/.t3), or undefined when it keeps
 * no versions there. A T3 Code service that updates itself keeps every version in a folder of its own and names the
 * one it runs as `activeVersion` in `runtime/service-state.json`, a file of T3's that is no public interface. */
export function activeT3(home: string) {
  try {
    const state = JSON.parse(readFileSync(join(home, "runtime", "service-state.json"), "utf8"));
    const { activeVersion } = z.object({ activeVersion: z.string().regex(/^\w[\w.+-]*$/) }).parse(state);
    return [join(home, "runtime", "versions", activeVersion, "t3")].find((p) => existsSync(p));
  } catch {
    return undefined; // no state file, or one agentgate cannot read
  }
}

/** T3 Code's own CLI: the running server's own binary first, because the `t3` on PATH can be an older launcher whose
 * pairing tokens the server refuses and which lacks `--scope`; then `t3` on PATH, then the launcher T3 Code's desktop
 * app writes. Tests point it elsewhere. */
export const host = {
  t3: () =>
    activeT3(process.env.T3CODE_HOME || join(homedir(), ".t3")) ??
    Bun.which("t3") ??
    [join(homedir(), ".t3", "bin", "t3")].find((p) => existsSync(p)),
};

export const pairingLinkInput = z.object({ tailscale: z.boolean().optional() }).strict();
type PairOptions = { label?: string; tailscale?: boolean; scopes?: string[] };

/** A new single-use pairing link from the T3 Code server running on this machine, made by its `t3 pair`, which writes
 * straight into T3's own state: no token of ours is needed, so it also works when agentgate's token expired. With
 * `tailscale`, T3 Code publishes itself over Tailscale Serve (a lasting change T3 reports in the notes) so the link
 * works from other machines. `scopes` replaces T3's default set of permissions for the link. */
export async function createPairingLink(s: Store, options: PairOptions = {}): Promise<T3PairingLink> {
  return (await pair(s, options)).link;
}

/** The link, and the `t3` binary that made it. */
async function pair(s: Store, options: PairOptions) {
  const bin = host.t3();
  if (!bin)
    throw new T3Error(
      `T3 Code's t3 command is not installed on ${s.nodeId}; open T3 Code there once, or create a pairing link in its Settings → Connections`,
    );
  const child = Bun.spawn(
    [
      bin,
      "pair",
      "--log-level",
      "error",
      ...(options.label ? ["--label", options.label] : []),
      ...(options.tailscale ? ["--tailscale"] : []),
      ...(options.scopes ?? []).flatMap((scope) => ["--scope", scope]),
    ],
    {
      // Run inside a T3 worktree, `t3 pair` looks for a server in the worktree's own `.t3` and finds none.
      cwd: homedir(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = (key: string) => out.match(new RegExp(`^${key}: (.+)$`, "m"))?.[1]?.trim();
  const url = line("Pairing URL");
  // stdout holds the token; only stderr may go into an error. The binary is named so that a `t3` that is not the
  // running server's shows: an older one prints its usage for a flag it does not know.
  if (code !== 0 || !url) {
    const why = err.trim().split("\n").at(-1)?.slice(0, 300) || (code ? `exit ${code}` : "it printed no pairing link");
    throw new T3Error(`t3 pair failed on ${s.nodeId} (${bin}): ${why}`);
  }
  return {
    bin,
    link: { url, expiresAt: line("Expires"), notes: [...out.matchAll(/^Note: (.+)$/gm)].map((m) => m[1]!.trim()) },
  };
}

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
  if (u.protocol !== "http:" || !u.port)
    throw new T3Error(
      "connect agentgate to the T3 Code server on this machine: use its pairing link, or --url http://127.0.0.1:<port>",
    );
  return `http://127.0.0.1:${u.port}`;
}

/** Exchange a single-use pairing token for a 30-day bearer token. `mintedBy` is the `t3` binary that made the token a
 * moment ago, when agentgate ran it itself: a refusal then points at the binary, as the token is neither used nor old. */
export async function connectT3(s: Store, input: { url: string; token: string }, mintedBy?: string) {
  const url = loopback(input.url);

  const res = await fetchHeaders(`${url}/oauth/token`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: input.token,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: `agentgate ${s.nodeId}`,
    }),
  }).catch(() => {
    throw new T3Error(`T3 Code is not reachable at ${url}`);
  });
  const text = new TextDecoder().decode(await readBody(res.body, 1024 * 1024, AbortSignal.timeout(15_000)));
  if (res.status === 400 || res.status === 401)
    throw new T3Error(
      mintedBy
        ? `T3 Code on ${s.nodeId} rejected the pairing token ${mintedBy} had just created, so that t3 may not belong to the running T3 Code; create a pairing link in its Settings → Connections and connect with that`
        : "T3 Code rejected the pairing token; it is single-use and expires, so create a new pairing link",
    );
  if (!res.ok) throw new T3Error(`T3 Code answered ${res.status} to the pairing`);

  const token = z
    .object({ access_token: z.string().min(1), expires_in: z.number().positive() })
    .parse(JSON.parse(text));
  const label = await fetchHeaders(`${url}/.well-known/t3/environment`, { signal: AbortSignal.timeout(5000) }).then(
    async (r) =>
      r.ok
        ? z
            .object({ label: z.string() })
            .passthrough()
            .parse(await r.json()).label
        : undefined,
    () => undefined,
  );
  s.transaction(() => {
    t3Local.set(s, "url", url);
    t3Local.set(s, "token", token.access_token);
    t3Local.set(s, "expiresAt", String(s.now() + token.expires_in * 1000));
    t3Local.set(s, "label", label);
  });

  // Check the protocol now rather than at the first handoff.
  await new T3(url, token.access_token, s.nodeId).shell();
  return t3State(s);
}

// This node's T3 Code connection, which the app shows with the threads.
const t3Local = defineLocal("t3:", z.string(), { topic: "threads" });

export function disconnectT3(s: Store) {
  s.transaction(() => {
    for (const key of ["url", "token", "expiresAt", "label"]) t3Local.set(s, key, undefined);
  });
}

export function t3State(s: Store): T3NodeState {
  const url = t3Local.get(s, "url");
  if (!url || !t3Local.get(s, "token")) return { connected: false };
  const expiresAt = Number(t3Local.get(s, "expiresAt") ?? 0);
  const projectSyncError = t3Local.get(s, "projectSyncError");
  return {
    connected: s.now() < expiresAt,
    url,
    label: t3Local.get(s, "label"),
    expiresAt,
    repair: s.now() > expiresAt - REPAIR_AHEAD,
    ...(projectSyncError && { projectSyncError }),
  };
}

/** This node's T3 client, or an error that says how to connect. */
export function t3Client(s: Store): T3 {
  const state = t3State(s);
  if (!state.url) throw new T3Error(`T3 Code is not connected on ${s.nodeId}; run agentgate t3 connect there`);
  if (!state.connected) throw new T3Error(`agentgate's T3 Code token on ${s.nodeId} expired; pair T3 Code again there`);
  return new T3(state.url, t3Local.get(s, "token")!, s.nodeId);
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
  const instance = z
    .object({
      driver: z.string(),
      config: z.object({ homePath: z.string().optional() }).passthrough().optional(),
      environment: z.array(z.object({ name: z.string(), value: z.string().optional() })).optional(),
    })
    .passthrough();
  const settings = z
    .object({
      providerInstances: z.record(z.string(), instance).optional(),
      providers: z
        .object({ claudeAgent: z.object({ homePath: z.string().optional() }).passthrough().optional() })
        .passthrough()
        .optional(),
    })
    .passthrough();
  const config = z
    .object({ settings })
    .passthrough()
    .parse(await call("server.getConfig", {}));

  const homes: [string, string | undefined][] = Object.entries(config.settings.providerInstances ?? {})
    .filter(([, i]) => i.driver === "claudeAgent")
    .map(([id, i]) => [id, i.config?.homePath || i.environment?.find((v) => v.name === "CLAUDE_CONFIG_DIR")?.value]);
  if (!homes.some(([id]) => id === "claudeAgent"))
    homes.push(["claudeAgent", config.settings.providers?.claudeAgent?.homePath]);
  return homes.map(([id, home]) => [id, real(home || defaultHome)]);
}

/** The Claude provider instance a thread runs with here, and the home its sessions live in: `instanceId` when this
 * T3 Code has it, else the default instance. Imported threads are named after the instance. */
export async function claudeInstance(call: Call, instanceId: string | undefined, defaultHome: string) {
  const homes = await claudeHomes(call, defaultHome);
  const [id, home] = homes.find(([i]) => i === instanceId) ?? homes.find(([i]) => i === "claudeAgent")!;
  return { instanceId: id, home };
}
