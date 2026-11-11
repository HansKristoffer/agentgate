import { existsSync, rmSync } from "node:fs";
import { createCache, startTimer } from "hanzio";
import { join } from "node:path";
import { z } from "zod";
import type { HandoffJob, HandoffTiming } from "@agentgate/protocol";
import { fetchHeaders, killGroup, readBody, serialTask } from "../runtime.ts";
import type { Store } from "../store.ts";
import { peers } from "../sync.ts";
import { relayInvite, via } from "../relay.ts";
import { relayCall } from "../channel.ts";
import { destinationSteps, destinationView, manifestFile, runDestination } from "./destination.ts";
import { runSource, sourceSteps } from "./source.ts";
import { syncT3Projects } from "./projects.ts";

/** Handoff jobs: one row per job and role in the node-local `handoffs` table, resumed after a restart from the
 * step they reached. Steps are idempotent. The source drives; the destination answers peer requests. */

type Role = "source" | "destination";
export type Timing = HandoffTiming;

/** A job's state is parsed on load with its step's schema (`sourceSteps`, `destinationSteps`), so each step sees as
 * required what the steps before it filled in. */
type Steps = Record<string, z.ZodType>;
type JobAt<R extends Role, M extends Steps, K extends keyof M> = K extends string
  ? {
      id: string;
      role: R;
      thread: string;
      target: string;
      step: K;
      state: z.output<M[K]>;
      error?: string;
      createdAt: number;
      updatedAt: number;
    }
  : never;
export type SourceStep = keyof typeof sourceSteps;
export type DestStep = keyof typeof destinationSteps;
export type SourceJob<K extends SourceStep = SourceStep> = JobAt<"source", typeof sourceSteps, K>;
export type DestJob<K extends DestStep = DestStep> = JobAt<"destination", typeof destinationSteps, K>;
export type Job = SourceJob | DestJob;
type JobOf<R extends Role> = R extends "source" ? SourceJob : DestJob;
type StepOf<J extends Job> = J extends SourceJob ? SourceStep : DestStep;
type NewJob = Job extends infer J ? (J extends Job ? Omit<J, "createdAt" | "updatedAt"> : never) : never;

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

type PeerInit = { method?: string; json?: unknown; body?: Uint8Array; timeout?: number };

/** A daemon-to-daemon call to `node`'s `/peer` routes: over Tailscale with the peer token, or sealed through the relay.
 * The answer is parsed with `schema`, so a machine on another version that answers in another shape fails with a
 * message naming it. */
export async function peerCall<S extends z.ZodType>(
  s: Store,
  node: string,
  path: string,
  schema: S,
  init?: PeerInit,
): Promise<z.output<S>>;
/** @deprecated Unchecked answer, kept for factory/board.ts, factory/follow.ts and update.ts; pass a schema instead. */
export async function peerCall<T>(s: Store, node: string, path: string, init?: PeerInit): Promise<T>;
export async function peerCall(
  s: Store,
  node: string,
  path: string,
  schemaOrInit?: z.ZodType | PeerInit,
  maybeInit: PeerInit = {},
): Promise<unknown> {
  const [schema, init] =
    schemaOrInit instanceof z.ZodType ? [schemaOrInit, maybeInit] : [undefined, schemaOrInit ?? {}];
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
  if (!schema) return data;
  const answer = schema.safeParse(data);
  if (answer.success) return answer.data;
  throw new Error(
    `${node} answered ${path.split("?")[0]} in a form ${s.nodeId} cannot read (${firstIssue(answer.error)}); update agentgate on both machines`,
  );
}

const firstIssue = (error: z.ZodError) => {
  const issue = error.issues[0];
  const at = issue?.path.join(".");
  return `${at ? `${at}: ` : ""}${issue?.message ?? "invalid"}`;
};

type Row = {
  id: string;
  role: Role;
  thread: string;
  target: string;
  step: string;
  state: string;
  error: string | null;
  created_at: number;
  updated_at: number;
};

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

  /** The row as its step's job. One this version cannot continue (a step it does not know, or a state that does not
   * fit its step, as another version may write) fails here with the reason, instead of waiting for a step loop that
   * cannot run it. Finished jobs always load: nothing runs them, and their schema falls back to an empty state. */
  private read(row: Row): Job {
    const steps = row.role === "source" ? sourceSteps : destinationSteps;
    let raw: unknown;
    try {
      raw = JSON.parse(row.state);
    } catch {
      // Parsed as missing, which no running step accepts.
    }
    const job = {
      id: row.id,
      role: row.role,
      thread: row.thread,
      target: row.target,
      error: row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    const schema = (steps as Steps)[row.step];
    const parsed = schema?.safeParse(raw);
    // The schema of `row.step` parsed the state: the pair is that step's job, which TypeScript cannot follow.
    if (parsed?.success) return { ...job, step: row.step, state: parsed.data } as Job;

    const why = parsed ? firstIssue(parsed.error) : "unknown step";
    const error = `${row.step} on ${this.s.nodeId}: another version of agentgate wrote this handoff, and this one cannot continue it (${why})`;
    const failed = this.s.db.run(
      "update handoffs set step = 'failed', error = ?, updated_at = ? where role = ? and id = ? and step = ?",
      [error, this.s.now(), row.role, row.id, row.step],
    ).changes;
    if (failed) {
      this.s.bump("threads");
      rmSync(this.dir(row.id), { recursive: true, force: true });
    }
    return {
      ...job,
      step: "failed",
      error,
      updatedAt: this.s.now(),
      state: steps.failed.parse(raw),
    } as Job;
  }

  load<R extends Role>(role: R, id: string): JobOf<R> | undefined {
    const row = this.s.db.query("select * from handoffs where role = ? and id = ?").get(role, id) as Row | null;
    return row ? (this.read(row) as JobOf<R>) : undefined;
  }
  list<R extends Role = Role>(role?: R): JobOf<R>[] {
    const rows = this.s.db
      .query("select * from handoffs where ?1 is null or role = ?1 order by created_at desc limit 200")
      .all(role ?? null) as Row[];
    return rows.map((r) => this.read(r) as JobOf<R>);
  }
  // Jobs are shown with the threads, so every write the user can see marks `threads` changed; `touch` does not.
  create<R extends Role>(job: NewJob & { role: R }): JobOf<R> {
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
    return this.load(job.role, job.id)!;
  }
  /** The job's step loop is the only writer after creation; a job that failed (an abort) is never brought back.
   * Returns false when it had failed already. */
  save(job: Job): boolean {
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
    for (const job of rows.map((r) => this.read(r))) {
      if (this.starting.has(job.id) || job.step === "failed") continue;
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

  /** Moves the job on. The state is checked against the new step's schema when the loop loads it next. */
  advance<J extends Job>(job: J, step: StepOf<J>) {
    Object.assign(job, { step });
    this.save(job);
  }

  /** Returns false when the job had failed already, so only one caller acts on its failure. */
  fail(job: Job, error: string): boolean {
    Object.assign(job, { step: "failed", error });
    const failed = this.save(job);
    rmSync(this.dir(job.id), { recursive: true, force: true });
    return failed;
  }

  /** A warning for a job that already failed, which `save` no longer writes. */
  warnFailed(job: Job, warning: string) {
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
  view(job: Job): HandoffJob {
    if (job.role === "destination") return destinationView(this, job);
    const st = job.state;
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
