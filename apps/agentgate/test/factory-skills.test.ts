import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, afterEach, expect, test } from "bun:test";
import { fetcher } from "../src/factory/folder.ts";
import { loopTask } from "../src/factory/runtime.ts";
import { deleteSkill, updateSkill, updateSkills, writeSkillMd } from "../src/skills.ts";
import type { Store } from "../src/store.ts";
import { removeTmp } from "./fixtures/git.ts";
import { factoryNode } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** The fixture's factory folder lives in this repository, which names its skills' source. */
const SOURCE = "factory:acme/factory";
const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nDo it well.\n`;
const factorySkills = (s: Store) =>
  s
    .list("skill")
    .filter((k) => k.source?.startsWith("factory:"))
    .map((k) => [k.id, k.source]);

test("the folder's skills are installed and linked into the factory's repositories, and removed when they leave the folder or the factory turns off", async () => {
  const n = await factoryNode(cleanup, {
    files: {
      "skills/review-tips/SKILL.md": skill("review-tips", "How we review"),
      "skills/style/SKILL.md": skill("style", "House style"),
    },
  });
  const linked = () => n.s.get("project", n.repo)?.skills.toSorted() ?? [];
  // Installed when `use` loaded the folder, under the factory repo it came from.
  expect(factorySkills(n.s)).toEqual([
    ["review-tips", SOURCE],
    ["style", SOURCE],
  ]);
  expect(linked()).toEqual(["review-tips", "style"]);
  // Only the folder updates them: the hourly skill update never asks the skills CLI for a `factory:` source.
  const asked: string[] = [];
  expect(await updateSkills(n.s, async (from) => (asked.push(from), []))).toEqual([]);
  expect(asked).toEqual([]);
  await expect(updateSkill(n.s, "style", async (from) => (asked.push(from), []))).rejects.toThrow(
    "style follows the factory folder acme/factory; it updates when the folder loads",
  );
  expect(asked).toEqual([]);

  // The next commit drops `style` and adds `notes`, a name a person already wrote a skill under.
  writeSkillMd(n.s, "notes", skill("notes", "Mine"));
  const commit = "b".repeat(40);
  const dir = join(fetcher.root, commit);
  const next = {
    "factory.yaml": JSON.stringify({ version: 1, name: "acme", repositories: { [n.repo]: {} } }),
    "skills/review-tips/SKILL.md": skill("review-tips", "How we review, rewritten"),
    "skills/notes/SKILL.md": skill("notes", "The factory's notes"),
  };
  for (const [file, text] of Object.entries(next)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  fetcher.fetch = async () => ({ commit, dir });
  expect((await n.command("reload")).code).toBe(0);
  expect(factorySkills(n.s)).toEqual([["review-tips", SOURCE]]);
  expect(n.s.get("skill", "review-tips")!.description).toBe("How we review, rewritten");
  expect(n.s.get("skill", "style")).toBeUndefined();
  expect(n.s.get("skill", "notes")!.description).toBe("Mine");
  expect(linked()).toEqual(["review-tips"]);
  expect(n.f.events.recent(5).map((e) => e.text)).toContain(
    "The factory's skills are review-tips; skipped notes: a skill with this name already exists",
  );

  expect((await n.command("off")).code).toBe(0);
  expect(factorySkills(n.s)).toEqual([]);
  expect(linked()).toEqual([]);
  expect(n.s.get("skill", "notes")).toBeDefined();
});

test("a daemon that starts with its folder already loaded installs the folder's skills on its loop's first pass", async () => {
  const n = await factoryNode(cleanup, { files: { "skills/style/SKILL.md": skill("style", "House style") } });
  // As a store whose folder loaded before the daemon knew about skills.
  deleteSkill(n.s, "style");
  const restarted = await n.restart();
  expect(factorySkills(restarted.s)).toEqual([]);

  await loopTask(
    restarted.f,
    restarted.f.loops.find((l) => l.name === "factory-skills")!,
  )();
  expect(factorySkills(restarted.s)).toEqual([["style", SOURCE]]);
});
