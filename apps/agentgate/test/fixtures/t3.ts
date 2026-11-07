import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { claudeProjectKey } from "../../src/handoff/session.ts";

/** A fake T3 Code server speaking the subset agentgate uses: token exchange, the shell snapshot, and Effect RPC frames
 * over a WebSocket, including the `orchestration.subscribeShell` stream that tests drive through `shell`. Session
 * import follows upstream: only sessions recorded in a project's main checkout, named `import:claudeAgent:<sid>`, an earlier import left as it is (a native thread with the same session is not
 * recognised), and a first turn that fails once. */

type Run = {
  id: string;
  status: string;
  userMessageId?: string;
  ordinal?: number;
  queuePosition?: number | null;
  dispatchedAt?: number;
  settledAt?: number;
};
type Message = { id: string; text: string; attachments: unknown[]; delegatedCompletion?: unknown };
export type FakeThread = {
  id: string;
  projectId: string;
  title: string;
  providerInstanceId: string;
  modelSelection: Record<string, unknown>;
  runtimeMode: string;
  interactionMode: string;
  branch: string | null;
  worktreePath: string | null;
  archivedAt: string | null;
  updatedAt: string;
  runs: Run[];
  settledOverride?: "settled" | "active" | null;
  subagent?: boolean;
  /** A subagent's parent thread, as T3's lineage names it. */
  parentThreadId?: string;
  createdAt: string;
  pinnedAt?: string | null;
  pinOrderKey?: string | null;
  activeOrderKey?: string | null;
  sessionId: string;
  failNextTurn?: boolean;
  /** The shell state a turn driven through `/mcp` set (fixtures/t3-mcp.ts), which every view of the shell shows: the
   * stream, a resumed stream's snapshot and a poll. Without it the status comes from `runs`. */
  shell?: { status: string; needsYou: boolean };
  messages: string[];
  conversation?: Message[];
  background?: { kind: string; description: string }[];
};
type Project = {
  id: string;
  title: string;
  workspaceRoot: string;
  scripts: { id: string; name: string; command: string; icon: string; runOnWorktreeCreate: boolean }[];
};

export function fakeT3(options: {
  claudeDir: string;
  protocol?: number;
  label?: string;
  /** Tried before the fake's own routes, on the same origin; `undefined` falls through to them. */
  routes?: (req: Request) => Response | Promise<Response> | undefined;
}) {
  const threads = new Map<string, FakeThread>();
  const projects: Project[] = [];
  const pairing = new Set<string>();
  const tokens = new Set<string>();
  const tickets = new Set<string>();
  const commands: Record<string, unknown>[] = [];
  const clones: Record<string, unknown>[] = [];
  const protocol = String(options.protocol ?? 2);
  /** Open `orchestration.subscribeShell` streams, by socket and request id. */
  const streams = new Set<{ ws: ServerWebSocket<{ ok: true }>; id: string }>();
  const exitAll = (exit: unknown) => {
    for (const sub of streams) sub.ws.send(JSON.stringify({ _tag: "Exit", requestId: sub.id, exit }));
    streams.clear();
  };
  const shell = {
    /** Send a stream item (`thread.updated`, `project.updated`…) to every open subscription. */
    push(item: unknown) {
      for (const sub of streams) sub.ws.send(JSON.stringify({ _tag: "Chunk", requestId: sub.id, values: [item] }));
    },
    /** End every open subscription successfully. */
    end() {
      exitAll({ _tag: "Success", value: null });
    },
    /** End every open subscription with a failure. */
    fail(message: string) {
      exitAll({
        _tag: "Failure",
        cause: [{ _tag: "Fail", error: { _tag: "OrchestrationV2GetShellSnapshotError", message } }],
      });
    },
    /** Close the sockets of every open subscription. */
    drop() {
      for (const sub of streams) sub.ws.close();
      streams.clear();
    },
    acks: 0,
    subscriptions: [] as { afterSequence?: number }[],
  };
  const now = () => new Date().toISOString();
  const status = (t: FakeThread) =>
    t.shell?.status ??
    t.runs.find((r) => ["preparing", "starting", "running", "waiting", "queued"].includes(r.status))?.status ??
    "idle";
  const shellThread = (t: FakeThread) => ({
    id: t.id,
    projectId: t.projectId,
    title: t.title,
    providerInstanceId: t.providerInstanceId,
    branch: t.branch,
    worktreePath: t.worktreePath,
    status: status(t),
    ...(t.shell?.needsYou && {
      pendingRuntimeRequest: { id: "request-1", kind: "user-input", createdAt: t.updatedAt },
    }),
    archivedAt: t.archivedAt,
    updatedAt: t.updatedAt,
    createdAt: t.createdAt,
    pinnedAt: t.pinnedAt ?? null,
    pinOrderKey: t.pinOrderKey ?? null,
    activeOrderKey: t.activeOrderKey ?? null,
    settledOverride: t.settledOverride ?? null,
    lineage: { parentThreadId: t.parentThreadId ?? null, relationshipToParent: t.subagent ? "subagent" : null },
  });
  const projection = (t: FakeThread) => ({
    thread: {
      id: t.id,
      projectId: t.projectId,
      title: t.title,
      providerInstanceId: t.providerInstanceId,
      modelSelection: t.modelSelection,
      runtimeMode: t.runtimeMode,
      interactionMode: t.interactionMode,
      branch: t.branch,
      worktreePath: t.worktreePath,
      activeProviderThreadId: `pt-${t.id}`,
      archivedAt: t.archivedAt,
      settledOverride: t.settledOverride ?? null,
    },
    runs: t.runs,
    messages: t.conversation ?? [],
    providerThreads: [
      {
        id: `pt-${t.id}`,
        driver: "claudeAgent",
        nativeThreadRef: { nativeId: t.sessionId, strength: "strong" },
        pendingBackgroundTasks: t.background ?? [],
      },
    ],
  });
  const snapshot = () => {
    const all = [...threads.values()];
    return {
      threads: all.filter((t) => !t.archivedAt).map(shellThread),
      archivedThreads: all.filter((t) => t.archivedAt).map(shellThread),
      projects,
    };
  };
  const settle = (t: FakeThread, run: Run, outcome: string, ms = 20) =>
    setTimeout(() => {
      run.status = outcome;
      run.settledAt = Date.now();
      t.updatedAt = now();
    }, ms);

  const rpc: Record<string, (p: Record<string, unknown>) => unknown> = {
    "server.getConfig": () => ({
      settings: { providerInstances: {}, providers: { claudeAgent: api.homePath ? { homePath: api.homePath } : {} } },
    }),
    "orchestration.getThreadProjection": (p) => {
      const t = threads.get(String(p.threadId));
      if (!t) throw { _tag: "OrchestrationV2ThreadNotFoundError", message: "thread not found" };
      return projection(t);
    },
    "projects.mutate": (p) => {
      const project = {
        id: String(p.projectId),
        title: String(p.title),
        workspaceRoot: String(p.workspaceRoot),
        scripts: [],
      };
      projects.push(project);
      return project;
    },
    // Like upstream: the project is registered at once and the clone runs in the background (not simulated here).
    "projectClone.start": (p) => {
      // Like upstream T3 Code since October 2026 for a token paired before cloning got its own permission.
      if (api.denyClones)
        throw {
          _tag: "EnvironmentAuthorizationError",
          message: "The authenticated token is missing required scope: source-control:write.",
          requiredScope: "orchestration:operate",
          requiredPermission: "source-control:write",
        };
      clones.push(p);
      projects.push({
        id: String(p.projectId),
        title: String(p.title),
        workspaceRoot: String(p.destinationPath),
        scripts: [],
      });
      return {
        projectId: p.projectId,
        cwd: p.destinationPath,
        remoteUrl: `https://github.com/${p.repository}.git`,
        repository: null,
      };
    },
    "agentSessions.scan": () => ({ candidates: [] }),
    "agentSessions.import": (p) => {
      const project = projects.find((pr) => pr.id === p.projectId)!;
      const dir = join(options.claudeDir, "projects", claudeProjectKey(realpathSync(project.workspaceRoot)));
      let importedCount = 0;
      for (const file of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : []) {
        const sessionId = file.slice(0, -6);
        // Like upstream: only its own earlier imports count, not a native thread that holds the same session.
        const id = `import:claudeAgent:${sessionId}`;
        if (threads.has(id)) continue;
        threads.set(id, {
          id,
          projectId: project.id,
          title: "Imported",
          providerInstanceId: "claudeAgent",
          modelSelection: { instanceId: "claudeAgent", model: "default" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          archivedAt: null,
          settledOverride: "settled",
          updatedAt: now(),
          createdAt: now(),
          runs: [],
          sessionId,
          failNextTurn: true,
          messages: [],
        });
        importedCount++;
      }
      return { importedCount, skippedCount: 0 };
    },
    "orchestration.dispatchCommand": (c) => {
      if (api.failCommands.has(String(c.type))) throw { _tag: "CommandFailed", message: `${c.type} failed` };
      commands.push(c);
      const t = threads.get(String(c.threadId))!;
      t.updatedAt = now();
      switch (c.type) {
        // Like T3's Stop: interrupting the latest run also ends the background work.
        case "run.interrupt":
          settle(
            t,
            t.runs.find((r) => r.id === c.runId)!,
            "interrupted",
          );
          t.background = [];
          break;
        case "queued-run.cancel":
          t.runs.find((r) => r.id === c.runId)!.status = "cancelled";
          break;
        case "thread.archive":
          t.archivedAt = now();
          break;
        case "thread.unarchive":
          t.archivedAt = null;
          break;
        case "thread.settle":
          t.settledOverride = "settled";
          break;
        case "thread.unsettle":
          t.settledOverride = "active";
          break;
        case "thread.metadata.update":
          Object.assign(t, { worktreePath: c.worktreePath, branch: c.branch, ...(c.title ? { title: c.title } : {}) });
          break;
        case "thread.runtime-mode.set":
          t.runtimeMode = String(c.runtimeMode);
          break;
        case "thread.interaction-mode.set":
          t.interactionMode = String(c.interactionMode);
          break;
        case "thread.model-selection.set":
          t.modelSelection = c.modelSelection as Record<string, unknown>;
          break;
        case "message.dispatch": {
          const run: Run = {
            id: crypto.randomUUID(),
            status: "running",
            userMessageId: String(c.messageId),
            dispatchedAt: Date.now(),
          };
          t.runs.push(run);
          t.messages.push(String(c.text));
          settle(t, run, t.failNextTurn ? "failed" : "completed");
          t.failNextTurn = false;
          break;
        }
        default:
          throw { _tag: "UnknownCommand", message: `unknown command ${c.type}` };
      }
      return { sequence: commands.length };
    },
  };

  const authorized = (req: Request) => tokens.has(req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  const server = Bun.serve<{ ok: true }>({
    port: 0,
    async fetch(req, srv) {
      const routed = await options.routes?.(req);
      if (routed) return routed;
      const url = new URL(req.url);
      if (url.pathname === "/oauth/token") {
        const form = new URLSearchParams(await req.text());
        const token = form.get("subject_token") ?? "";
        if (!pairing.delete(token) || form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:token-exchange")
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        const access = crypto.randomUUID();
        tokens.add(access);
        return Response.json({ access_token: access, token_type: "Bearer", expires_in: 30 * 86400, scope: "" });
      }
      if (url.pathname === "/.well-known/t3/environment")
        return Response.json({ environmentId: "env", label: options.label ?? "fake" });
      if (url.pathname === "/ws") {
        if (url.searchParams.get("orchestrationProtocol") !== protocol)
          return Response.json({ code: "orchestration_protocol_incompatible" }, { status: 426 });
        if (!tickets.delete(url.searchParams.get("wsTicket") ?? ""))
          return new Response("unauthorized", { status: 401 });
        return srv.upgrade(req, { data: { ok: true } }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (url.pathname === "/api/auth/websocket-ticket") {
        const ticket = crypto.randomUUID();
        tickets.add(ticket);
        return Response.json({ ticket });
      }
      if (url.pathname === "/api/orchestration/shell") {
        if (req.headers.get("x-t3-orchestration-protocol") !== protocol)
          return Response.json({ code: "orchestration_protocol_incompatible" }, { status: 426 });
        return Response.json(snapshot());
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        const frame = JSON.parse(String(raw)) as {
          _tag: string;
          id: string;
          tag: string;
          payload: Record<string, unknown>;
        };
        if (frame._tag === "Ping") return void ws.send(JSON.stringify({ _tag: "Pong" }));
        if (frame._tag === "Ack") return void shell.acks++;
        if (frame._tag !== "Request") return;
        // Like upstream: a snapshot first, unless the client resumes after a sequence; then live items from `shell`.
        if (frame.tag === "orchestration.subscribeShell") {
          const afterSequence = frame.payload.afterSequence as number | undefined;
          shell.subscriptions.push(afterSequence === undefined ? {} : { afterSequence });
          streams.add({ ws, id: frame.id });
          if (afterSequence === undefined) {
            const item = {
              kind: "snapshot",
              snapshot: { schemaVersion: 2, snapshotSequence: commands.length, ...snapshot() },
            };
            ws.send(JSON.stringify({ _tag: "Chunk", requestId: frame.id, values: [item] }));
          }
          return;
        }
        try {
          const handler = rpc[frame.tag];
          api.reads.set(frame.tag, (api.reads.get(frame.tag) ?? 0) + 1);
          if (!handler) throw { _tag: "RpcNotFound", message: `no method ${frame.tag}` };
          const answer = JSON.stringify({
            _tag: "Exit",
            requestId: frame.id,
            exit: { _tag: "Success", value: handler(frame.payload) },
          });
          const delay = api.delayNext?.tag === frame.tag ? api.delayNext.ms : 0;
          if (delay) api.delayNext = undefined;
          if (delay) setTimeout(() => ws.send(answer), delay);
          else ws.send(answer);
        } catch (error) {
          ws.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: frame.id,
              exit: { _tag: "Failure", cause: [{ _tag: "Fail", error }] },
            }),
          );
        }
      },
      close(ws) {
        for (const sub of streams) if (sub.ws === ws) streams.delete(sub);
      },
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const api = {
    url,
    threads,
    projects,
    commands,
    clones,
    server,
    shell,
    /** The Claude provider's home in T3's settings; unset means Claude's default home. Imports read `claudeDir`. */
    homePath: options.claudeDir as string | undefined,
    /** Refuse clones for a missing permission. */
    denyClones: false,
    /** How many times each RPC method was called. */
    reads: new Map<string, number>(),
    /** Commands that fail when dispatched. */
    failCommands: new Set<string>(),
    /** Answer the next call of this RPC method late. */
    delayNext: undefined as { tag: string; ms: number } | undefined,
    /** A single-use pairing token, as `t3 pair` prints. */
    pairingToken() {
      const token = crypto.randomUUID();
      pairing.add(token);
      return token;
    },
    addProject(workspaceRoot: string, scripts: Project["scripts"] = []) {
      const project = { id: crypto.randomUUID(), title: "repo", workspaceRoot, scripts };
      projects.push(project);
      return project;
    },
    addThread(t: Partial<FakeThread> & { projectId: string; sessionId: string }) {
      const thread: FakeThread = {
        id: crypto.randomUUID(),
        title: "Fix the bug",
        providerInstanceId: "claudeAgent",
        modelSelection: { instanceId: "claudeAgent", model: "opus" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        archivedAt: null,
        updatedAt: now(),
        createdAt: now(),
        runs: [],
        messages: [],
        ...t,
      };
      threads.set(thread.id, thread);
      return thread;
    },
    stop: () => server.stop(true),
  };
  return api;
}
