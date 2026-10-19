import { useEffect, useState } from "react";
import { Copy, ExternalLink, Globe, KeyRound, Monitor, Network, Plus } from "lucide-react";
import { Button, Spinner, Switch, toast } from "@heroui/react";
import { HEALTH_PATH, outdatedNodes, type SharedLogin } from "@agentgate/protocol";
import { confirmDialog } from "@hanskristoffer/taurio/runtime";
import {
  Badge,
  Field,
  Modal,
  Panel,
  HeaderActions,
  LiveSwitch,
  RowMenu,
  usePending,
} from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { openExternal, request } from "../api.ts";
import { field, idPath, relative } from "./utils.ts";

type Method = "tailnet" | "relay";
/** `known`: the machines there were when the command was shown, so the one that joins can be told apart. */
type Shown = { command: string; method: Method; rotated?: boolean; known?: string[] };

const routingText = (r: { claude: boolean; codex: boolean }) =>
  r.claude && r.codex
    ? "Claude Code and Codex use Agentgate"
    : r.claude || r.codex
      ? `Only ${r.claude ? "Claude Code" : "Codex"} uses Agentgate`
      : "Claude Code and Codex use their own logins";

export function Nodes({ data, connection, perform, local }: ViewProps) {
  const [choosing, setChoosing] = useState(false);
  const [shown, setShown] = useState<Shown>();
  const [joinOpen, setJoinOpen] = useState(false);
  const [name, setName] = useState("");
  const relay = data.relay;
  const pending = usePending();
  const outdated = new Set(outdatedNodes(data.nodes).map((n) => n.id));
  // The machine the pairing command was for has joined: say so, and the dialog has done its job.
  const joined = shown?.known && data.nodes.find((n) => !shown.known!.includes(n.id));
  useEffect(() => {
    if (!joined) return;
    toast(`${joined.id} joined`);
    setShown(undefined);
  }, [joined]);
  const update = (node: string) =>
    void perform(async () => {
      const result = await request<{ version?: string; restarting: boolean }>(
        connection,
        `/nodes/${idPath(node)}/update`,
        "POST",
      );
      toast(
        !result.version
          ? `${node} already runs the latest release`
          : result.restarting
            ? `${node} installed Agentgate ${result.version} and is restarting`
            : `${node} installed Agentgate ${result.version}; restart Agentgate there to use it`,
      );
    }, undefined, `update:${node}`);
  const route = (node: string, on: boolean) =>
    void perform(async () => {
      await request(connection, `/nodes/${idPath(node)}/primary`, "POST", { on });
      toast(on ? `Claude Code and Codex on ${node} now use Agentgate` : `Claude Code and Codex on ${node} use their own logins again`);
    });
  const pair = (method: Method) =>
    void perform(async () => {
      const result = await request<{ command: string }>(
        connection,
        "/nodes/pair",
        "POST",
        { method, ...(name.trim() ? { name: name.trim() } : {}) },
      );
      setChoosing(false);
      setName("");
      setShown({ command: result.command, method, known: data.nodes.map((n) => n.id) });
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
          // This machine's dashboard is opened on loopback, which works without Tailscale; the others at their address.
          const origin = n.id === data.node && local ? connection.url.replace(/\/$/, "") : n.url;
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
                  {n.version && ` · Agentgate ${n.version}`}
                </small>
                {n.update?.state === "failed" && <small>Update failed: {n.update.error}</small>}
                {n.routing && <small>{routingText(n.routing)}</small>}
              </div>
              {n.update?.state === "installing" || n.update?.state === "restarting" || pending.has(`update:${n.id}`) ? (
                <Badge>
                  <Spinner size="sm" color="current" />
                  {n.update?.state === "restarting" ? `Restarting on ${n.update.version}` : "Installing update"}
                </Badge>
              ) : n.update?.state === "installed" ? (
                <small>Restart Agentgate on {n.id} to use {n.update.version}</small>
              ) : (
                outdated.has(n.id) && (
                  <Button size="sm" variant="tertiary" onPress={() => update(n.id)}>
                    {n.update?.state === "failed" ? "Retry update" : "Update"}
                  </Button>
                )
              )}
              {n.healthDashboard && origin && (n.online || n.id === data.node) && (
                <Button
                  size="sm"
                  variant="tertiary"
                  onPress={() => void perform(() => openExternal(`${origin}${HEALTH_PATH}`), undefined, `open:${n.id}`)}
                >
                  <ExternalLink size={15} />
                  Open dashboard
                </Button>
              )}
              <LiveSwitch
                isSelected={!!n.healthDashboard}
                onChange={(on) =>
                  perform(
                    () =>
                      request(connection, `/nodes/${idPath(n.id)}/dashboard`, "POST", {
                        on,
                      }),
                    undefined,
                    `dashboard:${n.id}`,
                  )
                }
              >
                <Switch.Content className="check muted">
                  Dashboard
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Content>
              </LiveSwitch>
              <LiveSwitch
                isSelected={!!n.alwaysOn}
                onChange={(on) =>
                  perform(() =>
                    request(connection, `/nodes/${idPath(n.id)}`, "PATCH", {
                      alwaysOn: on,
                    }),
                    undefined,
                    `alwaysOn:${n.id}`,
                  )
                }
              >
                <Switch.Content className="check muted">
                  Always on
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Content>
              </LiveSwitch>
              <RowMenu
                label={`More for ${n.id}`}
                items={[
                  (n.online || n.id === data.node) && {
                    label: n.routing?.claude && n.routing.codex ? "Stop routing Claude Code and Codex" : "Route Claude Code and Codex",
                    onAction: async () => {
                      const on = !(n.routing?.claude && n.routing.codex);
                      if (
                        await confirmDialog(
                          on
                            ? `Route ${n.id}'s own Claude Code and Codex through Agentgate? This changes ~/.claude and ~/.codex on ${n.id}; you can undo it here.`
                            : `Stop routing ${n.id}'s Claude Code and Codex? They go back to the logins they had before, and stop if they had none.`,
                          { okLabel: on ? "Route" : "Stop routing" },
                        )
                      )
                        route(n.id, on);
                    },
                  },
                  // A relay removal rotates the relay secret, which only that daemon's own machine can hand out.
                  n.id !== data.node && !(viaRelay && !local) && {
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
            </div>
          );
        })}
      </Panel>
      <SharedLogins data={data} connection={connection} perform={perform} local={local} />
      {relay && (
        <Panel
          title="Relay"
          detail={`${relay.hosted ? "Agentgate relay" : relay.url || "No active group"}. End-to-end encrypted: the relay can't read your credentials.`}
          action={
            relay.url && (
              <Button
                size="sm"
                variant="tertiary"
                isPending={pending.has("Relay reconciled")}
                onPress={() =>
                  void perform(
                    () => request(connection, "/relay/reconcile", "POST"),
                    "Relay reconciled",
                  )
                }
              >
                {pending.has("Relay reconciled") && <Spinner size="sm" color="current" />}
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
          <Field
            label="Name of the other machine"
            description="Leave empty to use its hostname."
            value={name}
            onChange={setName}
            placeholder="mac-mini"
          />
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
                ? "Run this on the other machine. It installs Agentgate, joins this machine, starts the service and routes that machine's Claude Code and Codex through Agentgate."
                : "Start Tailscale on the other machine, then run this there. It installs Agentgate, joins this machine, starts the service and routes that machine's Claude Code and Codex through Agentgate. The code expires in 10 minutes."}
          </p>
          <pre>{shown.command}</pre>
          {shown.known && (
            <p className="row note">
              <Spinner size="sm" color="current" />
              Waiting for the other machine to join
            </p>
          )}
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
              placeholder="The command from Pair a machine on the other machine"
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

const LOGINS = [
  { id: "github", name: "GitHub", tool: "gh" },
  { id: "infisical", name: "Infisical", tool: "the Infisical CLI" },
] as const;

/** The gh and Infisical CLI logins one machine shares; every other machine signs in with them. */
function SharedLogins({ data, connection, perform, local }: ViewProps) {
  const share = (id: SharedLogin["id"]) =>
    void perform(async () => {
      const { results } = await request<{ results: { account?: string; skipped?: string }[] }>(
        connection,
        "/logins/share",
        "POST",
        { id },
      );
      for (const r of results) {
        const account = r.account ? ` ${r.account}` : "";
        toast(r.skipped ? `Not shared: ${r.skipped}` : `Shared${account}; every machine signs in with it`);
      }
    });
  return (
    <Panel
      title="Shared logins"
      detail="Sign every machine in to GitHub and Infisical, including servers that join later."
      foot={local ? undefined : "Sharing reads this machine's own logins, so it is only available on the daemon's own machine."}
    >
      {LOGINS.map(({ id, name, tool }) => {
        const login = data.logins.find((l) => l.id === id);
        const fromHere = login?.from === data.node;
        return (
          <div className="item" key={id}>
            <div className="machine-icon">
              <KeyRound size={16} />
            </div>
            <div className="grow">
              <div className="row">
                <strong>{name}</strong>
                {login && fromHere && <Badge good={!login.error}>Shared from this machine</Badge>}
                {login && !fromHere && (
                  <Badge good={login.signedIn}>{login.signedIn ? "Signed in here" : "Not signed in here"}</Badge>
                )}
              </div>
              <small>
                {login
                  ? `${login.account || "Signed in"} · shared from ${login.from}`
                  : `Not shared. Share ${tool}'s login from the machine where you are signed in.`}
              </small>
              {login?.error && <small>{login.error}</small>}
            </div>
            {(!login || fromHere) && (
              <Button size="sm" variant="tertiary" isDisabled={!local} onPress={() => share(id)}>
                {login ? "Share again" : "Share"}
              </Button>
            )}
            {login && (
              <RowMenu
                label={`More for ${name}`}
                items={[
                  {
                    label: "Stop sharing",
                    danger: true,
                    onAction: async () => {
                      const confirmed = await confirmDialog(
                        `Stop sharing the ${name} login? Machines already signed in stay signed in.`,
                        { destructive: true, okLabel: "Stop sharing" },
                      );
                      if (confirmed)
                        void perform(
                          () => request(connection, `/logins/${id}`, "DELETE"),
                          `${name} login no longer shared`,
                        );
                    },
                  },
                ]}
              />
            )}
          </div>
        );
      })}
      <InfisicalIdentity data={data} connection={connection} perform={perform} local={local} />
    </Panel>
  );
}

/** An Infisical machine identity on every machine, for tools that run unattended (hanzio reads it when a process has no
 * client credentials). Unlike a user login it does not expire. */
function InfisicalIdentity({ data, connection, perform, local }: ViewProps) {
  const [open, setOpen] = useState(false);
  const identity = data.logins.find((l) => l.id === "infisical-identity");
  return (
    <div className="item">
      <div className="machine-icon">
        <KeyRound size={16} />
      </div>
      <div className="grow">
        <div className="row">
          <strong>Infisical machine identity</strong>
          {identity && <Badge good={identity.signedIn}>{identity.signedIn ? "On this machine" : "Not on this machine yet"}</Badge>}
        </div>
        <small>
          {identity
            ? `${identity.account} · set from ${identity.from}`
            : "For unattended tools such as hanzio: a Universal Auth client id and secret that does not expire, kept on every machine."}
        </small>
        {identity?.error && <small>{identity.error}</small>}
      </div>
      <Button size="sm" variant="tertiary" isDisabled={!local} onPress={() => setOpen(true)}>
        {identity ? "Replace" : "Set"}
      </Button>
      {identity && (
        <RowMenu
          label="More for the Infisical machine identity"
          items={[{
            label: "Remove from every machine",
            danger: true,
            onAction: async () => {
              if (await confirmDialog("Remove the Infisical machine identity from every machine?", { destructive: true, okLabel: "Remove" }))
                void perform(() => request(connection, "/logins/infisical-identity", "DELETE"), "Infisical machine identity removed");
            },
          }]}
        />
      )}
      {open && (
        <Modal title="Infisical machine identity" close={() => setOpen(false)}>
          <p className="muted">
            Create a machine identity with Universal Auth in Infisical (Organization → Access Control → Identities) and give it
            access to your projects. agentgate checks it with Infisical, then writes it to ~/.infisical/universal-auth.json on
            every machine.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const siteUrl = field(f, "siteUrl");
              void perform(async () => {
                await request(connection, "/logins/infisical-identity", "PUT", {
                  clientId: field(f, "clientId"),
                  clientSecret: field(f, "clientSecret"),
                  ...(siteUrl && { siteUrl }),
                });
                setOpen(false);
              }, "Infisical machine identity set on every machine");
            }}
          >
            <Field label="Client ID" name="clientId" isRequired />
            <Field label="Client secret" name="clientSecret" type="password" isRequired />
            <Field label="Infisical URL" name="siteUrl" description="Leave empty for the instance the Infisical CLI here uses" placeholder="https://eu.infisical.com" />
            <Button type="submit" size="sm">Save</Button>
          </form>
        </Modal>
      )}
    </div>
  );
}
