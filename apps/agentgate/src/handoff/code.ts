import { copyFileSync, existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { killGroup } from "../runtime.ts";

/** The code that travels with a thread: local commits plus a snapshot commit of uncommitted, untracked and ignored
 * files, as a git bundle sent between daemons. Nothing is pushed to `origin`; the source's branch, index and files stay
 * as they are until the destination confirms it took the code. */

/** `plainTree` is the snapshot without its ignored files, what the source compares before stashing. */
export type Snapshot = { sha: string; uncommitted: boolean; plainTree?: string };
// A throwaway commit; a fixed identity keeps it from failing where git has none configured.
const IDENTITY = {
  GIT_AUTHOR_NAME: "agentgate",
  GIT_AUTHOR_EMAIL: "agentgate@localhost",
  GIT_COMMITTER_NAME: "agentgate",
  GIT_COMMITTER_EMAIL: "agentgate@localhost",
};

/** A fetch or clone can stall on a dead remote or an SSH agent waiting for approval; past the deadline git and its
 * helpers are killed, and the step fails instead of holding the handoff and daemon shutdown. */
const GIT_TIMEOUT = 10 * 60_000;

export async function run(cwd: string, args: string[], env: Record<string, string> = {}, input?: string) {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    detached: true,
    // Never wait on a credential prompt nobody can answer.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
  });
  const timer = setTimeout(() => killGroup(child), GIT_TIMEOUT);
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { ok: code === 0, out: out.trim(), err: err.trim() };
  } finally {
    clearTimeout(timer);
  }
}
export async function git(cwd: string, args: string[], env?: Record<string, string>, input?: string): Promise<string> {
  const r = await run(cwd, args, env, input);
  if (!r.ok) throw new Error(`git ${args[0]} failed: ${r.err.split("\n").at(-1) || "unknown error"}`);
  return r.out;
}
const maybe = async (cwd: string, args: string[], env?: Record<string, string>) => {
  const r = await run(cwd, args, env);
  return r.ok ? r.out : undefined;
};
const hasCommit = async (cwd: string, sha: string) => (await run(cwd, ["cat-file", "-e", `${sha}^{commit}`])).ok;
const ref = (id: string) => `refs/agentgate/handoff/${id}`;

/** Where the source's code stands. `baseSha` is the newest commit of HEAD already on origin: the destination
 * builds its worktree from it before the bundle arrives, and it is the bundle's only prerequisite. */
export async function describe(cwd: string) {
  const headSha = await git(cwd, ["rev-parse", "HEAD"]);
  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const remoteUrl = await maybe(cwd, ["config", "--get", "remote.origin.url"]);
  if (!remoteUrl) throw new Error("the repository has no origin remote, so the other machine cannot find or clone it");
  const unpushed = (await git(cwd, ["rev-list", "--reverse", "HEAD", "--not", "--remotes=origin"]))
    .split("\n")
    .filter(Boolean);
  return {
    headSha,
    branch: branch === "HEAD" ? null : branch,
    remoteUrl,
    baseSha: unpushed.length ? ((await maybe(cwd, ["rev-parse", "--verify", `${unpushed[0]}^`])) ?? null) : headSha,
  };
}

// Ignored folders that setup or a build makes again, often large or built for one platform: they stay behind.
// ponytail: fixed list by folder name; make it configurable when a project needs one sent or another skipped.
const REBUILT = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "dist",
  "build",
  ".build",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".gradle",
  "Pods",
  "DerivedData",
]);
const LITERAL = { GIT_LITERAL_PATHSPECS: "1" };

/** The trees of everything in the checkout: uncommitted and untracked files as `git add --all` sees them (`plain`),
 * and with ignored files outside `REBUILT` folders and `skip` added (`full`). Built in a scratch index so the real one stays as it is. */
async function worktreeTrees(cwd: string, withIgnored = true, skip: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    // Starting from a copy of the real index skips rehashing every file.
    try {
      copyFileSync(resolve(cwd, await git(cwd, ["rev-parse", "--git-path", "index"])), env.GIT_INDEX_FILE);
    } catch {
      await git(cwd, ["read-tree", "HEAD"], env);
    }
    await git(cwd, ["add", "--all"], env);
    const plain = await git(cwd, ["write-tree"], env);
    if (!withIgnored) return { plain, full: plain };
    const ignored = (
      await git(cwd, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], env)
    )
      .split("\0")
      .filter((p) => p && !p.split("/").some((part) => REBUILT.has(part)));
    if (ignored.length) {
      writeFileSync(join(dir, "ignored"), ignored.join("\0"));
      // Best effort: an ignored file git cannot add (a socket, unreadable) stays behind rather than failing the handoff.
      await run(
        cwd,
        ["add", "--force", "--ignore-errors", `--pathspec-from-file=${join(dir, "ignored")}`, "--pathspec-file-nul"],
        { ...env, ...LITERAL },
      );
    }
    if (skip.length)
      await git(cwd, ["rm", "--cached", "--quiet", "--ignore-unmatch", "--", ...skip], { ...env, ...LITERAL });
    return { plain, full: await git(cwd, ["write-tree"], env) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `skip` names ignored files that travel another way, such as the file store's env files. */
export async function snapshot(cwd: string, id: string, headSha: string, skip: string[] = []): Promise<Snapshot> {
  const { plain, full } = await worktreeTrees(cwd, true, skip);
  if (full === (await git(cwd, ["rev-parse", `${headSha}^{tree}`]))) return { sha: headSha, uncommitted: false };
  const sha = await git(cwd, ["commit-tree", full, "-p", headSha, "-m", `agentgate handoff ${id}`], IDENTITY);
  return { sha, uncommitted: true, plainTree: plain };
}

/** Write the commits origin lacks to `out`. False when origin already has everything. */
export async function createBundle(cwd: string, id: string, sha: string, out: string): Promise<boolean> {
  if ((await git(cwd, ["rev-list", "--count", sha, "--not", "--remotes=origin"])) === "0") return false;
  await git(cwd, ["update-ref", ref(id), sha]);
  try {
    await git(cwd, ["bundle", "create", out, ref(id), "--not", "--remotes=origin"]);
  } finally {
    await run(cwd, ["update-ref", "-d", ref(id)]);
  }
  return true;
}

/** Fetch a received bundle. False when its prerequisites are missing even after fetching origin. */
export async function fetchBundle(cwd: string, bundle: string, id: string): Promise<boolean> {
  if (!(await run(cwd, ["bundle", "verify", bundle])).ok) {
    await run(cwd, ["fetch", "origin"]);
    if (!(await run(cwd, ["bundle", "verify", bundle])).ok) return false;
  }
  await git(cwd, ["fetch", bundle, `${ref(id)}:${ref(id)}`]);
  return true;
}
/** The fetched ref keeps the snapshot commit alive until the code is applied. */
export const dropRef = (cwd: string, id: string) => run(cwd, ["update-ref", "-d", ref(id)]);

/** Make `sha` present, fetching origin only when it is missing: the common round trip needs no network. */
export async function ensureCommit(cwd: string, sha: string): Promise<boolean> {
  if (await hasCommit(cwd, sha)) return true;
  await run(cwd, ["fetch", "origin"]);
  return hasCommit(cwd, sha);
}

/** Files here that restoring `sha` would overwrite with content git has no copy of, such as this machine's own `.env`.
 * A copy this machine sent away earlier is already in its objects, so the stale copy a thread comes back to is not listed. */
async function unsaved(cwd: string, sha: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    await git(cwd, ["read-tree", sha], env);
    const changed = (await git(cwd, ["diff", "--name-only", "-z"], env))
      .split("\0")
      .filter((p) => p && !p.includes("\n") && lstatSync(join(cwd, p), { throwIfNoEntry: false })?.isFile());
    if (!changed.length) return [];
    const blobs = await git(cwd, ["hash-object", "--stdin-paths"], undefined, `${changed.join("\n")}\n`);
    const known = (await git(cwd, ["cat-file", "--batch-check"], undefined, `${blobs}\n`)).split("\n");
    return changed.filter((_, i) => known[i]?.endsWith(" missing"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Move the destination's checkout onto the source's code, only when that loses nothing: clean, on the same branch,
 * at or behind `headSha`. Restores a snapshot's uncommitted and ignored files (deletions included) as uncommitted
 * changes. `kept` says why it kept the checkout as it was; `replaced` lists files of this machine's own it parked in a
 * stash because the snapshot brought other versions of them. */
export async function moveToSource(
  cwd: string,
  branch: string | null,
  headSha: string,
  snap: Snapshot | undefined,
): Promise<{ kept?: string; replaced: string[] }> {
  const keep = (kept: string) => ({ kept, replaced: [] });
  if ((await git(cwd, ["status", "--porcelain"])) !== "") return keep("it has uncommitted changes");
  const current = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current !== (branch ?? "HEAD"))
    return keep(`it is on ${current === "HEAD" ? "a detached HEAD" : current}, not ${branch ?? "a detached HEAD"}`);
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  if (head !== headSha) {
    if (!(await run(cwd, ["merge-base", "--is-ancestor", head, headSha])).ok)
      return keep("it has commits the source does not");
    await git(cwd, branch ? ["merge", "--ff-only", headSha] : ["checkout", "--detach", headSha]);
  }
  if (!snap?.uncommitted) return { replaced: [] };
  const replaced = await unsaved(cwd, snap.sha);
  if (replaced.length) {
    await git(
      cwd,
      [
        "stash",
        "push",
        "--all",
        "--message",
        `agentgate: replaced by handoff ${snap.sha.slice(0, 12)}`,
        "--",
        ...replaced,
      ],
      { ...IDENTITY, ...LITERAL },
    );
  }
  await git(cwd, ["restore", `--source=${snap.sha}`, "--worktree", "--", "."]);
  return { replaced };
}

/** Park the uncommitted files the destination now holds, so this worktree is clean for the return trip.
 * Only when it still is exactly what was sent, so nothing that exists only here moves. */
export async function stashIfUnchanged(cwd: string, snap: Snapshot, message: string): Promise<boolean> {
  if (!snap.uncommitted) return false;
  if ((await maybe(cwd, ["rev-parse", "HEAD"])) !== (await maybe(cwd, ["rev-parse", `${snap.sha}^`]))) return false;
  // Ignored files are not stashed, so only the rest must be unchanged: a log written since does not matter.
  if (
    (await worktreeTrees(cwd, false)).plain !==
    (snap.plainTree ?? (await git(cwd, ["rev-parse", `${snap.sha}^{tree}`])))
  )
    return false;
  return (await run(cwd, ["stash", "push", "--include-untracked", "--message", message], IDENTITY)).ok;
}

/** Drop the stash a handoff left, once the code came back and supersedes it. Stashes are shared by every worktree of
 * a repository, so it is found by its unique message. */
export async function dropStash(cwd: string, message: string) {
  const list = (await maybe(cwd, ["stash", "list", "--format=%gd%x00%gs"])) ?? "";
  for (const line of list.split("\n")) {
    const [name, subject] = line.split("\0");
    if (!name || !subject?.endsWith(message)) continue;
    await run(cwd, ["stash", "drop", name]);
    return;
  }
}

/** `git worktree list --porcelain` as path and branch pairs; the main checkout comes first. A bare repository and
 * worktrees whose folder is gone (prunable) are left out. */
export async function worktrees(cwd: string): Promise<{ path: string; branch: string | null }[]> {
  return (await git(cwd, ["worktree", "list", "--porcelain"])).split("\n\n").flatMap((block) => {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? "";
    const head = lines.find((l) => l.startsWith("branch "))?.slice(7);
    if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable")) || !existsSync(path)) return [];
    return [{ path, branch: head?.replace(/^refs\/heads\//, "") ?? null }];
  });
}

export async function addWorktree(main: string, path: string, branch: string | null, start: string) {
  if (!branch) return git(main, ["worktree", "add", "--detach", path, start]);
  const exists = (await run(main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
  return git(main, ["worktree", "add", path, ...(exists ? [branch] : ["-b", branch, start])]);
}

const MANIFESTS = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "uv.lock",
  "poetry.lock",
  "go.sum",
  "Gemfile.lock",
]);
/** Whether dependency manifests or lockfiles differ between two commits, so setup should run again. */
export async function manifestsChanged(cwd: string, from: string, to: string): Promise<boolean> {
  if (from === to) return false;
  const names = (await maybe(cwd, ["diff", "--name-only", from, to])) ?? "";
  return names.split("\n").some((f) => MANIFESTS.has(basename(f)) || /^requirements.*\.txt$/.test(basename(f)));
}
