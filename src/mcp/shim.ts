import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { LOCAL_URL, type McpInstance } from "../store.ts";
import { VERSION, connect, mergeInstructions, mergedServer, parseRemote, type Source } from "./gateway.ts";

export const DAEMON_DOWN = "agentgate daemon is not running on this machine (run `agentgate service start`). No agentgate tools are available in this session.";

/** AGENTGATE_PROJECT, else the git origin as owner/repo, else only the `*` defaults apply. */
export function detectProject(cwd: string, env = process.env): string {
  if (env.AGENTGATE_PROJECT) return env.AGENTGATE_PROJECT;
  const r = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd, stderr: "ignore" });
  return (r.exitCode === 0 && parseRemote(r.stdout.toString())) || "*";
}

/** The shim: an MCP client toward the local daemon, an MCP server toward Claude Code or Codex. */
export async function buildShim(cwd: string, daemonUrl = LOCAL_URL, env = process.env) {
  const project = detectProject(cwd, env);
  const q = `project=${encodeURIComponent(project)}`;
  let daemon: Client | undefined;
  const sources: Source[] = [];
  try {
    daemon = new Client({ name: "agentgate-shim", version: VERSION });
    await daemon.connect(new StreamableHTTPClientTransport(new URL(`${daemonUrl}/mcp?${q}`)));
    sources.push({ alias: "", client: daemon });
    // perSession instances run here, in the worktree, and end with the session.
    // ponytail: perSession mapping is read once at start; a change needs a new session.
    const res = await fetch(`${daemonUrl}/api/shim?${q}`);
    const perSession = res.ok ? ((await res.json()) as { alias: string; instance: McpInstance }[]) : [];
    await Promise.all(
      perSession.map(async ({ alias, instance }) => {
        try {
          sources.push({ alias, client: await connect(instance, cwd) });
        } catch (e) {
          console.error(`agentgate: ${alias}: ${e}`);
        }
      }),
    );
  } catch {
    daemon = undefined;
  }
  const instructions = daemon ? mergeInstructions(sources) : DAEMON_DOWN;
  const server = mergedServer(instructions, async () => sources, (alias, e) => console.error(`agentgate: ${alias || "daemon"}: ${e}`));
  daemon?.setNotificationHandler(ToolListChangedNotificationSchema, () => server.sendToolListChanged().catch(() => {}));
  const close = async () => {
    for (const src of sources) await src.client.close().catch(() => {});
  };
  return { project, server, close };
}

export async function runShim() {
  const { server, close } = await buildShim(process.cwd());
  const transport = new StdioServerTransport();
  transport.onclose = () => close().finally(() => process.exit(0));
  process.stdin.on("end", () => close().finally(() => process.exit(0)));
  await server.connect(transport);
}
