import { useState } from "react";
import { Copy, Globe, Monitor, Network, Plus } from "lucide-react";
import { Button, Switch } from "@heroui/react";
import { confirmDialog } from "@hanskristoffer/taurio/runtime";
import {
  Badge,
  Field,
  Modal,
  Panel,
  HeaderActions,
  RowMenu,
} from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { request } from "../api.ts";
import { field, idPath, relative } from "./utils.ts";

type Method = "tailnet" | "relay";
type Shown = { command: string; method: Method; rotated?: boolean };

export function Nodes({ data, connection, perform, local }: ViewProps) {
  const [choosing, setChoosing] = useState(false);
  const [shown, setShown] = useState<Shown>();
  const [joinOpen, setJoinOpen] = useState(false);
  const relay = data.relay;
  const pair = (method: Method) =>
    void perform(async () => {
      const result = await request<{ command: string }>(
        connection,
        "/nodes/pair",
        "POST",
        { method },
      );
      setChoosing(false);
      setShown({ command: result.command, method });
    });
  const relayState = relay && [
    relay.reconciling && "Reconciling",
    relay.rotating && "Rotation pending",
    relay.cleanupPending && "Old group cleanup pending",
  ].filter(Boolean);
  return (
    <>
      <HeaderActions>
        <Button size="sm" variant="tertiary" onPress={() => setJoinOpen(true)}>
          Join another machine
        </Button>
        <Button size="sm" onPress={() => setChoosing(true)}>
          <Plus size={15} />
          Pair a machine
        </Button>
      </HeaderActions>
      <Panel
        foot="Each machine serves its own agents and keeps working offline. Always-on machines take care of token refreshes while your laptop is away."
      >
        {data.nodes.map((n) => {
          const viaRelay = !!n.via?.includes("relay");
          return (
            <div className="item" key={n.id}>
              <div className="machine-icon">
                <Monitor size={16} />
              </div>
              <div className="grow">
                <div className="row">
                  <strong>{n.id}</strong>
                  {n.id === data.node && <Badge>This node</Badge>}
                  <Badge good={n.online}>{n.online ? "Online" : "Offline"}</Badge>
                  {n.via?.includes("tailnet") && <Badge>Tailscale</Badge>}
                  {viaRelay && <Badge>Relay</Badge>}
                </div>
                <small>
                  {n.url ??
                    (viaRelay
                      ? "Connected through the relay"
                      : "Tailscale address not available")}
                </small>
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
              {n.id !== data.node && !(viaRelay && !local) && (
                // A relay removal rotates the relay secret, which only that daemon's own machine can hand out.
                <RowMenu
                  label={`More for ${n.id}`}
                  items={[
                    {
                      label: viaRelay ? "Remove" : "Unpair",
                      danger: true,
                      onAction: async () => {
                        const endpoints = data.projects.some((p) => p.remote)
                          ? ` Virtual projects get new URLs and secrets, because ${n.id} knows the current ones; update them in Grok.`
                          : "";
                        const message = (viaRelay
                          ? `Remove ${n.id}? The relay secret changes: every other relay machine must join again with the new command. Also remove ${n.id}'s Tailscale pairing on every machine you keep, because a new relay secret cannot revoke those links.`
                          : `Unpair ${n.id}? It will stop syncing with this node.`) + endpoints;
                        if (
                          await confirmDialog(message, {
                            destructive: true,
                            okLabel: viaRelay ? "Remove and rotate" : "Unpair",
                          })
                        )
                          void perform(async () => {
                            const result = await request<{
                              rotated?: boolean;
                              command?: string;
                            }>(connection, `/nodes/${idPath(n.id)}`, "DELETE");
                            if (result.rotated && result.command)
                              setShown({
                                command: result.command,
                                method: "relay",
                                rotated: true,
                              });
                          }, viaRelay ? undefined : "Machine unpaired");
                      },
                    },
                  ]}
                />
              )}
            </div>
          );
        })}
      </Panel>
      {relay && (
        <Panel
          title="Relay"
          detail={`${relay.hosted ? "Agentgate relay" : relay.url || "No active group"}. End-to-end encrypted: the relay can't read your credentials.`}
          action={
            relay.url && (
              <Button
                size="sm"
                variant="tertiary"
                onPress={() =>
                  void perform(
                    () => request(connection, "/relay/reconcile", "POST"),
                    "Relay reconciled",
                  )
                }
              >
                Reconcile now
              </Button>
            )
          }
        >
          <div className="item">
            <div className="grow">
              <div className="row">
                {relayState?.length ? (
                  relayState.map((s) => <Badge key={String(s)}>{s}</Badge>)
                ) : (
                  <Badge good>In sync</Badge>
                )}
              </div>
              {relay.pushError && <small>Upload: {relay.pushError}</small>}
              {relay.pullError && <small>Download: {relay.pullError}</small>}
              {!!relay.skipped && (
                <small>
                  {relay.skipped} entries could not be decrypted or validated. Update all nodes and reconcile to
                  retry them.
                </small>
              )}
            </div>
            {relay.url && (
              <Button
                size="sm"
                variant="danger-soft"
                onPress={async () => {
                  if (
                    await confirmDialog(
                      "Stop using the relay on this machine? Other machines keep their copies and can keep using the group.",
                      { destructive: true, okLabel: "Leave relay" },
                    )
                  )
                    void perform(
                      () => request(connection, "/relay/leave", "POST", {}),
                      "Left the relay",
                    );
                }}
              >
                Leave
              </Button>
            )}
          </div>
        </Panel>
      )}
      {choosing && (
        <Modal title="Pair another machine" close={() => setChoosing(false)}>
          <p>How will the other machine connect?</p>
          <div className="rows">
            <div className="item">
              <div className="machine-icon">
                <Network size={16} />
              </div>
              <div className="grow">
                <strong>Same network (Tailscale)</strong>
                <small>
                  Both machines are on your tailnet. The code expires in 10
                  minutes.
                </small>
              </div>
              <Button size="sm" onPress={() => pair("tailnet")}>
                Use Tailscale
              </Button>
            </div>
            <div className="item">
              <div className="machine-icon">
                <Globe size={16} />
              </div>
              <div className="grow">
                <strong>Agentgate relay</strong>
                <small>
                  {local
                    ? "Works on any network. End-to-end encrypted: the relay can't read your credentials."
                    : "The relay invite is a master key, so it is only shown on the daemon's own machine. Run this there."}
                </small>
              </div>
              <Button
                size="sm"
                isDisabled={!local}
                onPress={() => pair("relay")}
              >
                Use the relay
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {shown && (
        <Modal
          title={shown.rotated ? "New relay secret" : "Pair another machine"}
          close={() => setShown(undefined)}
        >
          <p>
            {shown.rotated
              ? "Run this on every relay machine you keep. The old secret no longer reaches this machine."
              : shown.method === "relay"
                ? "On the other machine, initialize Agentgate, then run this command."
                : "On the other machine, initialize Agentgate, start Tailscale, then run this command. The code expires in 10 minutes."}
          </p>
          <pre>{shown.command}</pre>
          <Button
            size="sm"
            variant="tertiary"
            onPress={() =>
              void perform(
                () => navigator.clipboard.writeText(shown.command),
                "Pairing command copied",
              )
            }
          >
            <Copy size={15} />
            Copy command
          </Button>
          <p className="note">
            {shown.method === "relay"
              ? "This invite does not expire. Anyone who has it can read every account and MCP login: share it privately. If it leaks, remove and re-add machines to change the secret."
              : "Pair only machines you control. Working account and MCP credentials are copied to each paired node."}
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
                  command: field(f, "command"),
                });
                setJoinOpen(false);
              }, "Machine paired");
            }}
          >
            <Field
              label="Pairing command"
              name="command"
              isRequired
              multiline
              placeholder="agentgate join …, from Pair a machine on the other machine"
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
