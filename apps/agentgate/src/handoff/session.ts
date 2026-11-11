import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, rmdirSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { escapeRegExp } from "hanzio";
import { dirname, join, relative, sep } from "node:path";

/** Native session files of a provider: where they live, and how to place them under another checkout.
 * Only Claude Code today; Codex keeps rollouts under `sessions/YYYY/MM/DD/` with `cwd` in `session_meta`
 * and would be one more implementation of this shape. */
interface SessionProvider {
  /** Files relative to `root`, the session file first; undefined when the session is not in this home. */
  locate(home: string, sessionId: string, cwd: string): { root: string; files: string[] } | undefined;
  /** Copy received files (relative to `from`) so the session resumes in `cwd`, rewriting recorded paths in `oldPaths`. */
  place(home: string, sessionId: string, from: string, files: string[], cwd: string, oldPaths: string[]): Promise<void>;
  /** Delete the session's files under `cwd`'s key: a copy placed only so T3 could import it. */
  remove(home: string, sessionId: string, cwd: string): void;
  /** Whether a received relative path belongs to the session. */
  accepts(sessionId: string, file: string): boolean;
}

// Session ids become file names; anything else could escape the projects directory.
export const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const KEY_MAX = 200;

/** The directory name Claude Code keeps a cwd's sessions under (`<home>/projects/<key>`). Mirrors the SDK:
 * non-alphanumerics become `-`, and long paths are cut and suffixed with a hash so they stay unique. */
export function claudeProjectKey(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= KEY_MAX) return sanitized;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
  return `${sanitized.slice(0, KEY_MAX)}-${Math.abs(hash).toString(36)}`;
}

// The CLI resolves its cwd before deriving the key (macOS reports /tmp as /private/tmp).
export function realPath(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path; // a checkout that is gone was recorded under the path itself
  }
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .sort()
    .filter((f) => lstatSync(join(dir, f)).isFile())
    .map((f) => f.split(sep).join("/"));
}

/** Replace `"cwd": "<old>"` values without re-serializing: other fields keep their exact bytes, and tool inputs
 * that mention a path are left alone. Escaped occurrences inside other strings do not match. */
export function rewriteCwd(text: string, oldPaths: string[], to: string): string {
  let out = text;
  for (const from of new Set(oldPaths)) {
    if (from === to) continue;
    const literal = escapeRegExp(JSON.stringify(from));
    out = out.replace(
      new RegExp(`(?<!\\\\)"cwd"(\\s*):(\\s*)${literal}`, "g"),
      (_m, a: string, b: string) => `"cwd"${a}:${b}${JSON.stringify(to)}`,
    );
  }
  return out;
}

/** A file's text as it streams in, cut at line breaks: the pieces of all yields together are `text.split("\n")`. A
 * transcript can be hundreds of megabytes, which read or split whole would stall every other stream. */
export async function* splitLines(file: Blob): AsyncGenerator<string[]> {
  const decoder = new TextDecoder();
  // A line longer than a read: kept in parts, so joining it is linear.
  let partial: string[] = [];
  for await (const bytes of file.stream()) {
    const text = decoder.decode(bytes, { stream: true });
    const end = text.lastIndexOf("\n");
    if (end < 0) {
      partial.push(text);
      continue;
    }
    const lines = text.slice(0, end).split("\n");
    lines[0] = partial.join("") + lines[0];
    partial = [text.slice(end + 1)];
    yield lines;
  }
  yield [partial.join("") + decoder.decode()];
}

/** Copy `from` to `target` with its recorded cwd rewritten (`rewriteCwd`, line by line, which a match never spans),
 * then rename it into place: the rename replaces a symlink at `target` rather than following it. */
async function placeFile(from: string, target: string, oldPaths: string[], cwd: string) {
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  const out = await open(temp, "wx", 0o600);
  try {
    let first = true;
    for await (const lines of splitLines(Bun.file(from))) {
      await out.write((first ? "" : "\n") + rewriteCwd(lines.join("\n"), oldPaths, cwd));
      first = false;
    }
    await out.sync();
    await rename(temp, target);
  } finally {
    await out.close();
    await rm(temp, { force: true });
  }
}

/** Create `dir` under `root` without passing through a symlink, so placed files stay inside the Claude home. */
function safeDir(root: string, dir: string) {
  const rel = relative(root, dir);
  if (rel.startsWith("..") || rel.startsWith(sep)) throw new Error("session path escapes the Claude home");
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    let isDir: boolean;
    try {
      isDir = lstatSync(current).isDirectory();
    } catch {
      mkdirSync(current, { mode: 0o700 }); // missing: create it here, never through a link
      continue;
    }
    if (!isDir) throw new Error(`${current} is not a directory`);
  }
}

export const claudeSessions: SessionProvider = {
  locate(home, sessionId, cwd) {
    if (!SAFE_ID.test(sessionId)) return undefined;
    const projects = join(home, "projects");
    // The session may have started in another directory of this home.
    const keys = [
      claudeProjectKey(realPath(cwd)),
      claudeProjectKey(cwd),
      ...(existsSync(projects) ? readdirSync(projects) : []),
    ];
    for (const key of keys) {
      const root = join(projects, key);
      if (!existsSync(join(root, `${sessionId}.jsonl`))) continue;
      return {
        root,
        files: [`${sessionId}.jsonl`, ...filesUnder(join(root, sessionId)).map((f) => `${sessionId}/${f}`)],
      };
    }
    return undefined;
  },
  async place(home, sessionId, from, files, cwd, oldPaths) {
    const root = join(home, "projects", claudeProjectKey(realPath(cwd)));
    mkdirSync(home, { recursive: true, mode: 0o700 });
    safeDir(home, root);
    for (const file of files) {
      if (!this.accepts(sessionId, file)) throw new Error(`unexpected session file ${file}`);
      const target = join(root, file);
      safeDir(home, dirname(target));
      await placeFile(join(from, file), target, oldPaths, cwd);
    }
  },
  remove(home, sessionId, cwd) {
    if (!SAFE_ID.test(sessionId)) return;
    const root = join(home, "projects", claudeProjectKey(realPath(cwd)));
    rmSync(join(root, `${sessionId}.jsonl`), { force: true });
    rmSync(join(root, sessionId), { recursive: true, force: true });
    try {
      rmdirSync(root);
    } catch {
      // Other sessions still live under this key, or it is already gone.
    }
  },
  accepts(sessionId, file) {
    return (
      SAFE_ID.test(sessionId) &&
      safeRelative(file) &&
      (file === `${sessionId}.jsonl` || file.startsWith(`${sessionId}/`))
    );
  },
};

export const sessionProviders: Record<string, SessionProvider> = { claudeAgent: claudeSessions };

/** A relative path with plain segments: no absolute paths, `..`, empty segments or backslashes. */
export function safeRelative(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
