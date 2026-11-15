/** How long a body may take to arrive. A stalled sender would hold its request open, so it is cut off after this. */
const BODY_DEADLINE_MS = 30_000;

/** A request body of at most `max` bytes, or undefined when it is larger. A sender that stalls is cut off. */
export async function readBounded(req: Request, max: number): Promise<Uint8Array | undefined> {
  // The header is checked first so an oversized sender is refused without reading its body.
  if (Number(req.headers.get("content-length") ?? 0) > max) return undefined;

  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = setTimeout(() => {
    void reader.cancel();
  }, BODY_DEADLINE_MS);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(deadline);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
