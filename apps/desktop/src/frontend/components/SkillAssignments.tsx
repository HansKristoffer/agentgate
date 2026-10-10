import type { Status } from "@agentgate/protocol";
import { Check, Empty } from "./ui.tsx";
import { projectSkillChoices, repoClashes } from "../skill-assignment.ts";

function AssignmentChecks({ title, name, choices }: { title: string; name: string; choices: { id: string; label?: string; detail?: string; selected: boolean }[] }) {
  return <fieldset className="checklist">
    <legend>{title}</legend>
    <div className="rows">{choices.map(choice => <Check className="item" key={choice.id} name={name} value={choice.id} defaultSelected={choice.selected}>
      <span className="grow"><strong>{choice.label ?? choice.id}</strong>{choice.detail && <small>{choice.detail}</small>}</span>
    </Check>)}{!choices.length && <Empty>Install a skill first.</Empty>}</div>
  </fieldset>;
}

/** `skills` are the skills being assigned; the every-session choice warns when a local repository has its own by that name. */
export function ProjectChecks({ data, selected, skills = [] }: { data: Status; selected: string[]; skills?: string[] }) {
  const clashes = repoClashes(data, skills);
  const names = [...new Set(clashes.map(c => c.skill))].join(", "), projects = [...new Set(clashes.map(c => c.project))].join(", ");
  return <AssignmentChecks title="Use in" name="project" choices={[
    { id: "*", label: "Every session", selected: selected.includes("*"), detail: clashes.length
      ? `All repositories, on every machine. ${projects} has its own ${names}; Claude Code would run this one instead there.`
      : "All repositories, on every machine" },
    ...data.projects.filter(p => p.id !== "*").map(p => ({ id: p.id, selected: selected.includes(p.id) })),
  ]} />;
}

export function ProjectSkillChecks({ data, project, selected }: { data: Status; project: string; selected: string[] }) {
  return <AssignmentChecks title="Skills assigned to this project" name="skill" choices={projectSkillChoices(data, project, selected)} />;
}
