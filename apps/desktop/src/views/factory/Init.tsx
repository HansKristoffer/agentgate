import { useState } from "react";
import { Button, toast } from "@heroui/react";
import { Factory as FactoryIcon } from "lucide-react";
import { isVirtual, type FactoryBoard, type FactoryStore, type Status } from "@agentgate/protocol";
import type { ViewProps } from "../../types.ts";
import { factoryOp } from "../../api.ts";
import { Choice, Empty, Field, Modal } from "../../components/ui.tsx";
import { field } from "../utils.ts";

/** The repositories the app knows, for the init picker: connected projects, then this machine's checkouts. */
export const knownRepos = (data: Status) =>
  [
    ...new Set([
      ...data.projects.map((p) => p.id).filter((id) => id !== "*" && !isVirtual(id)),
      ...data.checkouts.map((c) => c.project),
    ]),
  ].sort((a, b) => a.localeCompare(b));

const defaultNode = (data: Status) => data.nodes.find((n) => n.alwaysOn)?.id ?? data.node;
const storeOptions = [
  { id: "github", label: "In the repository on GitHub" },
  { id: "agentgate", label: "In agentgate, outside the repository" },
];
const nodeOptions = (data: Status) =>
  data.nodes.map((n) => ({
    id: n.id,
    label: `${n.id}${n.alwaysOn ? " (always on)" : ""}${n.online ? "" : " (offline)"}`,
  }));

/** `agentgate factory init`: the template as the folder agentgate stores, and the factory on it. The label is created
 * with the `gh` login of the machine the app is connected to. */
export function InitDialog({
  data,
  connection,
  perform,
  repo,
  close,
  done,
}: Pick<ViewProps, "data" | "connection" | "perform"> & {
  repo?: string;
  close: () => void;
  done?: () => void;
}) {
  const repos = knownRepos(data);
  return (
    <Modal title="Start a factory" close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const input = { repo: field(form, "repo"), node: field(form, "node") };
          void perform(async () => {
            const result = await factoryOp(connection, "init", input);
            close();
            done?.();
            for (const warning of result.warnings) toast(warning);
            toast("The factory is on", { description: "Edit its folder under Settings." });
          });
        }}
      >
        <p className="muted">
          Keeps the factory's folder (factory.yaml and rulings.md) in agentgate, so nothing is pushed to the repository,
          creates the <code>factory</code> label with the <code>gh</code> login of {data.node}, and turns the factory
          on. <code>agentgate factory folder export</code> writes the folder out to keep it in git.
        </p>
        <Field
          label="Repository"
          name="repo"
          isRequired
          defaultValue={repo ?? repos[0]}
          description={repos.length ? `For example ${repos.slice(0, 3).join(", ")}` : "owner/repo"}
        />
        <Choice label="Runs on" name="node" defaultValue={defaultNode(data)} options={nodeOptions(data)} />
        <Button type="submit" size="sm">
          Start the factory
        </Button>
      </form>
    </Modal>
  );
}

/** `agentgate factory use`: a folder that exists already, on GitHub or stored in agentgate. */
function UseDialog({
  data,
  connection,
  perform,
  close,
  done,
}: Pick<ViewProps, "data" | "connection" | "perform"> & { close: () => void; done: () => void }) {
  const [store, setStore] = useState<FactoryStore>("github");
  return (
    <Modal title="Turn on a factory folder" close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const node = field(form, "node");
          const [repo = "", ...path] = field(form, "folder").split(":");
          const ref = field(form, "ref");
          const input =
            store === "agentgate" ? { store, node } : { repo, path: path.join(":"), node, ...(ref && { ref }) };
          void perform(async () => {
            const status = await factoryOp(connection, "use", input);
            if (status.warning) toast(status.warning);
            close();
            done();
          }, "The factory is on");
        }}
      >
        <Choice
          label="Stored"
          selectedKey={store}
          onSelectionChange={(key) => setStore(key as FactoryStore)}
          options={storeOptions}
        />
        {store === "github" && (
          <>
            <Field
              label="Folder"
              name="folder"
              isRequired
              placeholder="owner/repo:factory"
              description="The repository, and the folder inside it after a colon."
            />
            <Field label="Branch or tag" name="ref" description="Empty: the repository's default branch." />
          </>
        )}
        <Choice label="Runs on" name="node" defaultValue={defaultNode(data)} options={nodeOptions(data)} />
        <Button type="submit" size="sm">
          Turn on
        </Button>
      </form>
    </Modal>
  );
}

/** The view while the factory is off. */
export function FactoryOff(props: ViewProps & { board: FactoryBoard; refresh: () => Promise<void> }) {
  const [dialog, setDialog] = useState<"init" | "use">();
  const done = () => void props.refresh();
  return (
    <>
      <Empty>
        <FactoryIcon size={28} />
        <strong>The factory is off</strong>
        <p>
          It works issues you label in T3 Code threads, up to a pull request ready for you to merge. Start one in a
          repository, or turn on a factory folder you already have.
        </p>
        <div className="row">
          <Button size="sm" onPress={() => setDialog("init")}>
            Start a factory
          </Button>
          <Button size="sm" variant="tertiary" onPress={() => setDialog("use")}>
            Use an existing folder
          </Button>
        </div>
      </Empty>
      {dialog === "init" && <InitDialog {...props} close={() => setDialog(undefined)} done={done} />}
      {dialog === "use" && <UseDialog {...props} close={() => setDialog(undefined)} done={done} />}
    </>
  );
}
