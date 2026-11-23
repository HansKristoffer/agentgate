import { useEffect, useState } from "react";
import { isTruthy } from "hanzio";
import { Copy, Globe, KeyRound, Monitor, Network, Plus } from "lucide-react";
import { Button, Spinner, toast } from "@heroui/react";
import { outdatedNodes, type SharedLogin } from "@agentgate/protocol";
import { confirmDialog } from "@hanskristoffer/taurio/runtime";
import {
  Badge,
  Disclosure,
  Field,
  Modal,
  Panel,
  HeaderActions,
  RowMenu,
  Working,
  usePending,
} from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { INFISICAL_SIGNIN_STARTED, control, request, signInToInfisical } from "../api.ts";
import { useDaemon } from "../useDaemon.ts";
import { MachineHealth } from "./MachineHealth.tsx";
import { field, relative } from "./utils.ts";

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
  const [relayUrl, setRelayUrl] = useState("");
  const [relayKey, setRelayKey] = useState("");
  const [keyOpen, setKeyOpen] = useState(false);
  /** The machine whose health is shown in place of the list. */
  const [healthOf, setHealthOf] = useState<string>();
  const relay = data.relay;
  const pending = usePending();
  const outdated = new Set(outdatedNodes(data.nodes).map((n) => n.id));
  // The machine the pairing command was for has joined: say so, and the dialog has done its job.
  const known = shown?.known;
  const joined = known && data.nodes.find((n) => !known.includes(n.id));
  useEffect(() => {
    if (!joined) return;
    toast(`${joined.id} joined`);
    setShown(undefined);
  }, [joined]);
  const update = (node: string) =>
    void perform(
      async () => {
        const result = await control(connection, "nodes update", { node });
        toast(
          !result.version
            ? `${node} already runs the latest release`
            : result.restarting
              ? `${node} installed Agentgate ${result.version} and is restarting`
              : `${node} installed Agentgate ${result.version}; restart Agentgate there to use it`,
        );
      },
      undefined,
      `update:${node}`,
    );
  const route = (node: string, on: boolean) =>
    void perform(async () => {
      await control(connection, "nodes route", { node, on });
      toast(
        on
          ? `Claude Code and Codex on ${node} now use Agentgate`
          : `Claude Code and Codex on ${node} use their own logins again`,
      );
    });
  const pair = (method: Method) =>
    void perform(async () => {
      if (method === "relay" && relayKey.trim()) await control(connection, "relay key", { key: relayKey.trim() });
      const result = await control(connection, "pair", {
        method,
        ...(name.trim() && { name: name.trim() }),
        ...(method === "relay" && relayUrl.trim() && { relayUrl: relayUrl.trim() }),
      });
      setChoosing(false);
      setName("");
      setRelayKey("");
      setShown({ command: result.command, method, known: data.nodes.map((n) => n.id) });
      for (const note of result.notes) toast(note);
    });
  const leaveRelay = async (wipe: boolean) => {
    if (
      await confirmDialog(
        wipe
          ? "Stop using the relay on this machine and delete the group from the relay? Other machines in the group stop syncing through it."
          : "Stop using the relay on this machine? Other machines keep their copies and can keep using the group.",
        { destructive: true, okLabel: wipe ? "Leave and delete" : "Leave relay" },
      )
    )
      void perform(() => control(connection, "relay leave", wipe ? { wipe } : {}), "Left the relay");
  };
  const relayState =
    relay &&
    [
      relay.reconciling && "Reconciling",
      relay.rotating && "Rotation pending",
      relay.cleanupPending && "Old group cleanup pending",
    ].filter(isTruthy);
  if (healthOf && data.nodes.some((n) => n.id === healthOf))
    return (
      <MachineHealth
        key={healthOf}
        data={data}
        connection={connection}
        node={healthOf}
        onNode={setHealthOf}
        onBack={() => setHealthOf(undefined)}
      />
    );
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
      <Panel foot="Each machine serves its own agents and keeps working offline. Always-on machines refresh tokens while your laptop is away.">
        {data.nodes.map((n) => {
          const viaRelay = !!n.via?.includes("relay");
          const secondary = [
            n.syncError ?? (n.id === data.node ? undefined : `Last seen ${relative(n.lastSeen)}`),
            n.routing && routingText(n.routing),
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <div className="item" key={n.id}>
              <div className="machine-icon">
                <Monitor size={16} />
              </div>
              <div className="grow">
                <div className="row">
                  <span
                    className={`dot ${n.online ? "online" : "offline"}`}
                    title={n.online ? "Online" : "Offline"}
                    aria-label={n.online ? "Online" : "Offline"}
                  />
                  <strong>{n.id}</strong>
                  {n.id === data.node && <Badge>This machine</Badge>}
                  {n.alwaysOn && <Badge good>Always on</Badge>}
                  {pending.has(`alwaysOn:${n.id}`) && <Working>Saving</Working>}
                </div>
                <small>
                  {[
                    n.via?.includes("tailnet") && n.via.includes("relay")
                      ? "Tailscale and relay"
                      : n.via?.includes("tailnet")
                        ? "Tailscale"
                        : viaRelay && "Relay",
                    n.url ?? (viaRelay ? undefined : "Tailscale address not available"),
                    n.version && `v${n.version}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
                {secondary && <small className={n.syncError ? "danger" : ""}>{secondary}</small>}
                {n.update?.state === "failed" && <small className="danger">Update failed: {n.update.error}</small>}
              </div>
              {n.update?.state === "installing" || n.update?.state === "restarting" || pending.has(`update:${n.id}`) ? (
                <Working>
                  {n.update?.state === "restarting" ? `Restarting on ${n.update.version}` : "Installing update"}
                </Working>
              ) : n.update?.state === "installed" ? (
                <small>
                  Restart Agentgate on {n.id} to use {n.update.version}
                </small>
              ) : (
                outdated.has(n.id) && (
                  <Button size="sm" variant="tertiary" onPress={() => update(n.id)}>
                    {n.update?.state === "failed" ? "Retry update" : "Update"}
                  </Button>
                )
              )}
              <RowMenu
                label={`More for ${n.id}`}
                items={[
                  (n.online || n.id === data.node) && { label: "Show health", onAction: () => setHealthOf(n.id) },
                  {
                    label: n.alwaysOn ? "No longer always on" : "Mark as always on",
                    onAction: () =>
                      void perform(
                        () => control(connection, "nodes always-on", { node: n.id, on: !n.alwaysOn }),
                        n.alwaysOn
                          ? `${n.id} is no longer always on`
                          : `${n.id} is always on: it takes care of token refreshes while your other machines are away`,
                        `alwaysOn:${n.id}`,
                      ),
                  },
                  (n.online || n.id === data.node) && {
                    label:
                      n.routing?.claude && n.routing.codex
                        ? "Stop routing Claude Code and Codex"
                        : "Route Claude Code and Codex",
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
                  // Removing a machine can hand out a new relay secret and endpoint URLs, so only the daemon's own
                  // machine does it.
                  n.id !== data.node &&
                    local && {
                      label: viaRelay ? "Remove" : "Unpair",
                      danger: true,
                      onAction: async () => {
                        const endpoints = data.projects.some((p) => p.remote)
                          ? ` Virtual projects get new URLs and secrets, because ${n.id} knows the current ones; update them in Grok.`
                          : "";
                        const message =
                          (viaRelay
                            ? `Remove ${n.id}? The relay secret changes: every other relay machine must join again with the new command. Also remove ${n.id}'s Tailscale pairing on every machine you keep, because a new relay secret cannot revoke those links.`
                            : `Unpair ${n.id}? It will stop syncing with this node.`) + endpoints;
                        if (
                          await confirmDialog(message, {
                            destructive: true,
                            okLabel: viaRelay ? "Remove and rotate" : "Unpair",
                          })
                        )
                          void perform(
                            async () => {
                              const { rotated } = await control(connection, "unpair", { node: n.id });
                              if (rotated) setShown({ command: rotated.command, method: "relay", rotated: true });
                            },
                            viaRelay ? undefined : "Machine unpaired",
                          );
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
          detail={`${relay.hosted ? "Agentgate relay" : relay.url || "No active group"} · end-to-end encrypted`}
          action={
            relay.url && (
              <Button
                size="sm"
                variant="tertiary"
                isPending={pending.has("Relay reconciled")}
                onPress={() => void perform(() => control(connection, "relay reconcile", {}), "Relay reconciled")}
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
                {relayState?.length ? relayState.map((s) => <Badge key={s}>{s}</Badge>) : <Badge good>In sync</Badge>}
              </div>
              {relay.pushError && <small className="danger">Upload: {relay.pushError}</small>}
              {relay.pullError && <small className="danger">Download: {relay.pullError}</small>}
              {!!relay.rotatedAt && (
                <small>
                  The relay secret was rotated after an interruption. Every other relay machine must join again; add a
                  machine over the relay to see the command.
                </small>
              )}
              {!!relay.skipped && (
                <small>
                  {relay.skipped} entries could not be decrypted or validated. Update all nodes and reconcile to retry
                  them.
                </small>
              )}
            </div>
            {/* The new secret, the service key and leaving are for the daemon's own machine (ops/nodes.ts). */}
            <RowMenu
              label="More for the relay"
              items={[
                relay.cleanupPending && {
                  label: "Retry old group cleanup",
                  onAction: () =>
                    void perform(async () => {
                      const r = await control(connection, "relay cleanup", {});
                      toast(r.cleanupPending ? "Some old relay groups could not be deleted yet" : "Old groups deleted");
                    }),
                },
                relay.cleanupPending && {
                  label: "Stop retrying old group cleanup",
                  onAction: () =>
                    void perform(() => control(connection, "relay cleanup", { abandon: true }), "Cleanup stopped"),
                },
                local && { label: "Service key", onAction: () => setKeyOpen(true) },
                local &&
                  !!relay.url && {
                    label: "Rotate relay secret",
                    onAction: async () => {
                      if (
                        await confirmDialog(
                          "Move to a new relay secret? Every other relay machine must join again with the new command.",
                          { destructive: true, okLabel: "Rotate" },
                        )
                      )
                        void perform(async () => {
                          const r = await control(connection, "relay rotate", {});
                          setShown({ command: r.command, method: "relay", rotated: true });
                        });
                    },
                  },
                local &&
                  !!relay.url && {
                    label: "Leave relay",
                    danger: true,
                    onAction: () => void leaveRelay(false),
                  },
                local &&
                  !!relay.url && {
                    label: "Leave and delete the group",
                    danger: true,
                    onAction: () => void leaveRelay(true),
                  },
              ]}
            />
          </div>
        </Panel>
      )}
      <HandoffFolders data={data} connection={connection} perform={perform} local={local} />
      {keyOpen && <RelayKey close={() => setKeyOpen(false)} connection={connection} perform={perform} />}
      {choosing && (
        <Modal title="Pair another machine" close={() => setChoosing(false)}>
          <Field
            label="Name of the other machine"
            description="Leave empty to use its hostname."
            value={name}
            onChange={setName}
            placeholder="mac-mini"
          />
          <p>Choose how the other machine connects.</p>
          {!local && (
            <p className="note">
              A pairing code or relay invite lets whoever has it read every login, so it is only shown on the daemon's
              own machine. Pair from there, or run agentgate pair there.
            </p>
          )}
          <div className="rows mb-3.5">
            <div className="item">
              <div className="machine-icon">
                <Network size={16} />
              </div>
              <div className="grow">
                <strong>Same network (Tailscale)</strong>
                <small>Direct peer sync on your tailnet. Expires in 10 minutes.</small>
              </div>
              <Button size="sm" isDisabled={!local} onPress={() => pair("tailnet")}>
                Use Tailscale
              </Button>
            </div>
            <div className="item">
              <div className="machine-icon">
                <Globe size={16} />
              </div>
              <div className="grow">
                <strong>Agentgate relay</strong>
                <small>Works on any network. End-to-end encrypted.</small>
              </div>
              <Button size="sm" isDisabled={!local} onPress={() => pair("relay")}>
                Use the relay
              </Button>
            </div>
          </div>
          {local && (
            <Disclosure
              summary="Self-hosted relay"
              detail="Optional · leave empty for the hosted Agentgate relay"
              defaultOpen={!!(relayUrl || relayKey)}
            >
              <Field
                label="Relay URL"
                value={relayUrl}
                onChange={setRelayUrl}
                placeholder="https://agentgate-relay.example.workers.dev"
              />
              <Field
                label="Relay service key"
                description="Only when your own relay asks for one."
                type="password"
                value={relayKey}
                onChange={setRelayKey}
              />
            </Disclosure>
          )}
        </Modal>
      )}
      {shown && (
        <Modal title={shown.rotated ? "New relay secret" : "Pair another machine"} close={() => setShown(undefined)}>
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
            onPress={() => void perform(() => navigator.clipboard.writeText(shown.command), "Pairing command copied")}
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
                await control(connection, "join", { command: field(f, "command") });
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

/** The service key a self-hosted relay asks for. Write-only: the daemon never sends a key back. */
function RelayKey({ close, connection, perform }: Pick<ViewProps, "connection" | "perform"> & { close: () => void }) {
  const save = (key: string | null) =>
    void perform(
      async () => {
        await control(connection, "relay key", { key });
        close();
      },
      key ? "Relay service key saved" : "Relay service key cleared",
    );
  return (
    <Modal title="Relay service key" close={close}>
      <p className="muted">Only for your own relay, when it asks for one. The Agentgate relay needs none.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save(field(new FormData(e.currentTarget), "key"));
        }}
      >
        <Field label="Service key" name="key" type="password" isRequired />
        <div className="row">
          <Button type="submit" size="sm">
            Save
          </Button>
          <Button size="sm" variant="tertiary" onPress={() => save(null)}>
            Clear
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Where handoffs put new worktrees and clones on the connected machine (`agentgate t3 dirs`). */
function HandoffFolders({ data, connection, perform }: ViewProps) {
  const dirsRead = useDaemon(() => control(connection, "t3 dirs", {}), {
    topics: [],
    key: "t3-dirs",
    every: 300_000,
    staleTime: 60_000,
  });
  const [editing, setEditing] = useState(false);
  const dirs = dirsRead.data;
  if (!dirs) return null;
  return (
    <Panel
      title="Handoff folders"
      detail={`Where threads handed to ${data.node} place worktrees and cloned repositories`}
      action={
        <Button size="sm" variant="tertiary" onPress={() => setEditing(true)}>
          Change
        </Button>
      }
    >
      <div className="item">
        <div className="grow">
          <strong>Worktrees</strong>
          <small>{dirs.worktreesDir}</small>
        </div>
      </div>
      <div className="item">
        <div className="grow">
          <strong>Clones</strong>
          <small>{dirs.cloneDir}</small>
        </div>
      </div>
      {editing && (
        <Modal title={`Handoff folders on ${data.node}`} close={() => setEditing(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void perform(async () => {
                await control(connection, "t3 dirs", {
                  worktrees: field(f, "worktrees"),
                  clones: field(f, "clones"),
                });
                await dirsRead.reload();
                setEditing(false);
              }, "Handoff folders saved");
            }}
          >
            <Field label="Worktrees" name="worktrees" defaultValue={dirs.worktreesDir} isRequired />
            <Field label="Clones" name="clones" defaultValue={dirs.cloneDir} isRequired />
            <Button type="submit" size="sm">
              Save
            </Button>
          </form>
        </Modal>
      )}
    </Panel>
  );
}

const LOGINS = [
  { id: "github", name: "GitHub" },
  { id: "infisical", name: "Infisical" },
  { id: "opencode", name: "OpenCode" },
  { id: "antigravity", name: "Antigravity" },
] as const;

/** The gh, Infisical and Antigravity CLI logins and OpenCode API keys one machine shares; every other machine signs in with them. */
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
      detail="Share CLI logins across every machine, including servers that join later"
      foot={
        local
          ? undefined
          : "Sharing and signing in use this machine's own logins, so they are only available on the daemon's own machine. To sign in to Infisical on a server without a browser, run agentgate logins signin infisical there in a terminal."
      }
    >
      {LOGINS.map(({ id, name }) => {
        const login = data.logins.find((l) => l.id === id);
        const fromHere = login?.from === data.node;
        const broken = login?.problems.find((p) => p.node === data.node)?.problem;
        const remoteProblems = login?.problems.filter((p) => p.node !== data.node) ?? [];
        const needsAttention = !!login?.error || !!login?.problems.length;
        return (
          <div className="item" key={id}>
            <div className="machine-icon">
              <KeyRound size={16} />
            </div>
            <div className="grow">
              <div className="row">
                <strong>{name}</strong>
                {login && fromHere && (
                  <Badge good={!needsAttention}>
                    {needsAttention ? "Needs attention" : "Shared from this machine"}
                  </Badge>
                )}
                {login && !fromHere && (
                  <Badge good={login.signedIn && !needsAttention}>
                    {!login.signedIn
                      ? "Not signed in here"
                      : broken
                        ? "Not working here"
                        : needsAttention
                          ? "Needs attention"
                          : "Signed in here"}
                  </Badge>
                )}
              </div>
              <small>{login ? `${login.account || "Signed in"} · shared from ${login.from}` : "Not shared"}</small>
              {(login?.error ?? broken) && <small className="danger">{login?.error ?? broken}</small>}
              {remoteProblems.map((p) => (
                <small className="danger" key={p.node}>
                  {p.node}: {p.problem}
                </small>
              ))}
            </div>
            {id === "infisical" && login?.problems.length ? (
              <Button
                size="sm"
                variant="tertiary"
                isDisabled={!local}
                onPress={() => void perform(() => signInToInfisical(connection), INFISICAL_SIGNIN_STARTED)}
              >
                Sign in again
              </Button>
            ) : null}
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
          {identity && (
            <Badge good={identity.signedIn}>{identity.signedIn ? "On this machine" : "Not on this machine yet"}</Badge>
          )}
        </div>
        <small>
          {identity
            ? `${identity.account} · set from ${identity.from}`
            : "Non-expiring Universal Auth credentials for unattended tools like hanzio"}
        </small>
        {identity?.error && <small className="danger">{identity.error}</small>}
      </div>
      <Button size="sm" variant="tertiary" isDisabled={!local} onPress={() => setOpen(true)}>
        {identity ? "Replace" : "Set"}
      </Button>
      {identity && (
        <RowMenu
          label="More for the Infisical machine identity"
          items={[
            {
              label: "Remove from every machine",
              danger: true,
              onAction: async () => {
                if (
                  await confirmDialog("Remove the Infisical machine identity from every machine?", {
                    destructive: true,
                    okLabel: "Remove",
                  })
                )
                  void perform(
                    () => request(connection, "/logins/infisical-identity", "DELETE"),
                    "Infisical machine identity removed",
                  );
              },
            },
          ]}
        />
      )}
      {open && (
        <Modal title="Infisical machine identity" close={() => setOpen(false)}>
          <p className="muted">
            Create a machine identity with Universal Auth in Infisical (Organization → Access Control → Identities) and
            give it access to your projects. agentgate checks it with Infisical, then writes it to
            ~/.infisical/universal-auth.json on every machine.
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
            <Field
              label="Infisical URL"
              name="siteUrl"
              description="Leave empty for the instance the Infisical CLI here uses"
              placeholder="https://eu.infisical.com"
            />
            <Button type="submit" size="sm">
              Save
            </Button>
          </form>
        </Modal>
      )}
    </div>
  );
}
