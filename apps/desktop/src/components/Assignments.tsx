import { useState, type ReactNode } from "react";
import { Button } from "@heroui/react";
import { isVirtual, type Project, type ProjectChange, type ServerSummary, type Status } from "@agentgate/protocol";
import { getUniqueValues } from "hanzio";
import { Check, Empty, Modal } from "./ui.tsx";
import { repoClashes } from "../skill-assignment.ts";

function AssignmentChecks({
  title,
  name,
  choices,
}: {
  title: string;
  name: string;
  choices: { id: string; label?: string; detail?: string; selected: boolean }[];
}) {
  // What was chosen when the form opened, for AssignProjects. A row another machine adds later starts from it too.
  const [opened] = useState(() => choices.filter((c) => c.selected).map((c) => c.id));
  return (
    <fieldset className="checklist">
      <legend>{title}</legend>
      {opened.map((id) => (
        <input type="hidden" key={id} name={`${name}-opened`} value={id} />
      ))}
      <div className="rows">
        {choices.map((choice) => (
          <Check
            className="item"
            key={choice.id}
            name={name}
            value={choice.id}
            defaultSelected={opened.includes(choice.id)}
          >
            <span className="grow">
              <strong>{choice.label ?? choice.id}</strong>
              {choice.detail && <small>{choice.detail}</small>}
            </span>
          </Check>
        ))}
        {!choices.length && <Empty>Install a skill first.</Empty>}
      </div>
    </fieldset>
  );
}

/** A "Use in" dialog around `ProjectChecks` or `ServerProjectChecks`. `save` gets the projects added and removed since
 * it opened, so saving leaves alone a change another machine made meanwhile, and every project now chosen. */
export function AssignProjects({
  title,
  note = "Repositories appear here once a session starts in them, or after you add or scan them in Projects.",
  close,
  save,
  children,
}: {
  title: string;
  note?: string;
  close: () => void;
  save: (change: ProjectChange, chosen: string[]) => void;
  children: ReactNode;
}) {
  return (
    <Modal title={title} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const now = f.getAll("project") as string[],
            opened = f.getAll("project-opened") as string[];
          save({ add: now.filter((p) => !opened.includes(p)), remove: opened.filter((p) => !now.includes(p)) }, now);
        }}
      >
        {children}
        <p className="note">{note}</p>
        <Button type="submit" size="sm">
          Save
        </Button>
      </form>
    </Modal>
  );
}

/** `skills` are the skills being assigned; the every-session choice warns when a local repository has its own by that name. */
export function ProjectChecks({
  data,
  selected,
  skills = [],
}: {
  data: Status;
  selected: string[];
  skills?: string[];
}) {
  const clashes = repoClashes(data, skills);
  const names = getUniqueValues(clashes.map((c) => c.skill)).join(", "),
    projects = getUniqueValues(clashes.map((c) => c.project)).join(", ");
  return (
    <AssignmentChecks
      title="Use in"
      name="project"
      choices={[
        {
          id: "*",
          label: "Every session",
          selected: selected.includes("*"),
          detail: clashes.length
            ? `All repositories, on every machine. ${projects} has its own ${names}; Claude Code would run this one instead there.`
            : "All repositories, on every machine",
        },
        ...data.projects.filter((p) => p.id !== "*").map((p) => ({ id: p.id, selected: selected.includes(p.id) })),
      ]}
    />
  );
}

/** The tool prefix a project gives a server, if it uses it. */
export const aliasOf = (p: Pick<Project, "mcp">, server: string) =>
  Object.entries(p.mcp).find(([, id]) => id === server)?.[0];

/** Where a server is used, as the skills' "Use in" is. A per-session server starts in a session's worktree, which a
 * virtual project's remote client does not have. */
export function ServerProjectChecks({ data, server }: { data: Status; server: ServerSummary }) {
  const global = data.projects.find((p) => p.id === "*");
  const without = data.projects.filter((p) => p.id !== "*" && !isVirtual(p.id) && !p.inheritDefaults).length;
  return (
    <AssignmentChecks
      title="Use in"
      name="project"
      choices={[
        {
          id: "*",
          label: "Global defaults",
          selected: !!global && !!aliasOf(global, server.id),
          detail: `Every repository${without ? `, except ${without} that ${without === 1 ? "leaves" : "leave"} out global servers` : ""}`,
        },
        ...data.projects
          .filter((p) => p.id !== "*" && (server.mode === "shared" || !isVirtual(p.id)))
          .map((p) => {
            const alias = aliasOf(p, server.id);
            return {
              id: p.id,
              selected: !!alias,
              detail:
                alias && alias !== server.id ? `Tool prefix ${alias}` : isVirtual(p.id) ? "Virtual project" : undefined,
            };
          }),
      ]}
    />
  );
}
