import type { Status } from "@agentgate/protocol";

export function projectSkillChoices(data: Pick<Status, "skills" | "projects" | "checkouts">, project: string, selected: string[]) {
  const global = new Set(project === "*" ? [] : data.projects.find(p => p.id === "*")?.skills ?? []);
  const repository = new Set(data.checkouts.filter(c => c.project.toLowerCase() === project.toLowerCase()).flatMap(c => c.skills));
  const ids = [...new Set([...data.skills.map(k => k.id), ...selected])];
  return ids.map(id => ({
    id, selected: selected.includes(id),
    detail: [global.has(id) ? "Also available in every session" : undefined, repository.has(id) ? "Also present in a local repository checkout" : undefined,
      !data.skills.some(k => k.id === id) ? "Unavailable in the synced catalog; uncheck to remove the assignment" : undefined].filter(Boolean).join(" · "),
  }));
}
