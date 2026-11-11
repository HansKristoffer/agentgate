import { existsSync, rmSync } from "node:fs";
import { createCache, startTimer } from "hanzio";
import { join } from "node:path";
import type { HandoffJob } from "@agentgate/protocol";
import { fetchHeaders, killGroup, readBody, serialTask } from "../runtime.ts";
import type { Store } from "../store.ts";
import { peers } from "../sync.ts";
import { relayInvite, via } from "../relay.ts";
import { relayCall } from "../channel.ts";
import { destinationView, manifestFile, runDestination, type DestState } from "./destination.ts";
import { runSource, type SourceState } from "./source.ts";
import { syncT3Projects } from "./projects.ts";

/** Handoff jobs: one row per job and role in the node-local `handoffs` table, resumed after a restart from the
 * step they reached. Steps are idempotent. The source drives; the destination answers peer requests. */

type Role = "source" | "destination";
export interface Timing {
  step: string;
  node: string;
  ms: number;
}
export interface Job<S> {
  id: string;
  role: Role;
  thread: string;
  target: string;
  step: string;
  state: S;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface HandoffOptions {
  /** Claude's default home (~/.claude): sessions of a T3 Claude provider without a home of its own live here. */
  claudeDir: string;
  /** Where new worktrees go (T3's convention: `~/.t3/worktrees/<repo>/…`). */
  worktreesDir: string;
  /** Where a repository this node has no project for is cloned. */
  cloneDir: string;
  /** Per-handoff temp files, deleted when the job ends. */
  tempDir: string;
  /** T3 Code's state folder (`~/.t3/userdata`), where a returning thread's history is written. Unset in a checkout's
   * dev daemon, which must not write the real T3 Code's state, and then never written. */
  t3StateDir?: string;
  /** The buncargo file store's root (checkout-files.ts). Unset leaves checkout files out of handoffs. */
  filesRoot?: string;
  pollMs?: number;
  setupTimeoutMs?: number;
  retryPauseMs?: number;
}

/** Finished jobs stay this long, for the thread views and a look back at what happened. */
const KEEP_FINISHED = 30 * 86_400_000;

/** Node-local notes about a Claude session that outlive one handoff: the thread that held it when it left this node
 * (so a round trip brings that thread back), the stash of changes parked then (dropped when they come back), and how
 * many records its session file had then (the ones after are the history that thread lacks when it comes back). */
export const sessionNote = {
  thread: (sessionId: string) => `handoff:session:${sessionId}`,
  stash: (sessionId: string) => `handoff:stash:${sessionId}`,
  lines: (sessionId: string) => `handoff:lines:${sessionId}`,
};
const ABANDONED = 10 * 60_000;

export class PeerError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** How this node reaches `node`: a direct Tailscale peer, else the relay group both are in. */
export function transport(s: Store, node: string): "tailnet" | "relay" | undefined {
  if (peers(s).some((p) => p.node === node)) return "tailnet";
  return relayInvite(s) && via(s, node).includes("relay") ? "relay" : undefined;
}

/** A daemon-to-daemon call to `node`'s `/peer` routes: over Tailscale with the peer token, or sealed through the relay. */
export async function peerCall<T>(
  s: Store,
  node: string,
  path: string,
  init: { method?: string; json?: unknown; body?: Uint8Array; timeout?: number } = {},
): Promise<T> {
  const timeout = init.timeout ?? 30_000;
  const method = init.method ?? (init.json === undefined && !init.body ? "GET" : "POST");
  const type = init.json !== undefined ? "application/json" : init.body ? "application/gzip" : undefined;
  const body = init.json !== undefined ? new TextEncoder().encode(JSON.stringify(init.json)) : init.body;
  const p = peers(s).find((peer) => peer.node === node);
  let res: Response;
  if (p) {
    res = await fetchHeaders(
      `${p.url}/peer${path}`,
      {
        method,
        body,
        signal: AbortSignal.timeout(timeout),
        headers: { authorization: `Bearer ${p.token}`, ...(type && { "content-type": type }) },
      },
      timeout,
    ).catch(() => {
      throw new Error(`${node} is not reachable`);
    });
  } else if (transport(s, node) === "relay") {
    res = await relayCall(s, node, path, { method, body, type, timeout });
  } else throw new Error(`${node} is not paired with ${s.nodeId} over Tailscale or a relay`);

  const text = new TextDecoder().decode(await readBody(res.body, 16 * 1024 * 1024, AbortSignal.timeout(timeout)));
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text);
  } catch {
    // A non-JSON answer (a proxy error page) is reported by its status below.
  }
  if (!res.ok) {
    const message = typeof data.error === "string" ? data.error : `${node} answered ${res.status}`;
    throw new PeerError(res.status, message, data);
  }
  return data as T;
}

type Row = Omit<Job<unknown>, "state" | "error" | "createdAt" | "updatedAt"> & {
  state: string;
  error: string | null;
  created_at: number;
  updated_at: number;
};
const fromRow = <S>({ state, error, created_at, updated_at, ...rest }: Row): Job<S> => ({
  ...rest,
  state: JSON.parse(state),
  error: error ?? undefined,
  createdAt: created_at,
  updatedAt: updated_at,
});

export class Handoffs {
  private loops = new Map<string, () => Promise<void>>();
  private running = new Set<Promise<void>>();
  /** Source jobs `startHandoff` is still resolving, which the tick leaves alone: the agent is interrupted only after the
   * caller has the job id. */
  starting = new Set<string>();
  /** Setup scripts started on this node, per job, with their outcome; the destination waits for them before continuing the agent. */
  setups = new Map<string, Promise<{ warnings: string[]; timings: Timing[] }>>();
  /** Their processes, stopped on close: a restart runs an unfinished setup again. */
  setupProcesses = new Set<{ pid: number; kill(signal?: number | NodeJS.Signals): void }>();
  /** Short-lived listing cache: T3's Claude provider instances. */
  cache = createCache({ now: () => this.s.now() });
  private stop = new AbortController();
  /** Aborts on close and kills the git clones, fetches and bundles in flight; their steps run again on restart. */
  readonly signal = this.stop.signal;
  /** Resolves on close, so a step waiting on setup lets shutdown go; the step resumes on restart. */
  readonly closing = new Promise<void>((resolve) => this.signal.addEventListener("abort", () => resolve()));
  /** One T3 project sync at a time: the timer, record changes and the app's T3 Code page all ask for it. */
  syncProjects = serialTask(() => syncT3Projects(this));

  constructor(
    readonly s: Store,
    readonly options: HandoffOptions,
    /** Tell skill links about checkouts this node has, so a repo's first session here already has its skills. */
    readonly register: (checkouts: { path: string; project?: string }[]) => void = () => {},
  ) {}

  get closed() {
    return this.signal.aborted;
  }
  get pollMs() {
    return this.options.pollMs ?? 1000;
  }
  dir(id: string) {
    return join(this.options.tempDir, id);
  }

  load<S = SourceState | DestState>(role: Role, id: string): Job<S> | undefined {
    const row = this.s.db.query("select * from handoffs where role = ? and id = ?").get(role, id) as Row | null;
    return row ? fromRow<S>(row) : undefined;
  }
  list<S = SourceState | DestState>(role?: Role): Job<S>[] {
    const rows = this.s.db
      .query("select * from handoffs where ?1 is null or role = ?1 order by created_at desc limit 200")
      .all(role ?? null) as Row[];
    return rows.map((r) => fromRow<S>(r));
  }
  // Jobs are shown with the threads, so every write the user can see marks `threads` changed; `touch` does not.
  create<S>(job: Omit<Job<S>, "createdAt" | "updatedAt">) {
    const { changes } = this.s.db.run("insert or ignore into handoffs values (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      job.id,
      job.role,
      job.thread,
      job.target,
      job.step,
      JSON.stringify(job.state),
      job.error ?? null,
      this.s.now(),
      this.s.now(),
    ]);
    if (changes) this.s.bump("threads");
    return this.load<S>(job.role, job.id)!;
  }
  /** The job's step loop is the only writer after creation; a job that failed (an abort) is never brought back.
   * Returns false when it had failed already. */
  save<S>(job: Job<S>): boolean {
    job.updatedAt = this.s.now();
    const saved =
      this.s.db.run(
        "update handoffs set thread = ?, step = ?, state = ?, error = ?, updated_at = ? where role = ? and id = ? and step != 'failed'",
        [job.thread, job.step, JSON.stringify(job.state), job.error ?? null, job.updatedAt, job.role, job.id],
      ).changes > 0;
    if (saved) this.s.bump("threads");
    return saved;
  }

  /** Run a job's step loop, one at a time per job; a call while it runs makes it look again afterwards. */
  drive(role: Role, id: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const key = `${role}:${id}`;
    let loop = this.loops.get(key);
    if (!loop) {
      loop = serialTask(() => (role === "source" ? runSource(this, id) : runDestination(this, id)));
      this.loops.set(key, loop);
    }
    const running = loop().catch((e) => console.error(`handoff ${id}: ${e?.name ?? "failed"}`));
    this.running.add(running);
    void running.finally(() => this.running.delete(running));
    return running;
  }

  /** Resume unfinished jobs after a restart, and give up on prepares whose source never started. */
  tick() {
    // Only unfinished rows: a finished one can hold thousands of file entries, and nothing here reads them.
    const rows = this.s.db.query("select * from handoffs where step not in ('done', 'failed')").all() as Row[];
    for (const job of rows.map((r) => fromRow<SourceState | DestState>(r))) {
      if (this.starting.has(job.id)) continue;
      const waiting =
        job.role === "destination" &&
        (job.step === "prepare" || job.step === "prepared") &&
        !existsSync(manifestFile(this, job.id));
      if (waiting && this.s.now() - job.updatedAt > ABANDONED) {
        this.fail(job, "abandoned: the source never sent the thread");
        continue;
      }
      void this.drive(job.role, job.id);
    }
  }

  trim() {
    this.s.db.run("delete from handoffs where step in ('done', 'failed') and updated_at < ?", [
      this.s.now() - KEEP_FINISHED,
    ]);
  }

  advance<S>(job: Job<S>, step: string) {
    job.step = step;
    this.save(job);
  }

  /** Returns false when the job had failed already, so only one caller acts on its failure. */
  fail<S>(job: Job<S>, error: string): boolean {
    job.step = "failed";
    job.error = error;
    const failed = this.save(job);
    rmSync(this.dir(job.id), { recursive: true, force: true });
    return failed;
  }

  /** A warning for a job that already failed, which `save` no longer writes. */
  warnFailed(job: Job<{ warnings: string[] }>, warning: string) {
    job.state.warnings.push(warning);
    this.s.db.run("update handoffs set state = ? where role = ? and id = ?", [
      JSON.stringify(job.state),
      job.role,
      job.id,
    ]);
    this.s.bump("threads");
  }

  /** Mark activity without taking the step loop's place as the writer (a received chunk keeps a slow upload alive). */
  touch(role: Role, id: string) {
    this.s.db.run("update handoffs set updated_at = ? where role = ? and id = ?", [this.s.now(), role, id]);
  }

  /** Waits for step loops; setup scripts keep running on their own. */
  async close() {
    this.stop.abort();
    for (const child of this.setupProcesses) killGroup(child);
    await Promise.allSettled([...this.running]);
  }

  /** The job as the API and app show it. */
  view(job: Job<SourceState | DestState>): HandoffJob {
    if (job.role === "destination") return destinationView(this, job as Job<DestState>);
    const st = job.state as SourceState;
    return {
      id: job.id,
      role: "source",
      node: this.s.nodeId,
      from: this.s.nodeId,
      to: job.target,
      thread: job.thread,
      title: st.title,
      step: job.step,
      status:
        job.step === "failed"
          ? "failed"
          : job.step === "done"
            ? "done"
            : job.step === "finish"
              ? "imported"
              : "running",
      destThreadId: st.destThreadId,
      warnings: st.warnings,
      error: job.error,
      timings: [...st.timings, ...(st.remoteTimings ?? [])],
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }
}

/** Record how long a step took, for finding the next thing to make faster. */
export async function timed<T>(s: Store, timings: Timing[], step: string, fn: () => Promise<T>): Promise<T> {
  const elapsed = startTimer();
  const result = await fn();
  timings.push({ step, node: s.nodeId, ms: Math.round(elapsed()) });
  return result;
}
