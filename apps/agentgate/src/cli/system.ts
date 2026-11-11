import {
  operationFor,
  statusSchema,
  type AccountState,
  type FactoryCommandResult,
  type FactoryOperationInfo,
} from "@agentgate/protocol";
import { problems } from "@agentgate/protocol/attention";
import { hostname } from "node:os";
import packageInfo from "../../../../package.json";
import { patchSettings, revision } from "../configuration.ts";
import { accountStatus } from "../llm/pool.ts";
import { relayStatus, usesRelay } from "../relay.ts";
import { NODE_PROTOCOL } from "../remote.ts";
import { exportBackup, importBackup, LOCAL_URL, store } from "../store.ts";
import { lastSeen, peers, tailscale } from "../sync.ts";
import { die, initialized, management, stringOption, type Run } from "./common.ts";

/** `agentgate status`'s "needs attention" block: what the user must fix by hand, the list the app's overview shows. */
export function attentionLines(st: Parameters<typeof problems>[0]) {
  const list = problems(st);
  return list.length
    ? ["", "needs attention", ...list.map((p) => `  ${p.title}${p.detail ? `: ${p.detail}` : ""}`)]
    : [];
}

/** `agentgate factory help`: the commands to start with, then the rest, with those that share a first word together. */
function factoryHelp(operations: FactoryOperationInfo[]) {
  const start = ["init", "status", "add", "approve", "show"];
  const rest = operations.filter((op) => !start.includes(op.name));
  const family = (op: FactoryOperationInfo) => op.name.split(" ")[0]!;
  const families = Map.groupBy(rest, family);
  const groups = [
    start.flatMap((name) => operations.filter((op) => op.name === name)),
    rest.filter((op) => families.get(family(op))!.length === 1),
    ...[...families.values()].filter((ops) => ops.length > 1),
  ];
  return groups
    .filter((ops) => ops.length)
    .map((ops) => {
      // Aligned, but one long usage does not push every summary off the screen.
      const width = Math.min(50, Math.max(...ops.map((op) => op.usage.length)));
      return ops.map((op) => `  factory ${op.usage.padEnd(width)}  ${op.summary}`).join("\n");
    })
    .join("\n\n");
}

const bar = (pct: number) => {
  const n = Math.round(Math.min(100, pct) / 5);
  return `${"█".repeat(n)}${"░".repeat(20 - n)} ${Math.round(pct)}%`;
};
const mins = (t?: number) => (t ? `${Math.max(0, Math.round((t - Date.now()) / 60_000))} min` : "?");
/** Disabled is left to the account's own flag, which `status` prints beside a login problem too. */
function stateFlag(state: AccountState) {
  switch (state.kind) {
    case "needs-login":
      return "NEEDS LOGIN";
    case "waiting-for-holder":
      return `waiting for ${state.holder} to refresh`;
    case "refresh-failed":
      return "REFRESH FAILED";
    case "refreshing":
      return "token expired, refreshes on the next request";
    case "exhausted":
      return `exhausted, resets in ${mins(state.until)}`;
    case "cooling":
      return `backing off (${state.reason}) for ${mins(state.until)}`;
    case "disabled":
    case "ready":
      return undefined;
  }
}

/** init, serve, status, settings, factory, setup, service, update, export, import-backup and admin-token. */
export const run: Run = async (cmd, [sub], opts) => {
  const s = store();
  const str = stringOption(opts);
  switch (cmd) {
    case "init": {
      const name = str("name") ?? s.local("node") ?? hostname().split(".")[0]!.toLowerCase();
      const old = s.local("node");
      if (old && old !== name) {
        if (peers(s).length || usesRelay(s) || s.list("credential").length || s.list("mcpCredential").length)
          die("cannot rename a paired node, relay member or credential holder; keep its existing name");
        s.del("node", old);
      }
      s.setLocal("node", name);
      // A new store: the first `service install` routes this machine's own Claude Code, Codex and Cursor.
      if (!old && !s.local("setup:routing")) s.setLocal("setup:routing", "pending");
      if (!s.local("adminToken")) s.setLocal("adminToken", crypto.randomUUID().replace(/-/g, ""));
      const ts = await tailscale();
      const prev = s.get("node", name);
      s.put("node", name, {
        id: name,
        url: ts?.url ?? prev?.url,
        alwaysOn: !!opts["always-on"] || !!prev?.alwaysOn,
        healthDashboard: !!prev?.healthDashboard,
        protocol: NODE_PROTOCOL,
      });
      console.log(`node ${name}${opts["always-on"] ? " (always on)" : ""}, store ${s.db.filename}`);
      console.log(
        ts
          ? `tailnet: ${ts.url}`
          : "Tailscale not found; the daemon will keep looking for it. Without Tailscale, connect machines with `agentgate pair --relay`.",
      );
      return;
    }
    case "serve": {
      initialized(s);
      (await import("../service.ts")).stampLogs();
      // Bun reports these on stderr without the timestamp; the daemon still exits so the service restarts it.
      for (const event of ["uncaughtException", "unhandledRejection"] as const)
        process.on(event, (e: unknown) => {
          console.error(`${event}: ${e instanceof Error ? e.stack : String(e)}`);
          process.exit(1);
        });
      const daemon = await (await import("../daemon.ts")).serve(s);
      let shuttingDown = false;
      const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        void daemon.stop().then(() => {
          s.close();
          process.exit(0);
        });
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
      return;
    }

    case "status": {
      initialized(s);
      for (const p of ["claude", "codex", "cursor"] as const) {
        console.log(`\n${p}`);
        const accounts = s.list("account").filter((a) => a.provider === p);
        if (!accounts.length) console.log("  (no accounts)");
        for (const a of accounts) {
          const st = accountStatus(s, a);
          const flags = [st.active && "active", a.pinned && "pinned", !a.enabled && "disabled", stateFlag(st.state)]
            .filter(Boolean)
            .join(", ");
          console.log(
            `  ${a.id}  ${a.label}${flags ? `  [${flags}]` : ""}  holder ${st.holder ?? "-"}, token expires in ${mins(st.expiresAt)}`,
          );
          for (const w of st.windows)
            console.log(`    ${w.name.padEnd(10)} ${bar(w.usedPct)}  resets in ${mins(w.resetsAt)}`);
          if (!st.windows.length && st.state.kind !== "needs-login")
            console.log("    no quota data yet (or unrecognised quota headers)");
        }
      }
      // Some problems (skill links, file sync) only the running daemon knows, so the list needs it.
      const res = await fetch(`${LOCAL_URL}/api/status`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
      const up = !!res?.ok;
      const daemonStatus = res?.ok ? statusSchema.safeParse(await res.json().catch(() => undefined)).data : undefined;
      if (daemonStatus) for (const line of attentionLines(daemonStatus)) console.log(line);
      console.log("\nnodes");
      for (const n of s.list("node")) {
        const seen = lastSeen(s, n.id);
        const peer = peers(s).find((p) => p.node === n.id);
        console.log(
          `  ${n.id}${n.id === s.nodeId ? " (this node)" : ""}${n.alwaysOn ? " always-on" : ""}${n.healthDashboard ? " dashboard" : ""}  ${n.url ?? ""}  ${n.id === s.nodeId ? "" : `last seen ${seen ? `${Math.round((Date.now() - seen) / 1000)}s ago` : "never"}, cursor ${peer?.cursor ?? "-"}${s.local(`syncError:${n.id}`) ? ", sync failed" : ""}`}`,
        );
      }
      const relay = relayStatus(s);
      if (relay)
        console.log(
          `\nrelay ${relay.url}${relay.hosted ? " (hosted)" : ""}${relay.reconciling ? ", reconciling" : ""}${relay.rotating ? ", rotating" : ""}${relay.cleanupPending ? ", cleanup pending" : ""}${relay.pushError ? `\n  upload: ${relay.pushError}` : ""}${relay.pullError ? `\n  download: ${relay.pullError}` : ""}`,
        );
      const t3 = (await import("../handoff/t3.ts")).t3State(s);
      console.log(
        `\nT3 Code: ${!t3.url ? "not connected (agentgate t3 connect)" : t3.connected ? `${t3.url}${t3.repair ? ", pair again soon" : ""}` : "token expired, pair again"}`,
      );
      const setupMod = await import("../setup.ts"),
        claude = setupMod.claudeStatus(),
        codex = setupMod.primaryState().codex,
        cursor = setupMod.cursorMcpEnabled();
      const uses = (on: boolean) => (on ? "uses agentgate" : "does not use agentgate");
      console.log(
        `\nClaude Code ${uses(claude.routing)}, MCP servers ${claude.mcp ? "on" : "off"}\nCodex ${uses(codex)}${cursor === undefined ? "" : `\nCursor MCP servers ${cursor ? "on" : "off"}`}`,
      );
      if (!claude.routing || !codex) console.log("  to route them: agentgate setup --primary");
      const restored = Number(s.local(setupMod.MCP_RESTORED));
      if (claude.mcp && restored > Date.now() - 86_400_000)
        console.log(
          `  agentgate put its MCP server back in Claude Code at ${new Date(restored).toLocaleTimeString()}; to remove it for good: agentgate setup --mcp off`,
        );
      console.log(`\ndaemon: ${up ? `running at ${LOCAL_URL}` : "not running (agentgate service start)"}`);
      const lag = daemonStatus?.daemon?.lag;
      if (lag) console.log(`Event loop: worst ${lag.worstMs} ms, p99 ${lag.p99Ms} ms in the last minute`);
      return;
    }

    case "settings": {
      initialized(s);
      if (!sub || sub === "show") return console.log(JSON.stringify(s.settings(), null, 2));
      if (sub !== "set") die("settings show | settings set --file patch.json");
      const expected = revision(s, "setting", "settings");
      const patch = await Bun.file(str("file") ?? die("--file patch.json is required")).json();
      return console.log(JSON.stringify(patchSettings(s, patch, expected), null, 2));
    }

    case "factory": {
      // The daemon owns every factory operation. The words go as typed, since each operation parses its own.
      const args = Bun.argv.slice(Bun.argv.indexOf("factory", 2) + 1);
      const operations = await management<FactoryOperationInfo[]>("/factory/operations");
      if (!args.length || args[0] === "help") return console.log(factoryHelp(operations));
      // Stdin is read only for an operation that takes it: any other must answer while its stdin stays open and silent.
      const stdin = !process.stdin.isTTY && operationFor(operations, args)?.stdin ? await Bun.stdin.text() : undefined;
      const result = await management<FactoryCommandResult>("/factory/terminal", "POST", {
        args,
        ...(stdin !== undefined && { stdin }),
        cwd: process.cwd(),
      });
      for (const line of result.output) console.log(line);
      // Once the factory is on, the preflight says what it still needs; JSON output stays one document.
      if (!result.code && ["init", "use"].includes(args[0]!) && !args.includes("--json")) {
        const checks = await management<FactoryCommandResult>("/factory/terminal", "POST", { args: ["doctor"] });
        console.log(["", ...checks.output].join("\n"));
      }
      process.exit(result.code);
    }

    case "setup": {
      const setupMod = await import("../setup.ts");
      if (opts.primary && opts.node) {
        initialized(s);
        return console.log(
          (
            await management<{ message: string }>(`/ops/${encodeURIComponent("nodes route")}`, "POST", {
              node: str("node"),
              on: sub !== "off",
            })
          ).message,
        );
      }
      if (opts.primary) return console.log((await setupMod.routeHere(s, sub !== "off")).message);
      if (opts.mcp) return console.log(await setupMod.mcpHere(s, sub !== "off"));
      return console.log(await setupMod.setup());
    }
    case "service": {
      const code = await (await import("../service.ts")).service(sub ?? "");
      if (sub === "install" && code === 0) {
        const routed = await (await import("../setup.ts")).routeByDefault(s, !opts["no-routing"]);
        if (routed) console.log(routed);
      }
      return process.exit(code);
    }
    case "update": {
      if (sub) {
        initialized(s);
        const r = await management<{ version?: string; restarting: boolean }>(
          `/ops/${encodeURIComponent("nodes update")}`,
          "POST",
          { node: sub },
        );
        if (!r.version || !r.restarting)
          return console.log(
            !r.version
              ? `${sub} is up to date`
              : `${sub} installed agentgate ${r.version}; restart agentgate there to use it`,
          );
        console.log(`${sub} installed agentgate ${r.version} and is restarting`);
        return console.log(
          (await (await import("../update.ts")).waitForVersion(s, sub, r.version))
            ? `${sub} runs agentgate ${r.version}`
            : `${sub} is still restarting; check with agentgate nodes`,
        );
      }
      const update = await import("../update.ts");
      const { target, version, restart } = await update.updateSelf().catch((e: Error) => die(e.message));
      console.log(version ? `installed agentgate ${version} at ${target}` : "agentgate is up to date");
      // A global npm or bun install that PATH finds first would keep running the old CLI.
      const copy = update.pathCopy(),
        latest = version ?? packageInfo.version;
      if (copy && copy.version !== latest) {
        const command = copy.install(latest);
        console.log(`${copy.path} is agentgate ${copy.version ?? "(unknown)"}; running ${command.join(" ")}`);
        let ok = false;
        try {
          ok = Bun.spawnSync(command, { stdio: ["ignore", "inherit", "inherit"] }).exitCode === 0;
        } catch {}
        if (!ok) console.log(`that failed; run it yourself: ${command.join(" ")}`);
      }
      if (!version) return;
      if (restart) {
        const code = await (await import("../service.ts")).service("restart");
        if (code === 0 && s.local("node"))
          console.log(
            (await update.waitForVersion(s, s.nodeId, version))
              ? `this node runs agentgate ${version}`
              : "agentgate is still restarting; check with agentgate nodes",
          );
        return process.exit(code);
      }
      return console.log("restart agentgate to use it");
    }

    case "export":
      return console.log(JSON.stringify(exportBackup(s, !opts["no-secrets"]), null, 2));
    case "import-backup":
      return console.log(
        `restored ${importBackup(s, await Bun.file(sub ?? die("import-backup <file>")).json())} records`,
      );
    case "admin-token":
      return console.log(initialized(s).local("adminToken"));
  }
};
