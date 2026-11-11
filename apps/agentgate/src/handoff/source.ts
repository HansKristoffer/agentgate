import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { getErrorMessage, getUniqueValues, startTimer, sumBy } from "hanzio";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { sleep } from "../runtime.ts";
import { createBundle, describe, snapshot, stashIfUnchanged, type Snapshot } from "./code.ts";
import { PeerError, peerCall, sessionNote, timed, transport, type Handoffs, type Job, type Timing } from "./jobs.ts";
import { CHANNEL_CHUNK } from "../channel.ts";
import { sessionLines } from "./history.ts";
import { realPath, sessionProviders } from "./session.ts";
import { ACTIVE, T3Error, claudeInstance, dispatch, projection, t3Client } from "./t3.ts";
import { QUEUED_MAX, send as sendMessage, type Manifest } from "./destination.ts";
import { FILES_PROTOCOL, localEdits, managedFiles } from "../checkout-files.ts";
import { canonicalProject, parseRemote } from "../mcp/gateway.ts";
import type { HandoffCancel } from "@agentgate/protocol";

/** The steps on the thread's own machine (A): resolve → stop → package → send → await → finish.
 * B prepares its checkout while A stops the agent and packs. Until B reports `imported`, A may abort: the user's
 * queued messages go back on the thread, and nothing else here changed but the interrupted run. Afterwards it never
 * aborts, or the conversation would split in two. */

export interface SourceState {
  title?: string;
  sessionId?: string;
  driver?: string;
  claudeHome?: string;
  projectTitle?: string;
  modelSelection?: Record<string, unknown>;
  runtimeMode?: string;
  interactionMode?: string;
  workspaceRoot?: string;
  worktreePath?: string | null;
  cwd?: string;
  remoteUrl?: string;
  branch?: string | null;
  baseSha?: string | null;
  wasWorking?: boolean;
  background?: string[];
  queued?: string[];
  /** The user messages `queued` came from, so a failed handoff queues again only those stop cancelled. */
  queuedIds?: string[];
  headSha?: string;
  snapshot?: Snapshot;
  bundle?: boolean;
  files?: { path: string; size: number }[];
  /** The manifest went out at least once, so B may have imported the thread. */
  started?: boolean;
  destThreadId?: string;
  codeTaken?: boolean;
  lostSince?: number;
  finishAt?: number;
  finishTries?: number;
  warnings: string[];
  timings: Timing[];
  remoteTimings?: Timing[];
}

/** Most one handoff may move through the relay; Tailscale has only the destination's 1 GiB cap. */
const RELAY_MAX = 512 * 1024 * 1024;
const LOST = 30 * 60_000;
const FINISH_TRIES = 120;
const BEFORE_IMPORT = new Set(["resolve", "stop", "package", "send", "await"]);

/** Start handing `threadId` (on this node) to `target`. Resolves the thread before returning, so a thread that
 * cannot move fails here; the agent is interrupted only after the caller has the job id. */
export async function startHandoff(h: Handoffs, threadId: string, target: string): Promise<string> {
  if (target === h.s.nodeId) throw new T3Error("the thread already runs on this node");
  if (
    h.list<SourceState>("source").some((j) => j.thread === threadId && !["done", "failed", "finish"].includes(j.step))
  )
    throw new T3Error("a handoff of this thread is already running");
  const id = crypto.randomUUID();
  const job = h.create<SourceState>({
    id,
    role: "source",
    thread: threadId,
    target,
    step: "resolve",
    state: { warnings: [], timings: [] },
  });
  h.starting.add(id);
  try {
    await resolve(h, job);
  } catch (e) {
    h.fail(job, `resolve on ${h.s.nodeId}: ${getErrorMessage(e)}`);
    throw e;
  } finally {
    h.starting.delete(id);
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
      title: t.title,
      sessionId: native.nativeThreadRef!.nativeId,
      driver: native.driver,
      claudeHome: home,
      projectTitle: project.title,
      modelSelection: t.modelSelection,
      runtimeMode: t.runtimeMode,
      interactionMode: t.interactionMode,
      workspaceRoot: project.workspaceRoot,
      worktreePath: t.worktreePath,
      cwd,
      remoteUrl: code.remoteUrl,
      branch: code.branch,
      baseSha: code.baseSha,
    });
  });
  h.advance(job, "stop");
  // B creates its worktree and runs setup while A stops and packs; `start` runs it there if this is lost.
  void peerCall(h.s, job.target, `/handoff/${job.id}/prepare`, { json: prepareInput(st) }).catch(() => {});
}

const prepareInput = (st: SourceState) => ({
  remoteUrl: st.remoteUrl,
  projectTitle: st.projectTitle,
  branch: st.branch ?? null,
  baseSha: st.baseSha ?? null,
  worktree: !!st.worktreePath,
});

export async function runSource(h: Handoffs, id: string) {
  for (;;) {
    const job = h.load<SourceState>("source", id);
    if (!job || h.closed || job.step === "done" || job.step === "failed") return;
    const st = job.state;
    try {
      switch (job.step) {
        case "resolve":
          await resolve(h, job);
          break;
        case "stop":
          await stop(h, job);
          break;
        case "package":
          await pack(h, job);
          break;
        case "send":
          await send(h, job);
          break;
        case "await":
          if (!(await wait(h, job))) return;
          break;
        case "finish":
          await finish(h, job);
          if (job.step === "finish") return;
          break;
        default:
          return;
      }
    } catch (e) {
      // A stop cuts the step short (its git is killed); it runs again on the next start.
      if (h.closed) return;
      const message = `${job.step} on ${h.s.nodeId}: ${getErrorMessage(e)}`;
      if (!BEFORE_IMPORT.has(job.step)) {
        st.warnings.push(message);
        h.save(job);
        return;
      }
      await peerCall(h.s, job.target, `/handoff/${id}`, { method: "DELETE" }).catch(() => {});
      await failBeforeImport(h, job, message, true);
      return;
    }
  }
}

async function stop(h: Handoffs, job: Job<SourceState>) {
  const st = job.state;
  await timed(h.s, st.timings, "stop", () =>
    t3Client(h.s).rpc(async (call) => {
      let p = await projection(call, job.thread);
      // Remember before interrupting: after a restart the run is already stopped, and the background work with it.
      if (p.runs.some((r) => ACTIVE.has(r.status)) && !st.wasWorking) {
        st.wasWorking = true;
        h.save(job);
      }
      const tasks =
        p.providerThreads.find((pt) => pt.id === p.thread.activeProviderThreadId)?.pendingBackgroundTasks ?? [];
      if (tasks.length > 0 && !st.background) {
        st.background = tasks
          .slice(0, 20)
          .map((t) => `${t.kind ?? "task"}: ${t.description ?? "unnamed"}`.slice(0, 2000));
        h.save(job);
      }
      // Read before cancelling: the destination queues them again behind the continued turn.
      if (!st.queued) {
        const { texts, ids, attachments, overflow } = queuedMessages(p);
        st.queued = texts;
        st.queuedIds = ids;
        const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
        if (attachments)
          st.warnings.push(`${plural(attachments, "attachment")} on queued messages stayed on ${h.s.nodeId}`);
        if (overflow)
          st.warnings.push(
            `${plural(overflow, "queued message")} did not fit in the handoff and stayed on ${h.s.nodeId}`,
          );
        h.save(job);
      }
      for (const r of p.runs.filter((r) => r.status === "queued")) {
        await dispatch(call, { type: "queued-run.cancel", threadId: job.thread, runId: r.id });
      }
      for (const r of p.runs.filter((r) => ACTIVE.has(r.status))) {
        await dispatch(call, {
          type: "run.interrupt",
          threadId: job.thread,
          runId: r.id,
          reason: `Handed off to ${job.target}`,
        });
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
      const left =
        p.providerThreads.find((pt) => pt.id === p.thread.activeProviderThreadId)?.pendingBackgroundTasks ?? [];
      if (left.length === 0 || !latest) return;
      await dispatch(call, {
        type: "run.interrupt",
        threadId: job.thread,
        runId: latest.id,
        reason: `Handed off to ${job.target}`,
      }).catch(() =>
        st.warnings.push(`Background tasks may still be running on ${h.s.nodeId}; stop them in T3 Code there.`),
      );
    }),
  );
  h.advance(job, "package");
}

/** The user's queued messages in T3's delivery order, as text. Server-made ones (a child task's result, a notification)
 * belong to this machine's thread. Attachments do not move, nor messages past the cap. */
function queuedMessages(p: Awaited<ReturnType<typeof projection>>) {
  const texts: string[] = [],
    ids: string[] = [];
  let attachments = 0,
    overflow = 0,
    chars = 0;
  const order = (r: (typeof p.runs)[number]) => r.queuePosition ?? r.ordinal ?? 0;
  const runs = p.runs
    .filter((r) => r.status === "queued")
    .sort((x, y) => order(x) - order(y) || (x.ordinal ?? 0) - (y.ordinal ?? 0));
  for (const r of runs) {
    const m = p.messages.find((m) => m.id === r.userMessageId);
    if (!m || m.notification !== undefined || m.delegatedCompletion !== undefined) continue;
    attachments += m.attachments.length;
    if (!m.text.trim()) continue;
    // Past the first that does not fit, none move, so the ones that do keep their order.
    if (overflow || texts.length === QUEUED_MAX.count || chars + m.text.length > QUEUED_MAX.chars) overflow++;
    else {
      texts.push(m.text);
      ids.push(m.id);
      chars += m.text.length;
    }
  }
  return { texts, ids, attachments, overflow };
}

async function pack(h: Handoffs, job: Job<SourceState>) {
  const st = job.state;
  await timed(h.s, st.timings, "package", async () => {
    // HEAD may have moved since resolve if the agent committed before stopping; the bundle is built from now.
    const code = await describe(st.cwd!);
    st.headSha = code.headSha;
    st.snapshot = await snapshot(st.cwd!, job.id, code.headSha, await storeFiles(h, job));

    const out = join(h.dir(job.id), "out");
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true, mode: 0o700 });
    st.bundle = await createBundle(st.cwd!, job.id, st.snapshot.sha, join(out, "bundle"), h.signal);

    const located = sessionProviders[st.driver!]!.locate(st.claudeHome!, st.sessionId!, st.cwd!);
    if (!located)
      throw new T3Error(
        `the Claude session is not in ${st.claudeHome}, the Claude home of the thread's provider in T3 Code`,
      );
    // Copied now, while the agent is stopped, so a retried send resends the same bytes.
    for (const file of located.files) {
      mkdirSync(dirname(join(out, "session", file)), { recursive: true });
      copyFileSync(join(located.root, file), join(out, "session", file));
    }
    const edits = await carriedFiles(h, job);
    for (const path of edits) {
      mkdirSync(dirname(join(out, "checkout-files", path)), { recursive: true });
      copyFileSync(join(st.cwd!, path), join(out, "checkout-files", path));
    }
    const paths = [
      ...(st.bundle ? ["bundle"] : []),
      ...located.files.map((f) => `session/${f}`),
      ...edits.map((f) => `checkout-files/${f}`),
    ];
    st.files = paths.map((path) => ({ path, size: statSync(join(out, path)).size }));

    // A later handoff back here finds the thread that held this session (round trips reuse threads), and the records
    // added elsewhere in the meantime.
    h.s.setLocal(sessionNote.thread(st.sessionId!), job.thread);
    h.s.setLocal(
      sessionNote.lines(st.sessionId!),
      String(sessionLines(readFileSync(join(located.root, located.files[0]!), "utf8"))),
    );
  });
  h.advance(job, "send");
}

/** The files the file store manages for this checkout; they travel through it, never in the snapshot. */
async function storeFiles(h: Handoffs, job: Job<SourceState>): Promise<string[]> {
  const root = h.options.filesRoot;
  const repo = parseRemote(job.state.remoteUrl!);
  if (!root || !repo) return [];
  return managedFiles(root, job.state.cwd!, h.s.get("project", canonicalProject(h.s, repo))?.fileList ?? []).catch(
    () => [],
  );
}

/** Gitignored files the checkout changed from its file store (checkout-files.ts): the thread's own `.env.local` edits.
 * Never what fails a handoff; they stay here with a warning instead. */
async function carriedFiles(h: Handoffs, job: Job<SourceState>): Promise<string[]> {
  const st = job.state;
  const root = h.options.filesRoot;
  if (!root) return [];
  try {
    const repo = parseRemote(st.remoteUrl!);
    const listed = repo ? (h.s.get("project", canonicalProject(h.s, repo))?.fileList ?? []) : [];
    const paths = await localEdits(root, st.cwd!, listed);
    if (paths.length && (h.s.get("node", job.target)?.protocol ?? 0) < FILES_PROTOCOL) {
      st.warnings.push(
        `Your changes to ${paths.join(", ")} stayed on ${h.s.nodeId}: update agentgate on ${job.target} to carry them`,
      );
      return [];
    }
    return paths;
  } catch (e) {
    st.warnings.push(`Changes to gitignored files stayed on ${h.s.nodeId}: ${getErrorMessage(e)}`);
    return [];
  }
}

async function send(h: Handoffs, job: Job<SourceState>) {
  const st = job.state;
  // The manifest went out before a restart: B either has it or abandons the prepare, and await learns which.
  if (st.started) return h.advance(job, "await");
  const out = join(h.dir(job.id), "out");
  await timed(h.s, st.timings, "send", async () => {
    // Again, idempotently: B may have missed the first prepare or restarted, and takes files only for a known job.
    await peerCall(h.s, job.target, `/handoff/${job.id}/prepare`, { json: prepareInput(st) });

    // One chunk size for Tailscale and the relay, each gzipped on its own. A retry restarts a file at offset 0.
    if (transport(h.s, job.target) === "relay" && sumBy(st.files!, "size") > RELAY_MAX) {
      throw new T3Error(
        "the thread's code and session are larger than the relay takes (512 MiB); pair the machines over Tailscale",
      );
    }
    for (const f of st.files!) {
      const file = Bun.file(join(out, f.path));
      for (let offset = 0; offset === 0 || offset < f.size; offset += CHANNEL_CHUNK) {
        const chunk = gzipSync(await file.slice(offset, Math.min(f.size, offset + CHANNEL_CHUNK)).bytes());
        const query = new URLSearchParams({ path: f.path, offset: String(offset) });
        await peerCall(h.s, job.target, `/handoff/${job.id}/files?${query}`, {
          method: "PUT",
          body: chunk,
          timeout: 120_000,
        });
        if (f.size === 0) break;
      }
    }

    const manifest: Manifest = {
      source: h.s.nodeId,
      sourceThreadId: job.thread,
      sessionId: st.sessionId!,
      driver: st.driver!,
      title: st.title!,
      modelSelection: st.modelSelection!,
      runtimeMode: st.runtimeMode!,
      interactionMode: st.interactionMode!,
      remoteUrl: st.remoteUrl!,
      projectTitle: st.projectTitle!,
      branch: st.branch ?? null,
      baseSha: st.baseSha ?? null,
      headSha: st.headSha!,
      snapshot: st.snapshot!,
      bundle: !!st.bundle,
      worktree: !!st.worktreePath,
      wasWorking: !!st.wasWorking,
      // Sent only when there is some, so a destination on the previous version still accepts ordinary handoffs.
      ...(st.background?.length ? { background: st.background } : {}),
      ...(st.queued?.length ? { queued: st.queued } : {}),
      oldPaths: getUniqueValues([st.cwd!, st.workspaceRoot!].flatMap((p) => [p, realPath(p)])),
      files: st.files!,
    };
    st.started = true;
    h.save(job);
    // B may take the manifest and still lose its answer (a relay timeout, a dropped connection): only a refusal is
    // certain. Failing on anything else could leave the thread on both machines; await learns from B what happened.
    await peerCall(h.s, job.target, `/handoff/${job.id}/start`, { json: manifest }).catch((e) => {
      if (e instanceof PeerError && e.status < 500) throw e;
    });
  });
  h.advance(job, "await");
}

/** Poll B until it imported. Returns false to stop the loop for now (B unreachable; the tick retries). */
async function wait(h: Handoffs, job: Job<SourceState>): Promise<boolean> {
  const st = job.state;
  const elapsed = startTimer();
  for (;;) {
    // Closing, or cancelled meanwhile (cancelHandoff).
    if (h.closed || h.load("source", job.id)?.step !== "await") return false;
    let r: {
      status: string;
      threadId?: string;
      codeTaken?: boolean;
      warnings?: string[];
      timings?: Timing[];
      error?: string;
    };
    try {
      r = await peerCall(h.s, job.target, `/handoff/${job.id}`);
      st.lostSince = undefined;
    } catch (e) {
      if (e instanceof PeerError && e.status === 404) throw new Error(`${job.target} lost the handoff`);
      // Unknown whether B imported, so never abort on silence alone: give up only once B confirms it did not.
      st.lostSince ??= h.s.now();
      h.save(job);
      if (h.s.now() - st.lostSince > LOST) {
        const aborted = await peerCall(h.s, job.target, `/handoff/${job.id}`, { method: "DELETE" }).then(
          () => true,
          () => false,
        );
        if (aborted) throw new Error(`lost contact with ${job.target}`);
      }
      await sleep(h.pollMs * 5);
      continue;
    }

    if (r.status === "failed") throw new Error(r.error ?? `${job.target} failed`);
    if (r.status === "imported") {
      // The destination has everything it needs: the packed output (up to 1 GiB) need not wait for finish.
      rmSync(h.dir(job.id), { recursive: true, force: true });
      st.timings.push({ step: `await ${job.target}`, node: h.s.nodeId, ms: Math.round(elapsed()) });
      Object.assign(st, {
        destThreadId: r.threadId,
        codeTaken: r.codeTaken,
        remoteTimings: r.timings,
        warnings: [...st.warnings, ...(r.warnings ?? [])],
      });
      h.advance(job, "finish");
      return true;
    }
    await sleep(h.pollMs);
  }
}

/** Fail a job before B imported. With `giveBack`, the user's queued messages that stop cancelled go back on the thread
 * here: only by the caller whose `fail` ended the job, so each is queued once, and never again after a restart. */
async function failBeforeImport(h: Handoffs, job: Job<SourceState>, message: string, giveBack: boolean) {
  if (!h.fail(job, message) || !giveBack) return;
  const st = job.state;
  const ids = st.queuedIds ?? [];
  if (!ids.length) return;
  try {
    await t3Client(h.s).rpc(async (call) => {
      const { runs } = await projection(call, job.thread);
      for (const [i, id] of ids.entries()) {
        if (runs.find((r) => r.userMessageId === id)?.status !== "cancelled") continue;
        await sendMessage(call, job.thread, st.queued![i]!, "queue_after_active");
      }
    });
  } catch (e) {
    h.warnFailed(
      job,
      `Queued messages may be missing from the thread on ${h.s.nodeId} (${getErrorMessage(e)}); send them again there`,
    );
  }
}

/** Give up a handoff that waits for its destination (gone, unpaired, or not answering), so the thread can be handed
 * off again. If the destination stops its side, or never had it, the handoff fails like any other before the import.
 * If it cannot be asked, it may already run the thread: the job ends without giving anything back here. */
export async function cancelHandoff(h: Handoffs, id: string): Promise<HandoffCancel> {
  const job = h.load<SourceState>("source", id);
  if (!job) throw new T3Error(`no handoff ${id} started on ${h.s.nodeId}`);
  if (job.step !== "await")
    throw new T3Error(
      job.step === "done" || job.step === "failed"
        ? "the handoff already ended"
        : job.step === "finish"
          ? `${job.target} already has the thread; it is being archived on ${h.s.nodeId}`
          : "only a handoff waiting for its destination can be cancelled; this one is still sending",
    );
  const answer = await peerCall(h.s, job.target, `/handoff/${id}`, { method: "DELETE" }).then(
    () => "aborted" as const,
    (e) => (!(e instanceof PeerError) || e.status >= 500 ? "unknown" : e.status === 404 ? "aborted" : "imported"),
  );
  if (answer === "imported")
    throw new T3Error(`${job.target} already imported the thread; the handoff finishes once ${h.s.nodeId} hears back`);
  const aborted = answer === "aborted";
  // Loaded again after the wait: the handoff may have moved on meanwhile (its own loop may have seen the abort first,
  // and failed it already). Nothing runs between this and the fail.
  const current = h.load<SourceState>("source", id)!;
  if (current.step !== "await" && !(aborted && current.step === "failed"))
    throw new T3Error(`the handoff moved on to ${current.step} meanwhile`);
  await failBeforeImport(
    h,
    current,
    aborted
      ? `cancelled on ${h.s.nodeId}; ${job.target} stopped its side`
      : `given up on ${h.s.nodeId} without reaching ${job.target}, which may already have the thread`,
    aborted,
  );
  const queued = current.state.queuedIds?.length ?? 0;
  return {
    aborted,
    message: aborted
      ? `Cancelled: the thread stays on ${h.s.nodeId}.`
      : `Gave up without reaching ${job.target}, which may already have the thread. Check T3 Code on ${job.target}: if the thread is there, continue it there and archive it on ${h.s.nodeId}.` +
        (queued ? ` Its queued messages were not queued again on ${h.s.nodeId}.` : ""),
  };
}

/** After B imported: archive here and park the sent uncommitted files. Retried every 30 seconds for an hour, then left
 * to the user. */
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
      if (await stashIfUnchanged(st.worktreePath, st.snapshot, message))
        h.s.setLocal(sessionNote.stash(st.sessionId!), message);
      else
        st.warnings.push(`Left the uncommitted changes in ${st.worktreePath}: the worktree changed after it was sent`);
    }
    h.advance(job, "done");
  } catch (e) {
    st.finishTries = (st.finishTries ?? 0) + 1;
    if (st.finishTries >= FINISH_TRIES) {
      st.warnings.push(`Stopped retrying on ${h.s.nodeId}: archive the thread in T3 Code there if it is still open`);
      return h.advance(job, "done");
    }
    if (!st.finishAt)
      st.warnings.push(`Could not archive the thread on ${h.s.nodeId} yet (${getErrorMessage(e)}); retrying`);
    st.finishAt = h.s.now() + 30_000;
    h.save(job);
  }
}
