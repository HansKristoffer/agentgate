import { setTimeout as delay } from "node:timers/promises";

export const MAX_BODY = 16 * 1024 * 1024;
export class BodyTooLarge extends Error { }
export class Unavailable extends Error { }
export const sleep = (ms: number, signal?: AbortSignal) => delay(Math.max(0, ms), undefined, { signal });

export async function readBody(body: ReadableStream<Uint8Array> | null, limit = MAX_BODY, signal?: AbortSignal): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel(signal?.reason).catch(() => { }); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (; ;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new BodyTooLarge(`request exceeds ${Math.round(limit / 1024 / 1024)} MiB`);
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
    return out;
  } catch (e) { await reader.cancel(e).catch(() => { }); throw e; }
  finally { signal?.removeEventListener("abort", abort); reader.releaseLock(); }
}

/** Stop waiting for headers while allowing an established response stream to continue. */
export async function fetchHeaders(url: string | URL | Request, init: RequestInit = {}, timeout = 30_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Unavailable("upstream response timeout")), timeout);
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  try { return await fetch(url, { ...init, signal }); }
  finally { clearTimeout(timer); }
}

/** Backpressure and a per-chunk deadline, with cancellation propagated to the upstream. */
export function streamBody(body: ReadableStream<Uint8Array> | null, signal: AbortSignal, idle = 5 * 60_000): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let target: ReadableStreamDefaultController<Uint8Array>;
  const clean = () => { finished = true; clearTimeout(timer); signal.removeEventListener("abort", abort); };
  const fail = (reason: unknown) => {
    if (finished) return;
    clean(); void reader.cancel(reason).catch(() => { }); target.error(reason);
  };
  const abort = () => fail(signal.reason);
  return new ReadableStream({
    start(controller) { target = controller; signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); },
    async pull(controller) {
      if (finished) return;
      timer = setTimeout(() => fail(new Unavailable("upstream stream idle timeout")), idle);
      try {
        const { done, value } = await reader.read(); clearTimeout(timer);
        if (finished) return;
        if (done) { clean(); controller.close(); } else controller.enqueue(value);
      } catch (e) { fail(e); }
    },
    async cancel(reason) { clean(); await reader.cancel(reason).catch(() => { }); },
  });
}

export function serialTask(task: () => Promise<unknown>): () => Promise<void> {
  let running: Promise<void> | undefined;
  let again = false;
  return () => {
    if (running) { again = true; return running; }
    running = (async () => { do { again = false; await task(); } while (again); })().finally(() => { running = undefined; });
    return running;
  };
}
