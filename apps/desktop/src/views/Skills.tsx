import { useState } from "react";
import { ArrowRight, Copy, FolderGit2, Plus, Sparkles } from "lucide-react";
import { confirmDialog } from "@hanskristoffer/taurio/runtime";
import {
  slugify,
  type SkillPreview,
  type SkillPreviewResponse,
  type SkillSearchResult,
  type Status,
} from "@agentgate/protocol";
import { Button, Input, Tabs, TextField, toast } from "@heroui/react";
import {
  Badge,
  Check,
  Empty,
  Field,
  Modal,
  Panel,
  HeaderActions,
  RowMenu,
} from "../components/ui.tsx";
import { ProjectChecks } from "../components/SkillAssignments.tsx";
import type { ViewProps } from "../types.ts";
import { request } from "../api.ts";
import { ago, field, idPath, confirmDelete } from "./utils.ts";

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
const places = (ids: string[]) =>
  ids.includes("*") ? "Every session" : ids.length ? ids.join(", ") : "Not linked to any project yet";
const where = (data: Status, id: string) =>
  places(data.projects.filter((p) => p.skills.includes(id)).map((p) => p.id));
type Editor = { id?: string; skillMd: string; revision?: string | null };
const repoName = (url: string) => url.replace("https://github.com/", "");
/** Where a skill came from: skills.sh installs are recorded as owner/repo, everything else by its repository or folder. */
const sourceLabel = (source?: string) => {
  if (!source) return "Hand-written";
  if (/^[\w.-]+\/[\w.-]+(@.+)?$/.test(source)) return "skills.sh";
  if (/^[/~.]/.test(source)) return "Local folder";
  return repoName(source).replace(/\.git$/, "");
};

export function Skills({ data, connection, perform }: ViewProps) {
  const [add, setAdd] = useState<"browse" | "source" | "repo" | "write">();
  const [results, setResults] = useState<SkillSearchResult[]>();
  const [preview, setPreview] = useState<{
    source: string;
    skill?: string;
    token: string;
    skills: SkillPreview[];
  }>();
  const [editor, setEditor] = useState<Editor>();
  const [skillName, setSkillName] = useState("");
  const [assign, setAssign] = useState<string>();
  const [repoAssign, setRepoAssign] = useState<string>();
  const fromRepo = (source?: string) => data.skillRepos.some((r) => r.url === source);
  const load = (source: string, skill?: string) =>
    perform(async () => {
      const fetched = await request<SkillPreviewResponse>(
        connection,
        "/skills/fetch",
        "POST",
        { source, skill },
      );
      setAdd(undefined);
      setPreview({ source, skill, ...fetched });
    });
  const editorForm = (draft: Editor) => (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const id = draft.id ?? slugify(skillName);
        let skillMd = String(f.get("skillMd") ?? "");
        // Agents read the name from the frontmatter, so a new skill's must match the slug it is saved under.
        if (!draft.id && skillMd.startsWith("---")) skillMd = skillMd.replace(/^name:.*$/m, `name: ${id}`);
        void perform(async () => {
          if (!id) throw new Error("Use at least one letter or digit in the name");
          if (!draft.id && data.skills.some((k) => k.id === id))
            throw new Error(`${id} already exists`);
          await request(connection, `/skills/${idPath(id)}`, "PUT", {
            skillMd,
            revision: draft.revision ?? null,
          });
          setEditor(undefined);
          setAdd(undefined);
          if (!draft.id) setAssign(id);
        }, "Skill saved");
      }}
    >
      {!draft.id && (
        <Field
          label="Name"
          isRequired
          value={skillName}
          onChange={setSkillName}
          placeholder="e.g. Release checklist"
          description={slugify(skillName) ? `Agents see it as ${slugify(skillName)}.` : "Any name. Agents see a short version of it."}
        />
      )}
      <Field
        multiline
        className="field skill-md"
        label="SKILL.md"
        name="skillMd"
        isRequired
        defaultValue={draft.skillMd}
      />
      <Button type="submit" size="sm">
        Save skill
      </Button>
    </form>
  );
  return (
    <>
      <HeaderActions>
        <Button
          size="sm"
          onPress={() => {
            setSkillName("");
            setAdd("browse");
          }}
        >
          <Plus size={15} />
          Add skills
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
              <div className="row group">
                {/* The copy button floats over the badge on hover, so it takes no room in the row. */}
                <span className="relative">
                  <strong>{skill.id}</strong>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="tertiary"
                    aria-label={`Copy ${skill.id}`}
                    className="absolute top-1/2 left-full z-10 ml-1.5 size-6 min-w-0 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onPress={() => void navigator.clipboard.writeText(skill.id).then(() => toast(`Copied ${skill.id}`))}
                  >
                    <Copy size={13} />
                  </Button>
                </span>
                <Badge good={!!skill.source}>{sourceLabel(skill.source)}</Badge>
              </div>
              {skill.description && <small>{short(skill.description)}</small>}
              <small>
                {where(data, skill.id)}
                {sourceLabel(skill.source) === "skills.sh" && ` · ${skill.source}`} · {size(skill.size)}
              </small>
            </div>
            <RowMenu
              label={`More for ${skill.id}`}
              items={[
                { label: "Choose projects", onAction: () => setAssign(skill.id) },
                // A skill with a source follows it; only hand-written skills can be edited.
                !skill.source && {
                  label: "Edit",
                  onAction: () =>
                    void perform(async () => {
                      const { skillMd, revision } = await request<{ skillMd: string; revision: string }>(
                        connection,
                        `/skills/${idPath(skill.id)}`,
                      );
                      setEditor({ id: skill.id, skillMd, revision });
                    }),
                },
                !!skill.source && {
                  label: "Update from source",
                  onAction: () =>
                    void perform(async () => {
                      const { updated } = await request<{ updated: boolean }>(
                        connection,
                        `/skills/${idPath(skill.id)}/update`,
                        "POST",
                      );
                      toast(updated ? `${skill.id} updated` : `${skill.id} is up to date`);
                    }),
                },
                !fromRepo(skill.source) && {
                  label: "Delete",
                  danger: true,
                  onAction: async () => {
                    if (await confirmDelete(skill.id))
                      void perform(
                        () => request(connection, `/skills/${idPath(skill.id)}`, "DELETE"),
                        "Skill deleted",
                      );
                  },
                },
              ]}
            />
          </div>
        ))}
      </Panel>
      {data.skillRepos.length > 0 && (
        <Panel
          title="GitHub repositories"
          detail="Every machine checks these for new commits every 10 minutes. New skills are used where the repository is connected, and skills removed from the repository are removed here."
        >
          {data.skillRepos.map((repo) => (
            <div className="item" key={repo.url}>
              <div className="machine-icon">
                <FolderGit2 size={16} />
              </div>
              <div className="grow">
                <div className="row">
                  <strong>{repoName(repo.url)}</strong>
                  {repo.error && <Badge>Sync failed</Badge>}
                </div>
                <small>
                  {places(repo.projects)} · {repo.skills.length} {repo.skills.length === 1 ? "skill" : "skills"} ·{" "}
                  {repo.syncedAt ? `checked ${ago(repo.syncedAt)}` : "not checked on this machine yet"}
                </small>
                {repo.error && <small className="danger">{repo.error}</small>}
                {repo.skipped.map((reason) => (
                  <small key={reason} className="danger">Skipped {reason}</small>
                ))}
              </div>
              <RowMenu
                label={`More for ${repoName(repo.url)}`}
                items={[
                  {
                    label: "Sync now",
                    onAction: () =>
                      void perform(async () => {
                        const { updated } = await request<{ updated: boolean }>(connection, "/skill-repos/sync", "POST", { url: repo.url });
                        toast(updated ? `${repoName(repo.url)} synced` : `${repoName(repo.url)} is up to date`);
                      }),
                  },
                  { label: "Choose projects", onAction: () => setRepoAssign(repo.url) },
                  {
                    label: "Disconnect",
                    danger: true,
                    onAction: async () => {
                      if (await confirmDialog(`Disconnect ${repoName(repo.url)}? Its skills are removed from every paired machine.`, { destructive: true, okLabel: "Disconnect" }))
                        void perform(
                          () => request(connection, "/skill-repos", "PUT", { url: repo.url, projects: [] }),
                          "Repository disconnected",
                        );
                    },
                  },
                ]}
              />
            </div>
          ))}
        </Panel>
      )}
      {(data.skillHealth.errors.length > 0 || data.skillConflicts.length > 0) && (
        <Panel title="Skills need attention" detail="Agentgate retries these automatically.">
          {data.skillHealth.errors.map((error, index) => <div className="item" key={`${error.path}:${index}`}>
            <span className="grow"><strong>{error.path}</strong><small className="danger">{error.message}</small></span>
          </div>)}
          {/* A folder we didn't create already holds a skill by this name, so we never overwrite it. */}
          {data.skillConflicts.map((path) => <div className="item" key={path}>
            <span className="grow"><strong>{path}</strong><small className="danger">Another skill with this name is already here, so Agentgate's copy isn't linked. Rename or remove one of them.</small></span>
          </div>)}
        </Panel>
      )}
      {add && (
        <Modal title="Add skills" close={() => setAdd(undefined)}>
          <Tabs className="segmented" selectedKey={add} onSelectionChange={(key) => setAdd(key as typeof add)}>
            <Tabs.ListContainer>
              <Tabs.List aria-label="Where the skills come from">
                {(
                  [
                    ["browse", "skills.sh"],
                    ["source", "Source"],
                    ["repo", "Synced repo"],
                    ["write", "Write"],
                  ] as const
                ).map(([id, label]) => (
                  <Tabs.Tab key={id} id={id}>
                    {label}
                    <Tabs.Indicator />
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
          {add === "browse" && (
            <>
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
            </>
          )}
          {add === "source" && (
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
          )}
          {add === "repo" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const projects = f.getAll("project") as string[];
                void perform(async () => {
                  if (!projects.length) throw new Error("Choose every session or at least one project");
                  await request(connection, "/skill-repos", "POST", { url: field(f, "url"), projects });
                  setAdd(undefined);
                }, "Repository connected");
              }}
            >
              <Field
                label="Repository"
                name="url"
                isRequired
                description="A public repository. Agentgate installs every skill in its .claude/skills and .agents/skills folders and keeps them in sync."
                placeholder="https://github.com/owner/repo"
              />
              <p className="note">
                Skills can run scripts in your sessions and are copied to every
                paired machine. New commits are installed automatically, so
                connect only repositories you trust.
              </p>
              <ProjectChecks data={data} selected={[]} />
              <Button type="submit" size="sm">
                <Plus size={15} />
                Connect
              </Button>
            </form>
          )}
          {add === "write" && editorForm({ skillMd: TEMPLATE })}
        </Modal>
      )}
      {repoAssign && (
        <Modal title={`Where ${repoName(repoAssign)} is used`} close={() => setRepoAssign(undefined)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const projects = new FormData(e.currentTarget).getAll("project") as string[];
              void perform(async () => {
                if (!projects.length) throw new Error("Choose at least one project, or disconnect the repository");
                await request(connection, "/skill-repos", "PUT", { url: repoAssign, projects });
                setRepoAssign(undefined);
              }, "Saved. New sessions pick it up.");
            }}
          >
            <ProjectChecks
              data={data}
              skills={data.skillRepos.find((r) => r.url === repoAssign)?.skills}
              selected={data.skillRepos.find((r) => r.url === repoAssign)?.projects ?? []}
            />
            <p className="note">
              All of the repository's skills are linked to the projects you add
              and unlinked from the ones you remove.
            </p>
            <Button type="submit" size="sm">
              Save
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
        <Modal title={`Edit ${editor.id}`} close={() => setEditor(undefined)}>
          {editorForm(editor)}
        </Modal>
      )}
    </>
  );
}
