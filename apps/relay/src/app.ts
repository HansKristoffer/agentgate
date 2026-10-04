import { RELAY_LIMITS, relayGroupId } from "@agentgate/protocol/relay";
import { remoteKey } from "@agentgate/protocol/remote";

/** What the Worker asks a RemoteEndpoint object to do; workers-only code lives in remote.ts. */
export type EndpointOp = "mcp" | "connect" | "update" | "delete";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { sameHash, type GroupOp, type GroupRequest, type Reply } from "./group.ts";

export interface RelayDeps {
  group(groupId: string): { handle(req: GroupRequest): Promise<Reply> };
  /** Remote MCP endpoints; absent in the in-process test relay. */
  endpoint?(key: string): { fetch(req: Request): Promise<Response> };
  /** Optional deployment-wide secret (self-hosting). */
  relayKey?: string;
  /** Optional aggregate per-address throttle, e.g. a Workers rate limiting binding. */
  ipLimit?(ipHash: string): Promise<boolean>;
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const reject = (status: 400 | 413, error: string, code: string) => new HTTPException(status, { res: new Response(JSON.stringify({ error, code }), { status, headers: { "content-type": "application/json" } }) });
const sha256 = async (text: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

async function readJson(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > RELAY_LIMITS.messageBytes) throw reject(413, "request too large", "size");
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RELAY_LIMITS.messageBytes) { await reader.cancel(); throw reject(413, "request too large", "size"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw reject(400, "invalid JSON", "shape"); }
}

export function relayApp(deps: RelayDeps) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    console.error(`relay request failed: ${error.name} ${error.message}`);
    return c.json({ error: "relay error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.get("/", (c) => c.text("agentgate relay\n"));

  const route = (op: GroupOp, hasBody: boolean) => async (c: Context) => {
    // A deployment key is checked before anything that could create or read group state.
    if (deps.relayKey && !sameHash(await sha256(c.req.header("x-relay-key") ?? ""), await sha256(deps.relayKey))) return c.json({ error: "relay key required", code: "relayKey" }, 401);
    const groupId = c.req.param("group");
    if (!relayGroupId.safeParse(groupId).success) return c.json({ error: "invalid group", code: "shape" }, 400);
    const token = c.req.header("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const ipHash = await sha256(`agentgate-relay-ip/${c.req.header("cf-connecting-ip") ?? "unknown"}`);
    if (deps.ipLimit && !(await deps.ipLimit(ipHash))) return c.json({ error: "too many requests", code: "rate" }, 429, { "retry-after": "60" });
    const body = hasBody ? await readJson(c.req.raw) : undefined;
    const reply = await deps.group(groupId!).handle({ op, groupId: groupId!, authHash: await sha256(token), ipHash, body, query: Object.fromEntries(new URL(c.req.url).searchParams) });
    const headers: Record<string, string> = { "cache-control": "no-store" };
    if (reply.retryAfter) headers["retry-after"] = String(reply.retryAfter);
    return c.json(reply.body as object, reply.status as 200, headers);
  };

  // Remote MCP endpoints. The public route can't require x-relay-key: clients like Grok only send a bearer token.
  const endpoint = (op: EndpointOp) => async (c: Context) => {
    const key = c.req.param("key");
    if (!deps.endpoint || !remoteKey.safeParse(key).success) return c.json({ error: "not found" }, 404);
    if (op !== "mcp" && deps.relayKey && !sameHash(await sha256(c.req.header("x-relay-key") ?? ""), await sha256(deps.relayKey))) return c.json({ error: "relay key required", code: "relayKey" }, 401);
    const ipHash = await sha256(`agentgate-relay-ip/${c.req.header("cf-connecting-ip") ?? "unknown"}`);
    if (deps.ipLimit && !(await deps.ipLimit(ipHash))) return c.json({ error: "too many requests", code: "rate" }, 429, { "retry-after": "60" });
    // Only the headers the endpoint reads; x-agentgate-* comes from here, never from the caller.
    const headers = new Headers({ "x-agentgate-op": op, "x-agentgate-key": key!, "x-agentgate-ip": ipHash });
    for (const name of ["authorization", "content-type", "content-length", "mcp-protocol-version", "upgrade", "x-agentgate-node"]) {
      const value = c.req.header(name);
      if (value !== undefined && (name !== "x-agentgate-node" || op === "connect")) headers.set(name, value);
    }
    const raw = c.req.raw;
    return deps.endpoint(key!).fetch(new Request(raw.url, { method: raw.method, headers, body: raw.body, signal: raw.signal }));
  };
  app.post("/mcp/:key", endpoint("mcp"));
  app.all("/mcp/:key", (c) => c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, 405, { allow: "POST" }));
  app.put("/e/:key", endpoint("update"));
  app.delete("/e/:key", endpoint("delete"));
  app.get("/e/:key/connect", endpoint("connect"));

  app.post("/g/:group", route("create", true));
  app.post("/g/:group/push", route("push", true));
  app.get("/g/:group/changes", route("changes", false));
  app.get("/g/:group/nodes", route("nodes", false));
  app.delete("/g/:group", route("delete", false));
  return app;
}
