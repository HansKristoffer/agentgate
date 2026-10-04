import { z } from "zod";

/** Remote MCP endpoints: frames between the relay's endpoint object and the serving node. See docs/internals/remote-mcp.md. */
export const REMOTE_LIMITS = {
  requestBytes: 256 * 1024,
  responseBytes: 4 * 1024 * 1024,
  /** Requests in flight per endpoint, at the relay and on the node. */
  inFlight: 4,
  timeoutMs: 10 * 60_000,
  /** Largest frame either side accepts: a response body plus JSON escaping and metadata. */
  frameBytes: 9 * 1024 * 1024,
} as const;

export const remoteKey = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const remoteToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const id = z.string().min(1).max(64);
const headers = z.record(z.string().max(64), z.string().max(1024));

/** relay → node */
export const remoteRequestFrame = z.object({ t: z.literal("req"), id, headers, body: z.string().max(REMOTE_LIMITS.requestBytes) }).strict();
export const remoteCancelFrame = z.object({ t: z.literal("cancel"), id }).strict();
export const relayFrame = z.discriminatedUnion("t", [remoteRequestFrame, remoteCancelFrame]);
export type RelayFrame = z.infer<typeof relayFrame>;

/** node → relay. `retry` means the node did not start the request (it was at capacity). */
export const remoteResponseFrame = z.object({
  t: z.literal("res"), id, status: z.number().int().min(100).max(599), headers, body: z.string().max(REMOTE_LIMITS.responseBytes), retry: z.boolean().optional(),
}).strict();
export type RemoteResponseFrame = z.infer<typeof remoteResponseFrame>;

/** `PUT /e/:key`: the serving node sets the hashes the relay checks. */
export const endpointUpdate = z.object({ secretHash: z.string().regex(/^[0-9a-f]{64}$/), enabled: z.boolean() }).strict();
export type EndpointUpdate = z.infer<typeof endpointUpdate>;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
