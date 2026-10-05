import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { atomicWrite } from "../files.ts";
import { basename, join } from "node:path";
import type { HandoffJob } from "@agentgate/protocol";
import { z } from "zod";
import { parseRemote } from "../mcp/gateway.ts";
import { sleep } from "../runtime.ts";
import { addWorktree, dropRef, dropStash, ensureCommit, fetchBundle, git, manifestsChanged, moveToSource, run, worktrees } from "./code.ts";
import { sessionNote, timed, type Handoffs, type Job, type Timing } from "./jobs.ts";
import { SAFE_ID, safeRelative, sessionProviders } from "./session.ts";
import { T3Error, TERMINAL, claudeInstance, dispatch, projection, t3Client, type Call } from "./t3.ts";

/** The steps on the receiving machine (B). `prepare` (find or clone the repository, make the worktree, start setup)
 * overlaps with A stopping and packing; after `start`: apply the code → place the session → import it into T3 →
 * report `imported` → wait for setup and continue the agent. */

const sha = z.string().regex(/^[0-9a-f]{40,64}$/);
export const prepareSchema = z.object({
  remoteUrl: z.string().min(1).max(2048),
  projectTitle: z.string().min(1).max(512),
  branch: z.string().min(1).max(512).nullable(),
  baseSha: sha.nullable(),
  worktree: z.boolean(),
}).strict();
export const manifestSchema = prepareSchema.extend({
  source: z.string().min(1).max(512),
  sourceThreadId: z.string().min(1).max(512),
  sessionId: z.string().regex(SAFE_ID),
  driver: z.string().min(1).max(64),
  title: z.string().min(1).max(1000),
  modelSelection: z.record(z.string(), z.unknown()),
  runtimeMode: z.string().min(1).max(64),
  interactionMode: z.string().min(1).max(64),
  headSha: sha,
  snapshot: z.object({ sha, uncommitted: z.boolean() }),
  bundle: z.boolean(),
  wasWorking: z.boolean(),
  oldPaths: z.array(z.string().min(1).max(4096)).max(16),
  files: z.array(z.object({ path: z.string().refine(safeRelative), size: z.number().int().nonnegative() })).max(10_000),
}).strict();
type Prepare = z.infer<typeof prepareSchema>;
export type Manifest = z.infer<typeof manifestSchema>;

export interface DestState {
  source: string;
  prepare: Prepare;
  manifest?: Manifest;
  projectId?: string;
  /** The project's main checkout. */
  main?: string;
  /** Where the thread runs: the main checkout or a worktree. */
  cwd?: string;
  setupCommand?: string;
  /** Whether the checkout moved onto the source's code; the source parks its sent changes only then. */
  codeTaken?: boolean;
  threadId?: string;
  /** The Claude provider instance the thread runs with here, and its home. */
  instanceId?: string;
  claudeHome?: string;
  /** No thread here held the session, so T3 imported it from a copy under the main checkout. */
  imported?: boolean;
  continued?: boolean;
  warnings: string[];
  timings: Timing[];
}

export const CONTINUE = "Continue where you left off.";
/** A turn still running after this is working, not failing on its first message (T3's import bug fails fast). */
const FIRST_TURN = 2 * 60_000;
/** What A sees of each step. */
const STATUS: Record<string, "preparing" | "running" | "imported" | "failed"> = {
  prepare: "preparing", prepared: "preparing",
  apply: "running", place: "running", import: "running",
  continue: "imported", done: "imported",
  failed: "failed",
};

export function destinationView(h: Handoffs, job: Job<DestState>): HandoffJob {
  const st = job.state;
  const shown = STATUS[job.step];
  const status = job.step === "done" ? "done" : shown === "imported" || shown === "failed" ? shown : "running";
  return {
    id: job.id, role: "destination", node: h.s.nodeId, from: st.source, to: h.s.nodeId,
    thread: st.manifest?.sourceThreadId ?? job.thread, title: st.manifest?.title, step: job.step, status,
    destThreadId: st.threadId, warnings: st.warnings, error: job.error, timings: st.timings,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
  };
}

/** What A polls: the status, the imported thread, and B's warnings and timings. */
export function peerStatus(h: Handoffs, job: Job<DestState>) {
  const st = job.state;
  return {
    step: job.step, status: STATUS[job.step] ?? "running", threadId: st.threadId,
    codeTaken: st.codeTaken, warnings: st.warnings, timings: st.timings, error: job.error,
  };
}

// `start` hands the manifest to the step loop as a file, so the loop stays the only writer of the job's state.
export const manifestFile = (h: Handoffs, id: string) => join(h.dir(id), "manifest.json");

/** The job, created by whichever of prepare and start arrives first, and only ever driven for its own source. */
function destinationJob(h: Handoffs, id: string, source: string, prepare: Prepare, thread = "") {
  const job = h.create<DestState>({ id, role: "destination", thread, target: h.s.nodeId, step: "prepare", state: { source, prepare, warnings: [], timings: [] } });
  if (job.state.source !== source) throw new T3Error("that handoff belongs to another node");
  return job;
}

export function prepare(h: Handoffs, id: string, source: string, input: Prepare) {
  destinationJob(h, id, source, input);
  void h.drive("destination", id);
}

export function start(h: Handoffs, id: string, source: string, manifest: Manifest) {
  const { remoteUrl, projectTitle, branch, baseSha, worktree } = manifest;
  const job = destinationJob(h, id, source, { remoteUrl, projectTitle, branch, baseSha, worktree }, manifest.sourceThreadId);
  if (job.step === "failed") throw new T3Error(job.error ?? "the handoff failed");

  if (job.step === "prepare" || job.step === "prepared") {
    for (const f of manifest.files) {
      const session = f.path.startsWith("session/");
      if (!session && f.path !== "bundle") throw new T3Error(`unexpected file ${f.path}`);
      if (session && !sessionProviders[manifest.driver]?.accepts(manifest.sessionId, f.path.slice(8))) throw new T3Error(`unexpected session file ${f.path}`);
      const path = join(h.dir(id), "files", f.path);
      if (!existsSync(path) || Bun.file(path).size !== f.size) throw new T3Error(`${f.path} has not fully arrived`);
    }
    atomicWrite(manifestFile(h, id), JSON.stringify(manifest));
  }
  void h.drive("destination", id);
}

/** Abort before import. After it, the thread lives here and only the user can move it again. */
export function abort(h: Handoffs, job: Job<DestState>) {
  if (job.step === "continue" || job.step === "done") throw new T3Error("the thread was already imported here");
  if (job.step !== "failed") h.fail(job, "aborted by the source");
}

export async function runDestination(h: Handoffs, id: string) {
  for (; ;) {
    const job = h.load<DestState>("destination", id);
    if (!job || h.closed) return;
    try {
      switch (job.step) {
        case "prepare": await doPrepare(h, job); break;
        case "prepared": {
          if (!existsSync(manifestFile(h, id))) return;
          const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestFile(h, id), "utf8")));
          job.state.manifest = manifest;
          job.thread = manifest.sourceThreadId; h.advance(job, "apply");
          break;
        }
        case "apply": await apply(h, job); break;
        case "place": await place(h, job); break;
        case "import": await importThread(h, job); break;
        case "continue": await carryOn(h, job); break;
        default: return;
      }
    } catch (e) {
      h.fail(job, `${job.step} on ${h.s.nodeId}: ${(e as Error).message}`);
      return;
    }
  }
}

const repoName = (remoteUrl: string) => parseRemote(remoteUrl)?.split("/")[1] ?? basename(remoteUrl).replace(/\.git$/, "");

async function doPrepare(h: Handoffs, job: Job<DestState>) {
  const st = job.state;
  const p = st.prepare;

  await timed(h.s, st.timings, "prepare", async () => {
    if (!st.main) {
      const project = await findProject(h, p.remoteUrl);
      if (project) {
        const setupCommand = project.scripts.find((s) => s.runOnWorktreeCreate)?.command;
        Object.assign(st, { projectId: project.id, main: project.workspaceRoot, setupCommand });
      } else {
        Object.assign(st, await cloneProject(h, p.remoteUrl));
        if (!p.worktree) {
          st.cwd = st.main;
          startSetup(h, job);
        }
      }
      h.save(job);
    }
    if (!st.cwd) await workspace(h, job, p.baseSha);
  });

  if (job.step === "prepare") h.advance(job, "prepared");
}

/** This node's T3 project for the repository, matched by `owner/repo` of its origin. */
async function findProject(h: Handoffs, remoteUrl: string) {
  const want = parseRemote(remoteUrl)?.toLowerCase();
  if (!want) return undefined;
  for (const project of (await t3Client(h.s).shell()).projects) {
    if (!existsSync(project.workspaceRoot)) continue;
    const origin = (await run(project.workspaceRoot, ["config", "--get", "remote.origin.url"])).out;
    if (parseRemote(origin)?.toLowerCase() === want) return project;
  }
  return undefined;
}

/** Clone the repository with this node's own git credentials and make it a T3 project. */
async function cloneProject(h: Handoffs, remoteUrl: string) {
  const repo = repoName(remoteUrl);
  mkdirSync(h.options.cloneDir, { recursive: true });
  let dir = join(h.options.cloneDir, repo);
  for (let n = 2; existsSync(dir); n++) dir = join(h.options.cloneDir, `${repo}-${n}`);
  await git(h.options.cloneDir, ["clone", remoteUrl, dir]);

  const create = { type: "project.create", commandId: crypto.randomUUID(), projectId: crypto.randomUUID(), title: repo, workspaceRoot: dir };
  const project = z.object({ id: z.string() }).passthrough().parse(await t3Client(h.s).rpc((call) => call("projects.mutate", create)));
  return { projectId: project.id, main: dir };
}

/** The checkout the thread runs in: B's main checkout, a worktree already on the branch (reused, so setup runs once
 * per branch and machine), or a new worktree from `start`. Without a start commit yet, wait for the code. */
async function workspace(h: Handoffs, job: Job<DestState>, startAt: string | null) {
  const st = job.state;
  const p = st.prepare;
  const main = st.main!;
  const use = (cwd: string) => {
    st.cwd = cwd;
    h.save(job);
  };

  if (!p.worktree) return use(main);
  const existing = p.branch && (await worktrees(main)).find((w) => w.branch === p.branch && existsSync(w.path));
  if (existing) return use(existing.path);
  if (!startAt || !(await ensureCommit(main, startAt))) return;

  const repo = basename(main);
  const path = join(h.options.worktreesDir, repo, `${repo}-${job.id.slice(0, 8)}`);
  mkdirSync(join(h.options.worktreesDir, repo), { recursive: true });
  if (!existsSync(path)) await addWorktree(main, path, p.branch, startAt);
  use(path);
  startSetup(h, job);
}

/** The project's setup script (`runOnWorktreeCreate`) in the background, as T3 runs it. Only for a checkout made here:
 * a reused worktree already has its dependencies. A failure is a warning, not a failed handoff. */
function startSetup(h: Handoffs, job: Job<DestState>) {
  const st = job.state;
  const command = st.setupCommand;
  const cwd = st.cwd!;
  if (!command) return;

  const previous = h.setups.get(job.id) ?? Promise.resolve({ warnings: [], timings: [] });
  h.setups.set(job.id, previous.then(async (notes) => {
    const started = performance.now();
    try {
      const child = Bun.spawn([process.env.SHELL || "/bin/sh", "-lc", command], {
        cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, T3CODE_PROJECT_ROOT: st.main!, ...(cwd !== st.main && { T3CODE_WORKTREE_PATH: cwd }), COLORTERM: "" },
      });
      const timer = setTimeout(() => child.kill(), h.options.setupTimeoutMs ?? 15 * 60_000);
      const [, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      clearTimeout(timer);
      if (code !== 0) {
        const last = err.trim().split("\n").at(-1)?.slice(0, 300);
        notes.warnings.push(`Setup in ${cwd} failed (exit ${code})${last ? `: ${last}` : ""}`);
      }
    } catch (e) {
      notes.warnings.push(`Setup in ${cwd} could not start: ${(e as Error).message}`);
    }
    notes.timings.push({ step: "setup", node: h.s.nodeId, ms: Math.round(performance.now() - started) });
    return notes;
  }));
}

async function apply(h: Handoffs, job: Job<DestState>) {
  const st = job.state;
  const m = st.manifest!;
  const main = st.main!;

  await timed(h.s, st.timings, "apply", async () => {
    const present = m.bundle
      ? await fetchBundle(main, join(h.dir(job.id), "files", "bundle"), job.id)
      : await ensureCommit(main, m.snapshot.sha);
    // The code builds on a commit origin no longer has (a force-push): nothing here can recover it.
    if (!present) {
      throw new T3Error("the thread's code builds on a commit that is not on origin; push or fetch its branch on the source, then hand it off again");
    }

    if (!st.cwd) await workspace(h, job, m.headSha);
    if (!st.cwd) throw new T3Error("could not create a worktree for the thread");

    const before = await git(st.cwd, ["rev-parse", "HEAD"]);
    const kept = await moveToSource(st.cwd, m.branch, m.headSha, m.snapshot);
    st.codeTaken = !kept;
    if (kept) {
      st.warnings.push(`Kept ${h.s.nodeId}'s code in ${st.cwd}: ${kept}`);
    } else {
      // New dependencies in the arriving code: install them again once the first setup is done.
      if (await manifestsChanged(st.cwd, before, m.snapshot.sha)) startSetup(h, job);

      // The thread came back: the changes this machine parked when it left are in the code that just arrived.
      const parked = h.s.local(sessionNote.stash(m.sessionId));
      if (parked) {
        await dropStash(st.cwd, parked);
        h.s.setLocal(sessionNote.stash(m.sessionId), undefined);
      }
    }
    await dropRef(main, job.id);
  });
  h.advance(job, "place");
}

/** The thread on this node that already holds the session: the one it had before the thread left (a round trip), or
 * the one an earlier import created. T3's import only knows its own imports, so asking it again would duplicate a
 * thread this node created itself. */
async function knownThread(h: Handoffs, call: Call, instanceId: string, sessionId: string) {
  for (const id of [h.s.local(sessionNote.thread(sessionId)), `import:${instanceId}:${sessionId}`]) {
    if (id && await projection(call, id).then(() => true, () => false)) return id;
  }
  return undefined;
}

/** The same provider instance as on the source when this T3 Code has one by that id, else its default instance. */
async function instance(h: Handoffs, call: Call, st: DestState) {
  if (!st.instanceId || !st.claudeHome) {
    const id = st.manifest!.modelSelection.instanceId;
    const found = await claudeInstance(call, typeof id === "string" ? id : undefined, h.options.claudeDir);
    st.instanceId = found.instanceId;
    st.claudeHome = found.home;
  }
  return st.instanceId;
}

async function place(h: Handoffs, job: Job<DestState>) {
  const st = job.state;
  const m = st.manifest!;
  await timed(h.s, st.timings, "place", async () => {
    const provider = sessionProviders[m.driver];
    if (!provider) throw new T3Error(`${m.driver} sessions cannot be placed here`);

    await t3Client(h.s).rpc(async (call) => {
      const instanceId = await instance(h, call, st);
      st.threadId ??= await knownThread(h, call, instanceId, m.sessionId);
    });
    st.imported = !st.threadId;
    h.save(job);

    const from = join(h.dir(job.id), "files", "session");
    const files = m.files.filter((f) => f.path.startsWith("session/")).map((f) => f.path.slice(8));
    // Claude resumes from the key of the checkout the thread runs in; T3 imports only from a main checkout's key.
    const places = st.imported ? [st.main!, st.cwd!] : [st.cwd!];
    for (const cwd of new Set(places)) provider.place(st.claudeHome!, m.sessionId, from, files, cwd, m.oldPaths);
  });
  h.advance(job, "import");
}

async function importThread(h: Handoffs, job: Job<DestState>) {
  const st = job.state;
  const m = st.manifest!;
  await timed(h.s, st.timings, "import", () => t3Client(h.s).rpc(async (call) => {
    const instanceId = await instance(h, call, st);
    if (st.imported) {
      await call("agentSessions.scan", {});
      await call("agentSessions.import", { projectId: st.projectId });
      // Imported threads are named after the session.
      st.threadId = await knownThread(h, call, instanceId, m.sessionId);
      if (!st.threadId) throw new T3Error(`T3 Code on ${h.s.nodeId} did not import the Claude session`);
    }
    const threadId = st.threadId!;

    const p = await projection(call, threadId);
    if (p.thread.archivedAt) await dispatch(call, { type: "thread.unarchive", threadId });
    await dispatch(call, { type: "thread.metadata.update", threadId, worktreePath: st.cwd !== st.main ? st.cwd : null, branch: m.branch, title: m.title });
    await dispatch(call, { type: "thread.runtime-mode.set", threadId, runtimeMode: m.runtimeMode });
    await dispatch(call, { type: "thread.interaction-mode.set", threadId, interactionMode: m.interactionMode });
    await dispatch(call, { type: "thread.model-selection.set", threadId, modelSelection: { ...m.modelSelection, instanceId } });
  }));

  // The main checkout's copy was only for the import; Claude resumes from the worktree's. Left behind, a later import
  // there could pick up the stale transcript.
  if (st.imported && st.cwd !== st.main) sessionProviders[m.driver]!.remove(st.claudeHome!, m.sessionId, st.main!);
  h.advance(job, "continue");
}

/** After reporting `imported`: wait for setup, then let a working agent go on. T3 fails the first message of a freshly
 * imported thread (an upstream bug), so a failed first turn is sent once more. */
async function carryOn(h: Handoffs, job: Job<DestState>) {
  const st = job.state;
  const setup = await h.setups.get(job.id);
  h.setups.delete(job.id);
  if (setup) {
    st.warnings.push(...setup.warnings);
    st.timings.push(...setup.timings);
    h.save(job);
  }

  if (st.manifest!.wasWorking && !st.continued) {
    await timed(h.s, st.timings, "continue", () => t3Client(h.s).rpc(async (call) => {
      // Recorded before sending, so a restart never sends it twice.
      st.continued = true;
      h.save(job);
      if (await turn(h, call, st.threadId!) === "failed") await turn(h, call, st.threadId!);
    }));
  }

  rmSync(h.dir(job.id), { recursive: true, force: true });
  h.advance(job, "done");
}

async function turn(h: Handoffs, call: Call, threadId: string): Promise<string> {
  const messageId = crypto.randomUUID();
  await dispatch(call, {
    type: "message.dispatch", threadId, messageId, text: CONTINUE, attachments: [],
    dispatchMode: { type: "start_immediately" }, createdBy: "user", creationSource: "web",
  });
  const deadline = h.s.now() + FIRST_TURN;
  for (; ;) {
    const r = (await projection(call, threadId)).runs.find((run) => run.userMessageId === messageId);
    if (r && TERMINAL.has(r.status)) return r.status;
    if (h.s.now() > deadline || h.closed) return r?.status ?? "unknown";
    await sleep(h.pollMs);
  }
}
