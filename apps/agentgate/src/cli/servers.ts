import { serverHealth } from "../mcp/gateway.ts";
import { startLogin } from "../mcp/oauth.ts";
import { presets, readableEndpoint } from "../mcp/templates.ts";
import { tuningNotes } from "../ops/servers.ts";
import { LOCAL_URL, store } from "../store.ts";
import { die, initialized, showHelp, type Run } from "./common.ts";

/** `mcp presets|ls|login`; the shim (`mcp` alone) starts in cli.ts, and the writes are operations (ops/servers.ts). */
export const run: Run = async (_cmd, [sub, ...rest]) => {
  const s = initialized(store());
  if (sub === "presets") {
    for (const preset of presets) {
      const target = preset.url ?? [preset.command, ...(preset.args ?? [])].join(" ");
      const note = preset.note ? `  (${preset.note})` : "";
      console.log(`${preset.id.padEnd(12)} ${target}${note}`);
    }
    return;
  }

  if (sub === "ls") {
    for (const server of s.list("mcp")) {
      const health = serverHealth(s, server.id);
      const state = !health ? "" : health.ok ? "  available" : health.needsLogin ? "  NEEDS LOGIN" : "  UNREACHABLE";
      const endpoint = server.url ? readableEndpoint(server.url) : [server.command, ...(server.args ?? [])].join(" ");
      const label = server.label ? `${server.label}  ` : "";
      const loggedIn = s.get("mcpCredential", server.id)?.tokens ? "  logged in" : "";
      console.log(
        `${server.id.padEnd(20)} ${label}${endpoint.padEnd(48)} ${server.mode}${loggedIn}${state}${tuningNotes(server)}`,
      );
    }
    return;
  }

  // Not an operation: the sign-in returns to the caller's own address, which an operation does not see (api/servers.ts).
  if (sub === "login") {
    const id = rest[0] ?? die("mcp login <name>");
    const url = await startLogin(s, id, `${LOCAL_URL}/oauth/callback`);
    if (!url) return console.log(`${id}: logged in`);
    console.log(`Open this to log in (the daemon must be running to receive the callback):\n\n  ${url.href}\n`);
    if (process.platform === "darwin") Bun.spawn(["open", url.href]);
    return;
  }
  return showHelp();
};
