import { useState } from "react";
import { Button } from "@heroui/react";
import { confirmDialog } from "@hanskristoffer/taurio/runtime";
import { movingLabel, type FactoryBoard } from "@agentgate/protocol";
import type { ViewProps } from "../../types.ts";
import { factoryOp } from "../../api.ts";
import { ActionButton, Badge, Check, Choice, Empty, Field, Modal, Panel } from "../../components/ui.tsx";
import { useDaemon } from "../../useDaemon.ts";
import { field } from "../utils.ts";
import { StoredFolder } from "./Folder.tsx";
import { ReadFailed, type Run } from "./parts.tsx";

/** The secrets factory.yaml names, set and delete. Loopback only, like the operations: values never cross the network
 * from the app. */
function Secrets({ connection, local, run }: Pick<ViewProps, "connection" | "local"> & { run: Run }) {
  const [editing, setEditing] = useState<string>();
  const {
    data: names,
    error,
    reload,
  } = useDaemon(local && (() => factoryOp(connection, "secret list", {})), { topics: ["factory"] });
  if (!local)
    return (
      <Panel title="Secrets">
        <Empty>
          <p>
            Secrets are set on a machine itself. Connect the app to that machine, or use agentgate factory secret set.
          </p>
        </Empty>
      </Panel>
    );
  const rows = [
    ...(names?.missing ?? []).map((n) => [n, false] as const),
    ...(names?.set ?? []).map((n) => [n, true] as const),
  ];
  return (
    <Panel
      title="Secrets"
      detail="The values factory.yaml names as secret:NAME. Copied to every paired machine, never shown."
    >
      {rows.length ? (
        rows.map(([name, set]) => (
          <div className="item" key={name}>
            <span className="grow">
              <code>{name}</code>
            </span>
            <Badge good={set}>{set ? "Set" : "Missing"}</Badge>
            <Button size="sm" variant="tertiary" onPress={() => setEditing(name)}>
              {set ? "Replace" : "Set"}
            </Button>
            {set && (
              <Button
                size="sm"
                variant="ghost"
                onPress={async () => {
                  if (await confirmDialog(`Delete ${name} on every machine?`, { destructive: true, okLabel: "Delete" }))
                    void run(async () => {
                      await factoryOp(connection, "secret delete", { name });
                      await reload();
                    }, `${name} deleted`);
                }}
              >
                Delete
              </Button>
            )}
          </div>
        ))
      ) : (
        <Empty>
          {names || !error ? (
            <p>{names ? "factory.yaml names no secrets." : "Loading…"}</p>
          ) : (
            <ReadFailed error={error} retry={reload} />
          )}
        </Empty>
      )}
      {editing && (
        <Modal title={`Set ${editing}`} close={() => setEditing(undefined)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const value = field(new FormData(e.currentTarget), "value");
              const name = editing;
              // Closes only once set: a refused value keeps the dialog and its text, and the error shows as a toast.
              void run(async () => {
                await factoryOp(connection, "secret set", { name, value });
                setEditing(undefined);
                await reload();
              }, `${name} set`);
            }}
          >
            <Field label="Value" name="value" type="password" isRequired />
            <Button type="submit" size="sm">
              Save
            </Button>
          </form>
        </Modal>
      )}
    </Panel>
  );
}

/** The person's own notify URL (factory/notify.ts): a secret, so loopback only, and shown by its host. */
function Notify({ connection, local, run }: Pick<ViewProps, "connection" | "local"> & { run: Run }) {
  const [editing, setEditing] = useState(false);
  const { data, error, reload } = useDaemon(local && (() => factoryOp(connection, "notify", {})), {
    topics: ["factory"],
  });
  // Undefined while loading, null when not set.
  const host = data && (data.host ?? null);
  return (
    <Panel
      title="Notifications"
      detail="An https URL, such as a Slack incoming webhook, that hears when an item waits for you or a PR is ready. GitHub does not notify you of the factory's comments, which it writes as you."
    >
      {local && host === undefined && error ? (
        <Empty>
          <ReadFailed error={error} retry={reload} />
        </Empty>
      ) : local ? (
        <div className="item">
          <span className="grow">{host ? <code>{host}</code> : host === null ? "Not set" : "Loading…"}</span>
          <Button size="sm" variant="tertiary" onPress={() => setEditing(true)}>
            {host ? "Replace" : "Set"}
          </Button>
          {host && (
            <Button
              size="sm"
              variant="ghost"
              onPress={() =>
                void run(async () => {
                  await factoryOp(connection, "notify", { url: null });
                  await reload();
                }, "Notifications are off")
              }
            >
              Turn off
            </Button>
          )}
        </div>
      ) : (
        <Empty>
          <p>
            The notify URL is set on a machine itself. Connect the app to that machine, or use agentgate factory notify.
          </p>
        </Empty>
      )}
      {editing && (
        <Modal title="Notify URL" close={() => setEditing(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const url = field(new FormData(e.currentTarget), "url");
              // Closes only once set: a refused URL keeps the dialog and its text, and the error shows as a toast.
              void run(async () => {
                await factoryOp(connection, "notify", { url });
                setEditing(false);
                await reload();
              }, "Notify URL set");
            }}
          >
            <Field label="URL" name="url" type="password" isRequired />
            <Button type="submit" size="sm">
              Save
            </Button>
          </form>
        </Modal>
      )}
    </Panel>
  );
}

/** Steering the whole factory: its T3 Code sign-in, the folder, the machine it runs on, and turning it off. */
export function FactorySettings({
  data,
  connection,
  local,
  board,
  run,
}: ViewProps & { board: FactoryBoard; run: Run }) {
  const [moving, setMoving] = useState(false);
  const pointer = board.factory!;
  return (
    <>
      <Panel title="Factory">
        <div className="item">
          <div className="grow">
            <strong>T3 Code sign-in</strong>
            <small className="muted">
              {
                { "signed-in": "Signed in", "signing-in": "Signing in", failed: "Sign-in failed", off: "Signed out" }[
                  board.t3.mcp
                ]
              }
              {board.t3.mcpExpiresAt
                ? ` until ${new Date(board.t3.mcpExpiresAt).toLocaleDateString(undefined, { dateStyle: "long" })}`
                : ""}
              {board.t3.error ? ` · ${board.t3.error}` : ""}
            </small>
          </div>
          <ActionButton
            size="sm"
            variant="tertiary"
            pendingKey="factory:t3"
            onPress={() =>
              void run(() => factoryOp(connection, "t3 sign-in", {}), "Signed in to T3 Code", "factory:t3")
            }
          >
            Sign in again
          </ActionButton>
        </div>
        <div className="item">
          <div className="grow">
            <strong>Folder</strong>
            <small className="muted">
              {pointer.label}
              {board.config ? ` · ${board.config.name} at ${board.config.commit.slice(0, 7)}` : ""}
            </small>
          </div>
          <ActionButton
            size="sm"
            variant="tertiary"
            pendingKey="factory:reload"
            onPress={() => void run(() => factoryOp(connection, "reload", {}), "Folder reloaded", "factory:reload")}
          >
            Reload now
          </ActionButton>
        </div>
        <div className="item">
          <div className="grow">
            <strong>Runs on {pointer.node}</strong>
            <small className="muted">
              {pointer.moving
                ? `${movingLabel(pointer.moving)}, and takes in nothing new until then.`
                : "A move waits until its open items have finished."}
            </small>
          </div>
          <Button size="sm" variant="tertiary" onPress={() => setMoving(true)}>
            Move…
          </Button>
        </div>
        <div className="item">
          <div className="grow">
            <strong>Turn the factory off</strong>
            <small className="muted">
              Takes in no new items and starts no threads on any machine, and signs out of T3 Code.
            </small>
          </div>
          <Button
            size="sm"
            variant="danger-soft"
            onPress={async () => {
              if (
                await confirmDialog("Turn the factory off on every machine?", {
                  destructive: true,
                  okLabel: "Turn off",
                })
              )
                void run(() => factoryOp(connection, "off", {}), "The factory is off");
            }}
          >
            Turn off
          </Button>
        </div>
      </Panel>
      {pointer.store === "agentgate" && <StoredFolder connection={connection} run={run} />}
      <Notify connection={connection} local={local} run={run} />
      <Secrets connection={connection} local={local} run={run} />
      {moving && (
        <Modal title="Move the factory" close={() => setMoving(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              const node = field(form, "node");
              const now = form.has("now");
              setMoving(false);
              void run(
                () => factoryOp(connection, "move", { node, ...(now && { now }) }),
                node === pointer.node ? `The factory stays on ${node}` : `The factory moves to ${node}`,
              );
            }}
          >
            <Choice
              label="Machine"
              name="node"
              defaultValue={pointer.moving?.to ?? pointer.node}
              options={data.nodes.map((n) => ({ id: n.id, label: `${n.id}${n.online ? "" : " (offline)"}` }))}
            />
            <p className="muted">
              {pointer.node} first finishes the items it has open, and takes in nothing new until the factory has moved.
              Choose {pointer.node} to cancel a move that waits.
            </p>
            <Check name="now">
              Move now. The open items stay frozen on {pointer.node} until the factory moves back or you drop them
              there.
            </Check>
            <Button type="submit" size="sm">
              Move
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
