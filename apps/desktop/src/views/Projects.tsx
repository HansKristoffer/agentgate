import { useState } from "react";
import { Bot, FolderGit2, FolderOpen, Plus, Search as SearchIcon, Trash2 } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import type { PublicProject, ToolPreview } from "@agentgate/protocol";
import { Button, Input, TextField } from "@heroui/react";
import {
  Badge,
  Check,
  Empty,
  Field,
  Modal,
  Panel,
  HeaderActions,
} from "../components/ui.tsx";
import { ProjectSkillChecks } from "../components/SkillAssignments.tsx";
import type { ViewProps } from "../types.ts";
import { request } from "../api.ts";
import { field, idPath, confirmDelete } from "./utils.ts";
import { EndpointDetails } from "./RemoteEndpoint.tsx";

type Editing = Omit<PublicProject, "remote" | "skillRepos"> & { virtual?: boolean };
const isVirtual = (id: string) => id.startsWith("@");
const aliasOf = (p: Editing, server: string) =>
  Object.entries(p.mcp).find(([, id]) => id === server)?.[0];

export function Projects(props: ViewProps) {
  const { data, connection, perform, local } = props;
  const [edit, setEdit] = useState<Editing>();
  const [repos, setRepos] = useState<{ repo: string; path: string }[]>();
  const [dir, setDir] = useState("~/Documents/GitHub");
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = (repos ?? []).filter((r) =>
    `${r.repo} ${r.path}`.toLowerCase().includes(needle),
  );
  const scan = (folder: string) =>
    perform(async () => {
      const result = await request<{ repos: { repo: string; path: string }[] }>(
        connection,
        "/projects/scan",
        "POST",
        { dir: folder },
      );
      setRepos(result.repos);
      setQuery("");
    });
  const [tools, setTools] = useState<ToolPreview[]>();
  const defaults = data.projects.find((p) => p.id === "*");
  return (
    <>
      <HeaderActions>
        <Button
          size="sm"
          variant="tertiary"
          onPress={() =>
            setEdit(defaults ?? { id: "*", mcp: {}, skills: [], inheritDefaults: true })
          }
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
          onPress={() => setEdit({ id: "", mcp: {}, skills: [], inheritDefaults: true })}
        >
          <Plus size={15} />
          Add project
        </Button>
      </HeaderActions>
      <Panel
        title="Project tools"
        detail="Aliases become tool prefixes. Changes reach running sessions automatically."
      >
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
                  <small>
                    {p.inheritDefaults
                      ? "Includes global MCP servers"
                      : "Project tools only"}
                  </small>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() =>
                    void perform(async () =>
                      setTools(
                        await request<ToolPreview[]>(
                          connection,
                          `/projects/tools?id=${idPath(p.id)}`,
                        ),
                      ),
                    )
                  }
                >
                  Preview
                </Button>
                <Button size="sm" variant="ghost" onPress={() => setEdit(p)}>
                  Edit
                </Button>
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  className="delete"
                  aria-label={`Delete ${p.id}`}
                  onPress={async () => {
                    if (await confirmDelete(p.id))
                      void perform(
                        () =>
                          request(
                            connection,
                            `/projects?id=${idPath(p.id)}`,
                            "DELETE",
                          ),
                        "Project removed",
                      );
                  }}
                >
                  <Trash2 size={15} />
                </Button>
              </div>
            ))
        ) : (
          <Empty>
            <FolderGit2 size={22} />
            <strong>Give your repositories their own tools.</strong>
            <p>
              Add owner/repo identifiers, or scan a local folder. Sessions also
              discover repositories automatically.
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
                <Button size="sm" variant="ghost" onPress={() => setEdit(p)}>
                  Edit
                </Button>
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  className="delete"
                  aria-label={`Delete ${p.id}`}
                  onPress={async () => {
                    if (await confirmDelete(p.id))
                      void perform(() => request(connection, `/projects?id=${idPath(p.id)}`, "DELETE"), "Virtual project removed");
                  }}
                >
                  <Trash2 size={15} />
                </Button>
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
      {local && data.checkouts.length > 0 && <Panel title="Repository skill mirroring" detail="Opt in to share repository-owned skills between Claude and Codex. This creates relative links you can review and commit.">
        {data.checkouts.map(checkout => <div className="item" key={checkout.path}>
          <span className="grow"><strong>{checkout.project}</strong><small>{checkout.path}</small></span>
          <Button size="sm" variant="ghost" onPress={() => void perform(() => request(connection, "/checkouts/mirroring", "PUT", { path: checkout.path, enabled: !checkout.mirror }), "Repository mirroring saved")}>
            {checkout.mirror ? "Stop mirroring" : "Mirror repository skills"}
          </Button>
        </div>)}
      </Panel>}
      {local && (
        <Panel
          title="Discover repositories"
          detail="Choose a folder, or type its path, to find the Git repositories in it."
        >
          <form
            className="item inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void scan(dir);
            }}
          >
            <TextField
              name="dir"
              isRequired
              aria-label="Repository folder"
              value={dir}
              onChange={setDir}
              className="grow"
            >
              <Input />
            </TextField>
            <Button
              size="sm"
              variant="tertiary"
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
              Choose folder…
            </Button>
            <Button type="submit" size="sm" variant="tertiary">
              Scan
            </Button>
          </form>
          {repos && repos.length > 0 && (
            <div className="item">
              <SearchIcon size={15} className="muted" />
              <TextField
                aria-label="Search repositories"
                value={query}
                onChange={setQuery}
                className="grow"
              >
                <Input type="search" placeholder={`Search ${repos.length} repositories`} />
              </TextField>
            </div>
          )}
          {repos &&
            (shown.length ? (
              shown.map((repo) => {
                const added = data.projects.some((p) => p.id === repo.repo);
                return (
                  <div className="item" key={repo.path}>
                    <div className="grow">
                      <strong>{repo.repo}</strong>
                      <small>{repo.path}</small>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      isDisabled={added}
                      onPress={() =>
                        setEdit({
                          id: repo.repo,
                          mcp: {},
                          skills: [],
                          inheritDefaults: true,
                        })
                      }
                    >
                      {added ? "Added" : "Add"}
                    </Button>
                  </div>
                );
              })
            ) : (
              <Empty>
                {repos.length
                  ? `No repositories match "${query}".`
                  : "No repositories found in this folder."}
              </Empty>
            ))}
        </Panel>
      )}
      {edit && (
        <Modal
          title={
            edit.id === "*"
              ? "Global defaults"
              : edit.virtual || isVirtual(edit.id)
                ? edit.id ? "Edit virtual project" : "New virtual project"
                : edit.id
                  ? "Edit project"
                  : "Add project"
          }
          close={() => setEdit(undefined)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void perform(async () => {
                // Keep an existing custom alias; new picks use the server id.
                const mcp: Record<string, string> = {};
                for (const id of f.getAll("server") as string[])
                  mcp[aliasOf(edit, id) ?? id] = id;
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
                defaultValue={edit.id}
                pattern={edit.id === "*" ? undefined : "[^\\/\\s@][^\\/\\s]*\\/[^\\/\\s]+"}
                placeholder="owner/repo"
              />
            )}
            <fieldset className="checklist">
              <legend>MCP servers</legend>
              <div className="rows">
                {data.servers.length ? (
                  // Per-session servers start inside a worktree, which a remote client doesn't have.
                  data.servers.filter((s) => !(edit.virtual || isVirtual(edit.id)) || s.mode === "shared").map((s) => {
                    const alias = aliasOf(edit, s.id);
                    return (
                      <Check
                        className="item"
                        key={s.id}
                        name="server"
                        value={s.id}
                        defaultSelected={!!alias}
                      >
                        <span className="grow">
                          <strong>{s.id}</strong>
                          {alias && alias !== s.id && (
                            <small>Tool prefix: {alias}</small>
                          )}
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
            {edit.id !== "*" && !edit.virtual && !isVirtual(edit.id) && (
              <Check name="inherit" defaultSelected={edit.inheritDefaults}>
                Include global MCP servers
              </Check>
            )}
            <Button type="submit" size="sm">
              Save project
            </Button>
          </form>
        </Modal>
      )}
      {tools && (
        <Modal
          title="Tools visible to this project"
          close={() => setTools(undefined)}
        >
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
