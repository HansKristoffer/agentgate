import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { skillId } from "../skill-import.ts";
import {
  deleteSkill,
  installSkills,
  readSkill,
  setSkillProjects,
  skillSummaries,
  type FetchedSkill,
} from "../skills.ts";
import { currentFolder } from "./config.ts";
import { folderStore } from "./folder-store.ts";
import { shortError, type FactoryRuntime } from "./runtime.ts";

/**
 * The folder's `skills/`: the factory machine installs each `skills/<name>/` that has a SKILL.md and links it into the
 * repositories the factory works in, every time the folder loads, and removes them when the factory turns off.
 */

const MINUTE = 60_000;

const factorySkills = (f: FactoryRuntime) => skillSummaries(f.s).filter((k) => k.source?.startsWith("factory:"));

/** Each `skills/<name>/` that has a SKILL.md; one that cannot be read is named instead of failing the rest. */
function readFolderSkills(dir: string | undefined) {
  const found: FetchedSkill[] = [];
  const skipped: string[] = [];
  if (!dir) return { found, skipped };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(join(dir, entry.name, "SKILL.md"))) continue;
    try {
      found.push({ id: skillId(entry.name), ...readSkill(join(dir, entry.name)) });
    } catch (e) {
      skipped.push(`${entry.name}: ${shortError(e)}`);
    }
  }
  return { found, skipped };
}

/** The folder's skills, installed and linked into every repository the factory works in; factory skills that left
 * the folder, or came from another factory repo, are removed. A name another source already has is left alone. */
function installFolderSkills(f: FactoryRuntime) {
  const pointer = f.pointer();
  const folder = currentFolder(f);
  // Not loaded yet is not empty: the skills stay until a folder says otherwise.
  if (pointer && !folder) return;
  const { s } = f;
  const source = pointer ? folderStore(f, pointer).skillSource : undefined;
  const { found, skipped } = readFolderSkills(folder?.skillsDir);
  // Another factory repo's skill of the same name is replaced; anyone else's is left alone.
  const taken = found.filter((k) => {
    const prev = s.get("skill", k.id);
    return !!prev && prev.source !== source && !prev.source?.startsWith("factory:");
  });
  for (const k of taken) skipped.push(`${k.id}: a skill with this name already exists`);
  const mine = found.filter((k) => !taken.includes(k));
  const repos = Object.keys(folder?.config.repositories ?? {});
  const before = JSON.stringify(factorySkills(f));
  s.transaction(() => {
    for (const k of factorySkills(f)) {
      const stays = k.source === source && mine.some((m) => m.id === k.id);
      if (!stays) deleteSkill(s, k.id);
    }
    if (source && mine.length) installSkills(s, source, mine);
    for (const k of mine) setSkillProjects(s, k.id, repos);
  });
  const after = factorySkills(f);
  if (JSON.stringify(after) !== before || skipped.length)
    f.events.emit({
      kind: "note",
      text: [
        after.length ? `The factory's skills are ${after.map((k) => k.id).join(", ")}` : "The factory has no skills",
        ...(skipped.length ? [`skipped ${skipped.join("; ")}`] : []),
      ].join("; "),
    });
}

export function setup(f: FactoryRuntime): void {
  const skills = () => {
    try {
      installFolderSkills(f);
    } catch (e) {
      f.events.emit({ kind: "note", text: `Installing the factory's skills failed: ${shortError(e)}` });
    }
  };
  // A folder loaded before this machine knew about skills gets them on the first round, not at its next commit.
  let installed = false;
  f.loops.push({
    name: "factory-skills",
    everyMs: 10 * MINUTE,
    where: "factory-node",
    run: async () => {
      if (!installed) skills();
      installed = true;
    },
  });
  f.events.on("config", (event) => {
    if (event.commit) skills();
  });
  f.events.on("factory.off", skills);
}
