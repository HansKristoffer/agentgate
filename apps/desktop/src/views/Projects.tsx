import { useState } from "react";
import { FolderGit2, Plus, Trash2 } from "lucide-react";
import type { Project, ToolPreview } from "@agentgate/protocol";
import { Empty, Modal, Panel } from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { request } from "../api.ts";
import { field, idPath, confirmDelete } from "./utils.ts";

export function Projects({ data, connection, perform, local }: ViewProps) {
  const [edit, setEdit] = useState<Project>();
  const [repos, setRepos] = useState<{ repo: string; path: string }[]>();
  const [tools, setTools] = useState<ToolPreview[]>();
  const defaults = data.projects.find((p) => p.id === "*");
  return (
    <>
      <div className="toolbar">
        <span>
          {data.projects.filter((p) => p.id !== "*").length} repositories
        </span>
        <div className="row">
          <button
            className="button"
            onClick={() =>
              setEdit(defaults ?? { id: "*", mcp: {}, inheritDefaults: true })
            }
          >
            Global defaults
          </button>
          <button
            className="button primary"
            onClick={() => setEdit({ id: "", mcp: {}, inheritDefaults: true })}
          >
            <Plus size={15} />
            Add project
          </button>
        </div>
      </div>
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
                <button
                  className="button quiet"
                  onClick={() =>
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
                </button>
                <button className="button quiet" onClick={() => setEdit(p)}>
                  Edit
                </button>
                <button
                  className="tool-btn danger"
                  title="Remove project"
                  aria-label={`Delete ${p.id}`}
                  onClick={() => {
                    if (confirmDelete(p.id))
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
                </button>
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
            <input
              name="dir"
              required
              aria-label="Repository folder"
              defaultValue="~/Documents/GitHub"
            />
            <button className="button">Scan folder</button>
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
                    <button
                      className="button quiet"
                      disabled={data.projects.some((p) => p.id === repo.repo)}
                      onClick={() =>
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
                    </button>
                  </div>
                ))
              ) : (
                <div className="empty">No repositories found in this folder.</div>
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
                const mcp: Record<string, string> = {};
                for (const line of field(f, "mcp")
                  .split("\n")
                  .filter((l) => l.trim())) {
                  const [alias, instance, extra] = line
                    .split("=")
                    .map((s) => s.trim());
                  if (!alias || !instance || extra !== undefined)
                    throw new Error("Use one alias=server mapping per line");
                  if (alias in mcp) throw new Error(`Duplicate alias ${alias}`);
                  mcp[alias] = instance;
                }
                await request(connection, "/projects", "PUT", {
                  id: field(f, "id"),
                  mcp,
                  inheritDefaults: edit.id === "*" || f.get("inherit") === "on",
                });
                setEdit(undefined);
              }, "Project saved");
            }}
          >
            <label>
              Repository
              <input
                name="id"
                required
                readOnly={!!edit.id}
                defaultValue={edit.id}
                pattern={edit.id === "*" ? undefined : "[^/\\s]+/[^/\\s]+"}
                placeholder="owner/repo"
              />
            </label>
            <label>
              Tool mappings
              <textarea
                name="mcp"
                className="mono"
                rows={5}
                defaultValue={Object.entries(edit.mcp)
                  .map(([a, i]) => `${a}=${i}`)
                  .join("\n")}
                placeholder={"posthog=posthog-work\nfilesystem=fs"}
              />
            </label>
            <p className="note">
              One alias=server per line. Available servers:{" "}
              {data.servers.map((s) => s.id).join(", ") ||
                "Connect a server first."}
            </p>
            {edit.id !== "*" && (
              <label className="check">
                <input
                  type="checkbox"
                  name="inherit"
                  defaultChecked={edit.inheritDefaults}
                />
                Include global defaults
              </label>
            )}
            <button className="button primary">Save project</button>
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
