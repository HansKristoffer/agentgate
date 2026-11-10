import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { confirmDialog } from "@hanskristoffer/taurio/runtime";
import { folderLabel, type FactoryBoard } from "@agentgate/protocol";
import type { ViewProps } from "../../types.ts";
import { request } from "../../api.ts";
import { ActionButton, Badge, Choice, Empty, Field, Modal, Panel } from "../../components/ui.tsx";
import { field } from "../utils.ts";
import { StoredFolder } from "./Folder.tsx";

export type Run = (task: () => Promise<unknown>, message?: string, key?: string) => Promise<void>;

/** The secrets factory.yaml names, set and delete. Loopback only, like the routes: values never cross the network from
 * the app. */
function Secrets({ connection, local, run }: Pick<ViewProps, "connection" | "local"> & { run: Run }) {
  const [names, setNames] = useState<{ set: string[]; missing: string[] }>();
  const [editing, setEditing] = useState<string>();
  const load = async () =>
    setNames(await request<{ set: string[]; missing: string[] }>(connection, "/factory/secrets"));
  useEffect(() => {
    if (local) void load().catch(() => setNames(undefined));
  }, [connection, local]);
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
                onPress={() =>
                  void run(async () => {
                    if (
                      !(await confirmDialog(`Delete ${name} on every machine?`, {
                        destructive: true,
                        okLabel: "Delete",
                      }))
                    )
                      return;
                    await request(connection, `/factory/secrets/${name}`, "DELETE");
                    await load();
                  }, `${name} deleted`)
                }
              >
                Delete
              </Button>
            )}
          </div>
        ))
      ) : (
        <Empty>
          <p>{names ? "factory.yaml names no secrets." : "Loading…"}</p>
        </Empty>
      )}
      {editing && (
        <Modal title={`Set ${editing}`} close={() => setEditing(undefined)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const value = field(new FormData(e.currentTarget), "value");
              const name = editing;
              setEditing(undefined);
              void run(async () => {
                await request(connection, `/factory/secrets/${name}`, "PUT", { value });
                await load();
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
              void run(() => request(connection, "/factory/t3/sign-in", "POST"), "Signed in to T3 Code", "factory:t3")
            }
          >
            Sign in again
          </ActionButton>
        </div>
        <div className="item">
          <div className="grow">
            <strong>Folder</strong>
            <small className="muted">
              {folderLabel(pointer)}
              {board.config ? ` · ${board.config.name} at ${board.config.commit.slice(0, 7)}` : ""}
            </small>
          </div>
          <ActionButton
            size="sm"
            variant="tertiary"
            pendingKey="factory:reload"
            onPress={() =>
              void run(() => request(connection, "/factory/reload", "POST"), "Folder reloaded", "factory:reload")
            }
          >
            Reload now
          </ActionButton>
        </div>
        <div className="item">
          <div className="grow">
            <strong>Runs on {pointer.node}</strong>
            <small className="muted">Each machine finishes the items it holds when the factory moves.</small>
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
            onPress={() =>
              void run(async () => {
                if (
                  !(await confirmDialog("Turn the factory off on every machine?", {
                    destructive: true,
                    okLabel: "Turn off",
                  }))
                )
                  return;
                await request(connection, "/factory", "DELETE");
              }, "The factory is off")
            }
          >
            Turn off
          </Button>
        </div>
      </Panel>
      {pointer.store === "agentgate" && <StoredFolder connection={connection} run={run} />}
      <Secrets connection={connection} local={local} run={run} />
      {moving && (
        <Modal title="Move the factory" close={() => setMoving(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const node = field(new FormData(e.currentTarget), "node");
              setMoving(false);
              void run(() => request(connection, "/factory/move", "POST", { node }), `The factory runs on ${node}`);
            }}
          >
            <Choice
              label="Machine"
              name="node"
              defaultValue={pointer.node}
              options={data.nodes.map((n) => ({ id: n.id, label: `${n.id}${n.online ? "" : " (offline)"}` }))}
            />
            <Button type="submit" size="sm">
              Move
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
