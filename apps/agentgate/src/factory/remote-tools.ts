import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Server, type CallToolResult, type ListToolsResult, type Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import { FACTORY_ALIAS, type Source } from "../mcp/gateway.ts";
import { setFactoryWebhook } from "../operations.ts";
import { runOperation, shortError, type FactoryRuntime, type Operation } from "./runtime.ts";

/**
 * The factory's tools on a virtual project's public endpoint (`factoryTools`), for assistants such as Grok: every
 * operation that says `remote` (the board, one item, adding work to any of the folder's repositories, the item
 * actions, pause and resume), and the webhook the factory posts its updates to (notify.ts). An operation reaches the
 * factory machine from whichever machine serves the endpoint. Adds start at triage like `factory add`, not held like
 * the agent tool `factory_add`: the maintainer chose to give the endpoint full control, and the URL and secret are the
 * only gate.
 */

/** Not an operation: it is the endpoint's own setting, on the project the request came through. */
const WEBHOOK = {
  name: "webhook",
  description:
    'Set the https URL the factory posts its updates to (an item added, moved to another phase, or waiting for the maintainer), or clear it with an empty url. Each POST is JSON: { type: "agentgate.factory.updates", node, updates: [{ seq, at, kind, text, item }] }; dedupe by node and seq, since a failed post is sent again.',
  input: z.object({
    url: z
      .string()
      .max(2000)
      .describe("An https URL; put a token for your receiver in its path or query. Empty clears it."),
  }),
};

type Offered = Operation & { remote: NonNullable<Operation["remote"]> };
const offered = (f: FactoryRuntime) => [...f.operations.values()].filter((op): op is Offered => !!op.remote);
const toolName = (op: Operation) => op.name.replaceAll(" ", "_");
const inputSchema = (input: z.ZodType) => z.toJSONSchema(input, { io: "input" }) as Tool["inputSchema"];

const text = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const fail = (value: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: value }] });

function server(f: FactoryRuntime, project: string): Server {
  const server = new Server(
    { name: "agentgate-factory", version: "1" },
    {
      capabilities: { tools: {} },
      instructions:
        "The maintainer's software factory works tasks in their repositories in T3 Code threads, up to a pull request they merge. Call factory__status first: it lists the repositories you can add tasks to and what waits for the maintainer.",
    },
  );
  server.setRequestHandler("tools/list", async (): Promise<ListToolsResult> => ({
    tools: [
      ...offered(f).map((op) => ({
        name: toolName(op),
        description: op.remote.description,
        inputSchema: inputSchema(op.input),
      })),
      { name: WEBHOOK.name, description: WEBHOOK.description, inputSchema: inputSchema(WEBHOOK.input) },
    ],
  }));
  server.setRequestHandler("tools/call", async (req) => {
    const args = req.params.arguments ?? {};
    try {
      if (req.params.name === WEBHOOK.name) {
        const url = WEBHOOK.input.parse(args).url.trim();
        setFactoryWebhook(f.s, project, url || undefined);
        return text(url ? "Updates will be posted to that URL." : "Updates are no longer posted.");
      }
      const op = offered(f).find((o) => toolName(o) === req.params.name);
      if (!op) return fail(`unknown tool ${req.params.name}`);
      const result = await runOperation(f, op.name, args, { via: "remote", node: f.s.nodeId });
      return text(op.remote.result ? op.remote.result(result) : result);
    } catch (e) {
      // The factory's own messages, as the CLI shows them; they name items and machines, never a credential.
      return fail(e instanceof z.ZodError ? z.prettifyError(e) : shortError(e));
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
