import { useState } from "react";
import { FolderGit2, Plus, Trash2 } from "lucide-react";
import type { Project, ToolPreview } from "@agentgate/protocol";
import { Button, Input, TextField } from "@heroui/react";
import {
  Check,
  Empty,
  Field,
  Modal,
  Panel,
  HeaderActions,
} from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { request } from "../api.ts";
import { field, idPath, confirmDelete } from "./utils.ts";

const aliasOf = (p: Project, server: string) =>
  Object.entries(p.mcp).find(([, id]) => id === server)?.[0];

export function Projects({ data, connection, perform, local }: ViewProps) {
  const [edit, setEdit] = useState<Project>();
  const [repos, setRepos] = useState<{ repo: string; path: string }[]>();
  const [tools, setTools] = useState<ToolPreview[]>();
  const defaults = data.projects.find((p) => p.id === "*");
  return (
    <>
      <HeaderActions>
        <Button
          size="sm"
          variant="tertiary"
          onPress={() =>
            setEdit(defaults ?? { id: "*", mcp: {}, inheritDefaults: true })
          }
        >
          Global defaults
        </Button>
        <Button
          size="sm"
          onPress={() => setEdit({ id: "", mcp: {}, inheritDefaults: true })}
        >
          <Plus size={15} />
          Add project
        </Button>
      </HeaderActions>
      <Panel
        title="Project tools"
        detail="Aliases become tool prefixes. Changes reach running sessions automatically."
      >
        {data.projects.filter((p) => p.id !== "*").length ? (
          data.projects
            .filter((p) => p.id !== "*")
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
                  <small>
                    {p.inheritDefaults
                      ? "Includes global defaults"
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
      {local && (
        <Panel
          title="Discover repositories"
          detail="Scan a local folder for Git repositories."
        >
          <form
            className="item inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void perform(async () => {
                const result = await request<{
                  repos: { repo: string; path: string }[];
                }>(connection, "/projects/scan", "POST", {
                  dir: field(f, "dir"),
                });
                setRepos(result.repos);
              });
            }}
          >
            <TextField
              name="dir"
              isRequired
              aria-label="Repository folder"
              defaultValue="~/Documents/GitHub"
              className="grow"
            >
              <Input />
            </TextField>
            <Button type="submit" size="sm" variant="tertiary">
              Scan folder
            </Button>
          </form>
          {repos && (
            <>
              {repos.length ? (
                repos.map((repo) => (
                  <div className="item" key={repo.path}>
                    <div className="grow">
                      <strong>{repo.repo}</strong>
                      <small>{repo.path}</small>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      isDisabled={data.projects.some((p) => p.id === repo.repo)}
                      onPress={() =>
                        setEdit({
                          id: repo.repo,
                          mcp: {},
                          inheritDefaults: true,
                        })
                      }
                    >
                      {data.projects.some((p) => p.id === repo.repo)
                        ? "Added"
                        : "Add"}
                    </Button>
                  </div>
                ))
              ) : (
                <Empty>No repositories found in this folder.</Empty>
              )}
            </>
          )}
        </Panel>
      )}
      {edit && (
        <Modal
          title={
            edit.id === "*"
              ? "Global tool defaults"
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
                await request(connection, "/projects", "PUT", {
                  id: field(f, "id"),
                  mcp,
                  inheritDefaults: edit.id === "*" || f.get("inherit") === "on",
                });
                setEdit(undefined);
              }, "Project saved");
            }}
          >
            <Field
              label="Repository"
              name="id"
              isRequired
              isReadOnly={!!edit.id}
              defaultValue={edit.id}
              pattern={edit.id === "*" ? undefined : "[^/\\s]+/[^/\\s]+"}
              placeholder="owner/repo"
            />
            <fieldset className="checklist">
              <legend>MCP servers</legend>
              <div className="rows">
                {data.servers.length ? (
                  data.servers.map((s) => {
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
            {edit.id !== "*" && (
              <Check name="inherit" defaultSelected={edit.inheritDefaults}>
                Include global defaults
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
