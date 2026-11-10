import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { confirmDialog } from "@hanskristoffer/taurio/runtime";
import type { StoredFolderView } from "@agentgate/protocol";
import type { ViewProps } from "../../types.ts";
import { factoryOp } from "../../api.ts";
import { Empty, Field, Modal, Panel } from "../../components/ui.tsx";
import { field } from "../utils.ts";
import type { Run } from "./Settings.tsx";

/** `agentgate factory folder`: the files of the folder agentgate stores, edited one at a time. The daemon refuses a
 * save that leaves a folder that does not load, and says which file and field. */
export function StoredFolder({ connection, run }: Pick<ViewProps, "connection"> & { run: Run }) {
  const [folder, setFolder] = useState<StoredFolderView>();
  const [editing, setEditing] = useState<{ path: string; text: string; isNew: boolean }>();
  const load = async () => setFolder(await factoryOp(connection, "folder ls", {}));
  useEffect(() => {
    void load().catch(() => setFolder(undefined));
  }, [connection]);
  const put = async (files: Record<string, string | null>) =>
    setFolder(await factoryOp(connection, "folder put", { files }));
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
      <div className="item">
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
