import { SkillConflict, projectIdSchema, skillSchema, type SkillRepoSummary, type SkillSummary } from "@agentgate/protocol";
import type { z } from "zod";
import { canonicalProject } from "./mcp/gateway.ts";
import { description, fetchRepo, fetchSkills, repoUrl, validateFetched, type FetchedSkill, type RepoFetcher, type SkillFetcher } from "./skill-import.ts";
import type { Skill, Store } from "./store.ts";

export { MAX_SKILL } from "@agentgate/protocol";
export { SkillLinks, SKILLS_DIR, globalSkillDirs } from "./skill-links.ts";
export { description, readSkill, skillId, fetchSkills, searchSkills, repoUrl, type FetchedSkill } from "./skill-import.ts";

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
    // It follows its source, which would overwrite any edit on the next update.
    if (prev?.source) throw new SkillConflict(`${id} comes from ${prev.source} and updates from it, so it can't be edited`);
    if (!text.trim()) throw new Error("SKILL.md is empty");
    description(text, id);
    const files = [...(prev?.files.filter(f => f.path !== "SKILL.md") ?? []), { path: "SKILL.md", data: Buffer.from(text).toString("base64") }];
    return putSkill(s, { ...prev, id, description: description(text), hash: undefined, files });
  });
}

function removeSkill(s: Store, id: string) {
  s.del("skill", id);
  for (const p of s.list("project")) if (p.skills.includes(id)) assign(s, p.id, id, false);
}

export function deleteSkill(s: Store, id: string) {
  s.transaction(() => {
    const source = s.get("skill", id)?.source;
    // The next sync would bring it back.
    if (source && repoProjects(s, source).length) throw new SkillConflict(`${id} comes from ${source}. Unlink it from its projects, or disconnect the repository.`);
    removeSkill(s, id);
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
    if (repoProjects(s, skill.source).length) return syncSkillRepo(s, skill.source, fetchRepo, signal);
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

/** Updates every skill installed once from a source; connected repositories sync on their own. Never throws. */
export async function updateSkills(s: Store, fetch: SkillFetcher = fetchSkills, signal?: AbortSignal) {
  const repos = new Set(skillRepoSummaries(s).map((r) => r.url));
  const results: { id: string; outcome: string }[] = [];
  for (const k of skillSummaries(s).filter((k) => k.source && !repos.has(k.source))) {
    if (signal?.aborted) break;
    const outcome = await updateSkill(s, k.id, fetch, signal).then(
      (changed) => (changed ? "updated" : "up to date"),
      (error) => `failed: ${error instanceof Error ? error.message : error}`,
    );
    results.push({ id: k.id, outcome });
  }
  return results;
}

// Connected GitHub repositories. A project's `skillRepos` lists the repositories feeding it; every node syncs them
// on its own, and identical content writes nothing, so nodes converge without coordinating.
const repoProjects = (s: Store, url: string) => s.list("project").filter(p => p.skillRepos.includes(url)).map(p => p.id);
const repoSkills = (s: Store, url: string) => skillSummaries(s).filter(k => k.source === url).map(k => k.id);
interface RepoState { commit?: string; syncedAt?: number; error?: string; skills?: string[]; skipped?: string[] }
const repoState = (s: Store, url: string): RepoState => { try { return JSON.parse(s.local(`skillRepo:${url}`) ?? "{}"); } catch { return {}; } };

export function skillRepoSummaries(s: Store): SkillRepoSummary[] {
  const urls = [...new Set(s.list("project").flatMap(p => p.skillRepos))].sort();
  return urls.map(url => {
    const { commit, syncedAt, error, skipped = [] } = repoState(s, url);
    return { url, projects: repoProjects(s, url), skills: repoSkills(s, url), commit, syncedAt, error, skipped };
  });
}

/** Where a repository's skills are linked: added projects get them, removed ones lose them, none disconnects it and deletes them. */
export function setSkillRepoProjects(s: Store, input: string, projects: string[]) {
  const url = repoUrl(input);
  s.transaction(() => {
    const targets = projectsFor(s, projects), ids = repoSkills(s, url);
    if (!targets.length && !repoProjects(s, url).length) throw new Error(`${url} is not connected`);
    for (const p of s.list("project")) if (p.skillRepos.includes(url) && !targets.includes(p.id)) {
      s.put("project", p.id, { ...p, skillRepos: p.skillRepos.filter(r => r !== url) });
      for (const id of ids) assign(s, p.id, id, false);
    }
    for (const target of targets) {
      const p = s.get("project", target) ?? s.put("project", target, { id: target });
      if (!p.skillRepos.includes(url)) s.put("project", target, { ...p, skillRepos: [...p.skillRepos, url] });
      for (const id of ids) assign(s, target, id, true);
    }
    if (!targets.length) { for (const id of ids) removeSkill(s, id); s.setLocal(`skillRepo:${url}`, undefined); }
  });
}

/** Fetch first, so a missing or empty repository is never connected. */
export async function connectSkillRepo(s: Store, input: string, projects: string[], fetch: RepoFetcher = fetchRepo, signal?: AbortSignal) {
  const url = repoUrl(input);
  if (!projects.length) throw new Error("Choose every session or at least one project");
  const fetched = (await fetch(url, undefined, signal))!;
  signal?.throwIfAborted();
  s.transaction(() => { setSkillRepoProjects(s, url, projects); applyRepo(s, url, fetched); });
  return url;
}

/** New skills are linked where the repository is connected; skills it dropped are deleted. Names taken by another source are skipped. */
function applyRepo(s: Store, url: string, fetched: { commit: string; skills: FetchedSkill[]; skipped: string[] }) {
  return s.transaction(() => {
    const targets = repoProjects(s, url);
    if (!targets.length) return false; // disconnected while fetching
    const before = s.seq(), skipped = [...fetched.skipped], applied: string[] = [];
    for (const f of fetched.skills) {
      const prev = s.get("skill", f.id);
      if (prev && prev.source !== url) { skipped.push(`${f.id}: a skill with this name already exists${prev.source ? ` from ${prev.source}` : ""}`); continue; }
      putSkill(s, { id: f.id, description: f.description, files: f.files, source: url });
      if (!prev) for (const p of targets) assign(s, p, f.id, true);
      applied.push(f.id);
    }
    for (const id of repoSkills(s, url)) if (!applied.includes(id)) removeSkill(s, id);
    s.setLocal(`skillRepo:${url}`, JSON.stringify({ commit: fetched.commit, syncedAt: s.now(), skills: applied, skipped } satisfies RepoState));
    return s.seq() !== before;
  });
}

const repoFlights = new WeakMap<Store, Map<string, Promise<boolean>>>();
/** Refetches only when HEAD moved or a skill it installed went missing. Resolves whether anything changed. */
export function syncSkillRepo(s: Store, input: string, fetch: RepoFetcher = fetchRepo, signal?: AbortSignal): Promise<boolean> {
  const url = repoUrl(input);
  let flights = repoFlights.get(s);
  if (!flights) repoFlights.set(s, flights = new Map());
  const hit = flights.get(url);
  if (hit) return hit;
  const work = (async () => {
    if (!repoProjects(s, url).length) throw new Error(`${url} is not connected`);
    const state = repoState(s, url), present = repoSkills(s, url);
    const since = state.skills?.every(id => present.includes(id)) ? state.commit : undefined;
    try {
      const fetched = await fetch(url, since, signal);
      signal?.throwIfAborted();
      if (fetched) return applyRepo(s, url, fetched);
      if (repoProjects(s, url).length) s.setLocal(`skillRepo:${url}`, JSON.stringify({ ...state, syncedAt: s.now(), error: undefined }));
      return false;
    } catch (error) {
      if (repoProjects(s, url).length) s.setLocal(`skillRepo:${url}`, JSON.stringify({ ...state, error: error instanceof Error ? error.message : String(error) }));
      throw error;
    }
  })().finally(() => flights!.delete(url));
  flights.set(url, work);
  return work;
}

export async function syncSkillRepos(s: Store, fetch: RepoFetcher = fetchRepo, signal?: AbortSignal) {
  for (const { url } of skillRepoSummaries(s)) {
    if (signal?.aborted) return;
    await syncSkillRepo(s, url, fetch, signal).catch(error => console.error(`skills: ${url}: ${error instanceof Error ? error.message : error}`));
  }
}
