import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { LOCAL_URL, schemas } from "../store.ts";
import { VERSION, connect, mergeInstructions, mergedServer, parseRemote, type Source } from "./gateway.ts";

import { z } from "zod";
import { fetchHeaders, readBody } from "../runtime.ts";

export const DAEMON_DOWN = "agentgate daemon is not running on this machine (run `agentgate service start`). Tools reconnect automatically when the daemon becomes available.";

/** AGENTGATE_PROJECT, else the git origin as owner/repo, else only the `*` defaults apply. */
export function detectProject(cwd: string, env = process.env): string {
  if (env.AGENTGATE_PROJECT) return env.AGENTGATE_PROJECT;
  // Claude Desktop starts MCP servers with a reduced PATH.
  const git = Bun.which("git", { PATH: env.PATH ?? "" }) ?? (process.platform === "darwin" ? "/usr/bin/git" : "git");
  try {
    const r = Bun.spawnSync([git, "remote", "get-url", "origin"], { cwd, stderr: "ignore" });
    return (r.exitCode === 0 && parseRemote(r.stdout.toString())) || "*";
  } catch { return "*"; }
}

/** The shim: an MCP client toward the local daemon, an MCP server toward Claude Code or Codex. */
export async function buildShim(cwd: string, daemonUrl = LOCAL_URL, env = process.env, options: { reconnectMs?: number } = {}) {
  const project = detectProject(cwd, env);
  const q = `project=${encodeURIComponent(project)}`;
  // Too late for this session's skills (agents read them before starting MCP servers), but it lets the
  // daemon link project skills into this repo's worktrees ahead of the next session.
  if (project !== "*") void fetchHeaders(`${daemonUrl}/api/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: cwd, project }) }, 5000).then(r => r.body?.cancel(), () => { });
  let daemon: Client | undefined, transport: StreamableHTTPClientTransport | undefined;
  let closed = false, flight: Promise<void> | undefined;
  const children = new Map<string, { config: string; client: Client }>();
  let server: ReturnType<typeof mergedServer> | undefined;
  const changed = () => { void server?.sendToolListChanged().catch(() => { }); };
  const invalidate = (client: Client) => {
    if (daemon !== client) return;
    daemon = undefined; transport = undefined; void client.close().catch(() => { }); changed();
  };
  const reconcile = async () => {
    const res = await fetchHeaders(`${daemonUrl}/api/shim?${q}`, { signal: AbortSignal.timeout(5000) }, 5000);
    if (!res.ok) throw new Error("cannot read session configuration");
    const config = z.array(z.object({ alias: z.string(), instance: schemas.mcp })).max(256).parse(JSON.parse(new TextDecoder().decode(await readBody(res.body, 4 * 1024 * 1024, AbortSignal.timeout(5000)))));
    if (closed) return;
    const names = new Set(config.map(v => v.alias));
    for (const [alias, child] of children) if (!names.has(alias)) { children.delete(alias); await child.client.close().catch(() => { }); }
    await Promise.all(config.map(async ({ alias, instance }) => {
      const serialized = JSON.stringify(instance), prev = children.get(alias);
      if (prev?.config === serialized) return;
      children.delete(alias); await prev?.client.close().catch(() => { });
      try {
        const client = await connect(instance, cwd);
        if (closed) { await client.close(); return; }
        children.set(alias, { config: serialized, client }); client.onclose = () => { if (children.get(alias)?.client === client) children.delete(alias); };
      } catch (e) { console.error(`agentgate: ${alias}: ${e}`); }
    }));
  };
  const ensure = () => {
    if (closed) return Promise.resolve();
    return flight ??= (async () => {
      if (!daemon) {
        const client = new Client({ name: "agentgate-shim", version: VERSION });
        const t = new StreamableHTTPClientTransport(new URL(`${daemonUrl}/mcp?${q}`), {
          fetch: async (url, init) => {
            const res = await fetchHeaders(url, init, init?.method === "DELETE" ? 1000 : 5000);
            if (res.status === 404 && t.sessionId) invalidate(client);
            return res;
          }
        });
        try { await client.connect(t, { timeout: 5000 }); }
        catch (e) { await client.close().catch(() => { }); throw e; }
        if (closed) { await client.close(); return; }
        daemon = client; transport = t;
        client.onclose = () => invalidate(client);
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => { void ensure().then(changed).catch(() => { }); });
        changed();
      }
      await reconcile();
    })().finally(() => { flight = undefined; });
  };
  await ensure().catch(() => { });
  const sources = async (): Promise<Source[]> => {
    await ensure().catch(() => { });
    return [...(daemon ? [{ alias: "", client: daemon }] : []), ...Array.from(children, ([alias, child]) => ({ alias, client: child.client }))];
  };
  server = mergedServer(daemon ? mergeInstructions(await sources()) : DAEMON_DOWN, sources, (alias, e) => console.error(`agentgate: ${alias || "daemon"}: ${e}`));
  const timer = setInterval(() => { void ensure().catch(() => { }); }, options.reconnectMs ?? 5000); timer.unref();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    closed = true; clearInterval(timer); await flight?.catch(() => { });
    try { if (transport?.sessionId) await transport.terminateSession(); } catch { }
    await Promise.allSettled([...(daemon ? [daemon.close()] : []), ...Array.from(children.values(), c => c.client.close())]);
    children.clear(); daemon = undefined;
  })();
  return { project, server, close };
}

export async function runShim() {
  const { server, close } = await buildShim(process.cwd());
  const transport = new StdioServerTransport();
  transport.onclose = () => close().finally(() => process.exit(0));
  process.stdin.on("end", () => close().finally(() => process.exit(0)));
  await server.connect(transport);
}
