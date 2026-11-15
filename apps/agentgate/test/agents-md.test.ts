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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsMd, setAgentsMd, AGENTS_MD_PROTOCOL } from "../src/agents-md.ts";
import { revision } from "../src/configuration.ts";
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
  const home = join(dir, "home"),
    file = join(home, "AGENTS.md"),
    claude = join(home, "claude", "CLAUDE.md"),
    codex = join(dir, "own-codex", "AGENTS.md");
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
