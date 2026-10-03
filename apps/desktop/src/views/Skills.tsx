import { useState } from "react";
import { ArrowRight, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import type {
  SkillPreview,
  SkillPreviewResponse,
  SkillSearchResult,
  Status,
} from "@agentgate/protocol";
import { Button, Input, TextField, toast } from "@heroui/react";
import {
  Badge,
  Check,
  Empty,
  Field,
  Modal,
  Panel,
  HeaderActions,
} from "../components/ui.tsx";
import { ProjectChecks } from "../components/SkillAssignments.tsx";
import { repoClashes } from "../skill-assignment.ts";
import type { ViewProps } from "../types.ts";
import { request } from "../api.ts";
import { field, idPath, confirmDelete } from "./utils.ts";

const TEMPLATE = `---
name: my-skill
description: What this skill does, and when the agent should use it.
---

Instructions for the agent.
`;
const short = (text: string, max = 180) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
const where = (data: Status, id: string) => {
  const ids = data.projects.filter((p) => p.skills.includes(id)).map((p) => p.id);
  if (ids.includes("*")) return "Every session";
  return ids.length ? ids.join(", ") : "Not linked to any project yet";
};

export function Skills({ data, connection, perform }: ViewProps) {
  const [browse, setBrowse] = useState(false);
  const [results, setResults] = useState<SkillSearchResult[]>();
  const [addSource, setAddSource] = useState(false);
  const [preview, setPreview] = useState<{
    source: string;
    skill?: string;
    token: string;
    skills: SkillPreview[];
  }>();
  const [editor, setEditor] = useState<{ id?: string; skillMd: string; revision?: string | null }>();
  const [assign, setAssign] = useState<string>();
  const hidden = repoClashes(data, data.projects.find((p) => p.id === "*")?.skills ?? []);
  const load = (source: string, skill?: string) =>
    perform(async () => {
      const fetched = await request<SkillPreviewResponse>(
        connection,
        "/skills/fetch",
        "POST",
        { source, skill },
      );
      setBrowse(false);
      setAddSource(false);
      setPreview({ source, skill, ...fetched });
    });
  return (
    <>
      <HeaderActions>
        <Button size="sm" variant="tertiary" onPress={() => setEditor({ skillMd: TEMPLATE })}>
          New skill
        </Button>
        <Button size="sm" variant="tertiary" onPress={() => setAddSource(true)}>
          Add from source
        </Button>
        <Button size="sm" onPress={() => setBrowse(true)}>
          <Search size={15} />
          Browse skills.sh
        </Button>
      </HeaderActions>
      <Panel
        foot={`Project skills are linked into ${data.checkouts.length} local ${data.checkouts.length === 1 ? "checkout" : "checkouts"} on this machine. A repository is added when a session starts in it, or when you scan a folder in Projects. New sessions pick up changes.`}
      >
        {!data.skills.length && (
          <Empty>
            <Sparkles size={22} />
            <strong>Install your first skill.</strong>
            <p>
              Browse skills.sh, add one from a GitHub repository or folder, or
              write your own. Then choose which projects use it.
            </p>
          </Empty>
        )}
        {data.skills.map((skill) => (
          <div className="item" key={skill.id}>
            <div className="machine-icon">
              <Sparkles size={16} />
            </div>
            <div className="grow">
              <div className="row">
                <strong>{skill.id}</strong>
                <Badge good={!!skill.source}>
                  {skill.source ? "Installed" : "Hand-written"}
                </Badge>
              </div>
              {skill.description && <small>{short(skill.description)}</small>}
              <small>
                {where(data, skill.id)}
                {skill.source && ` · ${skill.source}`} · {size(skill.size)}
              </small>
            </div>
            <Button size="sm" variant="ghost" onPress={() => setAssign(skill.id)}>
              Projects
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onPress={() =>
                void perform(async () => {
                  const { skillMd, revision } = await request<{ skillMd: string; revision: string }>(
                    connection,
                    `/skills/${idPath(skill.id)}`,
                  );
                  setEditor({ id: skill.id, skillMd, revision });
                })
              }
            >
              Edit
            </Button>
            {skill.source && (
              <Button
                size="sm"
                variant="ghost"
                onPress={() =>
                  void perform(async () => {
                    const { updated } = await request<{ updated: boolean }>(
                      connection,
                      `/skills/${idPath(skill.id)}/update`,
                      "POST",
                    );
                    toast(updated ? `${skill.id} updated` : `${skill.id} is up to date`);
                  })
                }
              >
                Update
              </Button>
            )}
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              className="delete"
              aria-label={`Delete ${skill.id}`}
              onPress={async () => {
                if (await confirmDelete(skill.id))
                  void perform(
                    () => request(connection, `/skills/${idPath(skill.id)}`, "DELETE"),
                    "Skill deleted",
                  );
              }}
            >
              <Trash2 size={15} />
            </Button>
          </div>
        ))}
      </Panel>
      {data.skillHealth.errors.length > 0 && (
        <Panel title="Skills need attention" detail="Some changes are saved but could not be applied on this machine. Agentgate retries automatically.">
          {data.skillHealth.errors.map((error, index) => <div className="item" key={`${error.path}:${index}`}>
            <span className="grow"><strong>{error.path}</strong><small className="danger">{error.message}</small></span>
          </div>)}
        </Panel>
      )}
      {hidden.length > 0 && (
        <Panel
          title="Repository skills hidden by every-session skills"
          detail="These repositories have their own skill with the same name as one used in every session. Claude Code runs the every-session skill there; Codex lists both. To let a repository's own skill win, use the skill in specific projects instead."
        >
          {hidden.map((c) => (
            <div className="item" key={`${c.skill}:${c.path}`}>
              <span className="grow">
                <strong>{c.skill}</strong>
                <small>{c.project} · {c.path}</small>
              </span>
              <Button size="sm" variant="tertiary" onPress={() => setAssign(c.skill)}>
                Change where it's used
              </Button>
            </div>
          ))}
        </Panel>
      )}
      {data.skillConflicts.length > 0 && (
        <Panel
          title="Skipped links"
          detail="These folders already hold a skill with the same name that Agentgate did not create, so it left them alone. Rename or remove one of them."
        >
          {data.skillConflicts.map((path) => (
            <div className="item" key={path}>
              <small className="grow danger">{path}</small>
            </div>
          ))}
        </Panel>
      )}
      {browse && (
        <Modal title="Browse skills.sh" close={() => setBrowse(false)}>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const q = field(new FormData(e.currentTarget), "q");
              void perform(async () =>
                setResults(
                  await request<SkillSearchResult[]>(
                    connection,
                    `/skills/search?q=${encodeURIComponent(q)}`,
                  ),
                ),
              );
            }}
          >
            <TextField name="q" isRequired minLength={2} aria-label="Search skills" className="grow">
              <Input placeholder="react, testing, postgres…" />
            </TextField>
            <Button type="submit" size="sm" variant="tertiary">
              Search
            </Button>
          </form>
          {results && (
            <div className="tool-list">
              {results.length ? (
                results.map((r) => (
                  <div key={`${r.source}@${r.skill}`} className="row">
                    <span className="grow">
                      <code>{r.skill}</code>
                      <p>
                        {r.source} · {r.installs.toLocaleString()} installs
                        {data.skills.some((k) => k.id === r.skill) && " · installed"}
                      </p>
                    </span>
                    <Button size="sm" variant="ghost" onPress={() => void load(r.source, r.skill)}>
                      Preview
                    </Button>
                  </div>
                ))
              ) : (
                <Empty>No skills found.</Empty>
              )}
            </div>
          )}
        </Modal>
      )}
      {addSource && (
        <Modal title="Add skills from a source" close={() => setAddSource(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void load(field(new FormData(e.currentTarget), "source"));
            }}
          >
            <Field
              label="Source"
              name="source"
              isRequired
              description="A GitHub owner/repo (optionally @skill), a Git or GitHub URL, or a folder on the daemon's machine. Fetched with npx skills."
              placeholder="vercel-labs/agent-skills"
            />
            <Button type="submit" size="sm">
              Find skills
              <ArrowRight size={15} />
            </Button>
          </form>
        </Modal>
      )}
      {preview && (
        <Modal title={preview.source} close={() => setPreview(undefined)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const ids = f.getAll("skill") as string[];
              void perform(async () => {
                if (!ids.length) throw new Error("Choose at least one skill");
                await request(connection, "/skills", "POST", {
                  token: preview.token,
                  ids,
                  projects: f.getAll("project") as string[],
                });
                setPreview(undefined);
              }, ids.length === 1 ? "Skill installed" : `${ids.length} skills installed`);
            }}
          >
            <p className="note">
              Skills can run scripts in your sessions and are copied to every
              paired machine. Install only sources you trust.
            </p>
            <fieldset className="checklist">
              <legend>Skills</legend>
              <div className="rows">
                {preview.skills.map((k) => (
                  <Check
                    className="item"
                    key={k.id}
                    name="skill"
                    value={k.id}
                    isDisabled={!!k.conflict}
                    defaultSelected={!k.conflict && (preview.skills.length === 1 || !k.installed)}
                  >
                    <span className="grow">
                      <span className="row">
                        <strong>{k.id}</strong>
                        {k.installed && <Badge>{k.conflict ?? "Installed · updates it"}</Badge>}
                        {k.security &&
                          Object.entries(k.security)
                            .filter(([key]) => key !== "details")
                            .map(([key, value]) => (
                              <Badge key={key} good={/^(safe|low|0 alerts)$/i.test(value)}>
                                {key}: {value}
                              </Badge>
                            ))}
                      </span>
                      {k.description && <small>{short(k.description)}</small>}
                      <small>
                        {k.files} {k.files === 1 ? "file" : "files"} · {size(k.size)}
                      </small>
                    </span>
                  </Check>
                ))}
              </div>
            </fieldset>
            <ProjectChecks data={data} selected={[]} skills={preview.skills.map((k) => k.id)} />
            <Button type="submit" size="sm">
              <Plus size={15} />
              Install
            </Button>
          </form>
        </Modal>
      )}
      {assign && (
        <Modal title={`Where ${assign} is used`} close={() => setAssign(undefined)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const projects = new FormData(e.currentTarget).getAll("project") as string[];
              void perform(async () => {
                await request(connection, `/skills/${idPath(assign)}/projects`, "PUT", { projects });
                setAssign(undefined);
              }, "Saved. New sessions pick it up.");
            }}
          >
            <ProjectChecks
              data={data}
              skills={[assign]}
              selected={data.projects.filter((p) => p.skills.includes(assign)).map((p) => p.id)}
            />
            <p className="note">
              Repositories appear here once a session starts in them, or after
              you add or scan them in Projects.
            </p>
            <Button type="submit" size="sm">
              Save
            </Button>
          </form>
        </Modal>
      )}
      {editor && (
        <Modal title={editor.id ? `Edit ${editor.id}` : "New skill"} close={() => setEditor(undefined)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const id = editor.id ?? field(f, "id");
              void perform(async () => {
                if (!editor.id && data.skills.some((k) => k.id === id))
                  throw new Error(`${id} already exists`);
                await request(connection, `/skills/${idPath(id)}`, "PUT", {
                  skillMd: String(f.get("skillMd") ?? ""),
                  revision: editor.revision ?? null,
                });
                setEditor(undefined);
                if (!editor.id) setAssign(id);
              }, "Skill saved");
            }}
          >
            {!editor.id && (
              <Field
                label="Name"
                name="id"
                isRequired
                pattern="[a-z0-9][a-z0-9._\-]*"
                placeholder="my-skill"
                description="Lowercase letters, digits, dots, dashes and underscores. Use the same name in the frontmatter."
              />
            )}
            <Field
              multiline
              className="field skill-md"
              label="SKILL.md"
              name="skillMd"
              isRequired
              defaultValue={editor.skillMd}
            />
            {editor.id && data.skills.find((k) => k.id === editor.id)?.source && (
              <p className="note">
                Updating from the source replaces your edits.
              </p>
            )}
            <Button type="submit" size="sm">
              Save skill
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
