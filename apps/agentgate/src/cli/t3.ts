import type { HandoffCancel, HandoffJob, NodeThreads, T3NodeState, T3PairingLink } from "@agentgate/protocol";
import { patchSettings } from "../configuration.ts";
import { store } from "../store.ts";
import { die, initialized, management, showHelp, stringOption, type Run } from "./common.ts";

/** t3, threads, handoff and handoffs. */
export const run: Run = async (cmd, [sub, ...rest], opts) => {
  const s = initialized(store());
  const str = stringOption(opts);
  switch (cmd) {
    case "t3": {
      const t3 = await import("../handoff/t3.ts");
      // Another machine (--node) is set up through this machine's daemon, which forwards the link to it.
      const node = str("node") && str("node") !== s.nodeId ? str("node") : undefined;
      const query = node ? `?node=${encodeURIComponent(node)}` : "";
      if (sub === "connect") {
        // No link: that machine's T3 Code creates one with `t3 pair`.
        const url = str("url");
        const input = rest[0]
          ? { pairingUrl: rest[0] }
          : url
            ? { url, token: str("token") ?? die("--token is required") }
            : { create: true as const };
        const state = node
          ? await management<T3NodeState>(`/t3/connect${query}`, "POST", input)
          : await t3.connectWith(s, input);
        const label = state.label ? ` (${state.label})` : "";
        const expires = new Date(state.expiresAt!).toISOString().slice(0, 10);
        return console.log(`connected ${node ?? "this machine"} to T3 Code${label}; the token expires ${expires}`);
      }
      if (sub === "pair") {
        const input = { ...(opts.tailscale && { tailscale: true }) };
        const link = node
          ? await management<T3PairingLink>(`/t3/pairing-link${query}`, "POST", input)
          : await t3.createPairingLink(s, input);
        console.log(link.url);
        if (link.expiresAt) console.log(`single use, expires ${link.expiresAt}`);
        for (const note of link.notes) console.log(note);
        return;
      }
      if (sub === "disconnect") {
        if (node) await management(`/t3${query}`, "DELETE");
        else t3.disconnectT3(s);
        return console.log("disconnected");
      }
      if (sub === "sync") {
        if (rest[0] === "on" || rest[0] === "off") patchSettings(s, { t3ProjectSync: rest[0] === "on" });
        else if (rest[0]) die("t3 sync [on|off]");
        await management("/t3/projects/sync", "POST").catch(() => {}); // a stopped daemon syncs when it starts
        const error = t3.t3State(s).projectSyncError;
        const state = s.settings().t3ProjectSync ? "on" : "off";
        return console.log(`T3 project sync is ${state} on every machine${error ? `; here: ${error}` : ""}`);
      }
      if (sub === "history") {
        if (rest[0] === "on" || rest[0] === "off") patchSettings(s, { t3HandoffHistory: rest[0] === "on" });
        else if (rest[0]) die("t3 history [on|off]");
        return console.log(
          `Copying a returning thread's messages into T3 Code is ${s.settings().t3HandoffHistory ? "on" : "off"} on every machine. It writes T3 Code's own database, which T3 Code does not support; turn it off if T3 Code misbehaves after a handoff.`,
        );
      }
      if (sub && sub !== "status") showHelp();
      const st = t3.t3State(s);
      if (!st.url) return console.log("T3 Code is not connected. With T3 Code running, run: agentgate t3 connect");

      const token = st.connected
        ? `connected, token expires ${new Date(st.expiresAt!).toISOString().slice(0, 10)}`
        : "token expired";
      const repair = st.repair ? "; pair again soon: agentgate t3 connect" : "";
      return console.log(`T3 Code${st.label ? ` ${st.label}` : ""} at ${st.url}: ${token}${repair}`);
    }
    case "threads": {
      const nodes = await management<NodeThreads[]>("/threads");
      for (const n of nodes.filter((n) => !str("node") || n.node === str("node"))) {
        const problem = n.error ? `  ${n.error}` : !n.t3?.connected ? "  T3 Code not connected" : "";
        console.log(`\n${n.node}${n.server ? " (server)" : ""}${problem}`);

        for (const thread of n.threads) {
          const state = (thread.running ? "running" : "idle").padEnd(8);
          const branch = thread.branch ? `@${thread.branch}` : "";
          const notClaude = thread.claude ? "" : "  (not Claude)";
          const link = thread.link ? `  ${thread.link}` : "";
          console.log(
            `  ${thread.id.padEnd(40)} ${state} ${thread.project}${branch}  ${thread.title}${notClaude}${link}`,
          );
        }
      }
      return;
    }
    case "handoff": {
      const threadId = sub ?? die("handoff <thread> [--to server|here|<node>] [--no-wait]");
      const started = await management<{ handoffId: string; node: string; to: string }>("/handoffs", "POST", {
        threadId,
        to: str("to") ?? "server",
      });
      if (opts["no-wait"]) return console.log(started.handoffId);
      console.log(`handing ${threadId} from ${started.node} to ${started.to} (${started.handoffId})`);
      let last = "";
      for (;;) {
        const job = await management<HandoffJob>(
          `/handoffs/${started.handoffId}?node=${encodeURIComponent(started.node)}`,
        );
        if (job.step !== last) {
          console.log(`  ${job.step}`);
          last = job.step;
        }
        if (job.status === "failed") die(`handoff failed: ${job.error}`);
        if (job.status === "imported" || job.status === "done") {
          for (const w of job.warnings) console.warn(`warning: ${w}`);
          console.log(
            job.timings
              .map((x) => `${x.step}${x.node === started.node ? "" : ` on ${x.node}`} ${(x.ms / 1000).toFixed(1)} s`)
              .join(" · "),
          );
          return console.log(`now on ${started.to} as thread ${job.destThreadId}`);
        }
        await Bun.sleep(1000);
      }
    }
    case "handoffs": {
      if (sub === "cancel") {
        const id = rest[0] ?? die("handoffs cancel <id> [--node <node>]");
        const node = str("node");
        const r = await management<HandoffCancel>(
          `/handoffs/${encodeURIComponent(id)}/cancel${node ? `?node=${encodeURIComponent(node)}` : ""}`,
          "POST",
        );
        return console.log(r.message);
      }
      for (const job of await management<HandoffJob[]>("/handoffs")) {
        const created = new Date(job.createdAt).toISOString().slice(0, 16);
        const error = job.error ? `\n    ${job.error}` : "";
        const warnings = job.warnings.map((warning) => `\n    warning: ${warning}`).join("");
        console.log(
          `${created}  ${job.id}  ${job.from} → ${job.to}  ${job.status.padEnd(8)} ${job.step.padEnd(9)} ${job.title ?? job.thread}${error}${warnings}`,
        );
      }
      return;
    }
  }
};
