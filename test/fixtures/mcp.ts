import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ["cwd", "slow"].map(name => ({ name, inputSchema: { type: "object" as const } })) }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name === "slow") {
    const token = extra._meta?.progressToken;
    if (token !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: 1, total: 2 } });
    await new Promise<void>((resolve) => {
      if (extra.signal.aborted) return resolve();
      const timer = setTimeout(resolve, 10000);
      extra.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    if (extra.signal.aborted) { await Bun.write(process.env.AGENTGATE_CANCEL_FILE ?? `${process.cwd()}/cancelled`, "yes"); throw new Error("cancelled"); }
  }
  return { content: [{ type: "text", text: process.cwd() }] };
});
await server.connect(new StdioServerTransport());
