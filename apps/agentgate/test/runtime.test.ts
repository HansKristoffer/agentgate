import { expect, test } from "bun:test";
import { retryAfterMs } from "../src/llm/pool.ts";
import { BodyTooLarge, fetchHeaders, readBody, serialTask, streamBody } from "../src/runtime.ts";

test("Retry-After is finite, nonnegative, and bounded", () => {
  for (const value of ["NaN", "-5", "garbage", "Infinity"]) expect(retryAfterMs(new Headers({ "retry-after": value }))).toBeGreaterThanOrEqual(0);
  expect(retryAfterMs(new Headers({ "retry-after": "99999999999" }))).toBe(600000);
  expect(retryAfterMs(new Headers({ "retry-after": "0" }))).toBe(0);
});

test("stream idle deadlines cancel the upstream, while active streams continue", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const stream = streamBody(body, new AbortController().signal, 10)!;
  await expect(stream.getReader().read()).rejects.toThrow("idle timeout"); expect(cancelled).toBe(true);
  const active = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("streamed")); c.close(); } });
  expect(await new Response(streamBody(active, new AbortController().signal, 10)).text()).toBe("streamed");
});

test("aborted and oversized request bodies cancel and release their readers", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(20)); }, cancel() { cancelled = true; } });
  await expect(readBody(body, 10)).rejects.toBeInstanceOf(BodyTooLarge); expect(cancelled).toBe(true); expect(body.locked).toBe(false);
  const aborted = new AbortController(); aborted.abort(); const another = new ReadableStream<Uint8Array>();
  await expect(readBody(another, 10, aborted.signal)).rejects.toThrow(); expect(another.locked).toBe(false);
});

test("missing response headers meet a deadline", async () => {
  const upstream = Bun.serve({ port: 0, fetch: async () => { await Bun.sleep(200); return new Response("late"); } });
  try { await expect(fetchHeaders(`http://127.0.0.1:${upstream.port}`, {}, 10)).rejects.toThrow("timeout"); } finally { upstream.stop(true); }
});

test("background task invocations coalesce without overlapping work", async () => {
  let active = 0, max = 0, runs = 0;
  const task = serialTask(async () => { max = Math.max(max, ++active); runs++; await Bun.sleep(5); active--; });
  await Promise.all(Array.from({ length: 10 }, () => task())); expect(max).toBe(1); expect(runs).toBe(2);
});
