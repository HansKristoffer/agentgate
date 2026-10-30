import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler("tools/list", async () => ({ tools: ["cwd", "slow"].map(name => ({ name, inputSchema: { type: "object" as const } })) }));
server.setRequestHandler("tools/call", async (request, ctx) => {
  if (request.params.name === "slow") {
    const token = ctx.mcpReq._meta?.progressToken;
    if (token !== undefined) await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: 1, total: 2 } });
    await new Promise<void>((resolve) => {
      if (ctx.mcpReq.signal.aborted) return resolve();
      const timer = setTimeout(resolve, 10000);
      ctx.mcpReq.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    if (ctx.mcpReq.signal.aborted) { await Bun.write(process.env.AGENTGATE_CANCEL_FILE ?? `${process.cwd()}/cancelled`, "yes"); throw new Error("cancelled"); }
  }
  return { content: [{ type: "text", text: process.cwd() }] };
});
await server.connect(new StdioServerTransport());
