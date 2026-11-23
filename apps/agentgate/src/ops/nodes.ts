import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { machineHealthSchema, type MachineHealth } from "@agentgate/protocol";
import { getErrorMessage } from "hanzio";
import { z } from "zod";
import type { Ctx } from "../daemon.ts";
import { PeerError, peerCall } from "../handoff/jobs.ts";
import { defineLocal } from "../local-state.ts";
import {
  cleanupRelay,
  createRelay,
  installAndJoin,
  joinRelay,
  leaveRelay,
  newNodeName,
  parseJoin,
  reconcileRelay,
  RelayBusy,
  RelayError,
  relayInvite,
  relayStatus,
  rotateRelay,
  setServiceKey,
  via,
} from "../relay.ts";
import { regenerateAfterUnpair } from "../remote.ts";
import type { Store } from "../store.ts";
import { join, pairCode, peers, tailscale, unpair } from "../sync.ts";
import { nodeUpdate, routeNode, updateTracked } from "../update.ts";
import { asUserError, controlOp, onOff, parseWords, UserError } from "./registry.ts";

/** The machines family's control operations: pairing, the relay, and what one machine changes on another. */

const nodeId = z.string().min(1).max(512);
const throwUser = (message: string): never => {
  throw new UserError(message);
};
const machine = (s: Store, id: string) => s.get("node", id) ?? throwUser(`No machine named ${id}`);

/** The relay words its errors as sanitized summaries (relay.ts), safe for the caller. */
const relayed = <T>(fn: () => T) =>
  asUserError(fn, (e) => (e instanceof RelayError || e instanceof RelayBusy ? e.message : undefined));

const counts = (s: Store) => ({
  accounts: s.list("account").length,
  servers: s.list("mcp").length,
  projects: s.list("project").length,
});

// Not loopback-only: marking your server always on from the laptop you are on is the point.
controlOp({
  name: "nodes always-on",
  summary: "mark a machine always on: it takes care of token refreshes while your other machines are away",
  input: z.object({ node: nodeId, on: z.boolean() }).strict(),
  needs: "store",
  run({ node, on }, { s }) {
    return s.put("node", node, { ...machine(s, node), alwaysOn: on });
  },
  terminal: {
    usage: "nodes always-on <node> on|off",
    parse(args) {
      const [node, state, ...extra] = args;
      if (!node || extra.length) throw new UserError();
      return { input: { node, on: onOff(state) } };
    },
    print(n) {
      return [
        n.alwaysOn
          ? `${n.id} is always on: it takes care of token refreshes while your other machines are away`
          : `${n.id} is no longer always on`,
      ];
    },
  },
});

// Loopback-only: a pairing code, and even more a relay invite, lets whoever holds it read every login.
controlOp({
  name: "pair",
  summary: "print the command that sets up another machine and joins it to this one",
  input: z
    .object({
      method: z.enum(["tailnet", "relay"]).optional(), // with none, Tailscale when it runs here
      name: z.string().max(63).optional(),
      relayUrl: z.string().max(2000).optional(),
    })
    .strict(),
  needs: "store",
  loopbackOnly: true,
  async run({ method, name, relayUrl }, { s }) {
    const named = name?.trim() ? await relayed(() => newNodeName(s, name.trim())) : undefined;
    method ??= relayUrl ? "relay" : (await tailscale()) ? "tailnet" : "relay";
    if (method === "relay") {
      const args = await relayed(() => createRelay(s, relayUrl));
      const pushError = relayStatus(s)?.pushError;
      return {
        method,
        command: installAndJoin(args, named),
        args,
        notes: [
          ...(process.env.AGENTGATE_RELAY_KEY || s.local("relay:serviceKey")
            ? ["This relay needs a service key: set AGENTGATE_RELAY_KEY on the other machine before joining."]
            : []),
          ...(pushError ? [`Upload not finished yet: ${pushError}. The daemon keeps retrying.`] : []),
        ],
      };
    }
    const url = s.get("node", s.nodeId)?.url ?? (await tailscale())?.url;
    if (!url) throw new UserError("Start Tailscale before pairing, or pair over the relay (agentgate pair --relay)");
    const args = `${url} ${pairCode(s)}`;
    return { method, command: installAndJoin(args, named), args, expiresIn: 600, notes: [] };
  },
  terminal: {
    usage: "pair [--name <name>] [--tailnet | --relay [--relay-url <url>]]",
    parse(args) {
      const { values, positionals } = parseWords(args, {
        name: { type: "string" },
        tailnet: { type: "boolean" },
        relay: { type: "boolean" },
        "relay-url": { type: "string" },
      });
      const relay = values.relay || values["relay-url"] !== undefined;
      if (positionals.length || (relay && values.tailnet)) throw new UserError();
      return {
        input: {
          ...(values.tailnet && { method: "tailnet" }),
          ...(relay && { method: "relay" }),
          ...(values.name !== undefined && { name: values.name }),
          ...(values["relay-url"] !== undefined && { relayUrl: values["relay-url"] }),
        },
      };
    },
    print(r, { input }) {
      const name = input.name?.trim();
      return [
        ...(r.method === "tailnet"
          ? ["Start Tailscale on the other machine. The code is valid for 10 minutes.", ""]
          : []),
        `On the other machine run this to install agentgate${name ? ` as ${name}` : ""}, join, start the service and route its Claude Code and Codex through agentgate:`,
        "",
        `  ${r.command}`,
        "",
        "If agentgate is already installed there, run instead:",
        "",
        `  agentgate join ${r.args}`,
        "",
        ...(r.method === "relay"
          ? [
              "This invite does not expire. Anyone who has it can read every account and MCP login, so share it privately.",
              "If it leaks, run `agentgate relay rotate` and have every relay machine join again.",
            ]
          : []),
        ...r.notes,
      ];
    },
  },
});

/** `join`'s own refusals name only the status; a network error's text is another program's, so only the URL is named. */
async function joinPeer(s: Store, url: string, code: string) {
  const self = s.get("node", s.nodeId)?.url ?? (await tailscale())?.url;
  if (!self) throw new UserError("Start Tailscale before pairing");
  try {
    return await join(s, url, code, self);
  } catch (e) {
    if (e instanceof z.ZodError) throw e;
    const status = e instanceof Error && /^join failed: (\d+)$/.exec(e.message)?.[1];
    throw new UserError(status ? `${url} refused to pair (HTTP ${status})` : `Could not pair with ${url}`);
  }
}

// Not loopback-only: joining takes a secret in, it never shows one.
controlOp({
  name: "join",
  summary: "connect to a paired machine (Tailscale) or a relay group, from the command `pair` printed",
  input: z.object({ command: z.string().min(1).max(4096) }).strict(),
  needs: "store",
  async run({ command }, { s }) {
    const target = await relayed(() => parseJoin(command));
    let peer: string | undefined;
    if ("invite" in target) {
      await relayed(() => joinRelay(s, target.invite, target.force));
    } else {
      peer = await joinPeer(s, target.url, target.code);
    }
    return { peer, ...counts(s) };
  },
  terminal: {
    usage: "join <url> <code> | join agr1.… [--force]",
    parse(args) {
      if (!args.length) throw new UserError();
      return { input: { command: args.join(" ") } };
    },
    print(r) {
      const joined = r.peer ? `paired with ${r.peer}` : "joined the relay";
      return [`${joined}; ${r.accounts} accounts, ${r.servers} MCP instances, ${r.projects} projects`];
    },
  },
});

// Loopback-only: new endpoint URLs and a new relay secret are credentials.
controlOp({
  name: "unpair",
  summary: "stop syncing with a machine; removing a relay machine rotates the relay secret",
  input: z.object({ node: nodeId }).strict(),
  needs: "store",
  loopbackOnly: true,
  async run({ node }, { s, daemon }) {
    const isKnown = s.get("node", node) || peers(s).some((p) => p.node === node);
    if (!isKnown) throw new UserError(`No machine named ${node}`);

    // Only a new relay secret shuts a relay machine out, and every remote endpoint then gets a URL it has never seen.
    // The rotation goes first, so a failed one changes nothing and can be retried.
    const rotated = relayInvite(s) && via(s, node).includes("relay") ? await relayed(() => rotateRelay(s)) : undefined;
    const endpoints = regenerateAfterUnpair(s, node);
    unpair(s, node);
    if (endpoints.length) daemon?.remote.reconcile();
    return rotated ? { endpoints, rotated } : { endpoints };
  },
  terminal: {
    usage: "unpair <node>",
    parse([node, ...extra]) {
      if (!node || extra.length) throw new UserError();
      return { input: { node } };
    },
    print({ endpoints, rotated }, { input: { node } }) {
      return [
        ...endpoints.map(
          (e) => `${e.project} has a new URL; update it in Grok: ${e.url} (agentgate remote show ${e.project})`,
        ),
        ...(rotated
          ? [
              "Moved this machine to a new relay secret. Every other relay machine must join again:",
              "",
              `  ${rotated.command}`,
              "",
              `Also remove ${node}'s Tailscale pairing from every machine you keep: rotation cannot revoke those links. If ${node} may be compromised, log in to its accounts again.`,
              ...(rotated.cleanupPending
                ? ["Deleting the old relay group failed; it will be retried (agentgate relay cleanup)."]
                : []),
            ]
          : ["ok"]),
      ];
    },
  },
});

/** A machine's health, from its own daemon (health.ts): this one's directly, another's over Tailscale or the relay. */
async function machineHealth(s: Store, daemon: Ctx, node: string) {
  if (node === s.nodeId) return asUserError(() => daemon.health.read());
  machine(s, node);
  try {
    return await peerCall(s, node, "/health", machineHealthSchema);
  } catch (e) {
    // Its /health route never answers 404, so a 404 is a daemon from before it.
    if (e instanceof PeerError && e.status === 404) {
      throw new UserError(
        `${node} runs an older Agentgate that cannot report its health. Update it with \`agentgate update ${node}\`.`,
      );
    }
    throw new UserError(getErrorMessage(e));
  }
}

const gb = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(2)} TB` : `${value.toFixed(0)} GB`);
const upDown = (up: boolean) => (up ? "up" : "down");

/** What `agentgate health` prints: the numbers the app's health view shows, without the charts. */
function printHealth(h: MachineHealth) {
  const { load, memory, disk, pressure, disk_io: io, network, workload: w } = h;
  const services = [
    `Tailscale ${upDown(h.services.tailscale)}`,
    h.services.docker !== undefined && `Docker ${upDown(h.services.docker)}`,
    h.services.t3_code !== undefined && `T3 Code ${upDown(h.services.t3_code)}`,
  ].filter(Boolean);
  return [
    `${h.host}: up ${Math.round(h.uptime_hours)} h, ${services.join(", ")}`,
    `CPU        ${h.cpu_used_percent.toFixed(0)}% of ${h.cpus} cores, load per core ${load.per_cpu_1m.toFixed(2)} (${load["1m"]} ${load["5m"]} ${load["15m"]})`,
    `Memory     ${memory.used_percent.toFixed(0)}%, ${gb(memory.used_gb)} of ${gb(memory.total_gb)}`,
    `Disk       ${disk.used_percent.toFixed(0)}%, ${gb(disk.used_gb)} of ${gb(disk.total_gb)}, ${gb(disk.free_gb)} free`,
    `Pressure   CPU ${pressure.cpu.toFixed(1)}%, memory ${pressure.memory.toFixed(1)}%, I/O ${pressure.io.toFixed(1)}% (last 10 s)`,
    `Disk I/O   ${io.busy_percent.toFixed(0)}% busy, read ${io.read_mb_s.toFixed(1)} MB/s, write ${io.write_mb_s.toFixed(1)} MB/s`,
    `Network    ${network.in_mbit_s.toFixed(1)} Mbit/s in, ${network.out_mbit_s.toFixed(1)} Mbit/s out (${network.interface})`,
    `Agents     ${w.agents.claude + w.agents.codex} (Claude Code ${w.agents.claude}, Codex ${w.agents.codex})`,
    `CI runners ${w.runners.busy} of ${w.runners.total} busy`,
    `Containers ${w.containers.running} running`,
    `OOM kills  ${w.oom_kills.last_hour} in the last hour, ${w.oom_kills.since_boot} since boot`,
    ...(h.daemon_lag ? [`Agentgate  event loop ${h.daemon_lag.worstMs} ms worst, p99 ${h.daemon_lag.p99Ms} ms`] : []),
    "",
    "Top programs by CPU",
    ...h.top_processes.map(
      (p) =>
        `  ${p.program.padEnd(24)} ${String(p.processes).padStart(4)} proc  ${p.cpu_cores.toFixed(2).padStart(6)} cores  ${p.memory_gb.toFixed(2).padStart(6)} GB`,
    ),
  ];
}

// Not loopback-only: watching your server from the laptop you are on is the point.
controlOp({
  name: "health",
  summary: "a Linux machine's CPU, memory, disk, pressure and agents; the app also charts its last hour",
  input: z.object({ node: nodeId.optional() }).strict(),
  needs: "daemon",
  run({ node }, { s, daemon }) {
    return machineHealth(s, daemon!, node ?? s.nodeId);
  },
  terminal: {
    usage: "health [--node <node>] [--json]",
    parse(args) {
      const { values, positionals } = parseWords(args, { node: { type: "string" }, json: { type: "boolean" } });
      if (positionals.length) throw new UserError();
      return { input: values.node !== undefined ? { node: values.node } : {}, json: values.json };
    },
    print(health, { json }) {
      return json ? [JSON.stringify(health, null, 2)] : printHealth(health);
    },
  },
});

// The CLI's words for these two are `update <node>` and `setup --primary [off] --node <node>` (cli/system.ts), which
// also do the same on this machine without a daemon. Neither is loopback-only: updating or routing your server from
// the laptop you are on is the point (see routeNode).
controlOp({
  name: "nodes update",
  summary: "install the latest release on a machine and restart its service",
  input: z.object({ node: nodeId }).strict(),
  needs: "daemon",
  async run({ node }, { s }) {
    machine(s, node);
    try {
      return await updateTracked(s, node);
    } catch {
      // updateTracked records a failure in words it chose; it throws without one only when an update already runs.
      const u = nodeUpdate(s, node);
      throw new UserError(u?.state === "failed" ? u.error : `${node} is already updating`);
    }
  },
});

controlOp({
  name: "nodes route",
  summary: "route a machine's own Claude Code and Codex through agentgate, or stop",
  input: z.object({ node: nodeId, on: z.boolean() }).strict(),
  needs: "daemon",
  async run({ node, on }, { s }) {
    machine(s, node);
    try {
      return await routeNode(s, node, on);
    } catch (e) {
      // routeHere and peerCall word their errors for the user; a paired node answers 409 with routeHere's.
      if (e instanceof PeerError && e.status !== 409) throw new UserError(`${node} answered ${e.status}`);
      throw new UserError(getErrorMessage(e));
    }
  },
});

const noInput = z.object({}).strict();
const noWords = (args: string[]) => {
  if (args.length) throw new UserError();
  return { input: {} };
};

controlOp({
  name: "relay reconcile",
  summary: "read the whole relay group again and retry entries that could not be decrypted",
  input: noInput,
  needs: "store",
  async run(_, { s }) {
    await relayed(() => reconcileRelay(s));
    return { ok: true as const };
  },
  terminal: { usage: "relay reconcile", parse: noWords, print: () => ["reconciled"] },
});

// Loopback-only: the new join command carries the new secret.
controlOp({
  name: "relay rotate",
  summary: "move to a new relay secret; every other relay machine must join again",
  input: noInput,
  needs: "store",
  loopbackOnly: true,
  run: (_, { s }) => relayed(() => rotateRelay(s)),
  terminal: {
    usage: "relay rotate",
    parse: noWords,
    print: (r) => [
      "New relay secret. Every other relay machine must join again:",
      "",
      `  ${r.command}`,
      "",
      ...(r.cleanupPending
        ? ["Deleting the old relay group failed; it will be retried (agentgate relay cleanup)."]
        : []),
    ],
  },
});

controlOp({
  name: "relay leave",
  summary: "stop using the relay on this machine; --wipe also deletes the group from the relay",
  input: z.object({ wipe: z.boolean().optional() }).strict(),
  needs: "store",
  loopbackOnly: true,
  run: ({ wipe }, { s }) => relayed(() => leaveRelay(s, !!wipe)),
  terminal: {
    usage: "relay leave [--wipe]",
    parse(args) {
      const { values, positionals } = parseWords(args, { wipe: { type: "boolean" } });
      if (positionals.length) throw new UserError();
      return { input: { ...(values.wipe && { wipe: true }) } };
    },
    print: (r) => [
      `This machine no longer uses the relay.${r.cleanupPending ? " Deleting the group failed; it will be retried (agentgate relay cleanup)." : ""}`,
    ],
  },
});

controlOp({
  name: "relay cleanup",
  summary: "retry deleting old relay groups; --abandon stops trying",
  input: z.object({ abandon: z.boolean().optional() }).strict(),
  needs: "store",
  run: ({ abandon }, { s }) => relayed(() => cleanupRelay(s, !!abandon)),
  terminal: {
    usage: "relay cleanup [--abandon]",
    parse(args) {
      const { values, positionals } = parseWords(args, { abandon: { type: "boolean" } });
      if (positionals.length) throw new UserError();
      return { input: { ...(values.abandon && { abandon: true }) } };
    },
    print: (r) => [r.cleanupPending ? "Some old relay groups could not be deleted yet." : "No cleanup pending."],
  },
});

// Loopback-only: the key is a credential for the relay.
controlOp({
  name: "relay key",
  summary: "the service key a self-hosted relay asks for, or --clear",
  input: z.object({ key: z.string().min(1).max(512).nullable() }).strict(),
  needs: "store",
  loopbackOnly: true,
  run({ key }, { s }) {
    setServiceKey(s, key ?? undefined);
    return { ok: true as const };
  },
  terminal: {
    usage: "relay key <value> | relay key --clear",
    parse(args) {
      const { values, positionals } = parseWords(args, { clear: { type: "boolean" } });
      const [key, ...extra] = positionals;
      if (extra.length || !!values.clear === !!key) throw new UserError();
      return { input: { key: key ?? null } };
    },
    print: () => ["ok"],
  },
});

/** Where handoffs put new worktrees and clones on this machine (`handoffOptions` in daemon.ts reads them). Stored raw,
 * so folders set before the key was typed still read. */
export const handoffDirs = defineLocal("handoff:", z.string());

/** A folder as given, with `~` for this machine's home; a relative one names a folder under the CLI's directory. */
const folder = z.string().min(1).max(4096);

controlOp({
  name: "t3 dirs",
  summary: "where handoffs put new worktrees and clones on this machine",
  input: z.object({ worktrees: folder.optional(), clones: folder.optional() }).strict(),
  needs: "store",
  async run({ worktrees, clones }, { s }) {
    const dirs = [
      ["worktreesDir", worktrees],
      ["cloneDir", clones],
    ] as const;
    for (const [, dir] of dirs) {
      if (dir && !isAbsolute(dir) && !/^~(\/|$)/.test(dir)) {
        throw new UserError(`Give ${dir} as an absolute folder, or one under ~`);
      }
    }
    for (const [id, dir] of dirs) {
      if (dir) handoffDirs.set(s, id, resolve(dir.replace(/^~(?=\/|$)/, homedir())));
    }

    // Loaded on use, not imported at the top: daemon.ts imports this file.
    const { handoffOptions } = await import("../daemon.ts");
    const o = handoffOptions(s);
    return { worktreesDir: o.worktreesDir, cloneDir: o.cloneDir };
  },
  terminal: {
    usage: "t3 dirs [--worktrees <dir>] [--clones <dir>]",
    parse(args, _stdin, cwd) {
      const { values, positionals } = parseWords(args, { worktrees: { type: "string" }, clones: { type: "string" } });
      if (positionals.length) throw new UserError();
      const given = (dir: string | undefined) => (dir && !/^~(\/|$)/.test(dir) ? resolve(cwd ?? "/", dir) : dir);
      const worktrees = given(values.worktrees);
      const clones = given(values.clones);
      return { input: { ...(worktrees && { worktrees }), ...(clones && { clones }) } };
    },
    print: (o) => [`worktrees  ${o.worktreesDir}`, `clones     ${o.cloneDir}`],
  },
});
