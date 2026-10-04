import { z } from "zod";

/** Wire protocol shared by the relay Worker and the daemon. See docs/internals/relay.md. */
export const RELAY_PROTOCOL = 1;
export const MiB = 1024 * 1024;
export const RELAY_LIMITS = {
  pushEntries: 500,
  pullEntries: 1000,
  /** Decoded sealed blob: nonce + ciphertext + tag. */
  blobBytes: MiB,
  /** Serialized JSON per request or response, base64 expansion included. */
  messageBytes: 8 * MiB,
  nodes: 64,
} as const;

const b64urlLength = (bytes: number) => Math.ceil((bytes * 4) / 3);
export const hex128 = z.string().regex(/^[0-9a-f]{32}$/);
export const relayGroupId = hex128;
export const relayGeneration = hex128;
/** Same bounds as store ids; no control characters so names are safe to print. */
export const relayNode = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/);
/** base64url HMAC-SHA256 without padding. */
export const relayKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const relayBlob = z.string().min(b64urlLength(12 + 16)).max(b64urlLength(RELAY_LIMITS.blobBytes)).regex(/^[A-Za-z0-9_-]+$/);
export const pusherSeq = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const relayEnvelope = z.object({ key: relayKey, pusherSeq, blob: relayBlob }).strict();
export type RelayEnvelope = z.infer<typeof relayEnvelope>;

export const createRequest = z.object({ protocol: z.literal(RELAY_PROTOCOL) }).strict();
export const groupState = z.object({ protocol: z.literal(RELAY_PROTOCOL), generation: relayGeneration, headSeq: seq });
export const pushRequest = z.object({
  protocol: z.literal(RELAY_PROTOCOL),
  generation: relayGeneration,
  node: relayNode,
  entries: z.array(relayEnvelope).min(1).max(RELAY_LIMITS.pushEntries),
}).strict();
export type PushRequest = z.infer<typeof pushRequest>;

export const relayEntry = relayEnvelope.extend({ node: relayNode, seq: seq.min(1) });
export type RelayEntry = z.infer<typeof relayEntry>;
export const changesResponse = z.object({
  protocol: z.literal(RELAY_PROTOCOL),
  generation: relayGeneration,
  nextCursor: seq,
  headSeq: seq,
  more: z.boolean(),
  entries: z.array(relayEntry).max(RELAY_LIMITS.pullEntries),
  seen: z.record(relayNode, seq),
});
export type ChangesResponse = z.infer<typeof changesResponse>;
export const nodesResponse = z.object({
  protocol: z.literal(RELAY_PROTOCOL),
  generation: relayGeneration,
  nodes: z.array(z.object({ node: relayNode, lastSeen: seq })).max(RELAY_LIMITS.nodes),
});
export const errorResponse = z.object({
  error: z.string(),
  code: z.string().optional(),
  resetRequired: z.boolean().optional(),
  generation: relayGeneration.optional(),
});
export type RelayError = z.infer<typeof errorResponse>;

/** Page invariants every client checks before committing a cursor. */
export function checkPage(page: ChangesResponse, since: number): string | undefined {
  if (page.nextCursor < since || page.nextCursor > page.headSeq) return "cursor out of range";
  let last = since;
  for (const e of page.entries) {
    if (e.seq <= last || e.seq > page.nextCursor) return "entries out of order";
    last = e.seq;
  }
  if (page.more && (!page.entries.length || page.nextCursor !== last)) return "page made no progress";
  if (!page.more && page.nextCursor !== page.headSeq) return "final page does not reach the head";
  return undefined;
}
