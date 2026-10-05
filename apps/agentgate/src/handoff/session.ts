import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { atomicWrite } from "../files.ts";

/** Native session files of a provider: where they live, and how to place them under another checkout.
 * Only Claude Code today; Codex keeps rollouts under `sessions/YYYY/MM/DD/` with `cwd` in `session_meta`
 * and would be one more implementation of this shape. */
interface SessionProvider {
  /** Files relative to `root`, the session file first; undefined when the session is not in this home. */
  locate(home: string, sessionId: string, cwd: string): { root: string; files: string[] } | undefined;
  /** Copy received files (relative to `from`) so the session resumes in `cwd`, rewriting recorded paths in `oldPaths`. */
  place(home: string, sessionId: string, from: string, files: string[], cwd: string, oldPaths: string[]): void;
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
  return (readdirSync(dir, { recursive: true }) as string[]).sort()
    .filter((f) => lstatSync(join(dir, f)).isFile()).map((f) => f.split(sep).join("/"));
}

/** Replace `"cwd": "<old>"` values without re-serializing: other fields keep their exact bytes, and tool inputs
 * that mention a path are left alone. Escaped occurrences inside other strings do not match. */
export function rewriteCwd(text: string, oldPaths: string[], to: string): string {
  let out = text;
  for (const from of new Set(oldPaths)) {
    if (from === to) continue;
    const literal = JSON.stringify(from).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<!\\\\)"cwd"(\\s*):(\\s*)${literal}`, "g"), (_m, a: string, b: string) => `"cwd"${a}:${b}${JSON.stringify(to)}`);
  }
  return out;
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
    const keys = [claudeProjectKey(realPath(cwd)), claudeProjectKey(cwd), ...(existsSync(projects) ? readdirSync(projects) : [])];
    for (const key of keys) {
      const root = join(projects, key);
      if (!existsSync(join(root, `${sessionId}.jsonl`))) continue;
      return { root, files: [`${sessionId}.jsonl`, ...filesUnder(join(root, sessionId)).map((f) => `${sessionId}/${f}`)] };
    }
    return undefined;
  },
  place(home, sessionId, from, files, cwd, oldPaths) {
    const root = join(home, "projects", claudeProjectKey(realPath(cwd)));
    mkdirSync(home, { recursive: true, mode: 0o700 });
    safeDir(home, root);
    for (const file of files) {
      if (!this.accepts(sessionId, file)) throw new Error(`unexpected session file ${file}`);
      const target = join(root, file);
      safeDir(home, dirname(target));
      // atomicWrite renames over the target, which replaces a symlink rather than following it.
      atomicWrite(target, rewriteCwd(readFileSync(join(from, file), "utf8"), oldPaths, cwd));
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
    return SAFE_ID.test(sessionId) && safeRelative(file) && (file === `${sessionId}.jsonl` || file.startsWith(`${sessionId}/`));
  },
};

export const sessionProviders: Record<string, SessionProvider> = { claudeAgent: claudeSessions };

/** A relative path with plain segments: no absolute paths, `..`, empty segments or backslashes. */
export function safeRelative(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0")
    && path.split("/").every((part) => part && part !== "." && part !== "..");
}
