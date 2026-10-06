import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync, rmSync, renameSync, unlinkSync, symlinkSync, utimesSync, watch, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSkillRepo, deleteSkill, description, installSkills, readSkill, repoUrl, setSkillProjects, setSkillRepoProjects, SkillLinks, skillRepoSummaries, syncSkillRepo, updateSkill, updateSkills, writeSkillMd, skillRevision, skillSummaries, type FetchedSkill } from "../src/skills.ts";
import { readRepoSkills, type RepoFetch, type RepoFetcher } from "../src/skill-import.ts";
import { MAX_SKILL, SkillConflict } from "@agentgate/protocol";
import { parseData, parseRecord, importBackup, Store } from "../src/store.ts";

const md = (name: string, text = "Do it.") => `---\nname: ${name}\ndescription: ${name} helps.\n---\n${text}\n`;
const fetched = (id: string, text?: string): FetchedSkill => ({ id, description: `${id} helps.`, files: [{ path: "SKILL.md", data: Buffer.from(md(id, text)).toString("base64") }, { path: "scripts/run.sh", data: Buffer.from("echo hi").toString("base64"), executable: true }] });
const git = (cwd: string, ...args: string[]) => { const r = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" }); if (r.exitCode) throw new Error(r.stderr.toString()); };
const link = (path: string) => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ? readlinkSync(path) : undefined;
const until = async (check: () => boolean, ms = 3000) => { for (let i = 0; i < ms / 50 && !check(); i++) await Bun.sleep(50); return check(); };

const fixtures: { dir: string; s: Store; links: SkillLinks }[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.links.close(); f.s.close(); rmSync(f.dir, { recursive: true, force: true }); } });

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentgate-skills-test-")));
  const s = new Store(":memory:"); s.setLocal("node", "a");
  const root = join(dir, "store"), global = join(dir, "claude-skills"), primary = join(dir, "home-claude-skills");
  const repo = join(dir, "repo");
  mkdirSync(repo); git(repo, "init", "-q"); git(repo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init");
  git(repo, "worktree", "add", "-q", join(dir, "wt1"));
  const links = new SkillLinks(s, root, () => [[global, true], [primary, false]]);
  fixtures.push({ dir, s, links });
  return { dir, s, root, global, primary, repo, links };
}

test("skill file paths cannot leave the skill folder", () => {
  const skill = (path: string) => parseData("skill", "x", { id: "x", updatedAt: 1, files: [{ path: "SKILL.md", data: Buffer.from("instructions").toString("base64") }, { path, data: "" }] });
  for (const bad of ["../x", "/etc/passwd", "a/../../x", "a//b", "./x", "a\\b"]) expect(() => skill(bad)).toThrow();
  expect(skill("scripts/run.sh").files[1]!.path).toBe("scripts/run.sh");
  expect(() => parseData("skill", "../x", { id: "../x", updatedAt: 1, files: [{ path: "SKILL.md", data: "" }] })).toThrow();
});

test("readSkill reads files, the exec bit and the frontmatter description", () => {
  const { dir } = setup();
  const src = join(dir, "src"); mkdirSync(join(src, "scripts"), { recursive: true });
  writeFileSync(join(src, "SKILL.md"), md("demo")); writeFileSync(join(src, "scripts", "run.sh"), "echo", { mode: 0o755 });
  const skill = readSkill(src);
  expect(skill.description).toBe("demo helps.");
  expect(skill.files.map(f => [f.path, !!f.executable]).sort()).toEqual([["SKILL.md", false], ["scripts/run.sh", true]]);
  expect(description("no frontmatter")).toBe("");
});

test("links follow project assignments, never touch foreign entries, and reach worktrees", async () => {
  const { dir, s, root, global, primary, repo, links } = setup();
  try {
    installSkills(s, "owner/pack", [fetched("alpha"), fetched("beta")]);
    expect(() => installSkills(s, "other/pack", [fetched("alpha")])).toThrow(/already exists/);
    setSkillProjects(s, "alpha", ["owner/repo"]);
    setSkillProjects(s, "beta", ["*"]);
    // Something the user put there themselves, under a name we want.
    mkdirSync(join(repo, ".agents", "skills", "alpha"), { recursive: true });
    expect(links.register(join(dir, "wt1"), "owner/repo")).toBe(repo);

    expect(readFileSync(join(root, "alpha", "SKILL.md"), "utf8")).toContain("alpha helps");
    expect(lstatSync(join(root, "alpha", "scripts", "run.sh")).mode & 0o111).toBeTruthy();
    expect(link(join(global, "beta"))).toBe(join(root, "beta"));
    expect(existsSync(join(primary, "beta"))).toBe(false); // primary is off
    expect(link(join(repo, ".claude", "skills", "alpha"))).toBe(join(root, "alpha"));
    expect(link(join(repo, ".agents", "skills", "alpha"))).toBeUndefined(); // foreign folder kept
    expect(links.conflicts()).toEqual([join(repo, ".agents", "skills", "alpha")]);
    expect(link(join(dir, "wt1", ".agents", "skills", "alpha"))).toBe(join(root, "alpha"));
    // Claude falls back to the main checkout from a worktree without .claude/skills: do not create one.
    expect(existsSync(join(dir, "wt1", ".claude"))).toBe(false);
    expect(link(join(repo, ".claude", "skills", "beta"))).toBeUndefined(); // already global
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toContain("/.agents/skills/alpha");
    const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: join(dir, "wt1") }).stdout.toString();
    expect(status).toBe("");

    // A worktree created later gets its links from the watcher, before any session starts there.
    git(repo, "worktree", "add", "-q", join(dir, "wt2"));
    expect(await until(() => link(join(dir, "wt2", ".agents", "skills", "alpha")) === join(root, "alpha"))).toBe(true);

    installSkills(s, "owner/pack", [fetched("alpha", "Changed.")]);
    links.sync();
    expect(readFileSync(join(root, "alpha", "SKILL.md"), "utf8")).toContain("Changed.");
    expect(existsSync(join(root, "alpha", "scripts", "run.sh"))).toBe(true);

    setSkillProjects(s, "alpha", []);
    links.sync();
    expect(existsSync(join(repo, ".claude", "skills", "alpha"))).toBe(false);
    expect(existsSync(join(dir, "wt1", ".agents", "skills", "alpha"))).toBe(false);
    expect(existsSync(join(repo, ".agents", "skills", "alpha"))).toBe(true);

    deleteSkill(s, "beta");
    links.sync();
    expect(existsSync(join(root, "beta"))).toBe(false);
    expect(lstatSync(join(global, "beta"), { throwIfNoEntry: false })).toBeUndefined();
    expect(s.get("project", "*")!.skills).toEqual([]);
  } finally { links.close(); }
});

test("update refetches from the original source", async () => {
  const { s } = setup();
  installSkills(s, "owner/pack", [fetched("alpha")]);
  expect(await updateSkill(s, "alpha", async () => [fetched("alpha")])).toBe(false);
  expect(await updateSkill(s, "alpha", async () => [fetched("alpha", "New.")])).toBe(true);
  expect(Buffer.from(s.get("skill", "alpha")!.files[0]!.data, "base64").toString()).toContain("New.");
  writeSkillMd(s, "mine", md("mine"));
  expect(updateSkill(s, "mine")).rejects.toThrow(/by hand/);
});

test("repository mirroring reaches worktrees and preserves committed links after source removal", () => {
  const { dir, s, root, repo, links } = setup();
  try {
    const commit = (msg: string) => { git(repo, "add", "-A"); git(repo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", msg); };
    mkdirSync(join(repo, ".claude", "skills", "claude-only"), { recursive: true });
    writeFileSync(join(repo, ".claude", "skills", "claude-only", "SKILL.md"), md("claude-only"));
    mkdirSync(join(repo, ".agents", "skills", "codex-only"), { recursive: true });
    writeFileSync(join(repo, ".agents", "skills", "codex-only", "SKILL.md"), md("codex-only"));
    // Like a repo that commits its skill folders: this beats .git/info/exclude.
    writeFileSync(join(repo, ".gitignore"), ".claude/*\n!.claude/skills/\n!.claude/skills/**\n.agents/*\n!.agents/skills/\n!.agents/skills/**\n");
    commit("skills");
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim();
    git(join(dir, "wt1"), "reset", "-q", "--hard", head);
    installSkills(s, "owner/pack", [fetched("alpha")]);
    setSkillProjects(s, "alpha", ["owner/repo"]);
    links.register(repo, "owner/repo");
    links.setMirroring(repo, true);

    for (const tree of [repo, join(dir, "wt1")]) {
      expect(link(join(tree, ".agents", "skills", "claude-only"))).toBe("../../.claude/skills/claude-only");
      expect(link(join(tree, ".claude", "skills", "codex-only"))).toBe("../../.agents/skills/codex-only");
      expect(readFileSync(join(tree, ".claude", "skills", "codex-only", "SKILL.md"), "utf8")).toContain("codex-only helps");
      // The worktree now has its own .claude/skills, so it gets the project links too (no fallback to main).
      expect(link(join(tree, ".claude", "skills", "alpha"))).toBe(join(root, "alpha"));
      // Mirrors are relative and meant to be committed; the links into this machine's store never show.
      expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: tree }).stdout.toString().split("\n").filter(Boolean).sort())
        .toEqual(["?? .agents/skills/claude-only", "?? .claude/skills/codex-only"]);
    }
    expect(links.repoSkills(repo)).toEqual(["claude-only", "codex-only"]);

    git(repo, "rm", "-rq", ".claude/skills/claude-only"); commit("drop");
    links.sync();
    expect(link(join(repo, ".agents", "skills", "claude-only"))).toBe("../../.claude/skills/claude-only"); // committed mirrors belong to the repository
    expect(link(join(repo, ".claude", "skills", "codex-only"))).toBe("../../.agents/skills/codex-only");

    setSkillProjects(s, "alpha", []);
    links.sync();
    expect(existsSync(join(repo, ".claude", "skills", ".gitignore"))).toBe(false);
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).not.toContain("alpha");
  } finally { links.close(); }
});

test("all bundle ingestion paths reject malformed content before committing", () => {
  const { s } = setup();
  const valid = fetched("x");
  const badFiles = [
    [{ path: "other", data: "aGk=" }],
    [{ path: "SKILL.md", data: "" }],
    [{ path: "SKILL.md", data: "not base64!" }],
    [...valid.files, { ...valid.files[0]! }],
    [...valid.files, { path: "skill.MD", data: "aGk=" }],
    [...valid.files, { path: "scripts", data: "aGk=" }],
    [...valid.files, { path: ".agentgate-rev", data: "aGk=" }],
    [...valid.files, { path: ".git/config", data: "aGk=" }],
    [{ path: "SKILL.md", data: "A".repeat(MAX_SKILL / 2 + 4) }, { path: "large", data: "A".repeat(MAX_SKILL / 2 + 4) }],
  ];
  for (const files of badFiles) {
    const data = { id: "x", description: "x", files, updatedAt: 1 };
    expect(() => s.put("skill", "x", data)).toThrow();
    expect(() => parseRecord({ kind: "skill", id: "x", rev: 1, node: "remote", updated_at: 1, deleted: 0, data: JSON.stringify(data) })).toThrow();
    expect(() => importBackup(s, { agentgate: 3, records: [{ kind: "account", id: "a", data: { id: "a", provider: "claude", label: "a" } }, { kind: "skill", id: "x", data }] })).toThrow();
  }
  expect(s.seq()).toBe(0);
  expect(s.get("account", "a")).toBeUndefined();
  expect(() => installSkills(s, "owner/pack", [valid, valid])).toThrow(/duplicate/);
  expect(s.seq()).toBe(0);
});

test("reading a source reports symlinks and oversized files rather than incomplete copies", () => {
  const { dir } = setup(), src = join(dir, "source");
  mkdirSync(src); writeFileSync(join(src, "SKILL.md"), md("x"));
  symlinkSync("SKILL.md", join(src, "alias"));
  expect(() => readSkill(src)).toThrow(/symlinks/);
  unlinkSync(join(src, "alias"));
  writeFileSync(join(src, "large"), Buffer.alloc(MAX_SKILL));
  expect(() => readSkill(src)).toThrow(/encoded/);
});

test("late updates cannot resurrect deletions, replace a recreated skill, or overwrite peer changes", async () => {
  const { s } = setup();
  for (const action of ["delete", "recreate", "peer"] as const) {
    const id = `race-${action}`;
    installSkills(s, "owner/pack", [fetched(id)]);
    const gate = Promise.withResolvers<FetchedSkill[]>();
    const updating = updateSkill(s, id, () => gate.promise);
    if (action === "delete" || action === "recreate") deleteSkill(s, id);
    if (action === "recreate") writeSkillMd(s, id, md(id, "new local edit"));
    if (action === "peer") {
      const record = s.record("skill", id)!;
      const data = { ...s.get("skill", id)!, files: fetched(id, "peer edit").files };
      s.merge({ ...record, rev: record.rev + 1, node: "peer", data: JSON.stringify(data) });
    }
    gate.resolve([fetched(id, "upstream")]);
    await expect(updating).rejects.toBeInstanceOf(SkillConflict);
    if (action === "delete") expect(s.get("skill", id)).toBeUndefined();
    else expect(Buffer.from(s.get("skill", id)!.files[0]!.data, "base64").toString()).toContain(action === "peer" ? "peer edit" : "new local edit");
  }
});

test("editor revisions protect existing records and creation rejects an occupied ID", () => {
  const { s } = setup();
  writeSkillMd(s, "x", md("x"), null);
  const rev = skillRevision(s, "x")!;
  expect(() => writeSkillMd(s, "x", md("x", "other"), null)).toThrow(SkillConflict);
  writeSkillMd(s, "x", md("x", "new"), rev);
  expect(() => writeSkillMd(s, "x", md("x", "stale"), rev)).toThrow(SkillConflict);
  expect(() => writeSkillMd(s, "x", md("wrong"))).toThrow(/name/);
  expect(() => writeSkillMd(s, "x", "---\nname: [\n---\nbody")).toThrow(/frontmatter/);
});

test("normalized unchanged installs and updates create no revisions and sizes count decoded files", async () => {
  const { s } = setup();
  const skill = fetched("x"); skill.hash = "upstream-hash";
  installSkills(s, "owner/pack", [skill], undefined, ["Owner/Repo"]);
  const before = s.seq();
  installSkills(s, "owner/pack", [{ ...skill, files: [...skill.files].reverse() }], undefined, ["owner/repo"]);
  expect(s.seq()).toBe(before);
  expect(s.list("project").map(p => p.id)).toEqual(["Owner/Repo"]);
  expect(await updateSkill(s, "x", async () => [{ ...skill, files: [...skill.files].reverse() }])).toBe(false);
  expect(s.seq()).toBe(before);
  expect(await updateSkill(s, "x", async () => [{ ...skill, files: skill.files.map(f => ({ ...f, executable: false })) }])).toBe(true);
  // A skill with a source follows it, so it can't be edited locally.
  expect(() => writeSkillMd(s, "x", md("x", "edit"))).toThrow(SkillConflict);
  writeSkillMd(s, "five", "hello");
  expect(skillSummaries(s).find(k => k.id === "five")!.size).toBe(5);
});

test("installed skills follow their source and report failures without stopping", async () => {
  const { s } = setup();
  installSkills(s, "owner/pack", [fetched("a"), fetched("gone")]);
  writeSkillMd(s, "mine", md("mine"));
  const results = await updateSkills(s, async () => [fetched("a", "upstream")]);
  expect(results).toEqual([{ id: "a", outcome: "updated" }, { id: "gone", outcome: "failed: owner/pack no longer has gone" }]);
  expect(Buffer.from(s.get("skill", "a")!.files[0]!.data, "base64").toString()).toContain("upstream");
});

test("a failed publication restores the old copy and continues to healthy skills", () => {
  const { s, root, links: initial } = setup(); initial.close();
  let fail = false;
  const links = new SkillLinks(s, root, () => [], { rename: (from, to) => {
    if (fail && String(from).endsWith(".tmp") && to === join(root, "alpha")) throw new Error("injected publication failure");
    renameSync(from, to);
  } });
  try {
    writeSkillMd(s, "alpha", "original"); links.sync();
    fail = true; writeSkillMd(s, "alpha", "updated"); writeSkillMd(s, "beta", "healthy"); links.sync();
    expect(readFileSync(join(root, "alpha", "SKILL.md"), "utf8")).toBe("original");
    expect(readFileSync(join(root, "beta", "SKILL.md"), "utf8")).toBe("healthy");
    expect(links.health().errors).toHaveLength(1);
    fail = false; links.sync();
    expect(readFileSync(join(root, "alpha", "SKILL.md"), "utf8")).toBe("updated");
    expect(links.health().errors).toEqual([]);
  } finally { links.close(); }
});

test("restart recovers an interrupted swap and integrity checks repair missing or changed files", () => {
  const { s, root, links } = setup();
  writeSkillMd(s, "x", "original"); links.sync();
  const old = join(root, `x.${crypto.randomUUID()}.old`);
  renameSync(join(root, "x"), old); links.close();
  const restarted = new SkillLinks(s, root, () => []);
  try {
    restarted.sync();
    expect(readFileSync(join(root, "x", "SKILL.md"), "utf8")).toBe("original");
    expect(existsSync(old)).toBe(false);
    unlinkSync(join(root, "x", "SKILL.md")); restarted.sync();
    expect(readFileSync(join(root, "x", "SKILL.md"), "utf8")).toBe("original");
    restarted.sync();
    writeFileSync(join(root, "x", "SKILL.md"), "modified");
    utimesSync(join(root, "x", "SKILL.md"), new Date(), new Date(Date.now() + 1000));
    restarted.sync();
    expect(readFileSync(join(root, "x", "SKILL.md"), "utf8")).toBe("original");
    mkdirSync(join(root, "foreign")); writeFileSync(join(root, "foreign", "keep"), "owned by user");
    restarted.sync(); expect(existsSync(join(root, "foreign", "keep"))).toBe(true);
  } finally { restarted.close(); }
});

test("a failing checkout does not block another and mirroring is opt-in with ownership", () => {
  const { s, dir, root, repo, links } = setup();
  const other = join(dir, "other"); mkdirSync(other); git(other, "init", "-q");
  installSkills(s, "owner/pack", [fetched("x")]); setSkillProjects(s, "x", ["owner/repo"]);
  mkdirSync(join(repo, ".claude")); writeFileSync(join(repo, ".claude", "skills"), "blocked");
  links.register(repo, "owner/repo", false); links.register(other, "owner/repo", false); links.sync();
  expect(link(join(other, ".agents", "skills", "x"))).toBe(join(root, "x"));
  expect(links.health().errors.length).toBeGreaterThan(0);
  mkdirSync(join(other, ".claude", "skills", "native"), { recursive: true });
  writeFileSync(join(other, ".claude", "skills", "native", "SKILL.md"), md("native"));
  links.sync(); expect(link(join(other, ".agents", "skills", "native"))).toBeUndefined();
  // A user-created mirror is preserved, even if its source later disappears.
  symlinkSync("../../.claude/skills/foreign", join(other, ".agents", "skills", "foreign"));
  links.setMirroring(other, true);
  expect(link(join(other, ".agents", "skills", "native"))).toBe("../../.claude/skills/native");
  expect(link(join(other, ".agents", "skills", "foreign"))).toBe("../../.claude/skills/foreign");
  rmSync(join(other, ".claude", "skills", "native"), { recursive: true }); links.sync();
  expect(lstatSync(join(other, ".agents", "skills", "native"), { throwIfNoEntry: false })).toBeUndefined();
});

test("worktree registrations delayed beyond 600 ms converge through bounded retries", async () => {
  const { s, dir, root, repo, links } = setup();
  installSkills(s, "owner/pack", [fetched("x")]); setSkillProjects(s, "x", ["owner/repo"]); links.register(repo, "owner/repo");
  const tree = join(dir, "slow-worktree"), metadata = join(repo, ".git", "worktrees", "slow");
  mkdirSync(tree); mkdirSync(metadata);
  await Bun.sleep(800);
  writeFileSync(join(metadata, "gitdir"), join(tree, ".git"));
  // Retries run up to 10 s after the event; on a busy macOS runner the event itself can arrive late, so wait through the
  // 5 s one rather than relying on the 2 s one.
  expect(await until(() => link(join(tree, ".agents", "skills", "x")) === join(root, "x"), 6000)).toBe(true);
}, 10_000);

test("watch setup failures and emitted errors are recoverable and close allocated watchers", () => {
  const { s, root, repo, links: initial } = setup(); initial.close();
  let fail = true, closes = 0;
  const allocated: FSWatcher[] = [];
  const factory = ((path: string, callback: () => void) => {
    if (fail && path.endsWith("worktrees")) throw new Error("injected watch failure");
    const watcher = watch(path, callback), close = watcher.close.bind(watcher);
    watcher.close = () => { closes++; close(); };
    allocated.push(watcher); return watcher;
  }) as typeof watch;
  const links = new SkillLinks(s, root, () => [], { watch: factory });
  try {
    writeSkillMd(s, "x", "instructions"); setSkillProjects(s, "x", ["owner/repo"]); links.register(repo, "owner/repo");
    expect(allocated).toHaveLength(1); expect(links.health().errors).toHaveLength(1);
    fail = false; links.sync(); expect(allocated).toHaveLength(2); expect(links.health().errors).toEqual([]);
    allocated[0]!.emit("error", new Error("watcher disconnected"));
    expect(links.health().errors[0]!.message).toContain("disconnected");
    links.sync(); expect(allocated).toHaveLength(3); expect(links.health().errors).toEqual([]);
  } finally { links.close(); }
  expect(closes).toBe(3);
});

test("a repository's skills are read from .claude/skills and .agents/skills, skipping mirrors and unreadable ones", () => {
  const { dir } = setup();
  const repo = join(dir, "gh");
  for (const [folder, name] of [[".claude", "alpha"], [".agents", "beta"], [".agents", "broken"]] as const) {
    mkdirSync(join(repo, folder, "skills", name), { recursive: true });
    writeFileSync(join(repo, folder, "skills", name, "SKILL.md"), md(name));
  }
  symlinkSync("../../.claude/skills/alpha", join(repo, ".agents", "skills", "alpha"));
  symlinkSync("SKILL.md", join(repo, ".agents", "skills", "broken", "link.md"));
  mkdirSync(join(repo, ".claude", "skills", "notes"));
  const { skills, skipped } = readRepoSkills(repo);
  expect(skills.map(k => [k.id, k.description])).toEqual([["alpha", "alpha helps."], ["beta", "beta helps."]]);
  expect(skipped).toEqual([expect.stringMatching(/^broken: .*symlinks/)]);
  mkdirSync(join(dir, "empty")); expect(() => readRepoSkills(join(dir, "empty"))).toThrow(/no skills/);
  for (const ok of ["owner/Repo", "github.com/owner/repo", "https://github.com/owner/repo.git", "https://www.github.com/owner/repo/"]) expect(repoUrl(ok)).toBe("https://github.com/owner/repo");
  for (const bad of ["https://user:token@github.com/o/r", "https://gitlab.com/o/r", "o/r/tree/main", "o/..", "-x"]) expect(() => repoUrl(bad)).toThrow(/public GitHub/);
});

test("a connected repository installs, links, updates and removes its skills, and disconnecting cleans up", async () => {
  const { s } = setup();
  const url = "https://github.com/owner/pack";
  let next: RepoFetch | null = null, since: (string | undefined)[] = [];
  const fetch: RepoFetcher = async (_, known) => { since.push(known); return next; };
  await expect(connectSkillRepo(s, url, ["*"], async () => { throw new Error("owner/pack was not found or is not public"); })).rejects.toThrow(/not public/);
  expect(skillRepoSummaries(s)).toEqual([]);

  writeSkillMd(s, "gamma", md("gamma"));
  next = { commit: "c1", skills: [fetched("alpha"), fetched("beta"), fetched("gamma")], skipped: [] };
  await connectSkillRepo(s, "owner/pack", ["*"], fetch);
  expect(s.get("project", "*")!.skills.sort()).toEqual(["alpha", "beta"]);
  expect(s.get("skill", "alpha")!.source).toBe(url);
  expect(skillRepoSummaries(s)).toEqual([expect.objectContaining({ url, projects: ["*"], skills: ["alpha", "beta"], commit: "c1", skipped: ["gamma: a skill with this name already exists"] })]);
  expect(() => deleteSkill(s, "alpha")).toThrow(SkillConflict);

  // Unchanged HEAD: the fetcher is asked with the known commit and writes nothing.
  next = null; since = [];
  expect(await syncSkillRepo(s, url, fetch)).toBe(false);
  expect(since).toEqual(["c1"]);

  // The user unlinks alpha; a new commit edits alpha, adds delta and drops beta.
  setSkillProjects(s, "alpha", []);
  next = { commit: "c2", skills: [fetched("alpha", "Changed."), fetched("delta")], skipped: [] };
  expect(await syncSkillRepo(s, url, fetch)).toBe(true);
  expect(s.get("project", "*")!.skills).toEqual(["delta"]);
  expect(Buffer.from(s.get("skill", "alpha")!.files.find(f => f.path === "SKILL.md")!.data, "base64").toString()).toContain("Changed.");
  expect(s.get("skill", "beta")).toBeUndefined();

  // A skill that went missing locally forces a full fetch even at the same commit.
  setSkillRepoProjects(s, url, ["owner/repo"]);
  expect(s.get("project", "*")!.skills).toEqual([]);
  expect(s.get("project", "owner/repo")!.skills.sort()).toEqual(["alpha", "delta"]);
  s.del("skill", "delta"); since = [];
  next = { commit: "c2", skills: [fetched("alpha", "Changed."), fetched("delta")], skipped: [] };
  await syncSkillRepo(s, url, fetch);
  expect(since).toEqual([undefined]);
  expect(s.get("skill", "delta")).toBeDefined();

  setSkillRepoProjects(s, url, []);
  expect(skillRepoSummaries(s)).toEqual([]);
  expect(skillSummaries(s).map(k => k.id)).toEqual(["gamma"]);
  expect(s.get("project", "owner/repo")!.skills).toEqual([]);
  await expect(syncSkillRepo(s, url, fetch)).rejects.toThrow(/not connected/);
});

test("a repository's skills folder that links outside the repository is ignored", () => {
  const { dir } = setup();
  const repo = join(dir, "gh"), outside = join(dir, "outside", "secret");
  mkdirSync(outside, { recursive: true }); writeFileSync(join(outside, "SKILL.md"), md("secret"));
  mkdirSync(join(repo, ".agents", "skills", "beta"), { recursive: true }); writeFileSync(join(repo, ".agents", "skills", "beta", "SKILL.md"), md("beta"));
  mkdirSync(join(repo, ".claude"), { recursive: true }); symlinkSync(join(dir, "outside"), join(repo, ".claude", "skills"));
  expect(readRepoSkills(repo).skills.map(k => k.id)).toEqual(["beta"]);
});
