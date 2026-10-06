import { copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { sleep } from "../runtime.ts";
import { createBundle, describe, snapshot, stashIfUnchanged, type Snapshot } from "./code.ts";
import { PeerError, peerCall, sessionNote, timed, transport, type Handoffs, type Job, type Timing } from "./jobs.ts";
import { CHANNEL_CHUNK } from "../channel.ts";
import { realPath, sessionProviders } from "./session.ts";
import { ACTIVE, T3Error, claudeInstance, dispatch, projection, t3Client } from "./t3.ts";
import { QUEUED_MAX, type Manifest } from "./destination.ts";

/** The steps on the thread's own machine (A): resolve → stop → package → send → await → finish.
 * B prepares its checkout while A stops the agent and packs. Until B reports `imported`, A may abort and nothing
 * here changed but the interrupted run; afterwards it never aborts, or the conversation would split in two. */

export interface SourceState {
  title?: string; sessionId?: string; driver?: string; claudeHome?: string; projectTitle?: string;
  modelSelection?: Record<string, unknown>; runtimeMode?: string; interactionMode?: string;
  workspaceRoot?: string; worktreePath?: string | null; cwd?: string;
  remoteUrl?: string; branch?: string | null; baseSha?: string | null;
  wasWorking?: boolean; background?: string[]; queued?: string[]; headSha?: string; snapshot?: Snapshot; bundle?: boolean;
  files?: { path: string; size: number }[];
  destThreadId?: string; codeTaken?: boolean; lostSince?: number; finishAt?: number;
  warnings: string[]; timings: Timing[]; remoteTimings?: Timing[];
}

/** Most one handoff may move through the relay; Tailscale has only the destination's 1 GiB cap. */
const RELAY_MAX = 512 * 1024 * 1024;
const LOST = 30 * 60_000;
const BEFORE_IMPORT = new Set(["resolve", "stop", "package", "send", "await"]);

/** Start handing `threadId` (on this node) to `target`. Resolves the thread before returning, so a thread that
 * cannot move fails here; the agent is interrupted only after the caller has the job id. */
export async function startHandoff(h: Handoffs, threadId: string, target: string): Promise<string> {
  if (target === h.s.nodeId) throw new T3Error("the thread already runs on this node");
  if (h.list<SourceState>("source").some((j) => j.thread === threadId && !["done", "failed", "finish"].includes(j.step)))
    throw new T3Error("a handoff of this thread is already running");
  const id = crypto.randomUUID();
  const job = h.create<SourceState>({ id, role: "source", thread: threadId, target, step: "resolve", state: { warnings: [], timings: [] } });
  try {
    await resolve(h, job);
  } catch (e) {
    h.fail(job, `resolve on ${h.s.nodeId}: ${(e as Error).message}`);
    throw e;
  }
  void h.drive("source", id);
  return id;
}

async function resolve(h: Handoffs, job: Job<SourceState>) {
  const st = job.state;
  const t3 = t3Client(h.s);
  await timed(h.s, st.timings, "resolve", async () => {
    const [p, shell] = await Promise.all([t3.rpc((call) => projection(call, job.thread)), t3.shell()]);
    const t = p.thread;
    const { home } = await t3.rpc((call) => claudeInstance(call, t.providerInstanceId, h.options.claudeDir));
    if (t.archivedAt) throw new T3Error("the thread is archived");

    const native = p.providerThreads.find((pt) => pt.id === t.activeProviderThreadId);
    if (!native || !sessionProviders[native.driver]) throw new T3Error("only Claude Code threads can be handed off");
    const hasSession = native.nativeThreadRef?.strength === "strong" && native.nativeThreadRef.nativeId;
    if (!hasSession) throw new T3Error("the thread has no Claude session to move yet");

    const project = shell.projects.find((pr) => pr.id === t.projectId);
    if (!project) throw new T3Error("the thread's project is gone");
    const cwd = t.worktreePath ?? project.workspaceRoot;
    const code = await describe(cwd);

    Object.assign(st, {
      title: t.title, sessionId: native.nativeThreadRef!.nativeId, driver: native.driver, claudeHome: home, projectTitle: project.title,
      modelSelection: t.modelSelection, runtimeMode: t.runtimeMode, interactionMode: t.interactionMode,
      workspaceRoot: project.workspaceRoot, worktreePath: t.worktreePath, cwd,
      remoteUrl: code.remoteUrl, branch: code.branch, baseSha: code.baseSha,
    });
  });
  h.advance(job, "stop");
  // B creates its worktree and runs setup while A stops and packs; `start` runs it there if this is lost.
  void peerCall(h.s, job.target, `/handoff/${job.id}/prepare`, { json: prepareInput(st) }).catch(() => { });
}

const prepareInput = (st: SourceState) => ({
  remoteUrl: st.remoteUrl, projectTitle: st.projectTitle, branch: st.branch ?? null, baseSha: st.baseSha ?? null, worktree: !!st.worktreePath,
});

export async function runSource(h: Handoffs, id: string) {
  for (; ;) {
    const job = h.load<SourceState>("source", id);
    if (!job || h.closed || job.step === "done" || job.step === "failed") return;
    const st = job.state;
    try {
      switch (job.step) {
        case "resolve": await resolve(h, job); break;
        case "stop": await stop(h, job); break;
        case "package": await pack(h, job); break;
        case "send": await send(h, job); break;
        case "await": if (!(await wait(h, job))) return; break;
        case "finish": await finish(h, job); if (job.step === "finish") return; break;
        default: return;
      }
    } catch (e) {
      const message = `${job.step} on ${h.s.nodeId}: ${(e as Error).message}`;
      if (!BEFORE_IMPORT.has(job.step)) { st.warnings.push(message); h.save(job); return; }
      await peerCall(h.s, job.target, `/handoff/${id}`, { method: "DELETE" }).catch(() => { });
      h.fail(job, message);
      return;
    }
  }
}

async function stop(h: Handoffs, job: Job<SourceState>) {
  const st = job.state;
  await timed(h.s, st.timings, "stop", () => t3Client(h.s).rpc(async (call) => {
    let p = await projection(call, job.thread);
    // Remember before interrupting: after a restart the run is already stopped, and the background work with it.
    if (p.runs.some((r) => ACTIVE.has(r.status)) && !st.wasWorking) {
      st.wasWorking = true;
      h.save(job);
    }
    const tasks = p.providerThreads.find((pt) => pt.id === p.thread.activeProviderThreadId)?.pendingBackgroundTasks ?? [];
    if (tasks.length > 0 && !st.background) {
      st.background = tasks.slice(0, 20).map((t) => `${t.kind ?? "task"}: ${t.description ?? "unnamed"}`.slice(0, 2000));
      h.save(job);
    }
    // Read before cancelling: the destination queues them again behind the continued turn.
    if (!st.queued) {
      const { texts, attachments, overflow } = queuedMessages(p);
      st.queued = texts;
      const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
      if (attachments) st.warnings.push(`${plural(attachments, "attachment")} on queued messages stayed on ${h.s.nodeId}`);
      if (overflow) st.warnings.push(`${plural(overflow, "queued message")} did not fit in the handoff and stayed on ${h.s.nodeId}`);
      h.save(job);
    }
    for (const r of p.runs.filter((r) => r.status === "queued")) {
      await dispatch(call, { type: "queued-run.cancel", threadId: job.thread, runId: r.id });
    }
    for (const r of p.runs.filter((r) => ACTIVE.has(r.status))) {
      await dispatch(call, { type: "run.interrupt", threadId: job.thread, runId: r.id, reason: `Handed off to ${job.target}` });
    }

    const deadline = h.s.now() + 60_000;
    while (p.runs.some((r) => ACTIVE.has(r.status) || r.status === "queued")) {
      if (h.s.now() > deadline) throw new T3Error("the agent did not stop within 60 seconds");
      await sleep(250);
      p = await projection(call, job.thread);
    }

    // Background work outlives its turn. Stop it the way T3's Stop button does: interrupting the latest run closes the
    // Claude process that runs it. The other machine is told what it was.
    if (!st.background) return;
    p = await projection(call, job.thread);
    const latest = p.runs.at(-1);
    const left = p.providerThreads.find((pt) => pt.id === p.thread.activeProviderThreadId)?.pendingBackgroundTasks ?? [];
    if (left.length === 0 || !latest) return;
    await dispatch(call, { type: "run.interrupt", threadId: job.thread, runId: latest.id, reason: `Handed off to ${job.target}` })
      .catch(() => st.warnings.push(`Background tasks may still be running on ${h.s.nodeId}; stop them in T3 Code there.`));
  }));
  h.advance(job, "package");
}

/** The user's queued messages in T3's delivery order, as text. Server-made ones (a child task's result, a notification)
 * belong to this machine's thread. Attachments do not move, nor messages past the cap. */
function queuedMessages(p: Awaited<ReturnType<typeof projection>>) {
  const texts: string[] = [];
  let attachments = 0, overflow = 0, chars = 0;
  const order = (r: (typeof p.runs)[number]) => r.queuePosition ?? r.ordinal ?? 0;
  const runs = p.runs.filter((r) => r.status === "queued").sort((x, y) => order(x) - order(y) || (x.ordinal ?? 0) - (y.ordinal ?? 0));
  for (const r of runs) {
    const m = p.messages.find((m) => m.id === r.userMessageId);
    if (!m || m.notification !== undefined || m.delegatedCompletion !== undefined) continue;
    attachments += m.attachments.length;
    if (!m.text.trim()) continue;
    // Past the first that does not fit, none move, so the ones that do keep their order.
    if (overflow || texts.length === QUEUED_MAX.count || chars + m.text.length > QUEUED_MAX.chars) overflow++;
    else {
      texts.push(m.text);
      chars += m.text.length;
    }
  }
  return { texts, attachments, overflow };
}

async function pack(h: Handoffs, job: Job<SourceState>) {
  const st = job.state;
  await timed(h.s, st.timings, "package", async () => {
    // HEAD may have moved since resolve if the agent committed before stopping; the bundle is built from now.
    const code = await describe(st.cwd!);
    st.headSha = code.headSha;
    st.snapshot = await snapshot(st.cwd!, job.id, code.headSha, code.dirty);

    const out = join(h.dir(job.id), "out");
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true, mode: 0o700 });
    st.bundle = await createBundle(st.cwd!, job.id, st.snapshot.sha, join(out, "bundle"));

    const located = sessionProviders[st.driver!]!.locate(st.claudeHome!, st.sessionId!, st.cwd!);
    if (!located) throw new T3Error(`the Claude session is not in ${st.claudeHome}, the Claude home of the thread's provider in T3 Code`);
    // Copied now, while the agent is stopped, so a retried send resends the same bytes.
    for (const file of located.files) {
      mkdirSync(dirname(join(out, "session", file)), { recursive: true });
      copyFileSync(join(located.root, file), join(out, "session", file));
    }
    const paths = [...(st.bundle ? ["bundle"] : []), ...located.files.map((f) => `session/${f}`)];
    st.files = paths.map((path) => ({ path, size: statSync(join(out, path)).size }));

    // A later handoff back here finds the thread that held this session (round trips reuse threads).
    h.s.setLocal(sessionNote.thread(st.sessionId!), job.thread);
  });
  h.advance(job, "send");
}

async function send(h: Handoffs, job: Job<SourceState>) {
  const st = job.state;
  const out = join(h.dir(job.id), "out");
  await timed(h.s, st.timings, "send", async () => {
    // Again, idempotently: B may have missed the first prepare or restarted, and takes files only for a known job.
    await peerCall(h.s, job.target, `/handoff/${job.id}/prepare`, { json: prepareInput(st) });

    // One chunk size for Tailscale and the relay, each gzipped on its own. A retry restarts a file at offset 0.
    if (transport(h.s, job.target) === "relay" && st.files!.reduce((n, f) => n + f.size, 0) > RELAY_MAX) {
      throw new T3Error("the thread's code and session are larger than the relay takes (512 MiB); pair the machines over Tailscale");
    }
    for (const f of st.files!) {
      const file = Bun.file(join(out, f.path));
      for (let offset = 0; offset === 0 || offset < f.size; offset += CHANNEL_CHUNK) {
        const chunk = gzipSync(await file.slice(offset, Math.min(f.size, offset + CHANNEL_CHUNK)).bytes());
        const query = new URLSearchParams({ path: f.path, offset: String(offset) });
        await peerCall(h.s, job.target, `/handoff/${job.id}/files?${query}`, { method: "PUT", body: chunk, timeout: 120_000 });
        if (f.size === 0) break;
      }
    }

    const manifest: Manifest = {
      source: h.s.nodeId, sourceThreadId: job.thread, sessionId: st.sessionId!, driver: st.driver!, title: st.title!,
      modelSelection: st.modelSelection!, runtimeMode: st.runtimeMode!, interactionMode: st.interactionMode!,
      remoteUrl: st.remoteUrl!, projectTitle: st.projectTitle!, branch: st.branch ?? null, baseSha: st.baseSha ?? null,
      headSha: st.headSha!, snapshot: st.snapshot!, bundle: !!st.bundle, worktree: !!st.worktreePath, wasWorking: !!st.wasWorking,
      // Sent only when there is some, so a destination on the previous version still accepts ordinary handoffs.
      ...(st.background?.length ? { background: st.background } : {}),
      ...(st.queued?.length ? { queued: st.queued } : {}),
      oldPaths: [...new Set([st.cwd!, st.workspaceRoot!].flatMap((p) => [p, realPath(p)]))], files: st.files!,
    };
    await peerCall(h.s, job.target, `/handoff/${job.id}/start`, { json: manifest });
  });
  h.advance(job, "await");
}



/** Poll B until it imported. Returns false to stop the loop for now (B unreachable; the tick retries). */
async function wait(h: Handoffs, job: Job<SourceState>): Promise<boolean> {
  const st = job.state;
  const started = performance.now();
  for (; ;) {
    if (h.closed) return false;
    let r: { status: string; threadId?: string; codeTaken?: boolean; warnings?: string[]; timings?: Timing[]; error?: string };
    try {
      r = await peerCall(h.s, job.target, `/handoff/${job.id}`);
      st.lostSince = undefined;
    } catch (e) {
      if (e instanceof PeerError && e.status === 404) throw new Error(`${job.target} lost the handoff`);
      // Unknown whether B imported, so never abort on silence alone: give up only once B confirms it did not.
      st.lostSince ??= h.s.now();
      h.save(job);
      if (h.s.now() - st.lostSince > LOST) {
        const aborted = await peerCall(h.s, job.target, `/handoff/${job.id}`, { method: "DELETE" }).then(() => true, () => false);
        if (aborted) throw new Error(`lost contact with ${job.target}`);
      }
      await sleep(h.pollMs * 5);
      continue;
    }

    if (r.status === "failed") throw new Error(r.error ?? `${job.target} failed`);
    if (r.status === "imported") {
      st.timings.push({ step: `await ${job.target}`, node: h.s.nodeId, ms: Math.round(performance.now() - started) });
      Object.assign(st, { destThreadId: r.threadId, codeTaken: r.codeTaken, remoteTimings: r.timings, warnings: [...st.warnings, ...(r.warnings ?? [])] });
      h.advance(job, "finish");
      return true;
    }
    await sleep(h.pollMs);
  }
}

/** After B imported: archive here and park the sent uncommitted files. Retried until it succeeds. */
async function finish(h: Handoffs, job: Job<SourceState>) {
  const st = job.state;
  if (st.finishAt && h.s.now() < st.finishAt) return;
  try {
    await t3Client(h.s).rpc(async (call) => {
      const archived = (await projection(call, job.thread)).thread.archivedAt;
      if (!archived) await dispatch(call, { type: "thread.archive", threadId: job.thread });
    });

    // Park the sent changes so this worktree is clean for the return trip, but only once the destination took them,
    // and never in the main checkout, which other threads share. The return trip drops the stash again.
    if (st.worktreePath && st.snapshot?.uncommitted && st.codeTaken) {
      const message = `agentgate: handed to ${job.target} (${job.id})`;
      if (await stashIfUnchanged(st.worktreePath, st.snapshot, message)) h.s.setLocal(sessionNote.stash(st.sessionId!), message);
      else st.warnings.push(`Left the uncommitted changes in ${st.worktreePath}: the worktree changed after it was sent`);
    }
    rmSync(h.dir(job.id), { recursive: true, force: true });
    h.advance(job, "done");
  } catch (e) {
    if (!st.finishAt) st.warnings.push(`Could not archive the thread on ${h.s.nodeId} yet (${(e as Error).message}); retrying`);
    st.finishAt = h.s.now() + 30_000; h.save(job);
  }
}
