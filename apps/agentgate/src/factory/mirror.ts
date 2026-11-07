import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod";
import { T3Error, t3Client, t3State } from "../handoff/t3.ts";
import { logError, type FactoryRuntime } from "./runtime.ts";
import { needsSignIn } from "./t3-mcp.ts";

/**
 * A live copy of this machine's T3 Code threads, from T3's `orchestration.subscribeShell` stream. While the stream is
 * down it polls T3's shell every `timing.pollMs` and tries the stream again. It runs while the factory is on and T3
 * Code is connected here, so a machine that never uses the factory keeps no stream open.
 */

export interface MirrorThread {
  id: string;
  title: string;
  projectId?: string;
  /** "idle" or a T3 run status: preparing | queued | starting | running | waiting | completed | interrupted | failed | cancelled | rolled_back */
  status: string;
  /** The thread waits on a person: T3 holds a pending runtime request (an approval or a question) for it. */
  needsYou: boolean;
  settled: boolean;
  archived: boolean;
  /** Set on subagent threads only: the thread that delegated to it. */
  parentThreadId?: string;
  worktreePath?: string;
  updatedAt: number;
}
/** T3 counts `waiting` as active too: the turn waits on background work, such as a command or a subagent. A thread
 * that waits on a person has a pending request instead (`needsYou`). */
const WORKING_STATUSES: readonly string[] = ["preparing", "queued", "starting", "running", "waiting"];
/** A T3 run status whose turn is still going. */
export const isWorkingStatus = (status: string) => WORKING_STATUSES.includes(status);
export interface T3Mirror {
  threads(): MirrorThread[];
  thread(id: string): MirrorThread | undefined;
  /** The project's title in T3 Code. */
  projectTitle(id: string): string | undefined;
  onChange(listener: (thread: MirrorThread, previous: MirrorThread | undefined) => void): () => void;
  status(): { stream: "live" | "polling" | "down"; error?: string };
}

/** Tests shorten it. */
export const timing = { pollMs: 5000 };

// Only the fields the mirror reads, so a field T3 adds or drops elsewhere does not break it.
const threadShell = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string().nullish(),
  status: z.string(),
  pendingRuntimeRequest: z.unknown().optional(),
  settledOverride: z.string().nullish(),
  archivedAt: z.string().nullish(),
  lineage: z.object({ parentThreadId: z.string().nullish(), relationshipToParent: z.string().nullish() }).nullish(),
  worktreePath: z.string().nullish(),
  updatedAt: z.string(),
});
const projectShell = z.object({ id: z.string(), title: z.string() });
const streamItem = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    snapshot: z.object({
      snapshotSequence: z.number(),
      threads: z.array(threadShell),
      archivedThreads: z.array(threadShell).default([]),
      projects: z.array(projectShell).default([]),
    }),
    /** Present on T3's repository-identity refreshes, which carry projects and no threads. */
    resolvedRepositoryIdentityRoots: z.array(z.string()).optional(),
  }),
  z.object({ kind: z.literal("synchronized") }),
  z.object({ kind: z.literal("thread.updated"), sequence: z.number(), location: z.string(), thread: threadShell }),
  z.object({ kind: z.literal("thread.removed"), sequence: z.number(), threadId: z.string() }),
  z.object({ kind: z.literal("project.updated"), sequence: z.number(), project: projectShell }),
  z.object({ kind: z.literal("project.removed"), sequence: z.number(), projectId: z.string() }),
]);
const KINDS: ReadonlySet<string> = new Set(streamItem.options.map((o) => o.shape.kind.value));
const polledShell = z.object({
  snapshotSequence: z.number().optional(),
  threads: z.array(threadShell),
  archivedThreads: z.array(threadShell).default([]),
  projects: z.array(projectShell).default([]),
});

function mirrored(t: z.infer<typeof threadShell>, archived: boolean): MirrorThread {
  const parent = t.lineage?.relationshipToParent === "subagent" ? t.lineage.parentThreadId : undefined;
  return {
    id: t.id,
    title: t.title,
    ...(t.projectId && { projectId: t.projectId }),
    status: t.status,
    needsYou: t.pendingRuntimeRequest != null,
    settled: t.settledOverride === "settled",
    archived: archived || !!t.archivedAt,
    ...(parent && { parentThreadId: parent }),
    ...(t.worktreePath && { worktreePath: t.worktreePath }),
    updatedAt: Date.parse(t.updatedAt) || 0,
  };
}

function unreadable(error: z.ZodError) {
  const issue = error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return new T3Error(`T3 Code sent a shell update agentgate cannot read (${where}${issue?.message ?? "invalid"})`);
}

/** For the token-less board: only text agentgate wrote. Other errors can carry anything, so they show by name. */
function reason(e: unknown) {
  if (e instanceof T3Error) return e.message;
  if (e instanceof z.ZodError) return unreadable(e).message;
  return `T3 Code could not be read (${e instanceof Error ? e.name : "error"})`;
}

type Listener = Parameters<T3Mirror["onChange"]>[0];

class Mirror implements T3Mirror {
  private byId = new Map<string, MirrorThread>();
  private projects = new Map<string, string>();
  private listeners = new Set<Listener>();
  private state: ReturnType<T3Mirror["status"]> = { stream: "down" };
  /** The last sequence applied, to resume the stream after a drop. */
  private sequence: number | undefined;
  private running?: AbortController;

  constructor(private f: FactoryRuntime) {}

  threads = () => [...this.byId.values()];
  thread = (id: string) => this.byId.get(id);
  projectTitle = (id: string) => this.projects.get(id);
  status = () => ({ ...this.state });
  onChange(listener: Listener) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Starts or stops the stream to match the T3 connection and whether this machine drives factory work. */
  reconcile() {
    const abort = this.f.ctx.abort.signal;
    const want = !abort.aborted && needsSignIn(this.f) && t3State(this.f.s).connected;
    if (want && !this.running) {
      this.running = new AbortController();
      void this.run(AbortSignal.any([this.running.signal, abort]));
    } else if (!want && this.running) {
      this.running.abort();
      this.running = undefined;
      this.byId.clear();
      this.projects.clear();
      this.sequence = undefined;
      this.state = { stream: "down" };
    }
  }

  private async run(signal: AbortSignal) {
    while (!signal.aborted) {
      let error: string;
      try {
        await t3Client(this.f.s).stream(
          "orchestration.subscribeShell",
          // The marker (`synchronized`) tells a resumed stream is caught up, since a resume sends no snapshot.
          { ...(this.sequence !== undefined && { afterSequence: this.sequence }), requestCompletionMarker: true },
          (values) => values.forEach((value) => this.apply(value, signal)),
          signal,
        );
        error = `T3 Code on ${this.f.s.nodeId} ended the shell stream`;
      } catch (e) {
        if (signal.aborted) return;
        error = reason(e);
      }
      await this.poll(signal, error);
      await wait(timing.pollMs, undefined, { signal }).catch(() => {});
    }
  }

  private async poll(signal: AbortSignal, streamError: string) {
    try {
      const shell = await t3Client(this.f.s).shell();
      const parsed = polledShell.safeParse(shell);
      if (!parsed.success) throw unreadable(parsed.error);
      if (signal.aborted) return;
      const { threads, archivedThreads, projects, snapshotSequence } = parsed.data;
      this.replace(threads, archivedThreads, projects);
      if (snapshotSequence !== undefined) this.sequence = snapshotSequence;
      this.state = { stream: "polling", error: streamError };
    } catch (e) {
      if (!signal.aborted) this.state = { stream: "down", error: reason(e) };
    }
  }

  /** One stream item. Throwing ends the stream, so an unreadable item switches the mirror to polling. */
  private apply(value: unknown, signal: AbortSignal) {
    if (signal.aborted) return;
    const kind = (value as { kind?: unknown } | null)?.kind;
    if (typeof kind === "string" && !KINDS.has(kind)) return; // a kind newer than this agentgate
    const parsed = streamItem.safeParse(value);
    if (!parsed.success) throw unreadable(parsed.error);
    const item = parsed.data;
    if (item.kind === "synchronized") {
      this.state = { stream: "live" };
      return;
    }
    if (item.kind === "snapshot") {
      const { snapshot } = item;
      if (item.resolvedRepositoryIdentityRoots) {
        for (const p of snapshot.projects) this.projects.set(p.id, p.title);
        return;
      }
      this.replace(snapshot.threads, snapshot.archivedThreads, snapshot.projects);
      this.sequence = snapshot.snapshotSequence;
      this.state = { stream: "live" };
      return;
    }
    // A resumed stream may repeat what a poll or the previous stream already applied.
    if (this.sequence !== undefined && item.sequence <= this.sequence) return;
    this.sequence = item.sequence;
    if (item.kind === "thread.updated") this.set(mirrored(item.thread, item.location === "archive"));
    else if (item.kind === "thread.removed") this.byId.delete(item.threadId);
    else if (item.kind === "project.updated") this.projects.set(item.project.id, item.project.title);
    else this.projects.delete(item.projectId);
  }

  private replace(
    active: z.infer<typeof threadShell>[],
    archived: z.infer<typeof threadShell>[],
    projects: z.infer<typeof projectShell>[],
  ) {
    const previous = this.byId;
    this.byId = new Map();
    this.projects = new Map(projects.map((p) => [p.id, p.title]));
    for (const t of active) this.set(mirrored(t, false), previous);
    for (const t of archived) this.set(mirrored(t, true), previous);
  }

  private set(thread: MirrorThread, previous = this.byId) {
    const before = previous.get(thread.id);
    this.byId.set(thread.id, thread);
    if (before && JSON.stringify(before) === JSON.stringify(thread)) return;
    for (const listener of this.listeners) {
      try {
        listener(thread, before);
      } catch (e) {
        console.error(`factory: mirror listener failed: ${logError(e)}`);
      }
    }
  }
}

const mirrors = new WeakMap<FactoryRuntime, Mirror>();

/** The machine's one mirror, started or stopped to match the factory setting and T3 connection as it is asked for. */
export function mirrorOf(f: FactoryRuntime): T3Mirror {
  let mirror = mirrors.get(f);
  if (!mirror) mirrors.set(f, (mirror = new Mirror(f)));
  mirror.reconcile();
  return mirror;
}
