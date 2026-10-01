import { useState } from "react";
import { Copy, Monitor, Plus } from "lucide-react";
import { Button, Switch } from "@heroui/react";
import { confirmDialog } from "@hanskristoffer/taurio/runtime";
import {
  Badge,
  Field,
  Modal,
  Panel,
  HeaderActions,
} from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { request } from "../api.ts";
import { field, idPath, relative } from "./utils.ts";

export function Nodes({ data, connection, perform }: ViewProps) {
  const [pair, setPair] = useState("");
  const [joinOpen, setJoinOpen] = useState(false);
  return (
    <>
      <HeaderActions>
        <Button size="sm" variant="tertiary" onPress={() => setJoinOpen(true)}>
          Join another machine
        </Button>
        <Button
          size="sm"
          onPress={() =>
            void perform(async () => {
              const result = await request<{ command: string }>(
                connection,
                "/nodes/pair",
                "POST",
              );
              setPair(result.command);
            })
          }
        >
          <Plus size={15} />
          Pair a machine
        </Button>
      </HeaderActions>
      <Panel
        foot="Each machine serves its own agents and keeps working offline. Always-on machines take care of token refreshes while your laptop is away."
      >
        {data.nodes.map((n) => (
          <div className="item" key={n.id}>
            <div className="machine-icon">
              <Monitor size={16} />
            </div>
            <div className="grow">
              <div className="row">
                <strong>{n.id}</strong>
                {n.id === data.node && <Badge>This node</Badge>}
                <Badge good={n.online}>{n.online ? "Online" : "Offline"}</Badge>
              </div>
              <small>{n.url ?? "Tailscale address not available"}</small>
              <small>
                {n.syncError ??
                  (n.id === data.node
                    ? "Local daemon"
                    : `Last seen ${relative(n.lastSeen)}`)}
              </small>
            </div>
            <Switch
              isSelected={!!n.alwaysOn}
              onChange={() =>
                void perform(() =>
                  request(connection, `/nodes/${idPath(n.id)}`, "PATCH", {
                    alwaysOn: !n.alwaysOn,
                  }),
                )
              }
            >
              <Switch.Content className="check muted">
                Always on
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
            {n.id !== data.node && (
              <Button
                size="sm"
                variant="danger-soft"
                onPress={async () => {
                  if (
                    await confirmDialog(
                      `Unpair ${n.id}? It will stop syncing with this node.`,
                      { destructive: true, okLabel: "Unpair" },
                    )
                  )
                    void perform(
                      () =>
                        request(connection, `/nodes/${idPath(n.id)}`, "DELETE"),
                      "Machine unpaired",
                    );
                }}
              >
                Unpair
              </Button>
            )}
          </div>
        ))}
      </Panel>
      {pair && (
        <Modal title="Pair another machine" close={() => setPair("")}>
          <p>
            On the other machine, initialize Agentgate, start Tailscale, then
            run this command. The code expires in 10 minutes.
          </p>
          <pre>{pair}</pre>
          <Button
            size="sm"
            variant="tertiary"
            onPress={() =>
              void perform(
                () => navigator.clipboard.writeText(pair),
                "Pairing command copied",
              )
            }
          >
            <Copy size={15} />
            Copy command
          </Button>
          <p className="note">
            Pair only machines you control. Working account and MCP credentials
            are copied to each paired node.
          </p>
        </Modal>
      )}
      {joinOpen && (
        <Modal title="Join another machine" close={() => setJoinOpen(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void perform(async () => {
                await request(connection, "/nodes/join", "POST", {
                  url: field(f, "url"),
                  code: field(f, "code"),
                });
                setJoinOpen(false);
              }, "Machine paired");
            }}
          >
            <Field
              label="Other machine's Tailscale address"
              name="url"
              type="url"
              isRequired
              placeholder="http://server.tailnet.ts.net:7878"
            />
            <Field
              label="Pairing code"
              name="code"
              isRequired
              placeholder="From agentgate pair on the other machine"
            />
            <Button type="submit" size="sm">
              Join machine
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
