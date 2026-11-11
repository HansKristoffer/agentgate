import { useState } from "react";
import { Boxes, Sparkles } from "lucide-react";
import { isVirtual, type Project, type Status } from "@agentgate/protocol";
import type { ControlOps } from "@agentgate/protocol/control";
import { Button, Input, TextField } from "@heroui/react";
import { Check, Empty, Field, Segmented, Toggle } from "./ui.tsx";
import { aliasOf } from "./Assignments.tsx";
import { projectSkillChoices } from "../skill-assignment.ts";

/** `revision` is the saved project's as status showed it when the form opened; a new project has none. */
export type Editing = Pick<Project, "id" | "mcp" | "skills" | "inheritDefaults"> & {
  virtual?: boolean;
  revision?: string;
};
type Row = { id: string; label: string; detail?: string; dot?: string };

/** A project's servers and skills, on two tabs. The choices are held here rather than in the form's inputs, so
 * searching or switching tabs never drops one. */
export function ProjectForm({
  data,
  edit,
  picked,
  save,
}: {
  data: Status;
  edit: Editing;
  /** A repository chosen with Find on this machine. */
  picked: string;
  save: (project: ControlOps["project set"]["input"]) => void;
}) {
  const virtual = edit.virtual || isVirtual(edit.id);
  const repository = edit.id !== "*" && !virtual;
  // The project the choices start from. Reload moves it to the saved project another machine changed.
  const [base, setBase] = useState(edit);
  const [servers, setServers] = useState(() => new Set(Object.values(edit.mcp)));
  const [skills, setSkills] = useState(() => new Set(edit.skills));
  const [inherit, setInherit] = useState(edit.inheritDefaults);
  const saved = edit.id ? data.projects.find((p) => p.id === edit.id) : undefined;
  const reload = (latest: Editing) => {
    setBase(latest);
    setServers(new Set(Object.values(latest.mcp)));
    setSkills(new Set(latest.skills));
    setInherit(latest.inheritDefaults);
  };
  const [tab, setTab] = useState<"servers" | "skills">("servers");
  const [query, setQuery] = useState("");
  const global = data.projects.find((p) => p.id === "*");
  const globalServers = new Set(repository ? Object.values(global?.mcp ?? {}) : []);
  const name = (id: string) => data.servers.find((s) => s.id === id)?.label ?? id;

  // Per-session servers start inside a worktree, which a remote client doesn't have. Servers the project already has lead.
  const serverRows: Row[] = data.servers
    .filter((s) => !virtual || s.mode === "shared")
    .toSorted((a, b) => Number(!aliasOf(base, a.id)) - Number(!aliasOf(base, b.id)))
    .map((s) => {
      const alias = aliasOf(base, s.id);
      return {
        id: s.id,
        label: s.label ?? s.id,
        dot: s.available === true ? "online" : s.available === false ? "offline" : "",
        detail: [
          alias && alias !== s.id && `Tool prefix ${alias}`,
          inherit && globalServers.has(s.id) && "Already included from Global defaults",
        ]
          .filter(Boolean)
          .join(" · "),
      };
    });
  const skillChoices = projectSkillChoices(data, edit.id, base.skills);
  const folded = skillChoices.filter((c) => c.redundant).map((c) => c.id);
  const skillRows: Row[] = skillChoices
    .filter((c) => !c.redundant)
    .map((c) => ({ id: c.id, label: c.id, detail: c.detail }));

  const [rows, chosen, setChosen] =
    tab === "servers" ? ([serverRows, servers, setServers] as const) : ([skillRows, skills, setSkills] as const);
  const needle = query.trim().toLowerCase();
  const shown = rows.filter((r) => `${r.label} ${r.id}`.toLowerCase().includes(needle));
  const toggle = (id: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <form
      className="project-form"
      onSubmit={(e) => {
        e.preventDefault();
        const typed = String(new FormData(e.currentTarget).get("id") ?? "").trim();
        // Keep an existing custom alias; new picks use the server id. The operation changes only the prefixes it is
        // given, so each one the form started with and dropped is removed by name.
        const mcp: Record<string, string | null> = Object.fromEntries(
          Object.keys(base.mcp).map((alias) => [alias, null]),
        );
        for (const id of servers) if (serverRows.some((r) => r.id === id)) mcp[aliasOf(base, id) ?? id] = id;
        save({
          id: edit.id || (virtual ? `@${typed}` : typed),
          mcp,
          skills: [...skills],
          inheritDefaults: !virtual && (edit.id === "*" || inherit),
          revision: base.revision,
        });
      }}
    >
      {saved && base.revision && saved.revision !== base.revision && (
        <div className="item" role="status">
          <span className="grow">
            <strong>Project changed elsewhere</strong>
            <small>
              Saving is refused until you reload, which starts from the latest and drops your unsaved choices.
            </small>
          </span>
          <Button variant="tertiary" size="sm" onPress={() => reload(saved)}>
            Reload
          </Button>
        </div>
      )}
      {!edit.id &&
        (virtual ? (
          <Field
            label="Name"
            description="Lowercase letters, digits and dashes."
            name="id"
            isRequired
            pattern="[a-z0-9][a-z0-9\-]{0,63}"
            placeholder="grok"
          />
        ) : (
          <Field
            label="Repository"
            name="id"
            isRequired
            key={picked}
            defaultValue={picked}
            pattern="[^\/\s@][^\/\s]*\/[^\/\s]+"
            placeholder="owner/repo"
          />
        ))}
      {repository && (
        <div className="rows">
          <Toggle
            label="Include global MCP servers"
            description={
              globalServers.size ? [...globalServers].map(name).join(", ") : "Global defaults has no MCP servers yet"
            }
            isSelected={inherit}
            onChange={setInherit}
          />
        </div>
      )}
      <Segmented
        label="Tools"
        value={tab}
        onChange={(id) => {
          setTab(id);
          setQuery("");
        }}
        options={[
          {
            id: "servers",
            label: (
              <>
                <Boxes size={14} />
                MCP servers{servers.size ? ` · ${servers.size}` : ""}
              </>
            ),
          },
          {
            id: "skills",
            label: (
              <>
                <Sparkles size={14} />
                Skills{skills.size ? ` · ${skills.size}` : ""}
              </>
            ),
          },
        ]}
      />
      {rows.length > 6 && (
        <TextField aria-label="Search" value={query} onChange={setQuery} className="field">
          <Input type="search" placeholder={`Search ${rows.length} ${tab === "servers" ? "servers" : "skills"}`} />
        </TextField>
      )}
      <div className="rows picker">
        {shown.map((r) => (
          <Check className="item" key={r.id} isSelected={chosen.has(r.id)} onChange={(on) => toggle(r.id, on)}>
            {r.dot !== undefined && <span className={`dot ${r.dot}`} />}
            <span className="grow">
              <strong>{r.label}</strong>
              {r.detail && <small>{r.detail}</small>}
            </span>
          </Check>
        ))}
        {!shown.length && (
          <Empty>
            {needle
              ? `Nothing matches "${query}".`
              : tab === "servers"
                ? "Connect a server first."
                : folded.length
                  ? "Every skill is already in every session."
                  : "Install a skill first."}
          </Empty>
        )}
      </div>
      {tab === "skills" && folded.length > 0 && (
        <p className="note">Already in every session, so not listed: {folded.join(", ")}.</p>
      )}
      <Button type="submit" size="sm">
        Save project
      </Button>
    </form>
  );
}
