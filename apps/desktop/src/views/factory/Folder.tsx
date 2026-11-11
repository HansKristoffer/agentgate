import { useState } from "react";
import { Button } from "@heroui/react";
import { confirmDialog } from "@hanskristoffer/taurio/runtime";
import type { ViewProps } from "../../types.ts";
import { factoryOp } from "../../api.ts";
import { Empty, Field, Modal, Panel } from "../../components/ui.tsx";
import { useDaemon } from "../../useDaemon.ts";
import { field } from "../utils.ts";
import { ReadFailed, type Run } from "./Settings.tsx";

/** `agentgate factory folder`: the files of the folder agentgate stores, edited one at a time. The daemon refuses a
 * save that leaves a folder that does not load, and says which file and field. */
export function StoredFolder({ connection, run }: Pick<ViewProps, "connection"> & { run: Run }) {
  /** `base` is the commit the dialog opened on; the daemon refuses the save if another machine changed the folder since. */
  const [editing, setEditing] = useState<{ path: string; text: string; isNew: boolean; base?: string }>();
  const {
    data: folder,
    error,
    reload,
  } = useDaemon(() => factoryOp(connection, "folder ls", {}), { topics: ["factory"] });
  const put = async (files: Record<string, string | null>, base: string | undefined) => {
    await factoryOp(connection, "folder put", { files, base });
    await reload();
  };
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
          <Button
            size="sm"
            variant="tertiary"
            onPress={() => setEditing({ ...file, isNew: false, base: folder.commit })}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onPress={async () => {
              if (await confirmDialog(`Remove ${file.path}?`, { destructive: true, okLabel: "Remove" }))
                void run(() => put({ [file.path]: null }, folder.commit), `${file.path} removed`);
            }}
          >
            Remove
          </Button>
        </div>
      )) ?? <Empty>{error ? <ReadFailed error={error} retry={reload} /> : <p>Loading…</p>}</Empty>}
      <div className="item">
        <Button
          size="sm"
          variant="tertiary"
          onPress={() => setEditing({ path: "", text: "", isNew: true, base: folder?.commit })}
        >
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
              // Closes only once saved: a refused save keeps the dialog and its text, and the error shows as a toast.
              void run(async () => {
                await put({ [path]: String(form.get("text") ?? "") }, editing.base);
                setEditing(undefined);
              }, `${path} saved`);
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
