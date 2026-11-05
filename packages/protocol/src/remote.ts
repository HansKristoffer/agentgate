import { z } from "zod";

/** Remote endpoints (MCP and webhooks): frames between the relay's endpoint object and the serving node. See docs/internals/remote-mcp.md. */
export const REMOTE_LIMITS = {
  requestBytes: 256 * 1024,
  /** Webhook deliveries (`/hook/:key`) are bigger than MCP requests: a GitHub push event can carry many commits. */
  hookRequestBytes: 1024 * 1024,
  /** Longest header name, header value or query string the relay forwards. */
  fieldChars: 8192,
  responseBytes: 4 * 1024 * 1024,
  /** Requests in flight per endpoint, at the relay and on the node. */
  inFlight: 4,
  timeoutMs: 10 * 60_000,
  /** Largest frame either side accepts: a response body plus JSON escaping and metadata. */
  frameBytes: 9 * 1024 * 1024,
} as const;

export const remoteKey = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const id = z.string().min(1).max(64);
const headers = z.record(z.string().max(64), z.string().max(1024));

/**
 * relay → node. MCP requests carry only `mcp-protocol-version`; webhook deliveries carry every header the sender
 * set except cookies and hop-by-hop headers, and the query string, so the node can check signatures.
 */
export const remoteRequestFrame = z
  .object({
    t: z.literal("req"),
    id,
    headers: z.record(z.string().max(REMOTE_LIMITS.fieldChars), z.string().max(REMOTE_LIMITS.fieldChars)),
    body: z.string().max(REMOTE_LIMITS.hookRequestBytes),
    query: z.string().max(REMOTE_LIMITS.fieldChars).optional(),
  })
  .strict();
export const remoteCancelFrame = z.object({ t: z.literal("cancel"), id }).strict();
export const relayFrame = z.discriminatedUnion("t", [remoteRequestFrame, remoteCancelFrame]);

/** node → relay. `retry` means the node did not start the request (it was at capacity). */
export const remoteResponseFrame = z
  .object({
    t: z.literal("res"),
    id,
    status: z.number().int().min(100).max(599),
    headers,
    body: z.string().max(REMOTE_LIMITS.responseBytes),
    retry: z.boolean().optional(),
  })
  .strict();
export type RemoteResponseFrame = z.infer<typeof remoteResponseFrame>;

/**
 * `PUT /e/:key`: the serving node sets the hashes the relay checks. A `hook` endpoint is served at `/hook/:key`
 * without a bearer, so its `secretHash` is never checked; the node checks the sender's signature instead.
 */
export const endpointUpdate = z
  .object({
    secretHash: z.string().regex(/^[0-9a-f]{64}$/),
    enabled: z.boolean(),
    kind: z.enum(["mcp", "hook"]).default("mcp"),
  })
  .strict();

export { sha256Hex } from "hanzio/crypto";
