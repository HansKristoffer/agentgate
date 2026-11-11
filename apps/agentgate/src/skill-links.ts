import type { SkillHealth } from "@agentgate/protocol";
import { getErrorMessage } from "hanzio";
import { SKILL_MARKER as MARKER, isVirtual, projectIdSchema, statusSchema } from "@agentgate/protocol";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { canonicalProject, parseRemote } from "./mcp/gateway.ts";
import { CLAUDE_DIR, CODEX_DIR, PRIMARY_CLAUDE_DIR, PRIMARY_CODEX_DIR, primaryState } from "./setup.ts";
import { CONFIG_DIR, liveOnly, SKILL_ID, timerSync, type Store } from "./store.ts";
import { z } from "zod";
import { defineLocal } from "./local-state.ts";

export const SKILLS_DIR = join(CONFIG_DIR, "skills");
const EXCLUDE_HEADER = "# agentgate skills (symlinks into ~/.config/agentgate/skills)";
const IGNORE_MARK = "# agentgate: links into this machine's ~/.config/agentgate/skills; never commit them";

/** Worktree folders of a repo, from `<common>/worktrees/<name>/gitdir`. */
function worktrees(common: string): string[] {
  const dir = join(common, "worktrees");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      const wt = dirname(readFileSync(join(dir, name, "gitdir"), "utf8").trim());
      return existsSync(wt) ? [wt] : [];
    } catch {
      return [];
    }
  });
}

/** `.claude/skills/x → ../../.agents/skills/x` or the reverse: a mirror, whether we or the skills CLI made it. */
function isMirror(path: string) {
  try {
    return (
      lstatSync(path).isSymbolicLink() && /^\.\.\/\.\.\/\.(claude|agents)\/skills\/[^/]+$/.test(readlinkSync(path))
    );
  } catch {
    return false;
  }
}

/** Keep agentgate's links out of `git status` in every worktree: our block in info/exclude lists exactly `ids`. */
function exclude(common: string, ids: string[]) {
  const file = join(common, "info", "exclude");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = text.split("\n"),
    start = lines.indexOf(EXCLUDE_HEADER);
  let end = start + 1;
  if (start >= 0) while (end < lines.length && /^\/\.(claude|agents)\/skills\//.test(lines[end]!)) end++;
  const body = (start >= 0 ? [...lines.slice(0, start), ...lines.slice(end)] : lines).join("\n").replace(/\n+$/, "");
  const block = ids.length
    ? `${EXCLUDE_HEADER}\n${[...ids]
        .sort()
        .flatMap((id) => [`/.claude/skills/${id}`, `/.agents/skills/${id}`])
        .join("\n")}\n`
    : "";
  const next = body ? `${body}\n${block}` : block;
  if (next === text || (!text && !block)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
}

/** info/exclude loses to a repo `.gitignore` that re-includes skill folders (`!.claude/skills/**`). A `.gitignore`
 * in the folder itself wins, and ignores itself. A `.gitignore` the repo owns there is left alone. */
function ignoreLinks(dir: string, names: string[]) {
  const file = join(dir, ".gitignore");
  const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  if (current !== undefined && !current.startsWith(IGNORE_MARK)) return;
  if (!names.length) {
    if (current !== undefined) unlinkSync(file);
    return;
  }
  const text = `${IGNORE_MARK}\n/.gitignore\n${[...names]
    .sort()
    .map((n) => `/${n}`)
    .join("\n")}\n`;
  if (text !== current) writeFileSync(file, text);
}

/** Where `*` skills go: the coding-tool folders `setup` writes, plus your own ~/.claude and ~/.codex while `setup --primary` is on. */
export function globalSkillDirs(): [dir: string, on: boolean][] {
  const primary = primaryState();
  return [
    [join(CLAUDE_DIR, "skills"), true],
    [join(CODEX_DIR, "skills"), true],
    [join(PRIMARY_CLAUDE_DIR, "skills"), primary.claude],
    [join(PRIMARY_CODEX_DIR, "skills"), primary.codex],
  ];
}

// What `/status` shows about skills on this node.
const healthLocal = defineLocal("skillHealth", statusSchema.shape.skillHealth, { topic: "status" });
const mirrorLocal = defineLocal("skillMirror:", z.string(), { topic: "status" });
const checkoutsLocal = defineLocal("checkouts", z.record(z.string(), z.string()), { topic: "status" });
/** Main checkout path → project, for every checkout this node registered (`SkillLinks.register`). */
export const registeredCheckouts = (s: Store) => checkoutsLocal.get(s) ?? {};
const conflictsLocal = defineLocal("skillConflicts", z.array(z.string()), { topic: "status" });
const keptLocal = defineLocal("skillKept", z.array(z.string()), { topic: "status" });
// Per worktree: the mirror links `mirror` made there, link path → target.
const mirrorsLocal = defineLocal("skillMirrors:", z.record(z.string(), z.string()));

/** Writes skill records to disk and keeps the symlinks that expose them to Claude Code and Codex in step.
 * Agents read skills when a session starts, so project links must exist before then: each known repo's
 * worktree list is watched, so a new worktree gets its links while git is still checking it out. */
export class SkillLinks {
  private watchers = new Map<string, { watcher: FSWatcher; inode: number }>();
  private manifests = new Map<
    string,
    { rev: string; files: { path: string; size: number; executable: boolean; digest: string; mtime?: number }[] }
  >();
  private errors: SkillHealth["errors"] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private closed = false;

  /** `root` null turns disk work off (in-memory stores, tests): skills never touch the real agent folders. */
  constructor(
    private s: Store,
    private root: string | null = SKILLS_DIR,
    private globalDirs = globalSkillDirs,
    private io: { rename?: typeof renameSync; watch?: typeof watch } = {},
  ) {}

  health(): SkillHealth {
    return healthLocal.get(this.s) ?? { errors: [] };
  }

  mirroring(main: string): boolean {
    return mirrorLocal.get(this.s, main) === "true";
  }

  setMirroring(main: string, on: boolean) {
    main = realpathSync(main);
    if (!this.checkouts()[main]) throw new Error("Register this checkout before changing repository mirroring");
    mirrorLocal.set(this.s, main, String(on));
    this.sync();
  }

  checkouts(): Record<string, string> {
    return registeredCheckouts(this.s);
  }

  /** Skills the repository itself carries in a checkout: SKILL.md folders we did not link. */
  repoSkills(main: string): string[] {
    const found = new Set<string>();
    for (const dir of [join(main, ".claude", "skills"), join(main, ".agents", "skills")]) {
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {}
      for (const name of names)
        if (!(this.root && this.ours(this.root, join(dir, name))) && existsSync(join(dir, name, "SKILL.md")))
          found.add(name);
    }
    return [...found].sort();
  }

  conflicts(): string[] {
    return conflictsLocal.get(this.s) ?? [];
  }

  /** Clashes the user settled by keeping what was there: no link of ours there on this machine, and no report. */
  kept(): string[] {
    return keptLocal.get(this.s) ?? [];
  }

  /**
   * Settle a clash at `path`. "agentgate" moves what is there into skill-backups next to the store and links our copy;
   * "keep" leaves it and stops linking ours there. Only reported or kept clashes are touched, never a folder the
   * repository tracks. Returns where the old entry went.
   */
  resolveConflict(path: string, use: "agentgate" | "keep"): string | undefined {
    const kept = this.kept();
    if (!this.root || (!this.conflicts().includes(path) && !kept.includes(path)))
      throw new Error(`${path} is not a skill that clashes with Agentgate's`);
    if (use === "keep") {
      keptLocal.set(this.s, undefined, [...new Set([...kept, path])]);
      this.sync();
      return;
    }
    if (this.root === SKILLS_DIR && !path.startsWith(CONFIG_DIR + sep)) liveOnly("Replacing a skill folder");
    const tracked = Bun.spawnSync(["git", "ls-files", "--error-unmatch", "--", basename(path)], {
      cwd: dirname(path),
      stdout: "ignore",
      stderr: "ignore",
      timeout: 10_000,
    });
    if (tracked.exitCode === 0)
      throw new Error(`${path} is part of its repository. Rename or remove it there, or keep it.`);
    const backups = join(dirname(this.root), "skill-backups");
    mkdirSync(backups, { recursive: true });
    const backup = join(mkdtempSync(join(backups, `${basename(path)}-`)), basename(path));
    try {
      (this.io.rename ?? renameSync)(path, backup);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      cpSync(path, backup, { recursive: true, verbatimSymlinks: true });
      rmSync(path, { recursive: true, force: true });
    }
    keptLocal.set(
      this.s,
      undefined,
      kept.filter((p) => p !== path),
    );
    this.sync();
    return backup;
  }

  /** Remember the main checkout of the repo containing `path`. Returns it, or undefined for non-repos. */
  register(path: string, project?: string, sync = true): string | undefined {
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(["git", ...args], { cwd: path, stderr: "ignore", timeout: 5000 });
      return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
    };
    if (!existsSync(path)) return;
    path = realpathSync(path);
    const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
    if (!common || basename(common) !== ".git") return; // a bare repo has no main checkout
    project ??= parseRemote(git("remote", "get-url", "origin") ?? "");
    if (!project || project === "*" || isVirtual(project)) return;
    project = canonicalProject(this.s, projectIdSchema.parse(project));
    const main = realpathSync(dirname(common)),
      all = this.checkouts();
    if (all[main] !== project) {
      all[main] = project;
      checkoutsLocal.set(this.s, undefined, all);
    }
    if (sync) this.sync();
    return main;
  }

  /** Events prompt bounded retries; the independent periodic pass provides eventual repair. */
  soon() {
    if (this.closed || !this.root) return;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [50, 600, 2000, 5000, 10000].map((ms) => {
      const t = setTimeout(
        timerSync(this.s, "skills", () => this.sync()),
        ms,
      );
      t.unref?.();
      return t;
    });
  }

  sync() {
    if (this.closed || !this.root) return;
    this.errors = [];
    const attemptedAt = this.s.now(),
      previous = this.health();
    this.attempt(this.root, () => {
      this.write(this.root!);
      this.link(this.root!);
    });
    // Written only when the errors change, not on every pass: attemptedAt is when the current errors were first seen,
    // succeededAt when the last clean run of passes began.
    if (previous.attemptedAt !== undefined && JSON.stringify(previous.errors) === JSON.stringify(this.errors)) return;
    healthLocal.set(this.s, undefined, {
      attemptedAt,
      succeededAt: this.errors.length ? previous.succeededAt : attemptedAt,
      errors: this.errors,
    });
  }

  private attempt(path: string, action: () => void) {
    try {
      action();
    } catch (error) {
      const message = getErrorMessage(error);
      this.errors.push({ path, message });
      console.error(`skills: ${path}: ${message}`);
    }
  }

  close() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    for (const { watcher } of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.manifests.clear();
  }

  private records() {
    return this.s.db
      .query("select id, rev, node, updated_at from records where kind = 'skill' and deleted = 0")
      .all() as { id: string; rev: number; node: string; updated_at: number }[];
  }

  /** Store → `<root>/<id>/`, swapped in whole, skipped when the folder's marker matches the record revision. */
  private write(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const rows = this.records(),
      keep = new Set(rows.map((r) => r.id));
    const rename = this.io.rename ?? renameSync;
    // Recover a previous copy before attempting publication or cleaning recognized leftovers.
    for (const name of readdirSync(root)) {
      if (keep.has(name)) continue;
      const artifact = name.match(/^(.+)\.[0-9a-f-]{36}\.(old|tmp)$/);
      if (!artifact || !SKILL_ID.test(artifact[1]!)) continue;
      this.attempt(join(root, name), () => {
        const path = join(root, name),
          dir = join(root, artifact[1]!);
        if (
          artifact[2] === "old" &&
          keep.has(artifact[1]!) &&
          !lstatSync(dir, { throwIfNoEntry: false }) &&
          existsSync(join(path, MARKER))
        )
          rename(path, dir);
        else rmSync(path, { recursive: true, force: true });
      });
    }
    for (const row of rows) {
      const dir = join(root, row.id),
        rev = `${row.rev}:${row.node}:${row.updated_at}`;
      this.attempt(dir, () => {
        let manifest = this.manifests.get(row.id);
        if (manifest?.rev !== rev) {
          const skill = this.s.get("skill", row.id);
          if (!skill) return;
          manifest = {
            rev,
            files: skill.files.map((f) => {
              const bytes = Buffer.from(f.data, "base64");
              return {
                path: f.path,
                size: bytes.length,
                executable: !!f.executable,
                digest: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
              };
            }),
          };
          this.manifests.set(row.id, manifest);
        }
        try {
          if (
            readFileSync(join(dir, MARKER), "utf8") === rev &&
            manifest.files.every((f) => {
              const path = join(dir, f.path),
                st = lstatSync(path, { throwIfNoEntry: false });
              if (!st?.isFile() || st.size !== f.size || !!(st.mode & 0o111) !== f.executable) return false;
              if (
                f.mtime !== st.mtimeMs &&
                new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex") !== f.digest
              )
                return false;
              f.mtime = st.mtimeMs;
              return true;
            })
          )
            return;
        } catch {}
        const skill = this.s.get("skill", row.id);
        if (!skill) return;
        const temp = `${dir}.${crypto.randomUUID()}.tmp`,
          old = `${dir}.${crypto.randomUUID()}.old`;
        let moved = false,
          published = false;
        try {
          for (const f of skill.files) {
            const target = resolve(temp, f.path);
            if (!target.startsWith(temp + sep)) throw new Error(`${row.id}: unsafe path ${f.path}`);
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, Buffer.from(f.data, "base64"), { mode: f.executable ? 0o755 : 0o644 });
          }
          writeFileSync(join(temp, MARKER), rev);
          if (lstatSync(dir, { throwIfNoEntry: false })) {
            rename(dir, old);
            moved = true;
          }
          rename(temp, dir);
          published = true;
        } catch (error) {
          if (moved && !lstatSync(dir, { throwIfNoEntry: false })) rename(old, dir);
          throw error;
        } finally {
          rmSync(temp, { recursive: true, force: true });
          if (published) rmSync(old, { recursive: true, force: true });
        }
      });
    }
    for (const name of readdirSync(root))
      if (
        !keep.has(name) &&
        !/^.+\.[0-9a-f-]{36}\.(old|tmp)$/.test(name) &&
        SKILL_ID.test(name) &&
        existsSync(join(root, name, MARKER))
      )
        this.attempt(join(root, name), () => rmSync(join(root, name), { recursive: true, force: true }));
    for (const id of this.manifests.keys()) if (!keep.has(id)) this.manifests.delete(id);
  }

  private link(root: string) {
    const all = new Set(
        this.records()
          .filter((r) => existsSync(join(root, r.id, "SKILL.md")) && existsSync(join(root, r.id, MARKER)))
          .map((r) => r.id),
      ),
      conflicts: string[] = [],
      kept = { asked: new Set(this.kept()), still: [] as string[] };
    const global = (this.s.get("project", "*")?.skills ?? []).filter((id) => all.has(id));
    for (const [dir, on] of this.globalDirs())
      this.attempt(dir, () => {
        this.linkDir(root, dir, on ? global : [], conflicts, kept);
      });
    const checkouts = this.checkouts(),
      live: Record<string, string> = {},
      watched = new Set<string>();
    const catalog = this.s.list("project");
    const projects = new Map(catalog.map((p) => [p.id.toLowerCase(), p]));
    const seen = new Set<string>();
    for (const p of catalog) {
      const id = p.id.toLowerCase();
      if (seen.has(id))
        this.errors.push({
          path: p.id,
          message: "Case-variant project IDs already exist. Consolidate their assignments before removing one.",
        });
      seen.add(id);
    }
    for (const [main, project] of Object.entries(checkouts)) {
      this.attempt(main, () => {
        const common = join(main, ".git");
        if (!statSync(common, { throwIfNoEntry: false })?.isDirectory()) return; // deleted or moved: forget it
        live[main] = project;
        const wanted = (projects.get(project.toLowerCase())?.skills ?? []).filter(
          (id) => all.has(id) && !global.includes(id),
        );
        // Mirror first: the repo's own skills win over agentgate's, and a mirror may create a worktree's .claude/skills.
        const trees = [main, ...worktrees(common)];
        const mirrored: string[] = [];
        if (this.mirroring(main))
          for (const tree of trees)
            this.attempt(tree, () => {
              mirrored.push(...this.mirror(root, tree));
            });
        // Claude Code falls back from a worktree without .claude/skills to the main checkout's; Codex reads only the worktree's own.
        const dirs = trees.flatMap((tree, i) => [
          ...(i === 0 || existsSync(join(tree, ".claude", "skills")) ? [join(tree, ".claude", "skills")] : []),
          join(tree, ".agents", "skills"),
        ]);
        for (const dir of dirs)
          this.attempt(dir, () => ignoreLinks(dir, this.linkDir(root, dir, wanted, conflicts, kept)));
        // Mirrors stay visible: they are relative, so committing them gives every clone both agents' skills.
        exclude(common, wanted);
        if (wanted.length || mirrored.length || this.mirroring(main))
          for (const path of this.watch(common)) watched.add(path);
      });
    }
    for (const [path, { watcher }] of this.watchers)
      if (!watched.has(path)) {
        watcher.close();
        this.watchers.delete(path);
      }
    if (Object.keys(live).length !== Object.keys(checkouts).length) checkoutsLocal.set(this.s, undefined, live);
    conflictsLocal.set(this.s, undefined, conflicts.length ? conflicts : undefined);
    // A kept entry that is gone, or no longer clashes, is forgotten, so ours is linked there again once the place is free.
    keptLocal.set(this.s, undefined, kept.still.length ? kept.still : undefined);
  }

  /** A skill the repo carries for one agent only, linked for the other with a relative link, so it holds in every worktree.
   * Returns the names it links. An owned, untracked mirror is removed once its source is gone. */
  private mirror(root: string, tree: string): string[] {
    const names: string[] = [];
    const owned = mirrorsLocal.get(this.s, tree) ?? {};
    const pairs = [
      [".claude", ".agents"],
      [".agents", ".claude"],
    ] as const;
    for (const [from, to] of pairs) {
      const src = join(tree, from, "skills"),
        dest = join(tree, to, "skills"),
        rel = `../../${from}/skills`;
      let sources: string[] = [];
      try {
        sources = readdirSync(src);
      } catch {}
      for (const name of sources) {
        const path = join(src, name);
        if (name.startsWith(".") || this.ours(root, path) || isMirror(path) || !existsSync(join(path, "SKILL.md")))
          continue;
        if (!lstatSync(join(dest, name), { throwIfNoEntry: false })) {
          mkdirSync(dest, { recursive: true });
          symlinkSync(`${rel}/${name}`, join(dest, name));
          owned[join(dest, name)] = `${rel}/${name}`;
        }
        if (isMirror(join(dest, name))) names.push(name);
      }
      let existing: string[] = [];
      try {
        existing = readdirSync(dest);
      } catch {}
      for (const name of existing) {
        const path = join(dest, name);
        if (
          owned[path] === `${rel}/${name}` &&
          isMirror(path) &&
          readlinkSync(path) === owned[path] &&
          !existsSync(path)
        ) {
          const tracked = Bun.spawnSync(["git", "ls-files", "--error-unmatch", "--", path], {
            cwd: tree,
            stderr: "ignore",
            timeout: 5000,
          }).exitCode;
          // Timed out: the repository may track the link, so the next pass asks again.
          if (tracked === null) continue;
          if (tracked !== 0) unlinkSync(path);
          delete owned[path];
        }
      }
    }
    mirrorsLocal.set(this.s, tree, Object.keys(owned).length ? owned : undefined);
    return names;
  }

  private ours(root: string, path: string) {
    try {
      return lstatSync(path).isSymbolicLink() && readlinkSync(path).startsWith(root + sep);
    } catch {
      return false;
    }
  }

  /** Make our links in `dir` exactly `wanted`. Entries we did not create are never touched; a clash is reported unless
   * the user kept it. Returns the names now linked. */
  private linkDir(
    root: string,
    dir: string,
    wanted: string[],
    conflicts: string[],
    kept: { asked: Set<string>; still: string[] },
  ): string[] {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      if (!wanted.length) return [];
    }
    for (const name of entries)
      if (!wanted.includes(name) && this.ours(root, join(dir, name))) unlinkSync(join(dir, name));
    for (const id of wanted) {
      const path = join(dir, id),
        target = join(root, id);
      if (lstatSync(path, { throwIfNoEntry: false })) {
        if (!this.ours(root, path)) {
          if (kept.asked.has(path)) kept.still.push(path);
          else conflicts.push(path);
          continue;
        }
        if (readlinkSync(path) === target) continue;
        unlinkSync(path);
      }
      mkdirSync(dir, { recursive: true });
      symlinkSync(target, path);
    }
    return wanted.filter((id) => this.ours(root, join(dir, id)));
  }

  /** The git dir itself (to see `worktrees/` appear) and its worktree list. */
  private watch(common: string): string[] {
    const paths = [common, join(common, "worktrees")].filter((p) => existsSync(p));
    for (const path of paths)
      this.attempt(path, () => {
        const inode = statSync(path).ino,
          current = this.watchers.get(path);
        if (current?.inode === inode) return;
        current?.watcher.close();
        this.watchers.delete(path);
        // In the git dir only `worktrees` matters: `git status` alone rewrites `index` there. No name: assume it might.
        const watcher = (this.io.watch ?? watch)(path, (_, name) => {
          const worktreesMayHaveChanged = path !== common || !name || String(name).startsWith("worktrees");
          if (worktreesMayHaveChanged) this.soon();
        });
        watcher.on("error", (error) => {
          watcher.close();
          this.watchers.delete(path);
          if (this.closed) return;
          const health = this.health();
          health.errors.push({ path, message: `Cannot watch worktrees: ${error.message}` });
          healthLocal.set(this.s, undefined, health);
          this.soon();
        });
        this.watchers.set(path, { watcher, inode });
      });
    return paths;
  }
}
