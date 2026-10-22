import { useState } from "react";
import { Bot, FileKey, FolderGit2, FolderOpen, Pencil, Plus } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import type { PublicProject, ToolPreview } from "@agentgate/protocol";
import { Button, Input, Tabs, TextField } from "@heroui/react";
import { Check, Empty, Field, Modal, Panel, HeaderActions, RowMenu } from "../components/ui.tsx";
import { ProjectSkillChecks } from "../components/SkillAssignments.tsx";
import type { ViewProps } from "../types.ts";
import { openExternal, request } from "../api.ts";
import { ago, field, idPath, confirmDelete } from "./utils.ts";
import { EndpointDetails } from "./RemoteEndpoint.tsx";

const FILES_GUIDE = "https://github.com/HansKristoffer/agentgate#env-files-between-machines";

type Editing = Omit<PublicProject, "remote" | "skillRepos"> & { virtual?: boolean };
const isVirtual = (id: string) => id.startsWith("@");
const aliasOf = (p: Editing, server: string) => Object.entries(p.mcp).find(([, id]) => id === server)?.[0];

export function Projects(props: ViewProps) {
  const { data, connection, perform, local } = props;
  const [edit, setEdit] = useState<Editing>();
  const [repos, setRepos] = useState<{ repo: string; path: string }[]>();
  const [dir, setDir] = useState("~/Documents/GitHub");
  const [query, setQuery] = useState("");
  // Adding a repository project: type owner/repo, or find it among this machine's checkouts.
  const [find, setFind] = useState(false);
  const [picked, setPicked] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = (repos ?? []).filter((r) => `${r.repo} ${r.path}`.toLowerCase().includes(needle));
  const scan = (folder: string) =>
    perform(async () => {
      const result = await request<{ repos: { repo: string; path: string }[] }>(connection, "/projects/scan", "POST", {
        dir: folder,
      });
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
          () => request(connection, "/projects/files", "POST", { project, path }),
          "File saved for every machine",
        );
    })();
  const defaults = data.projects.find((p) => p.id === "*");
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
          async () => {
            for (const c of mine)
              await request(connection, "/checkouts/mirroring", "PUT", { path: c.path, enabled: !on });
          },
          on ? "Repository skills no longer shared" : "Repository skills shared between Claude and Codex",
        ),
    };
  };
  return (
    <>
      <HeaderActions>
        <Button
          size="sm"
          variant="tertiary"
          onPress={() => setEdit(defaults ?? { id: "*", mcp: {}, skills: [], inheritDefaults: true })}
        >
          Global defaults
        </Button>
        <Button
          size="sm"
          variant="tertiary"
          onPress={() => setEdit({ id: "", mcp: {}, skills: [], inheritDefaults: false, virtual: true })}
        >
          <Bot size={15} />
          New virtual project
        </Button>
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
      <Panel title="Project tools" detail="Aliases become tool prefixes. Changes reach running sessions automatically.">
        {data.projects.filter((p) => p.id !== "*" && !isVirtual(p.id)).length ? (
          data.projects
            .filter((p) => p.id !== "*" && !isVirtual(p.id))
            .map((p) => (
              <div className="item" key={p.id}>
                <div className="machine-icon">
                  <FolderGit2 size={16} />
                </div>
                <div className="grow">
                  <strong>{p.id}</strong>
                  <small>
                    {Object.entries(p.mcp)
                      .map(([alias, id]) => `${alias} → ${id}`)
                      .join(" · ") || "No project-specific tools"}
                  </small>
                  {p.skills.length > 0 && <small>Skills: {p.skills.join(", ")}</small>}
                  <small>{p.inheritDefaults ? "Includes global MCP servers" : "Project tools only"}</small>
                  {p.files?.length ? <small>Env files: {p.files.map((f) => f.path).join(" · ")}</small> : null}
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
                        void perform(async () =>
                          setTools(await request<ToolPreview[]>(connection, `/projects/tools?id=${idPath(p.id)}`)),
                        ),
                    },
                    { label: "Env files", onAction: () => setFiles(p.id) },
                    mirrorItem(p.id),
                    {
                      label: "Delete",
                      danger: true,
                      onAction: async () => {
                        if (await confirmDelete(p.id))
                          void perform(
                            () => request(connection, `/projects?id=${idPath(p.id)}`, "DELETE"),
                            "Project removed",
                          );
                      },
                    },
                  ]}
                />
              </div>
            ))
        ) : (
          <Empty>
            <FolderGit2 size={22} />
            <strong>Give your repositories their own tools.</strong>
            <p>
              Add owner/repo identifiers, or scan a local folder. Sessions also discover repositories automatically.
            </p>
          </Empty>
        )}
      </Panel>
      <Panel
        title="Virtual projects"
        detail="A set of MCP servers and skills at a URL with a secret, for assistants that only take a server URL, like Grok."
      >
        {data.projects.filter((p) => isVirtual(p.id)).length ? (
          data.projects
            .filter((p) => isVirtual(p.id))
            .map((p) => (
              <div className="item stack virtual-project" key={p.id}>
                <div className="item">
                  <div className="machine-icon">
                    <Bot size={16} />
                  </div>
                  <div className="grow">
                    <strong>{p.id}</strong>
                    <small>{Object.keys(p.mcp).join(" · ") || "No MCP servers"}</small>
                    {p.skills.length > 0 && <small>Skills: {p.skills.join(", ")}</small>}
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
                              () => request(connection, `/projects?id=${idPath(p.id)}`, "DELETE"),
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
            <strong>Use your MCP servers and skills in Grok.</strong>
            <p>Create a virtual project, pick its servers and skills, then paste its URL and secret into Grok.</p>
          </Empty>
        )}
      </Panel>
      {edit && (
        <Modal
          title={
            edit.id === "*"
              ? "Global defaults"
              : edit.virtual || isVirtual(edit.id)
                ? edit.id
                  ? "Edit virtual project"
                  : "New virtual project"
                : edit.id
                  ? "Edit project"
                  : "Add project"
          }
          close={() => setEdit(undefined)}
        >
          {local && !edit.id && !edit.virtual && (
            <Tabs
              className="segmented"
              selectedKey={find ? "find" : "type"}
              onSelectionChange={(key) => setFind(key === "find")}
            >
              <Tabs.ListContainer>
                <Tabs.List aria-label="How to choose the repository">
                  <Tabs.Tab id="type">
                    Repository
                    <Tabs.Indicator />
                  </Tabs.Tab>
                  <Tabs.Tab id="find">
                    Find on this machine
                    <Tabs.Indicator />
                  </Tabs.Tab>
                </Tabs.List>
              </Tabs.ListContainer>
            </Tabs>
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
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void perform(async () => {
                  // Keep an existing custom alias; new picks use the server id.
                  const mcp: Record<string, string> = {};
                  for (const id of f.getAll("server") as string[]) mcp[aliasOf(edit, id) ?? id] = id;
                  const virtual = edit.virtual || isVirtual(edit.id);
                  await request(connection, "/projects", "PUT", {
                    id: virtual && !edit.id ? `@${field(f, "id")}` : field(f, "id"),
                    mcp,
                    skills: f.getAll("skill") as string[],
                    inheritDefaults: !virtual && (edit.id === "*" || f.get("inherit") === "on"),
                  });
                  setEdit(undefined);
                }, "Project saved");
              }}
            >
              {edit.virtual || isVirtual(edit.id) ? (
                <Field
                  label="Name"
                  description="Lowercase letters, digits and dashes."
                  name="id"
                  isRequired
                  isReadOnly={!!edit.id}
                  defaultValue={edit.id}
                  pattern={edit.id ? undefined : "[a-z0-9][a-z0-9\\-]{0,63}"}
                  placeholder="grok"
                />
              ) : (
                <Field
                  label="Repository"
                  name="id"
                  isRequired
                  isReadOnly={!!edit.id}
                  key={picked}
                  defaultValue={edit.id || picked}
                  pattern={edit.id === "*" ? undefined : "[^\\/\\s@][^\\/\\s]*\\/[^\\/\\s]+"}
                  placeholder="owner/repo"
                />
              )}
              <fieldset className="checklist">
                <legend>MCP servers</legend>
                <div className="rows">
                  {edit.id !== "*" && !edit.virtual && !isVirtual(edit.id) && (
                    <Check className="item" name="inherit" defaultSelected={edit.inheritDefaults}>
                      <span className="grow">
                        <strong>Global MCP servers</strong>
                        <small>The servers in Global defaults</small>
                      </span>
                    </Check>
                  )}
                  {data.servers.length ? (
                    // Per-session servers start inside a worktree, which a remote client doesn't have.
                    data.servers
                      .filter((s) => !(edit.virtual || isVirtual(edit.id)) || s.mode === "shared")
                      .map((s) => {
                        const alias = aliasOf(edit, s.id);
                        return (
                          <Check className="item" key={s.id} name="server" value={s.id} defaultSelected={!!alias}>
                            <span className="grow">
                              <strong>{s.label ?? s.id}</strong>
                              {alias && alias !== s.id && <small>Tool prefix: {alias}</small>}
                            </span>
                          </Check>
                        );
                      })
                  ) : (
                    <Empty>Connect a server first.</Empty>
                  )}
                </div>
              </fieldset>
              <ProjectSkillChecks data={data} project={edit.id} selected={edit.skills} />
              <Button type="submit" size="sm">
                Save project
              </Button>
            </form>
          )}
        </Modal>
      )}
      {files && (
        <Modal
          title={fileEdit ? fileEdit.path : `Env files for ${files}`}
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
                  await request(connection, "/projects/files/content", "PUT", {
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
                Saved for every machine. Checkouts on this machine that have the previous version get this one; a
                checkout with its own edits to the file keeps them.
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
                Gitignored files such as <code>.env.local</code> follow this repository to all your machines. A checkout
                agentgate creates, through a handoff or a clone, gets each file it is missing; a file already in a
                checkout is never replaced. Repositories that use buncargo get its <code>files pull</code> instead,
                which keeps your local edits. A handoff also carries the thread's own changes to these files. Files
                buncargo keeps for one machine stay there.
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
                            () =>
                              request(
                                connection,
                                `/projects/files?id=${idPath(files)}&path=${encodeURIComponent(f.path)}`,
                                "DELETE",
                              ),
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
                    <strong>No env files yet.</strong>
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
        <Modal title="Tools visible to this project" close={() => setTools(undefined)}>
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
