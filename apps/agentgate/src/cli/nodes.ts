import { outdatedNodes } from "@agentgate/protocol";
import { typedSwitch } from "hanzio";
import { relayNodes, relayStatus } from "../relay.ts";
import { store } from "../store.ts";
import { peers } from "../sync.ts";
import { initialized, showHelp, type Run } from "./common.ts";

/** The machines family's reads, `nodes` and `relay [status]`. Its writes are control operations (ops/nodes.ts). */
export const run: Run = async (cmd, [sub]) => {
  const s = initialized(store());
  switch (cmd) {
    case "nodes": {
      for (const peer of peers(s)) {
        const lastSeen = peer.last_seen ? new Date(peer.last_seen).toISOString() : "never";
        console.log(`${peer.node.padEnd(16)} tailscale ${peer.url}  cursor ${peer.cursor}  last seen ${lastSeen}`);
      }
      for (const machine of relayNodes(s)) {
        console.log(`${machine.node.padEnd(16)} relay  last seen ${new Date(machine.lastSeen).toISOString()}`);
      }

      const outdated = new Set(outdatedNodes(s.list("node")).map((node) => node.id));
      for (const node of s.list("node")) {
        const update = (await import("../update.ts")).nodeUpdate(s, node.id);
        if (update) {
          const progress = typedSwitch(update.state, {
            installing: () => "installing an update",
            restarting: () => `restarting on agentgate ${update.version}`,
            installed: () => `installed agentgate ${update.version}; restart agentgate there to use it`,
            failed: () => `update failed: ${update.error}`,
          });
          console.log(`${node.id}: ${progress}`);
        } else if (outdated.has(node.id)) {
          const running = node.version ? `agentgate ${node.version}` : "an older agentgate";
          console.log(`${node.id} runs ${running}; update it with agentgate update ${node.id}`);
        }
      }
      return;
    }
    case "relay":
      switch (sub) {
        case "status":
        case undefined: {
          const r = relayStatus(s);
          if (!r) return console.log("This machine does not use a relay. Connect one with `agentgate pair --relay`.");

          const state =
            [r.reconciling && "reconciling", r.rotating && "rotation pending", r.cleanupPending && "cleanup pending"]
              .filter(Boolean)
              .join(", ") || "in sync";
          console.log(
            `relay       ${r.url}${r.hosted ? " (hosted)" : ""}\ngeneration  ${r.generation ?? "-"}\ncursor      ${r.cursor}\nuploaded    ${r.pushed} of ${s.seq()}\nstate       ${state}`,
          );
          if (r.rotatedAt) {
            console.log(
              `rotated     ${new Date(r.rotatedAt).toISOString()}, after an interruption. Every other relay machine must join again; \`agentgate pair --relay\` shows the command`,
            );
          }
          if (r.pushError) console.log(`upload      ${r.pushError}`);
          if (r.pullError) console.log(`download    ${r.pullError}`);
          if (r.skipped) {
            console.log(
              `skipped     ${r.skipped} entries could not be decrypted (agentgate relay reconcile retries them)`,
            );
          }
          for (const machine of relayNodes(s)) {
            console.log(`machine     ${machine.node}, last seen ${new Date(machine.lastSeen).toISOString()}`);
          }
          return;
        }
        default:
          return showHelp();
      }
  }
};
