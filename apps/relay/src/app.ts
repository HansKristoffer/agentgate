import { RELAY_LIMITS, relayGroupId } from "@agentgate/protocol/relay";
import { safeEqual, sha256Hex } from "hanzio/crypto";
import { remoteKey } from "@agentgate/protocol/remote";

/** What the Worker asks a RemoteEndpoint object to do; workers-only code lives in remote.ts. */
export type EndpointOp = "mcp" | "hook" | "connect" | "update" | "delete";
/** What the Worker asks a group's RelayChannel object to do. */
export type ChannelOp = "call" | "connect";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { readBounded } from "./body.ts";
import { type GroupOp, type GroupRequest, type Reply } from "./group.ts";

export interface RelayDeps {
  group(groupId: string): { handle(req: GroupRequest): Promise<Reply> };
  /** Remote MCP endpoints; absent in the in-process test relay. */
  endpoint?(key: string): { fetch(req: Request): Promise<Response> };
  /** Node channels, one per group. */
  channel?(groupId: string): { fetch(req: Request): Promise<Response> };
  /** Optional deployment-wide secret (self-hosting). */
  relayKey?: string;
  /** Optional aggregate per-address throttle, e.g. a Workers rate limiting binding. */
  ipLimit?(ipHash: string): Promise<boolean>;
}

/** Never forwarded to a webhook's machine: they describe this hop, or (cookies) belong to the relay's origin. */
const NOT_FORWARDED = new Set([
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "cookie",
]);

const reject = (status: 400 | 413, error: string, code: string) =>
  new HTTPException(status, {
    res: new Response(JSON.stringify({ error, code }), { status, headers: { "content-type": "application/json" } }),
  });

async function readJson(req: Request): Promise<unknown> {
  const bytes = await readBounded(req, RELAY_LIMITS.messageBytes);
  if (!bytes) throw reject(413, "request too large", "size");
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw reject(400, "invalid JSON", "shape");
  }
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

  // Hashed once per app; the Worker keeps one app per isolate (index.ts).
  const relayKeyHash = deps.relayKey ? sha256Hex(deps.relayKey) : undefined;

  /**
   * The checks every route makes before it touches a Durable Object: the deployment key (when `relayKey`), the group
   * id and its bearer token (when `group`), then the per-address limit. A refusal comes back as the response.
   */
  const gate = async (c: Context, need: { relayKey: boolean; group: boolean }) => {
    if (need.relayKey && relayKeyHash) {
      const given = await sha256Hex(c.req.header("x-relay-key") ?? "");
      if (!safeEqual(given, await relayKeyHash)) return c.json({ error: "relay key required", code: "relayKey" }, 401);
    }
    let groupId = "",
      authHash = "";
    if (need.group) {
      groupId = c.req.param("group") ?? "";
      if (!relayGroupId.safeParse(groupId).success) return c.json({ error: "invalid group", code: "shape" }, 400);
      const token = c.req.header("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (!token) return c.json({ error: "unauthorized" }, 401);
      authHash = await sha256Hex(token);
    }
    const ipHash = await sha256Hex(`agentgate-relay-ip/${c.req.header("cf-connecting-ip") ?? "unknown"}`);
    if (deps.ipLimit && !(await deps.ipLimit(ipHash)))
      return c.json({ error: "too many requests", code: "rate" }, 429, { "retry-after": "60" });
    return { groupId, authHash, ipHash };
  };

  const route = (op: GroupOp, hasBody: boolean) => async (c: Context) => {
    const passed = await gate(c, { relayKey: true, group: true });
    if (passed instanceof Response) return passed;
    const { groupId, authHash, ipHash } = passed;
    const body = hasBody ? await readJson(c.req.raw) : undefined;
    const reply = await deps.group(groupId).handle({
      op,
      groupId,
      authHash,
      ipHash,
      body,
      query: Object.fromEntries(new URL(c.req.url).searchParams),
    });
    const headers: Record<string, string> = { "cache-control": "no-store" };
    if (reply.retryAfter) headers["retry-after"] = String(reply.retryAfter);
    return c.json(reply.body as object, reply.status as 200, headers);
  };

  // Remote endpoints. The public routes can't require x-relay-key: clients like Grok only send a bearer token, and
  // webhook senders send nothing the relay could check.
  const endpoint = (op: EndpointOp) => async (c: Context) => {
    const key = c.req.param("key");
    if (!deps.endpoint || !remoteKey.safeParse(key).success) return c.json({ error: "not found" }, 404);
    const passed = await gate(c, { relayKey: op !== "mcp" && op !== "hook", group: false });
    if (passed instanceof Response) return passed;
    const { ipHash } = passed;
    // Only the headers the endpoint reads, or for a webhook every header its sender might sign;
    // x-agentgate-* comes from here, never from the caller.
    const headers = new Headers();
    if (op === "hook") {
      // Headers that Connection names are hop-by-hop too.
      const named = (c.req.header("connection") ?? "").split(",").map((n) => n.trim().toLowerCase());
      for (const [name, value] of c.req.raw.headers) {
        const dropped = NOT_FORWARDED.has(name) || named.includes(name) || /^(proxy-|x-agentgate-)/.test(name);
        if (!dropped) headers.set(name, value);
      }
    } else {
      for (const name of [
        "authorization",
        "content-type",
        "content-length",
        "mcp-protocol-version",
        "upgrade",
        "x-agentgate-node",
      ]) {
        const value = c.req.header(name);
        if (value !== undefined && (name !== "x-agentgate-node" || op === "connect")) headers.set(name, value);
      }
    }
    headers.set("x-agentgate-op", op);
    headers.set("x-agentgate-key", key!);
    headers.set("x-agentgate-ip", ipHash);
    const raw = c.req.raw;
    return deps
      .endpoint(key!)
      .fetch(new Request(raw.url, { method: raw.method, headers, body: raw.body, signal: raw.signal }));
  };
  app.post("/mcp/:key", endpoint("mcp"));
  app.all("/mcp/:key", (c) =>
    c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, 405, {
      allow: "POST",
    }),
  );
  app.post("/hook/:key", endpoint("hook"));
  app.all("/hook/:key", (c) => c.json({ error: "method not allowed" }, 405, { allow: "POST" }));
  app.put("/e/:key", endpoint("update"));
  app.delete("/e/:key", endpoint("delete"));
  app.get("/e/:key/connect", endpoint("connect"));

  // Node channel: group members call each other (thread handoff). Same token and deployment key as sync.
  const channel = (op: ChannelOp) => async (c: Context) => {
    if (!deps.channel) return c.json({ error: "not found" }, 404);
    const passed = await gate(c, { relayKey: true, group: true });
    if (passed instanceof Response) return passed;
    const headers = new Headers({
      "x-agentgate-op": op,
      "x-agentgate-group": passed.groupId,
      "x-agentgate-auth": passed.authHash,
      "x-agentgate-ip": passed.ipHash,
      "x-agentgate-node": c.req.param("node")!,
    });
    for (const name of ["content-length", "upgrade"]) {
      const value = c.req.header(name);
      if (value !== undefined) headers.set(name, value);
    }
    const raw = c.req.raw;
    return deps
      .channel(passed.groupId)
      .fetch(new Request(raw.url, { method: raw.method, headers, body: raw.body, signal: raw.signal }));
  };
  app.post("/g/:group/n/:node/call", channel("call"));
  app.get("/g/:group/n/:node/connect", channel("connect"));

  app.post("/g/:group", route("create", true));
  app.post("/g/:group/push", route("push", true));
  app.get("/g/:group/changes", route("changes", false));
  app.get("/g/:group/nodes", route("nodes", false));
  app.delete("/g/:group", route("delete", false));
  return app;
}
