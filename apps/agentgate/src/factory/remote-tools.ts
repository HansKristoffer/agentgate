import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Server, type CallToolResult, type ListToolsResult, type Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  factoryActionInputSchema,
  factoryItemDetailSchema,
  factoryItemInputSchema,
  itemActions,
  type ItemAction,
} from "@agentgate/protocol";
import { FACTORY_ALIAS, type Source } from "../mcp/gateway.ts";
import { setFactoryWebhook } from "../operations.ts";
import { boardText, boardView } from "./board.ts";
import { detailText } from "./controller.ts";
import { runOp, shortError, type FactoryRuntime } from "./runtime.ts";

/**
 * The factory's tools on a virtual project's public endpoint (`factoryTools`), for assistants such as Grok: the board,
 * one item, adding work to any of the folder's repositories, the item actions, pause and resume, and the webhook the
 * factory posts its updates to (notify.ts). Each but the webhook calls the operation the CLI calls, which reaches the
 * factory machine from whichever machine serves the endpoint. Adds start at triage like `factory add`, not held like
 * the agent tool `factory_add`: the maintainer chose to give the endpoint full control, and the URL and secret are the
 * only gate.
 */

const item = z.object({
  item: z.string().min(1).max(200).describe("The item's key (web-42), id or issue (owner/repo#42)"),
});
const none = z.object({});

const ACTION_HELP: Record<ItemAction, string> = {
  approve:
    "Approve an item that waits for the maintainer: start a held item's stage, take a stage's recommendation (or give your answer as reason), approve a spec, or say what changed for a blocked item.",
  reject:
    "Reject an item that waits for the maintainer: turn a held item away, refuse a stage's recommendation, or ask for spec changes with reason as the feedback.",
  retry:
    "Take an item that failed, went over its token budget, stalled, got stuck, was stopped or handed off back to work, or start a closed item again at triage.",
  drop: "Stop an item's threads and close it with a comment. Its PR, if it has one, stays open.",
};

interface RemoteTool {
  description: string;
  input: z.ZodObject;
  run(input: Record<string, unknown>): Promise<unknown>;
}

function tools(f: FactoryRuntime, project: string): Record<string, RemoteTool> {
  const actions = Object.fromEntries(
    itemActions.map((action) => [
      action,
      {
        description: ACTION_HELP[action],
        input: item.extend(factoryActionInputSchema.shape),
        run: async (input: Record<string, unknown>) => ((await runOp(f, action, input)) as { message: string }).message,
      },
    ]),
  );
  return {
    status: {
      description:
        "The software factory's board: the repositories it works, its items by phase with their PRs, what waits for the maintainer, capacity and sources.",
      input: none,
      run: async () => boardText(await boardView(f, { includeWebhookUrls: false }), { short: true }).join("\n"),
    },
    show: {
      description:
        "One factory item: its phase, PR, runs with their T3 Code threads, the comments the factory posted and recent events.",
      input: item,
      run: async (input) => detailText(factoryItemDetailSchema.parse(await runOp(f, "show", input))).join("\n"),
    },
    add: {
      description:
        "Add a task for the factory in one of its repositories (factory__status lists them). It is triaged in a T3 Code thread like a labelled issue, then fixed or specced up to a pull request for the maintainer to merge.",
      input: factoryItemInputSchema,
      run: (input) => runOp(f, "add", input),
    },
    ...actions,
    pause: {
      description:
        "Pause the factory: no intake, new threads or nudges until resume. Running threads finish their turn.",
      input: none,
      run: async () => ((await runOp(f, "pause", {})) as { message: string }).message,
    },
    resume: {
      description: "Resume a paused factory.",
      input: none,
      run: async () => ((await runOp(f, "resume", {})) as { message: string }).message,
    },
    webhook: {
      description:
        'Set the https URL the factory posts its updates to (an item added, moved to another phase, or waiting for the maintainer), or clear it with an empty url. Each POST is JSON: { type: "agentgate.factory.updates", node, updates: [{ seq, at, kind, text, item }] }; dedupe by node and seq, since a failed post is sent again.',
      input: z.object({
        url: z
          .string()
          .max(2000)
          .describe("An https URL; put a token for your receiver in its path or query. Empty clears it."),
      }),
      run: async (input) => {
        const url = String(input.url ?? "").trim();
        setFactoryWebhook(f.s, project, url || undefined);
        return url ? "Updates will be posted to that URL." : "Updates are no longer posted.";
      },
    },
  };
}

const text = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

function server(f: FactoryRuntime, project: string): Server {
  const all = tools(f, project);
  const server = new Server(
    { name: "agentgate-factory", version: "1" },
    {
      capabilities: { tools: {} },
      instructions:
        "The maintainer's software factory works tasks in their repositories in T3 Code threads, up to a pull request they merge. Call factory__status first: it lists the repositories you can add tasks to and what waits for the maintainer.",
    },
  );
  server.setRequestHandler("tools/list", async (): Promise<ListToolsResult> => ({
    tools: Object.entries(all).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.input, { io: "input" }) as Tool["inputSchema"],
    })),
  }));
  server.setRequestHandler("tools/call", async (req) => {
    const tool = all[req.params.name];
    if (!tool) return { isError: true, content: [{ type: "text", text: `unknown tool ${req.params.name}` }] };
    const input = tool.input.safeParse(req.params.arguments ?? {});
    if (!input.success) return { isError: true, content: [{ type: "text", text: z.prettifyError(input.error) }] };
    try {
      return text(await tool.run(input.data));
    } catch (e) {
      // The factory's own messages, as the CLI shows them; they name items and machines, never a credential.
      return { isError: true, content: [{ type: "text", text: shortError(e) }] };
    }
  });
  return server;
}

/** The tools as a gateway source under the `factory` alias, for one remote request. */
export async function factoryToolsSource(f: FactoryRuntime, project: string): Promise<Source> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const srv = server(f, project),
    client = new Client({ name: "agentgate", version: "1" });
  await Promise.all([srv.connect(a), client.connect(b)]);
  const close = client.close.bind(client);
  client.close = async () => {
    await close();
    await srv.close();
  };
  return { alias: FACTORY_ALIAS, client };
}
