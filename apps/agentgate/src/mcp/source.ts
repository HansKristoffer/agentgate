import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { Server } from "@modelcontextprotocol/server";
import type { Source } from "./gateway.ts";

/** A server the daemon runs itself, as a gateway source under `alias`. Closing the source's client closes the server. */
export async function inProcessSource(alias: string, server: Server): Promise<Source> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agentgate", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const close = client.close.bind(client);
  client.close = async () => {
    await close();
    await server.close();
  };
  return { alias, client };
}
