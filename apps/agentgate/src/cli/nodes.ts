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
        default:
          return showHelp();
      }
  }
};
