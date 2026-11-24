import { afterEach, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsMd, setAgentsMd, AGENTS_MD_PROTOCOL } from "../src/agents-md.ts";
import { revision } from "../src/configuration.ts";
import { antigravityMcp } from "../src/setup.ts";
import { globalSkillDirs } from "../src/skill-links.ts";
import { SkillLinks } from "../src/skills.ts";
import { Store } from "../src/store.ts";

const link = (path: string) =>
  lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ? readlinkSync(path) : undefined;
const exists = (path: string) => !!lstatSync(path, { throwIfNoEntry: false });

const fixtures: { dir: string; s: Store; links: SkillLinks }[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.links.close();
    f.s.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

/** A node whose agentgate home is `dir/home`, with agentgate's Claude folder (on) and the user's own Codex (off). */
function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentgate-agents-md-test-")));
  const s = new Store(":memory:");
  s.setLocal("node", "a");

  const home = join(dir, "home");
  const file = join(home, "AGENTS.md");
  const claude = join(home, "claude", "CLAUDE.md");
  const codex = join(dir, "own-codex", "AGENTS.md");
  let primary = false;
  const links = new SkillLinks(s, join(home, "skills"), () => [
    [join(home, "claude", "skills"), true, claude],
    [join(dir, "own-codex", "skills"), primary, codex],
  ]);
  fixtures.push({ dir, s, links });
  return { dir, s, links, file, claude, codex, route: (on: boolean) => (primary = on) };
}

test("the stored AGENTS.md is written to the agentgate home and linked where Claude Code and Codex read it", () => {
  const { s, links, file, claude, codex, route } = setup();
  links.sync();
  // Nothing stored yet: an empty file to find and edit, and no links, so the tools' own setup is untouched.
  expect(readFileSync(file, "utf8")).toBe("");
  expect(exists(claude)).toBe(false);

  setAgentsMd(s, "Use bun.\n");
  links.sync();
  expect(readFileSync(file, "utf8")).toBe("Use bun.\n");
  expect(link(claude)).toBe(file);
  expect(exists(codex)).toBe(false);

  // `setup --primary` on: the user's own Codex gets it too, and loses it again when routing is undone.
  route(true);
  links.sync();
  expect(link(codex)).toBe(file);
  route(false);
  links.sync();
  expect(exists(codex)).toBe(false);

  setAgentsMd(s, "");
  links.sync();
  expect(s.get("project", "*")!.agentsMd).toBeUndefined();
  expect(readFileSync(file, "utf8")).toBe("");
  expect(exists(claude)).toBe(false);
});

test("a save in an editor goes to the store, and a newer text from another machine replaces the file", () => {
  const { s, links, file } = setup();
  setAgentsMd(s, "First.\n");
  links.sync();
  // Editors save by writing a new file and renaming it over the old one.
  writeFileSync(`${file}.swp`, "Edited here.\n");
  renameSync(`${file}.swp`, file);
  links.sync();
  expect(agentsMd(s)).toBe("Edited here.\n");

  // Another machine's change arrives: the file here was not edited since, so the store's text wins.
  setAgentsMd(s, "From the laptop.\n");
  links.sync();
  expect(readFileSync(file, "utf8")).toBe("From the laptop.\n");
  expect(agentsMd(s)).toBe("From the laptop.\n");
});

test("an edit is not shared while an older machine would drop it, and is kept on disk until it can be", () => {
  const { s, links, file } = setup();
  links.sync();
  s.put("node", "old", { id: "old", protocol: AGENTS_MD_PROTOCOL - 1 });
  writeFileSync(file, "Mine.\n");
  links.sync();
  expect(agentsMd(s)).toBe("");
  expect(readFileSync(file, "utf8")).toBe("Mine.\n");
  expect(links.health().errors).toEqual([{ path: file, message: expect.stringContaining("Update agentgate on old") }]);

  s.put("node", "old", { id: "old", protocol: AGENTS_MD_PROTOCOL });
  links.sync();
  expect(agentsMd(s)).toBe("Mine.\n");
  expect(links.health().errors).toEqual([]);
});

test("a CLAUDE.md the user wrote is a clash, never replaced until they choose Agentgate's", () => {
  const { dir, s, links, file, claude } = setup();
  mkdirSync(join(dir, "home", "claude"), { recursive: true });
  writeFileSync(claude, "My own.\n");
  setAgentsMd(s, "Shared.\n");
  links.sync();
  expect(links.conflicts()).toEqual([claude]);
  expect(readFileSync(claude, "utf8")).toBe("My own.\n");

  const backup = links.resolveConflict(claude, "agentgate")!;
  expect(readFileSync(backup, "utf8")).toBe("My own.\n");
  expect(link(claude)).toBe(file);
  expect(links.conflicts()).toEqual([]);
});

test("a save from an editor opened before another change is refused", () => {
  const { s } = setup();
  setAgentsMd(s, "One.\n");
  const opened = revision(s, "project", "*");
  setAgentsMd(s, "Two.\n");
  expect(() => setAgentsMd(s, "Three.\n", opened)).toThrow("Configuration changed");
  expect(agentsMd(s)).toBe("Two.\n");
});

test("saving the file is noticed without waiting for the periodic pass", async () => {
  const { s, links, file } = setup();
  links.sync();
  const saved = Promise.withResolvers<void>();
  const sync = links.sync.bind(links);
  links.sync = () => {
    sync();
    if (agentsMd(s)) saved.resolve();
  };
  writeFileSync(file, "Saved in an editor.\n");
  await saved.promise;
  expect(agentsMd(s)).toBe("Saved in an editor.\n");
});

test("T3 Antigravity instances get global AGENTS.md when routed and leave a symlinked skills dir alone", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentgate-t3-agy-")));
  const s = new Store(":memory:");
  s.setLocal("node", "a");
  const primaryAgy = join(dir, "gemini-config");
  const t3Providers = join(dir, "t3-antigravity");
  const instanceConfig = join(t3Providers, "inst-1", "config");
  mkdirSync(join(primaryAgy, "skills"), { recursive: true });
  mkdirSync(instanceConfig, { recursive: true });
  // Matches how T3 Code symlinks each Antigravity instance's skills directory to ~/.gemini/config/skills.
  symlinkSync(join(primaryAgy, "skills"), join(instanceConfig, "skills"));

  const home = join(dir, "home");
  const file = join(home, "AGENTS.md");
  const links = new SkillLinks(s, join(home, "skills"), () =>
    globalSkillDirs(primaryAgy, t3Providers).filter(([, , instructions]) => instructions?.startsWith(dir)),
  );
  fixtures.push({ dir, s, links });

  setAgentsMd(s, "Global steering.\n");
  // Primary routed, T3 instance not routed yet: primary gets AGENTS.md, shared skills symlink is untouched.
  await antigravityMcp(true, join(primaryAgy, "mcp_config.json"));
  links.sync();
  expect(link(join(primaryAgy, "AGENTS.md"))).toBe(file);
  expect(exists(join(instanceConfig, "AGENTS.md"))).toBe(false);
  expect(link(join(instanceConfig, "skills"))).toBe(join(primaryAgy, "skills"));

  // Routing both via antigravityMcp gives the T3 instance AGENTS.md too.
  await antigravityMcp(true, join(primaryAgy, "mcp_config.json"), t3Providers);
  links.sync();
  expect(link(join(instanceConfig, "AGENTS.md"))).toBe(file);

  // Turning off removes AGENTS.md from both without breaking the skills symlink.
  await antigravityMcp(false, join(primaryAgy, "mcp_config.json"), t3Providers);
  links.sync();
  expect(exists(join(primaryAgy, "AGENTS.md"))).toBe(false);
  expect(exists(join(instanceConfig, "AGENTS.md"))).toBe(false);
  expect(link(join(instanceConfig, "skills"))).toBe(join(primaryAgy, "skills"));
});
