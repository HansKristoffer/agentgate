import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BUILTIN_ALIAS, type Source } from "../mcp/gateway.ts";
import type { Handoffs } from "./jobs.ts";
import { t3State } from "./t3.ts";
import { handoffTargets } from "@agentgate/protocol";
import { allNodes, requestHandoff } from "./threads.ts";

const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const fail = (value: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: value }] });

function server(h: Handoffs): Server {
  const server = new Server({ name: "agentgate-handoff", version: "1" }, { capabilities: { tools: {} } });
  // Only once T3 Code is connected here: other sessions have no thread to hand off.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: !t3State(h.s).url ? [] : [
      {
        name: "handoff_targets",
        description: "List the machines a T3 Code thread on this machine can be handed to, and why the others are unavailable. Servers are always-on machines.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "handoff_thread",
        description: "Hand a T3 Code thread, with its Claude session and its code (unpushed commits and uncommitted files), to another machine and continue it there. To hand off yourself, get your thread id from T3's t3_thread_configuration tool (called without arguments). Handing off the calling thread interrupts it right after this returns; it then continues on the other machine.",
        inputSchema: {
          type: "object", required: ["threadId"],
          properties: {
            threadId: { type: "string", description: "The T3 Code thread id" },
            to: { type: "string", description: "\"server\" (default: the first available always-on machine), \"here\", or a machine name" },
          },
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (req.params.name === "handoff_targets") return text(handoffTargets(await allNodes(h), h.s.nodeId));
      if (req.params.name !== "handoff_thread") return fail(`unknown tool ${req.params.name}`);
      if (typeof args.threadId !== "string" || !args.threadId) return fail("threadId is required");
      const started = await requestHandoff(h, { threadId: args.threadId, to: typeof args.to === "string" ? args.to : undefined });
      return text({ status: "started", ...started });
    } catch (e) { return fail((e as Error).message); }
  });
  return server;
}

/** Built-in gateway tools under the `agentgate` alias, so an agent can hand its own thread to another machine. */
export async function handoffSource(h: Handoffs): Promise<Source> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const srv = server(h), client = new Client({ name: "agentgate", version: "1" });
  await Promise.all([srv.connect(a), client.connect(b)]);
  const close = client.close.bind(client);
  client.close = async () => { await close(); await srv.close(); };
  return { alias: BUILTIN_ALIAS, client };
}
