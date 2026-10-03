import type { Status } from "@agentgate/protocol";

export function projectSkillChoices(data: Pick<Status, "skills" | "projects" | "checkouts">, project: string, selected: string[]) {
  const global = new Set(project === "*" ? [] : data.projects.find(p => p.id === "*")?.skills ?? []);
  const repository = new Set(data.checkouts.filter(c => project === "*" || c.project.toLowerCase() === project.toLowerCase()).flatMap(c => c.skills));
  const ids = [...new Set([...data.skills.map(k => k.id), ...selected])];
  return ids.map(id => ({
    id, selected: selected.includes(id),
    detail: [global.has(id) ? "Also available in every session" : undefined, repository.has(id) ? project === "*" ? "A local repository has its own skill with this name; Claude Code runs this one instead" : "Also present in a local repository checkout" : undefined,
      !data.skills.some(k => k.id === id) ? "Unavailable in the synced catalog; uncheck to remove the assignment" : undefined].filter(Boolean).join(" · "),
  }));
}

/** Local checkouts that carry their own skill under one of these names. A skill for every session is
 * linked into ~/.claude/skills, and Claude Code ranks personal skills above project ones, so ours wins there. */
export function repoClashes(data: Pick<Status, "checkouts">, ids: string[]) {
  return data.checkouts.flatMap(c => c.skills.filter(id => ids.includes(id)).map(skill => ({ skill, path: c.path, project: c.project })));
}
