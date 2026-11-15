import { Server, type CallToolResult, type ListToolsResult, type Tool } from "@modelcontextprotocol/server";
import { getErrorMessage } from "hanzio";
import { z } from "zod";
import { BUILTIN_ALIAS } from "../mcp/gateway.ts";
import { inProcessSource } from "../mcp/source.ts";
import type { Handoffs } from "./jobs.ts";
import { t3State } from "./t3.ts";
import { MAX_AGENTS_MD, T3_THREAD_META_KEY, handoffTargets } from "@agentgate/protocol";
import { agentsMd, setAgentsMd } from "../agents-md.ts";
import { revision } from "../configuration.ts";
import { agentsMdPath } from "../skill-links.ts";
import { allNodes, requestHandoff } from "./threads.ts";
import { runOperation, type FactoryRuntime } from "../factory/runtime.ts";

const text = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});
const fail = (value: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: value }] });
/** What an agent is told about arguments a factory tool refuses: the first problem, by its field. */
function refused(error: z.ZodError) {
  const issue = error.issues[0]!;
  const field = [...issue.path, ...(issue.code === "unrecognized_keys" ? [issue.keys[0]!] : [])].join(".");
  return `${field ? `${field}: ` : ""}${issue.message}`;
}

const agentsMdWrite = z
  .object({ text: z.string().max(MAX_AGENTS_MD), revision: z.string().max(1024).optional() })
  .strict();
/** The global AGENTS.md (agents-md.ts), for an agent the user asks to change the instructions every session gets. */
const agentsMdTools: Tool[] = [
  {
    name: "agents_md_read",
    description:
      "Read the user's global AGENTS.md: instructions every Claude Code and Codex session reads, in every project, on all of the user's machines. Returns its text, the file it lives in on this machine, and the revision to pass to agents_md_write.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agents_md_write",
    description:
      "Replace the user's global AGENTS.md on all of their machines; new sessions read it. Only when the user asks for a change to it. Call agents_md_read first and send the whole new text with its revision; empty text removes it.",
    inputSchema: z.toJSONSchema(agentsMdWrite, { io: "input" }) as Tool["inputSchema"],
  },
];

function server(h: Handoffs, f?: FactoryRuntime): Server {
  const server = new Server({ name: "agentgate-handoff", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async (): Promise<ListToolsResult> => {
    const tools: Tool[] = [...agentsMdTools];
    // Only once T3 Code is connected here: other sessions have no thread to hand off.
    if (t3State(h.s).url)
      tools.push(
        {
          name: "handoff_targets",
          description:
            "List the machines a T3 Code thread on this machine can be handed to, and why the others are unavailable. Servers are always-on machines.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "handoff_thread",
          description:
            "Hand a T3 Code thread, with its Claude session and its code (unpushed commits and uncommitted files), to another machine and continue it there. To hand off yourself, get your thread id from T3's t3_thread_configure tool (called without arguments). Handing off the calling thread interrupts it right after this returns; it then continues on the other machine.",
          inputSchema: {
            type: "object",
            required: ["threadId"],
            properties: {
              threadId: { type: "string", description: "The T3 Code thread id" },
              to: {
                type: "string",
                description: '"server" (default: the first available always-on machine), "here", or a machine name',
              },
            },
          },
        },
      );
    if (f?.pointer())
      for (const { tool, input } of f.operations.values())
        if (tool)
          tools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: z.toJSONSchema(input, { io: "input" }) as Tool["inputSchema"],
          });
    return { tools };
  });
  server.setRequestHandler("tools/call", async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const op = f?.pointer() ? [...f.operations.values()].find((o) => o.tool?.name === req.params.name) : undefined;
      if (f && op?.tool) {
        const thread = req.params._meta?.[T3_THREAD_META_KEY];
        const result = await runOperation(f, op.name, args, {
          via: "tool",
          ...(typeof thread === "string" && thread && { thread }),
          node: h.s.nodeId,
        });
        return text(op.tool.result ? op.tool.result(result) : result);
      }
      if (req.params.name === "agents_md_read")
        return text({ text: agentsMd(h.s), path: agentsMdPath(), revision: revision(h.s, "project", "*") });
      if (req.params.name === "agents_md_write") {
        const input = agentsMdWrite.parse(args);
        setAgentsMd(h.s, input.text, input.revision);
        return text({ status: input.text ? "saved" : "removed", revision: revision(h.s, "project", "*") });
      }
      if (req.params.name === "handoff_targets") return text(handoffTargets(await allNodes(h), h.s.nodeId));
      if (req.params.name !== "handoff_thread") return fail(`unknown tool ${req.params.name}`);
      if (typeof args.threadId !== "string" || !args.threadId) return fail("threadId is required");
      const started = await requestHandoff(h, {
        threadId: args.threadId,
        to: typeof args.to === "string" ? args.to : undefined,
      });
      return text({ status: "started", ...started });
    } catch (e) {
      return fail(e instanceof z.ZodError ? refused(e) : getErrorMessage(e));
    }
  });
  return server;
}

/**
 * Built-in gateway tools under the `agentgate` alias, so an agent can read and change the global AGENTS.md and hand
 * its own thread to another machine, and, while the factory is on, the factory's tools.
 */
export const handoffSource = (h: Handoffs, f?: FactoryRuntime) => inProcessSource(BUILTIN_ALIAS, server(h, f));
