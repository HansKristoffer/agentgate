import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { confirmDialog } from "@hanskristoffer/taurio/runtime";
import type { FactoryBoard, FolderProposal, StoredFolderView } from "@agentgate/protocol";
import type { ViewProps } from "../../types.ts";
import { request } from "../../api.ts";
import { ActionButton, Empty, Field, Modal, Panel } from "../../components/ui.tsx";
import { field } from "../utils.ts";
import type { Run } from "./Settings.tsx";

/** `agentgate factory folder`: the files of the folder agentgate stores, edited one at a time. The daemon refuses a
 * save that leaves a folder that does not load, and says which file and field. */
export function StoredFolder({ connection, run }: Pick<ViewProps, "connection"> & { run: Run }) {
  const [folder, setFolder] = useState<StoredFolderView>();
  const [editing, setEditing] = useState<{ path: string; text: string; isNew: boolean }>();
  const load = async () => setFolder(await request<StoredFolderView>(connection, "/factory/folder"));
  useEffect(() => {
    void load().catch(() => setFolder(undefined));
  }, [connection]);
  const put = async (files: Record<string, string | null>) =>
    setFolder(await request<StoredFolderView>(connection, "/factory/folder", "PUT", { files }));
  return (
    <Panel
      title="Stored folder"
      detail={`The factory's folder, kept by agentgate and copied to every paired machine${folder?.commit ? `, at ${folder.commit.slice(0, 7)}` : ""}.`}
    >
      {folder?.files.map((file) => (
        <div className="item" key={file.path}>
          <span className="grow">
            <code>{file.path}</code>
          </span>
          <Button size="sm" variant="tertiary" onPress={() => setEditing({ ...file, isNew: false })}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onPress={() =>
              void run(async () => {
                if (!(await confirmDialog(`Remove ${file.path}?`, { destructive: true, okLabel: "Remove" }))) return;
                await put({ [file.path]: null });
              }, `${file.path} removed`)
            }
          >
            Remove
          </Button>
        </div>
      )) ?? (
        <Empty>
          <p>Loading…</p>
        </Empty>
      )}
      <div className="row">
        <Button size="sm" variant="tertiary" onPress={() => setEditing({ path: "", text: "", isNew: true })}>
          New file…
        </Button>
      </div>
      {editing && (
        <Modal title={editing.isNew ? "New file" : editing.path} close={() => setEditing(undefined)} size="lg">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              const path = editing.isNew ? field(form, "path") : editing.path;
              setEditing(undefined);
              void run(() => put({ [path]: String(form.get("text") ?? "") }), `${path} saved`);
            }}
          >
            {editing.isNew && <Field label="Path" name="path" isRequired placeholder="stages/implement.md" />}
            <Field label="Text" name="text" multiline defaultValue={editing.text} />
            <Button type="submit" size="sm">
              Save
            </Button>
          </form>
        </Modal>
      )}
    </Panel>
  );
}

/** `agentgate factory proposal`: what learning runs propose for the stored folder, to read, apply or discard. */
export function Proposals({
  connection,
  board,
  run,
}: Pick<ViewProps, "connection"> & { board: FactoryBoard; run: Run }) {
  const [shown, setShown] = useState<FolderProposal>();
  const proposals = board.proposals ?? [];
  if (!proposals.length) return null;
  const act = (id: string, action: "apply" | "discard") =>
    run(
      async () => {
        await request(connection, `/factory/proposals/${id}/${action}`, "POST");
        setShown(undefined);
      },
      action === "apply" ? "Proposal applied" : "Proposal discarded",
    );
  return (
    <Panel title="Learning proposals" detail="Changes a learning run suggests for the stored folder.">
      {proposals.map((p) => (
        <div className="item" key={p.run}>
          <div className="grow">
            <strong>{p.files.join(", ")}</strong>
            <small className="muted">
              {p.run} · {new Date(p.at).toLocaleDateString()}
            </small>
          </div>
          <ActionButton
            size="sm"
            variant="tertiary"
            pendingKey={`factory:proposal:${p.run}`}
            onPress={() =>
              void run(
                async () => setShown(await request<FolderProposal>(connection, `/factory/proposals/${p.run}`)),
                undefined,
                `factory:proposal:${p.run}`,
              )
            }
          >
            Review…
          </ActionButton>
        </div>
      ))}
      {shown && (
        <Modal title={`Proposal of ${shown.run}`} close={() => setShown(undefined)} size="lg">
          <pre className="muted">{shown.body}</pre>
          {shown.files.map((file) => (
            <div key={file.path}>
              <strong>
                {file.path} ({file.change})
              </strong>
              <pre>{file.diff}</pre>
            </div>
          ))}
          <div className="row">
            <Button size="sm" onPress={() => void act(shown.run, "apply")}>
              Apply
            </Button>
            <Button size="sm" variant="danger-soft" onPress={() => void act(shown.run, "discard")}>
              Discard
            </Button>
          </div>
        </Modal>
      )}
    </Panel>
  );
}
