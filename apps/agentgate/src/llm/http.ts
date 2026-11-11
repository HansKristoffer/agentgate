import { fetchHeaders, readBody } from "../runtime.ts";

/** A provider's read-only JSON endpoint called with a bearer token. The deadline covers the body as well as the
 * headers, the body is capped, and a refused response is cancelled unread and thrown as `refused(status)`, so its
 * text (which may echo a token) never reaches an error. */
export async function fetchJson(
  url: string,
  accessToken: string,
  refused: (status: number) => string,
  {
    headers = {},
    signal,
    timeoutMs = 10_000,
    maxBytes = 256 * 1024,
    ...init
  }: Omit<RequestInit, "headers" | "signal"> & {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): Promise<unknown> {
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const res = await fetchHeaders(
    url,
    { ...init, headers: { ...headers, authorization: `Bearer ${accessToken}` }, signal: deadline },
    timeoutMs,
  );
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(refused(res.status));
  }
  return JSON.parse(new TextDecoder().decode(await readBody(res.body, maxBytes, deadline)));
}
