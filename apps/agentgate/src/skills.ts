import { SkillConflict, projectIdSchema, skillSchema, type SkillSummary } from "@agentgate/protocol";
import type { z } from "zod";
import { canonicalProject } from "./mcp/gateway.ts";
import { description, fetchSkills, validateFetched, type FetchedSkill, type SkillFetcher } from "./skill-import.ts";
import type { Skill, Store } from "./store.ts";

export { MAX_SKILL } from "@agentgate/protocol";
export { SkillLinks, SKILLS_DIR, globalSkillDirs } from "./skill-links.ts";
export { description, readSkill, skillId, fetchSkills, searchSkills, type FetchedSkill } from "./skill-import.ts";

export const skillRevision = (s: Store, id: string) => {
  const record = s.record("skill", id);
  return record && !record.deleted ? JSON.stringify([record.rev, record.node, record.updated_at]) : null;
};
const contentHash = (files: Skill["files"]) => new Bun.CryptoHasher("sha256").update(JSON.stringify(files)).digest("hex");

/** JSON metadata only; legacy bundles are measured without decoding all contents. */
export function skillSummaries(s: Store): SkillSummary[] {
  return s.db.query(`select r.id, json_extract(r.data, '$.description') as description,
    json_extract(r.data, '$.source') as source, json_extract(r.data, '$.hash') as hash,
    json_extract(r.data, '$.contentHash') as contentHash, json_extract(r.data, '$.updatedAt') as updatedAt,
    coalesce(json_extract(r.data, '$.size'), (select sum(length(json_extract(f.value, '$.data')) / 4 * 3
      - case when json_extract(f.value, '$.data') like '%==' then 2 when json_extract(f.value, '$.data') like '%=' then 1 else 0 end)
      from json_each(r.data, '$.files') f)) as size
    from records r where kind = 'skill' and deleted = 0 order by id`).all().map(row => {
      const r = row as SkillSummary;
      return { ...r, source: r.source ?? undefined, hash: r.hash ?? undefined, contentHash: r.contentHash ?? undefined };
    });
}

function putSkill(s: Store, input: Omit<z.input<typeof skillSchema>, "updatedAt">) {
  const skill = skillSchema.parse({ ...input, updatedAt: s.now() });
  skill.contentHash = contentHash(skill.files);
  const prev = s.get("skill", skill.id);
  if (prev && contentHash(prev.files) === skill.contentHash && prev.description === skill.description
    && prev.source === skill.source && prev.selector === skill.selector && prev.hash === skill.hash) return prev;
  return s.put("skill", skill.id, skill);
}

function projectsFor(s: Store, projects: string[]) {
  return [...new Set(projects.map(project => canonicalProject(s, projectIdSchema.parse(project))))];
}

function assign(s: Store, project: string, id: string, on: boolean) {
  project = canonicalProject(s, projectIdSchema.parse(project));
  const p = s.get("project", project) ?? s.put("project", project, { id: project });
  if (p.skills.includes(id) !== on) s.put("project", project, { ...p, skills: on ? [...p.skills, id] : p.skills.filter(x => x !== id) });
}

export function installSkills(s: Store, source: string, fetched: FetchedSkill[], ids?: string[], projects: string[] = []): string[] {
  fetched = validateFetched(fetched);
  const selected = new Set(ids ?? fetched.map(f => f.id));
  if (!selected.size) throw new Error("Choose at least one skill");
  const missing = [...selected].filter(id => !fetched.some(f => f.id === id));
  if (missing.length) throw new Error(`not in ${source}: ${missing.join(", ")}`);
  return s.transaction(() => {
    const targets = projectsFor(s, projects);
    return fetched.filter(f => selected.has(f.id)).map(f => {
      const prev = s.get("skill", f.id);
      if (prev && prev.source !== source) throw new SkillConflict(`a skill named ${f.id} already exists${prev.source ? ` from ${prev.source}` : ""}; remove it first`);
      putSkill(s, { id: f.id, description: f.description, files: f.files, source, selector: f.selector, hash: f.hash });
      for (const project of targets) assign(s, project, f.id, true);
      return f.id;
    });
  });
}

/** null creates a new skill; a revision replaces an existing one; omitted is for internal callers. */
export function writeSkillMd(s: Store, id: string, text: string, expectedRevision?: string | null) {
  return s.transaction(() => {
    if (expectedRevision !== undefined && skillRevision(s, id) !== expectedRevision) throw new SkillConflict();
    const prev = s.get("skill", id);
    if (!text.trim()) throw new Error("SKILL.md is empty");
    description(text, id);
    const files = [...(prev?.files.filter(f => f.path !== "SKILL.md") ?? []), { path: "SKILL.md", data: Buffer.from(text).toString("base64") }];
    return putSkill(s, { ...prev, id, description: description(text), hash: undefined, files });
  });
}

export function deleteSkill(s: Store, id: string) {
  s.transaction(() => {
    s.del("skill", id);
    for (const p of s.list("project")) if (p.skills.includes(id)) assign(s, p.id, id, false);
  });
}

export function setSkillProjects(s: Store, id: string, projects: string[]) {
  s.transaction(() => {
    if (!s.get("skill", id)) throw new Error(`no skill ${id}`);
    const targets = projectsFor(s, projects);
    for (const p of s.list("project")) if (!targets.includes(p.id)) assign(s, p.id, id, false);
    for (const p of targets) assign(s, p, id, true);
  });
}

const updates = new WeakMap<Store, Map<string, Promise<boolean>>>();
export function updateSkill(s: Store, id: string, fetch: SkillFetcher = fetchSkills, signal?: AbortSignal): Promise<boolean> {
  let flights = updates.get(s);
  if (!flights) updates.set(s, flights = new Map());
  const hit = flights.get(id);
  if (hit) return hit;
  const work = (async () => {
    const { skill, revision } = s.transaction(() => ({ skill: s.get("skill", id), revision: skillRevision(s, id) }));
    if (!skill) throw new Error(`no skill ${id}`);
    if (!skill.source) throw new Error(`${id} was written by hand; edit it instead`);
    const fresh = validateFetched(await fetch(skill.source, skill.selector ?? "*", signal)).find(f => f.id === id);
    if (!fresh) throw new Error(`${skill.source} no longer has ${id}`);
    signal?.throwIfAborted();
    return s.transaction(() => {
      if (skillRevision(s, id) !== revision) throw new SkillConflict();
      const before = s.seq();
      putSkill(s, { ...skill, description: fresh.description, files: fresh.files, hash: fresh.hash, selector: fresh.selector ?? skill.selector });
      return s.seq() !== before;
    });
  })().finally(() => flights!.delete(id));
  flights.set(id, work);
  return work;
}
