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
    for (const p of presets)
      console.log(
        `${p.id.padEnd(12)} ${p.url ?? [p.command, ...(p.args ?? [])].join(" ")}${p.note ? `  (${p.note})` : ""}`,
      );
    return;
  }
  if (sub === "ls") {
    for (const i of s.list("mcp")) {
      const h = serverHealth(s, i.id),
        state = !h ? "" : h.ok ? "  available" : h.needsLogin ? "  NEEDS LOGIN" : "  UNREACHABLE";
      console.log(
        `${i.id.padEnd(20)} ${i.label ? `${i.label}  ` : ""}${(i.url ? readableEndpoint(i.url) : [i.command, ...(i.args ?? [])].join(" ")).padEnd(48)} ${i.mode}${s.get("mcpCredential", i.id)?.tokens ? "  logged in" : ""}${state}${tuningNotes(i)}`,
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
