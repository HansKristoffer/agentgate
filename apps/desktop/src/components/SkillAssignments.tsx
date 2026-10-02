import type { Status } from "@agentgate/protocol";
import { Check, Empty } from "./ui.tsx";
import { projectSkillChoices } from "../skill-assignment.ts";

function AssignmentChecks({ title, name, choices }: { title: string; name: string; choices: { id: string; label?: string; detail?: string; selected: boolean }[] }) {
  return <fieldset className="checklist">
    <legend>{title}</legend>
    <div className="rows">{choices.map(choice => <Check className="item" key={choice.id} name={name} value={choice.id} defaultSelected={choice.selected}>
      <span className="grow"><strong>{choice.label ?? choice.id}</strong>{choice.detail && <small>{choice.detail}</small>}</span>
    </Check>)}{!choices.length && <Empty>Install a skill first.</Empty>}</div>
  </fieldset>;
}

export function ProjectChecks({ data, selected }: { data: Status; selected: string[] }) {
  return <AssignmentChecks title="Use in" name="project" choices={[
    { id: "*", label: "Every session", detail: "All repositories, on every machine", selected: selected.includes("*") },
    ...data.projects.filter(p => p.id !== "*").map(p => ({ id: p.id, selected: selected.includes(p.id) })),
  ]} />;
}

export function ProjectSkillChecks({ data, project, selected }: { data: Status; project: string; selected: string[] }) {
  return <AssignmentChecks title="Skills assigned to this project" name="skill" choices={projectSkillChoices(data, project, selected)} />;
}
