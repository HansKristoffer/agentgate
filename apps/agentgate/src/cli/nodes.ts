import { HEALTH_PATH, outdatedNodes } from "@agentgate/protocol";
import { getErrorMessage, typedSwitch } from "hanzio";
import { removeNode, setHealthDashboard } from "../operations.ts";
import {
  cleanupRelay,
  createRelay,
  installAndJoin,
  joinRelay,
  leaveRelay,
  newNodeName,
  reconcileRelay,
  relayNodes,
  relayStatus,
  rotateRelay,
  setServiceKey,
} from "../relay.ts";
import { store } from "../store.ts";
import { join, pairCode, peers, tailscale } from "../sync.ts";
import { die, initialized, showHelp, stringOption, type Run } from "./common.ts";

/** pair, join, nodes, dashboard, unpair and relay. */
export const run: Run = async (cmd, [sub, ...rest], opts) => {
  const s = initialized(store());
  const str = stringOption(opts);
  switch (cmd) {
    case "pair": {
      let method = opts.tailnet ? "tailnet" : opts.relay || str("relay-url") ? "relay" : undefined;
      if (!method && process.stdin.isTTY && process.stdout.isTTY) {
        const answer = prompt(
          "How will the other machine connect?\n  [1] Same network (Tailscale)\n  [2] Agentgate relay (any network, end-to-end encrypted)\nChoose 1 or 2:",
        )?.trim();
        method = answer === "2" ? "relay" : answer === "1" ? "tailnet" : die("Choose 1 or 2.");
      }
      method ??= (await tailscale()) ? "tailnet" : "relay";
      const asked =
        str("name") ??
        (process.stdin.isTTY && process.stdout.isTTY
          ? prompt("Name for the other machine (Enter for its hostname):")
          : undefined);
      let name: string | undefined;
      try {
        name = asked?.trim() ? newNodeName(s, asked.trim()) : undefined;
      } catch (e) {
        die(getErrorMessage(e));
      }
      const printJoin = (args: string) =>
        console.log(
          `On the other machine run this to install agentgate${name ? ` as ${name}` : ""}, join, start the service and route its Claude Code and Codex through agentgate:\n\n  ${installAndJoin(args, name)}\n\nIf agentgate is already installed there, run instead:\n\n  agentgate join ${args}\n`,
        );
      if (method === "relay") {
        const invite = await createRelay(s, str("relay-url"));
        printJoin(invite);
        console.log(
          "This invite does not expire. Anyone who has it can read every account and MCP login, so share it privately.\nIf it leaks, run `agentgate relay rotate` and have every relay machine join again.",
        );
        if (process.env.AGENTGATE_RELAY_KEY || s.local("relay:serviceKey"))
          console.log("This relay needs a service key: set AGENTGATE_RELAY_KEY on the other machine before joining.");
        const status = relayStatus(s);
        if (status?.pushError)
          console.warn(`\nUpload not finished yet: ${status.pushError}. The daemon keeps retrying.`);
        return;
      }
      const url =
        s.get("node", s.nodeId)?.url ??
        (await tailscale())?.url ??
        die("No tailnet URL; is Tailscale running? Use `agentgate pair --relay` to connect over the relay instead.");
      console.log("Start Tailscale on the other machine. The code is valid for 10 minutes.\n");
      printJoin(`${url} ${pairCode(s)}`);
      return;
    }
    case "join": {
      if (sub?.startsWith("agr1.")) {
        await joinRelay(s, sub, !!opts.force);
        console.log(
          `joined the relay; ${s.list("account").length} accounts, ${s.list("mcp").length} MCP instances, ${s.list("project").length} projects`,
        );
        return;
      }
      const [url, code] = [sub, rest[0]];
      if (!url || !code) die("join <url> <code>, or join agr1.…");
      const self =
        s.get("node", s.nodeId)?.url ??
        (await tailscale())?.url ??
        die("No tailnet URL for this node; is Tailscale running?");
      const peer = await join(s, url!, code!, self);
      console.log(
        `paired with ${peer}; ${s.list("account").length} accounts, ${s.list("mcp").length} MCP instances, ${s.list("project").length} projects`,
      );
      return;
    }
    case "nodes": {
      for (const p of peers(s))
        console.log(
          `${p.node.padEnd(16)} tailscale ${p.url}  cursor ${p.cursor}  last seen ${p.last_seen ? new Date(p.last_seen).toISOString() : "never"}`,
        );
      for (const n of relayNodes(s))
        console.log(`${n.node.padEnd(16)} relay  last seen ${new Date(n.lastSeen).toISOString()}`);
      const outdated = new Set(outdatedNodes(s.list("node")).map((n) => n.id));
      for (const n of s.list("node")) {
        const u = (await import("../update.ts")).nodeUpdate(s, n.id);
        if (u)
          console.log(
            `${n.id}: ${typedSwitch(u.state, {
              installing: () => "installing an update",
              restarting: () => `restarting on agentgate ${u.version}`,
              installed: () => `installed agentgate ${u.version}; restart agentgate there to use it`,
              failed: () => `update failed: ${u.error}`,
            })}`,
          );
        else if (outdated.has(n.id))
          console.log(
            `${n.id} runs ${n.version ? `agentgate ${n.version}` : "an older agentgate"}; update it with agentgate update ${n.id}`,
          );
      }
      return;
    }
    case "dashboard": {
      const node = str("node") ?? s.nodeId;
      if (sub === "on" || sub === "off") setHealthDashboard(s, node, sub === "on");
      else if (sub !== undefined) die("dashboard [on|off] [--node <node>]");
      const n = s.get("node", node) ?? die(`no machine ${node}`);
      console.log(
        `${node}: health dashboard ${n.healthDashboard ? "on" : "off"}${n.healthDashboard && n.url ? `, ${n.url}${HEALTH_PATH}` : ""}`,
      );
      return;
    }
    case "unpair": {
      const node = sub ?? die("unpair <node>");
      const { endpoints, rotated } = await removeNode(s, node);
      for (const e of endpoints)
        console.log(`${e.project} has a new URL; update it in Grok: ${e.url} (agentgate remote show ${e.project})`);
      if (!rotated) return console.log("ok");
      console.log(
        `Moved this machine to a new relay secret. Every other relay machine must join again:\n\n  ${rotated.command}\n`,
      );
      console.log(
        `Also remove ${node}'s Tailscale pairing from every machine you keep: rotation cannot revoke those links. If ${node} may be compromised, log in to its accounts again.`,
      );
      if (rotated.cleanupPending)
        console.warn("Deleting the old relay group failed; it will be retried (agentgate relay cleanup).");
      return;
    }
    case "relay":
      switch (sub) {
        case "status":
        case undefined: {
          const r = relayStatus(s);
          if (!r) return console.log("This machine does not use a relay. Connect one with `agentgate pair --relay`.");
          console.log(
            `relay       ${r.url}${r.hosted ? " (hosted)" : ""}\ngeneration  ${r.generation ?? "-"}\ncursor      ${r.cursor}\nuploaded    ${r.pushed} of ${s.seq()}\nstate       ${[r.reconciling && "reconciling", r.rotating && "rotation pending", r.cleanupPending && "cleanup pending"].filter(Boolean).join(", ") || "in sync"}`,
          );
          if (r.rotatedAt)
            console.log(
              `rotated     ${new Date(r.rotatedAt).toISOString()}, after an interruption. Every other relay machine must join again; \`agentgate pair --relay\` shows the command`,
            );
          if (r.pushError) console.log(`upload      ${r.pushError}`);
          if (r.pullError) console.log(`download    ${r.pullError}`);
          if (r.skipped)
            console.log(
              `skipped     ${r.skipped} entries could not be decrypted (agentgate relay reconcile retries them)`,
            );
          for (const n of relayNodes(s))
            console.log(`machine     ${n.node}, last seen ${new Date(n.lastSeen).toISOString()}`);
          return;
        }
        case "reconcile":
          await reconcileRelay(s);
          return console.log("reconciled");
        case "rotate": {
          const r = await rotateRelay(s);
          console.log(`New relay secret. Every other relay machine must join again:\n\n  ${r.command}\n`);
          if (r.cleanupPending)
            console.warn("Deleting the old relay group failed; it will be retried (agentgate relay cleanup).");
          return;
        }
        case "leave": {
          const r = await leaveRelay(s, !!opts.wipe);
          console.log(
            `This machine no longer uses the relay.${r.cleanupPending ? " Deleting the group failed; it will be retried (agentgate relay cleanup)." : ""}`,
          );
          return;
        }
        case "cleanup": {
          const r = await cleanupRelay(s, !!opts.abandon);
          return console.log(
            r.cleanupPending ? "Some old relay groups could not be deleted yet." : "No cleanup pending.",
          );
        }
        case "key":
          if (!opts.clear && !rest[0]) die("relay key <value> | relay key --clear");
          setServiceKey(s, opts.clear ? undefined : rest[0]);
          return console.log("ok");
        default:
          return showHelp();
      }
  }
};
