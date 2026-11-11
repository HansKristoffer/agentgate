import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { T3_THREAD_META_KEY } from "@agentgate/protocol";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { exponentialBackoff } from "hanzio";
import { LOCAL_URL, schemas, type McpInstance } from "../store.ts";
import {
  SHIM_CLIENT_NAME,
  StdioTransport,
  VERSION,
  connect,
  mergeInstructions,
  mergedServer,
  parseRemote,
  type Source,
} from "./gateway.ts";
import { mcpFetch } from "./oauth.ts";

import { z } from "zod";
import { fetchHeaders, readBody } from "../runtime.ts";

/** A per-session server that failed to start is tried again after 5 s, doubling up to 5 minutes while its
 * configuration stays the same: each try may run npx or uvx. */
const retryDelay = (failures: number) =>
  exponentialBackoff(failures, { baseMs: 5_000, maxMs: 5 * 60_000, jitter: false });

/** The daemon answered 404 for this session: it forgot the session (idle sweep or restart) before running the request. */
class SessionLost extends Error {}

export const DAEMON_DOWN =
  "agentgate daemon is not running on this machine (run `agentgate service start`). Tools reconnect automatically when the daemon becomes available.";

/** AGENTGATE_PROJECT, else the git origin as owner/repo, else only the `*` defaults apply. */
export function detectProject(cwd: string, env = process.env): string {
  if (env.AGENTGATE_PROJECT) return env.AGENTGATE_PROJECT;
  // Claude Desktop starts MCP servers with a reduced PATH.
  const git = Bun.which("git", { PATH: env.PATH ?? "" }) ?? (process.platform === "darwin" ? "/usr/bin/git" : "git");
  try {
    const r = Bun.spawnSync([git, "remote", "get-url", "origin"], { cwd, stderr: "ignore" });
    return (r.exitCode === 0 && parseRemote(r.stdout.toString())) || "*";
  } catch {
    return "*";
  }
}

/** The shim: an MCP client toward the local daemon, an MCP server toward Claude Code, Codex, or Cursor. */
export async function buildShim(
  cwd: string,
  daemonUrl = LOCAL_URL,
  env = process.env,
  options: { reconnectMs?: number; handshakeMs?: number } = {},
) {
  // The handshake and session reads fail fast, so a hung daemon costs the session its tools, not its start.
  const handshake = options.handshakeMs ?? 5000;
  const project = detectProject(cwd, env);
  // A T3 Code thread names itself: the daemon narrows a factory thread's tools by it, and tells which thread a
  // factory report came from.
  const thread = env.T3CODE_THREAD_ID;
  const q = `project=${encodeURIComponent(project)}${thread ? `&thread=${encodeURIComponent(thread)}` : ""}`;
  // Too late for this session's skills (agents read them before starting MCP servers), but it lets the
  // daemon link project skills into this repo's worktrees ahead of the next session.
  if (project !== "*")
    void fetchHeaders(
      `${daemonUrl}/api/checkout`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: cwd, project }) },
      5000,
    ).then(
      (r) => r.body?.cancel(),
      () => {},
    );
  let daemon: Client | undefined, transport: StreamableHTTPClientTransport | undefined;
  let closed = false,
    flight: Promise<void> | undefined;
  const children = new Map<string, { config: string; instance: McpInstance; client: Client }>();
  const failed = new Map<string, { config: string; failures: number; retryAt: number }>();
  let server: ReturnType<typeof mergedServer> | undefined;
  const changed = () => {
    void server?.sendToolListChanged().catch(() => {});
  };
  // While connected, the daemon's notification stream says when tools change; the timer only brings a lost daemon
  // connection back.
  let timer: ReturnType<typeof setInterval> | undefined;
  const poll = (on: boolean) => {
    if (on && !timer && !closed) {
      timer = setInterval(() => {
        void ensure().catch(() => {});
      }, options.reconnectMs ?? 5000);
      timer.unref();
    } else if (!on && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const invalidate = (client: Client) => {
    if (daemon !== client) return;
    daemon = undefined;
    transport = undefined;
    void client.close().catch(() => {});
    poll(true);
    changed();
  };
  const reconcile = async () => {
    const res = await fetchHeaders(`${daemonUrl}/api/shim?${q}`, { signal: AbortSignal.timeout(handshake) }, handshake);
    if (!res.ok) throw new Error("cannot read session configuration");
    const config = z
      .array(z.object({ alias: z.string(), instance: schemas.mcp }))
      .max(256)
      .parse(
        JSON.parse(new TextDecoder().decode(await readBody(res.body, 4 * 1024 * 1024, AbortSignal.timeout(5000)))),
      );
    if (closed) return;
    const names = new Set(config.map((v) => v.alias));
    for (const alias of failed.keys()) if (!names.has(alias)) failed.delete(alias);
    for (const [alias, child] of children)
      if (!names.has(alias)) {
        children.delete(alias);
        await child.client.close().catch(() => {});
      }
    await Promise.all(
      config.map(async ({ alias, instance }) => {
        const serialized = JSON.stringify(instance),
          prev = children.get(alias);
        if (prev?.config === serialized) return;
        const last = failed.get(alias)?.config === serialized ? failed.get(alias) : undefined;
        if (last && Date.now() < last.retryAt) return;
        children.delete(alias);
        await prev?.client.close().catch(() => {});
        try {
          const client = await connect(instance, cwd);
          if (closed) {
            await client.close();
            return;
          }
          failed.delete(alias);
          children.set(alias, { config: serialized, instance, client });
          client.onclose = () => {
            if (children.get(alias)?.client === client) children.delete(alias);
          };
        } catch (e) {
          const failures = (last?.failures ?? 0) + 1;
          failed.set(alias, { config: serialized, failures, retryAt: Date.now() + retryDelay(failures) });
          console.error(`agentgate: ${alias}: ${e}`);
        }
      }),
    );
  };
  const ensure = () => {
    if (closed) return Promise.resolve();
    return (flight ??= (async () => {
      if (!daemon) {
        const client = new Client({ name: SHIM_CLIENT_NAME, version: VERSION });
        const t = new StreamableHTTPClientTransport(new URL(`${daemonUrl}/mcp?${q}`), {
          fetch: async (url, init) => {
            // A call's (a POST's) headers come when the tool finishes; the handshake keeps its own deadline below.
            const res = await mcpFetch(url, init, handshake);
            if (res.status !== 404 || !t.sessionId) return res;
            await res.body?.cancel();
            // Closing the client rejects its pending requests at once, so the close waits a turn for this request
            // to fail with SessionLost, which tells a call it may be sent again.
            setTimeout(() => invalidate(client));
            throw new SessionLost("the agentgate daemon no longer knows this session");
          },
        });
        try {
          await client.connect(t, { timeout: handshake });
        } catch (e) {
          await client.close().catch(() => {});
          throw e;
        }
        if (closed) {
          await client.close();
          return;
        }
        daemon = client;
        transport = t;
        client.onclose = () => invalidate(client);
        client.setNotificationHandler("notifications/tools/list_changed", () => {
          void ensure()
            .then(changed)
            .catch(() => {});
        });
        changed();
      }
      await reconcile();
    })().finally(() => {
      flight = undefined;
      poll(!daemon);
    }));
  };
  await ensure().catch(() => {});
  const call = (client: Client, ...[params, options]: Parameters<NonNullable<Source["invoke"]>>) =>
    client.request(
      {
        method: "tools/call",
        params: thread ? { ...params, _meta: { [T3_THREAD_META_KEY]: thread, ...params._meta } } : params,
      },
      options,
    ) as Promise<CallToolResult>;
  const toDaemon = (client: Client): Source => ({
    alias: "",
    client,
    // A call the daemon refused for a forgotten session never ran, so it goes once more on a new session.
    invoke: async (params, options) => {
      try {
        return await call(client, params, options);
      } catch (e) {
        if (!(e instanceof SessionLost)) throw e;
        invalidate(client);
        await ensure();
        if (!daemon) throw e;
        return call(daemon, params, options);
      }
    },
  });
  const child = (alias: string): Source | undefined => {
    const c = children.get(alias);
    return c && { alias, client: c.client, instance: c.instance };
  };
  const sources = async (): Promise<Source[]> => {
    await ensure().catch(() => {});
    return [...(daemon ? [toDaemon(daemon)] : []), ...Array.from(children.keys(), (a) => child(a)!)];
  };
  server = mergedServer(daemon ? mergeInstructions(await sources()) : DAEMON_DOWN, sources, {
    onError: (alias, e) => console.error(`agentgate: ${alias || "daemon"}: ${e}`),
    // A call goes to the connection it was listed from. Listings and the timer reread the session's configuration;
    // a call does not, which saves it a round trip to the daemon.
    resolveSource: async (alias) => {
      if (alias) return child(alias);
      if (!daemon) await ensure().catch(() => {});
      return daemon && toDaemon(daemon);
    },
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      poll(false);
      await flight?.catch(() => {});
      try {
        if (transport?.sessionId) await transport.terminateSession();
      } catch {}
      // A stdio server may ignore its closed stdin: SIGTERM ends its group now, and its close still escalates to SIGKILL.
      for (const { client } of children.values()) {
        const pid = client.transport instanceof StdioTransport && client.transport.pid;
        try {
          if (pid) process.kill(-pid, "SIGTERM");
        } catch {
          // already exited
        }
      }
      await Promise.allSettled([
        ...(daemon ? [daemon.close()] : []),
        ...Array.from(children.values(), (c) => c.client.close()),
      ]);
      children.clear();
      daemon = undefined;
    })());
  return { project, server, close };
}

export async function runShim(daemonUrl = LOCAL_URL) {
  const { server, close } = await buildShim(process.cwd(), daemonUrl);
  const transport = new StdioServerTransport();
  // Without a handler a signal ends the shim at once and leaves its stdio servers running.
  const exit = () => close().finally(() => process.exit(0));
  transport.onclose = exit;
  process.stdin.on("end", exit);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, exit);
  await server.connect(transport);
}
