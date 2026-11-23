import { useMemo, useState } from "react";
import { Bot, Boxes, FileKey, FolderGit2, FolderOpen, Globe, Pencil, Plus, Sparkles } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { isVirtual, type PublicProject, type ToolPreview } from "@agentgate/protocol";
import { Button, Input, TextField } from "@heroui/react";
import { Badge, Empty, Field, Modal, Panel, HeaderActions, RowMenu, Segmented } from "../components/ui.tsx";
import { ProjectForm, type Editing } from "../components/ProjectForm.tsx";
import type { ViewProps } from "../types.ts";
import { control, openExternal, request } from "../api.ts";
import { ago, idPath, confirmDelete } from "./utils.ts";
import { EndpointDetails } from "./RemoteEndpoint.tsx";

const FILES_GUIDE = "https://github.com/HansKristoffer/agentgate#env-files-between-machines";

export function Projects(props: ViewProps) {
  const { data, connection, perform, local } = props;
  const [edit, setEdit] = useState<Editing>();
  const [repos, setRepos] = useState<{ repo: string; path: string }[]>();
  const [dir, setDir] = useState("~/Documents/GitHub");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  // Adding a repository project: type owner/repo, or find it among this machine's checkouts.
  const [find, setFind] = useState(false);
  const [picked, setPicked] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = (repos ?? []).filter((r) => `${r.repo} ${r.path}`.toLowerCase().includes(needle));
  const scan = (folder: string) =>
    perform(async () => {
      const result = await control(connection, "project scan", { dir: folder });
      setRepos(result.repos);
      setQuery("");
    });
  const [tools, setTools] = useState<ToolPreview[]>();
  /** The project whose env files are open. */
  const [files, setFiles] = useState<string>();
  const filesOf = (id: string) => data.projects.find((p) => p.id === id)?.files ?? [];
  /** The env file whose contents are open for editing, with the text this machine's store has. */
  const [fileEdit, setFileEdit] = useState<{ path: string; content: string; sha256: string }>();
  const fileUrl = (project: string, path: string) =>
    `/projects/files/content?id=${idPath(project)}&path=${encodeURIComponent(path)}`;
  const editFile = (project: string, path: string) =>
    void perform(async () =>
      setFileEdit({
        path,
        ...(await request<{ content: string; sha256: string }>(connection, fileUrl(project, path))),
      }),
    );
  const addFile = (project: string) =>
    void (async () => {
      const checkout = data.checkouts.find((c) => c.project.toLowerCase() === project.toLowerCase())?.path;
      const path = await open({ title: `Choose a gitignored file in a checkout of ${project}`, defaultPath: checkout });
      if (typeof path === "string")
        await perform(
          () => control(connection, "project files add", { project, paths: [path] }),
          "File saved for every machine",
        );
    })();
  const defaults = data.projects.find((p) => p.id === "*");
  const repositories = data.projects.filter((p) => p.id !== "*" && !isVirtual(p.id));
  const virtualProjects = data.projects.filter((p) => isVirtual(p.id));
  const filterNeedle = filter.trim().toLowerCase();
  const shownRepos = filterNeedle
    ? repositories.filter((p) => p.id.toLowerCase().includes(filterNeedle))
    : repositories;
  const serverNames = useMemo(() => new Map(data.servers.map((s) => [s.id, s.label ?? s.id])), [data.servers]);
  const serverName = (id: string) => serverNames.get(id) ?? id;
  /** Links a repository's own skills between .claude/skills and .agents/skills, so Claude and Codex both see them.
   * Local only: it writes into this machine's checkouts of the repository. */
  const mirrorItem = (id: string) => {
    const mine = data.checkouts.filter((c) => c.project.toLowerCase() === id.toLowerCase());
    if (!local || !mine.length) return false;

    const on = mine.some((c) => c.mirror);
    return {
      label: on ? "Stop sharing repo skills between Claude and Codex" : "Share repo skills between Claude and Codex",
      onAction: () =>
        void perform(
          () => control(connection, "project mirroring", { project: id, on: !on }),
          on ? "Repository skills no longer shared" : "Repository skills shared between Claude and Codex",
        ),
    };
  };
  return (
    <>
      <HeaderActions>
        <Button
          size="sm"
          onPress={() => {
            setFind(false);
            setPicked("");
            setEdit({ id: "", mcp: {}, skills: [], inheritDefaults: true });
          }}
        >
          <Plus size={15} />
          Add project
        </Button>
      </HeaderActions>
      <Panel
        title="Repositories"
        detail="Each repository's MCP servers and skills. Changes reach running sessions automatically"
      >
        {repositories.length > 6 && (
          <div className="item">
            <TextField aria-label="Search repositories" value={filter} onChange={setFilter} className="field grow">
              <Input type="search" placeholder={`Search ${repositories.length} repositories`} />
            </TextField>
          </div>
        )}
        {!filterNeedle && (
          <div className="item">
            <div className="machine-icon">
              <Globe size={16} />
            </div>
            <div className="grow">
              <strong>Global defaults</strong>
              <small>Servers every repository includes unless opted out, and skills for every session.</small>
              <Uses project={defaults} servers={serverName} />
            </div>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label="Edit Global defaults"
              onPress={() => setEdit(defaults ?? { id: "*", mcp: {}, skills: [], inheritDefaults: true })}
            >
              <Pencil size={15} />
            </Button>
          </div>
        )}
        {shownRepos.map((p) => (
          <div className="item" key={p.id}>
            <div className="machine-icon">
              <FolderGit2 size={16} />
            </div>
            <div className="grow">
              <div className="row">
                <strong>{p.id}</strong>
                {!p.inheritDefaults && <Badge>Without global servers</Badge>}
              </div>
              <Uses project={p} servers={serverName} />
              {p.files?.length ? (
                <small>
                  {p.files.length === 1 ? "Env file" : "Env files"} {p.files.map((f) => f.path).join(", ")}
                </small>
              ) : null}
              {data.fileErrors[p.id] && (
                <small className="danger">Env files not syncing: {data.fileErrors[p.id]}</small>
              )}
            </div>
            <Button isIconOnly size="sm" variant="ghost" aria-label={`Edit ${p.id}`} onPress={() => setEdit(p)}>
              <Pencil size={15} />
            </Button>
            <RowMenu
              label={`More for ${p.id}`}
              items={[
                {
                  label: "Preview tools",
                  onAction: () =>
                    void perform(async () => setTools(await control(connection, "project tools", { id: p.id }))),
                },
                { label: "Env files", onAction: () => setFiles(p.id) },
                mirrorItem(p.id),
                {
                  label: "Delete",
                  danger: true,
                  onAction: async () => {
                    if (await confirmDelete(p.id))
                      void perform(() => control(connection, "project rm", { id: p.id }), "Project removed");
                  },
                },
              ]}
            />
          </div>
        ))}
        {filterNeedle && !shownRepos.length && <Empty>Nothing matches "{filter}".</Empty>}
        {!repositories.length && (
          <Empty>
            <FolderGit2 size={22} />
            <strong>Give your repositories their own tools</strong>
            <p>
              Add owner/repo identifiers, or scan a local folder. Sessions also discover repositories automatically.
            </p>
          </Empty>
        )}
      </Panel>
      <Panel
        title="Virtual projects"
        detail="Expose a set of MCP servers and skills at a secret URL for remote clients like Grok"
        action={
          <Button
            size="sm"
            variant="tertiary"
            onPress={() => setEdit({ id: "", mcp: {}, skills: [], inheritDefaults: false, virtual: true })}
          >
            <Plus size={14} />
            New virtual project
          </Button>
        }
      >
        {virtualProjects.length ? (
          virtualProjects.map((p) => (
            <div className="item stack virtual-project" key={p.id}>
              <div className="item">
                <div className="machine-icon">
                  <Bot size={16} />
                </div>
                <div className="grow">
                  <strong>{p.id}</strong>
                  <Uses project={p} servers={serverName} />
                </div>
                <Button isIconOnly size="sm" variant="ghost" aria-label={`Edit ${p.id}`} onPress={() => setEdit(p)}>
                  <Pencil size={15} />
                </Button>
                <RowMenu
                  label={`More for ${p.id}`}
                  items={[
                    {
                      label: "Delete",
                      danger: true,
                      onAction: async () => {
                        if (await confirmDelete(p.id))
                          void perform(
                            () => control(connection, "project rm", { id: p.id }),
                            "Virtual project removed",
                          );
                      },
                    },
                  ]}
                />
              </div>
              <EndpointDetails {...props} project={p} />
            </div>
          ))
        ) : (
          <Empty>
            <Bot size={22} />
            <strong>Use your MCP servers and skills in Grok</strong>
            <p>Create a virtual project, pick its servers and skills, then paste its URL and secret into Grok.</p>
          </Empty>
        )}
      </Panel>
      {edit && (
        <Modal
          title={
            edit.id === "*" ? "Global defaults" : edit.id || (edit.virtual ? "New virtual project" : "Add project")
          }
          size="lg"
          close={() => setEdit(undefined)}
        >
          {local && !edit.id && !edit.virtual && (
            <Segmented
              label="How to choose the repository"
              value={find ? "find" : "type"}
              onChange={(id) => setFind(id === "find")}
              options={[
                { id: "type", label: "Repository" },
                { id: "find", label: "Find on this machine" },
              ]}
            />
          )}
          {find && !edit.id ? (
            <>
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void scan(dir);
                }}
              >
                <TextField
                  name="dir"
                  isRequired
                  aria-label="Folder of repositories"
                  value={dir}
                  onChange={setDir}
                  className="grow"
                >
                  <Input />
                </TextField>
                <Button
                  isIconOnly
                  size="sm"
                  variant="tertiary"
                  aria-label="Choose folder"
                  onPress={() =>
                    void (async () => {
                      const path = await open({ directory: true, title: "Choose a folder of repositories" });
                      if (typeof path === "string") {
                        setDir(path);
                        await scan(path);
                      }
                    })()
                  }
                >
                  <FolderOpen size={15} />
                </Button>
                <Button type="submit" size="sm" variant="tertiary">
                  Scan
                </Button>
              </form>
              {repos && repos.length > 0 && (
                <TextField aria-label="Search repositories" value={query} onChange={setQuery} className="field">
                  <Input type="search" placeholder={`Search ${repos.length} repositories`} />
                </TextField>
              )}
              {repos && (
                <div className="tool-list">
                  {shown.length ? (
                    shown.map((repo) => {
                      const added = data.projects.some((p) => p.id === repo.repo);
                      return (
                        <div className="row" key={repo.path}>
                          <span className="grow">
                            <code>{repo.repo}</code>
                            <p>{repo.path}</p>
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            isDisabled={added}
                            onPress={() => {
                              setPicked(repo.repo);
                              setFind(false);
                            }}
                          >
                            {added ? "Added" : "Choose"}
                          </Button>
                        </div>
                      );
                    })
                  ) : (
                    <Empty>
                      {repos.length ? `No repositories match "${query}".` : "No repositories found in this folder."}
                    </Empty>
                  )}
                </div>
              )}
            </>
          ) : (
            <ProjectForm
              data={data}
              edit={edit}
              picked={picked}
              save={(project) =>
                void perform(async () => {
                  await control(connection, "project set", project);
                  setEdit(undefined);
                }, "Project saved")
              }
            />
          )}
        </Modal>
      )}
      {files && (
        <Modal
          title={fileEdit ? fileEdit.path : `Env files for ${files}`}
          size={fileEdit ? "lg" : undefined}
          close={() => {
            setFiles(undefined);
            setFileEdit(undefined);
          }}
        >
          {fileEdit ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                // Untrimmed: an env file's whitespace is its own.
                const content = String(new FormData(e.currentTarget).get("content") ?? "");
                void perform(async () => {
                  await control(connection, "project files set", {
                    project: files,
                    path: fileEdit.path,
                    content,
                    sha256: fileEdit.sha256,
                  });
                  setFileEdit(undefined);
                }, "Saved for every machine");
              }}
            >
              <p className="muted">
                Saved for every machine. Checkouts with the previous version update automatically; local edits are
                preserved.
              </p>
              <Field
                multiline
                className="field skill-md"
                label={fileEdit.path}
                name="content"
                defaultValue={fileEdit.content}
                placeholder="KEY=value"
              />
              <div className="inline-form">
                <Button type="submit" size="sm">
                  Save
                </Button>
                <Button size="sm" variant="tertiary" onPress={() => setFileEdit(undefined)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <>
              <p className="muted">
                Gitignored files like <code>.env.local</code> sync to new checkouts and handoffs without replacing local
                edits. Repositories using buncargo pull through <code>buncargo files pull</code> instead.
              </p>
              {local && <p className="muted">Env files are hidden in the file picker; press ⌘⇧. to show them.</p>}
              {data.fileErrors[files] && <small className="danger">Not syncing: {data.fileErrors[files]}</small>}
              <div className="tool-list">
                {filesOf(files).length ? (
                  filesOf(files).map((f) => (
                    <div className="row" key={f.path}>
                      <span className="grow">
                        <code>{f.path}</code>
                        <p>Saved {ago(Date.parse(f.updatedAt))}</p>
                      </span>
                      {local && (
                        <Button size="sm" variant="ghost" onPress={() => editFile(files, f.path)}>
                          Edit
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onPress={() =>
                          void perform(
                            () => control(connection, "project files rm", { project: files, paths: [f.path] }),
                            "Removed from every machine",
                          )
                        }
                      >
                        Stop syncing
                      </Button>
                    </div>
                  ))
                ) : (
                  <Empty>
                    <FileKey size={22} />
                    <strong>No env files yet</strong>
                    <p>Add one from a checkout on this machine, or save one with buncargo.</p>
                  </Empty>
                )}
              </div>
              <div className="inline-form">
                {local && (
                  <Button size="sm" onPress={() => addFile(files)}>
                    <Plus size={15} />
                    Add a file
                  </Button>
                )}
                <Button size="sm" variant="tertiary" onPress={() => void openExternal(FILES_GUIDE)}>
                  How it works
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}
      {tools && (
        <Modal title="Tools visible to this project" size="lg" close={() => setTools(undefined)}>
          <div className="tool-list">
            {tools.length ? (
              tools.map((t) => (
                <div key={t.name}>
                  <code>{t.name}</code>
                  <p>{t.error ?? t.description}</p>
                </div>
              ))
            ) : (
              <Empty>No tools mapped to this project.</Empty>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

/** A project's servers and skills as tags: servers by the name the app shows, with the tool prefix when it differs. */
function Uses({
  project,
  servers,
}: {
  project?: Pick<PublicProject, "mcp" | "skills">;
  servers: (id: string) => string;
}) {
  const mcp = Object.entries(project?.mcp ?? {});
  const skills = project?.skills ?? [];
  if (!mcp.length && !skills.length) return <small>No MCP servers or skills of its own</small>;
  return (
    <div className="uses">
      {mcp.length > 0 && (
        <span title="MCP servers">
          <Boxes size={13} aria-label="MCP servers" />
          {mcp.map(([alias, id]) => (
            <Badge key={alias}>{alias === id ? servers(id) : `${servers(id)} as ${alias}`}</Badge>
          ))}
        </span>
      )}
      {skills.length > 0 && (
        <span title="Skills">
          <Sparkles size={13} aria-label="Skills" />
          {skills.map((id) => (
            <Badge key={id}>{id}</Badge>
          ))}
        </span>
      )}
    </div>
  );
}
