import { useState } from "react";
import { Boxes, Sparkles } from "lucide-react";
import { isVirtual, type Project, type Status } from "@agentgate/protocol";
import { Button, Input, Tabs, TextField } from "@heroui/react";
import { Check, Empty, Field, Toggle } from "./ui.tsx";
import { aliasOf } from "./Assignments.tsx";
import { projectSkillChoices } from "../skill-assignment.ts";

export type Editing = Pick<Project, "id" | "mcp" | "skills" | "inheritDefaults"> & { virtual?: boolean };
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
  save: (project: Editing) => void;
}) {
  const virtual = edit.virtual || isVirtual(edit.id);
  const repository = edit.id !== "*" && !virtual;
  const [servers, setServers] = useState(() => new Set(Object.values(edit.mcp)));
  const [skills, setSkills] = useState(() => new Set(edit.skills));
  const [inherit, setInherit] = useState(edit.inheritDefaults);
  const [tab, setTab] = useState<"servers" | "skills">("servers");
  const [query, setQuery] = useState("");
  const global = data.projects.find((p) => p.id === "*");
  const globalServers = new Set(repository ? Object.values(global?.mcp ?? {}) : []);
  const name = (id: string) => data.servers.find((s) => s.id === id)?.label ?? id;

  // Per-session servers start inside a worktree, which a remote client doesn't have. Servers the project already has lead.
  const serverRows: Row[] = data.servers
    .filter((s) => !virtual || s.mode === "shared")
    .toSorted((a, b) => Number(!aliasOf(edit, a.id)) - Number(!aliasOf(edit, b.id)))
    .map((s) => {
      const alias = aliasOf(edit, s.id);
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
  const skillChoices = projectSkillChoices(data, edit.id, edit.skills);
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
        // Keep an existing custom alias; new picks use the server id.
        const mcp: Record<string, string> = {};
        for (const id of servers) if (serverRows.some((r) => r.id === id)) mcp[aliasOf(edit, id) ?? id] = id;
        save({
          id: edit.id || (virtual ? `@${typed}` : typed),
          mcp,
          skills: [...skills],
          inheritDefaults: !virtual && (edit.id === "*" || inherit),
        });
      }}
    >
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
      <Tabs
        className="segmented"
        selectedKey={tab}
        onSelectionChange={(key) => {
          setTab(key as typeof tab);
          setQuery("");
        }}
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="Tools">
            <Tabs.Tab id="servers">
              <Boxes size={14} />
              MCP servers{servers.size ? ` · ${servers.size}` : ""}
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="skills">
              <Sparkles size={14} />
              Skills{skills.size ? ` · ${skills.size}` : ""}
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>
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
