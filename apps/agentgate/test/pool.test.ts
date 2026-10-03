import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { Credentials } from "../src/credentials.ts";
import { CLAUDE, claude } from "../src/llm/claude.ts";
import { proxy, recordUsage } from "../src/llm/pool.ts";
import { Store } from "../src/store.ts";

// Fake Anthropic: behaviour per bearer token.
type Mode = "ok" | "quota" | "rate-once";
let modes: Record<string, Mode> = {};
let seen: string[] = [];
const soon = Math.floor(Date.now() / 1000) + 3600;
const later = Math.floor(Date.now() / 1000) + 7200;

const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const token = req.headers.get("authorization")!.replace("Bearer ", "");
    seen.push(token);
    const reset = token === "tok-a" ? soon : later;
    const quota = {
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-5h-reset": String(reset),
      "anthropic-ratelimit-unified-7d-utilization": "0.10",
      "anthropic-ratelimit-unified-7d-reset": String(reset + 86400),
      "anthropic-ratelimit-unified-status": "allowed",
    };
    const mode = modes[token] ?? "ok";
    if (mode === "quota")
      return new Response('{"type":"error"}', {
        status: 429,
        headers: { ...quota, "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-5h-status": "rejected", "anthropic-ratelimit-unified-5h-utilization": "1.0" },
      });
    if (mode === "rate-once") {
      modes[token] = "ok";
      return new Response('{"type":"error","error":{"type":"rate_limit_error"}}', { status: 429, headers: { ...quota, "retry-after": "0" } });
    }
    const body = (await req.json()) as any;
    return new Response(`event: message_start\ndata: ${JSON.stringify({ user: body.metadata?.user_id, beta: req.headers.get("anthropic-beta") })}\n\n`, {
      headers: { ...quota, "content-type": "text/event-stream" },
    });
  },
});
const originalApi = CLAUDE.api;
CLAUDE.api = `http://127.0.0.1:${upstream.port}`;
afterAll(() => { upstream.stop(true); CLAUDE.api = originalApi; });

let s: Store;
let creds: Credentials;
afterEach(() => s?.close());

beforeEach(() => {
  modes = {};
  seen = [];
  s = new Store(":memory:");
  s.setLocal("node", "n1");
  for (const [id, prio] of [["a", 2], ["b", 1]] as const) {
    s.put("account", id, { id, provider: "claude", label: id, priority: prio });
    s.put("credential", id, { accountId: id, accessToken: `tok-${id}`, refreshToken: `rt-${id}`, expiresAt: Date.now() + 8 * 3600_000, accountUuid: `uuid-${id}`, holder: "n1" });
  }
  creds = new Credentials(s, () => Promise.reject(new Error("no refresh in this test")), async () => { });
});

const send = () =>
  proxy(s, creds, claude, new Request("http://x/anthropic/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer agentgate", "anthropic-beta": "claude-code-20250219" },
    body: JSON.stringify({ model: "claude-sonnet-4-5", metadata: { user_id: "user_abc_account_00000000-0000_session_xyz" } }),
  }), "/v1/messages?beta=true");

test("forwards with the account's token, oauth beta and account uuid; records quota", async () => {
  const res = await send();
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain("account_uuid-a_session");
  expect(text).toContain("oauth-2025-04-20");
  expect(seen).toEqual(["tok-a"]);
  const u = s.get("usage", "a")!;
  expect(u.windows.find((w) => w.name === "5h")!.usedPct).toBeCloseTo(42);
  expect(s.local("active:claude")).toBe("a");
});

test("a quota 429 is retried on the next account; the client never sees it", async () => {
  await send();
  modes["tok-a"] = "quota";
  const res = await send();
  expect(res.status).toBe(200);
  expect(seen).toEqual(["tok-a", "tok-a", "tok-b"]);
  expect(s.get("usage", "a")!.status).toBe("exhausted");
  expect(s.local("active:claude")).toBe("b");
  // Sticky: the next turn stays on b even though a has higher priority.
  await send();
  expect(seen.at(-1)).toBe("tok-b");
});

test("a per-minute 429 retries the same account instead of switching", async () => {
  modes["tok-a"] = "rate-once";
  const res = await send();
  expect(res.status).toBe(200);
  expect(seen).toEqual(["tok-a", "tok-a"]);
});

test("whenExhausted fail returns 429 with retry-after of the earliest reset", async () => {
  modes["tok-a"] = "quota";
  modes["tok-b"] = "quota";
  const res = await send();
  expect(res.status).toBe(429);
  const retry = Number(res.headers.get("retry-after"));
  expect(retry).toBeGreaterThan(3500);
  expect(retry).toBeLessThanOrEqual(3600);
  expect(((await res.json()) as any).error.type).toBe("rate_limit_error");
});

test("pinned account wins while it is a candidate", async () => {
  s.put("account", "b", { ...s.get("account", "b")!, pinned: true });
  await send();
  expect(seen).toEqual(["tok-b"]);
});

const sendOwn = (path: string) =>
  proxy(s, creds, claude, new Request(`http://x/anthropic${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok-own" },
    body: JSON.stringify({ model: "claude-sonnet-4-5" }),
  }), path);

test("a client with its own login keeps it for non-model paths and gets pooled tokens for model calls", async () => {
  await sendOwn("/api/oauth/profile");
  await sendOwn("/v1/messages");
  expect(seen).toEqual(["tok-own", "tok-a"]);
});

test("with every pooled account exhausted, a client's own login is the last resort", async () => {
  modes["tok-a"] = "quota";
  modes["tok-b"] = "quota";
  const res = await sendOwn("/v1/messages");
  expect(res.status).toBe(200);
  expect(seen).toEqual(["tok-a", "tok-b", "tok-own"]);
});

test("a late success does not erase an exhaustion recorded meanwhile", async () => {
  recordUsage(s, "a", { windows: [], status: "exhausted" }, Date.now() + 60_000);
  recordUsage(s, "a", { windows: [{ name: "5h", usedPct: 50 }], status: "ok" });
  expect(s.get("usage", "a")!.exhaustedUntil).toBeGreaterThan(Date.now());
});

test("an unauthorized account with a failed refresh falls through to the second account", async () => {
  const original = claude.prepare;
  const endpoint = Bun.serve({ port: 0, fetch(req) { return req.headers.get("authorization") === "Bearer tok-a" ? new Response("unauthorized", { status: 401 }) : new Response("second account"); } });
  const provider = { ...claude, prepare: (...args: Parameters<typeof original>) => ({ ...original(...args), url: `http://127.0.0.1:${endpoint.port}` }) };
  const res = await proxy(s, creds, provider, new Request("http://x", { method: "POST", body: '{"model":"sonnet"}' }), "/v1/messages");
  expect(res.status).toBe(200); expect(await res.text()).toBe("second account"); endpoint.stop(true);
});

test("a model-specific quota does not exhaust other models", async () => {
  const original = claude.prepare;
  const endpoint = Bun.serve({ port: 0, fetch() { return new Response("quota", { status: 429, headers: { "anthropic-ratelimit-unified-7d_opus-utilization": "1", "anthropic-ratelimit-unified-7d_opus-reset": String(soon), "anthropic-ratelimit-unified-7d_opus-status": "rejected" } }); } });
  s.put("account", "b", { ...s.get("account", "b")!, enabled: false });
  const provider = { ...claude, prepare: (...args: Parameters<typeof original>) => ({ ...original(...args), url: `http://127.0.0.1:${endpoint.port}` }), classify429: () => "quota" as const };
  await proxy(s, creds, provider, new Request("http://x", { method: "POST", body: '{"model":"claude-opus"}' }), "/v1/messages");
  expect(s.get("usage", "a")?.exhaustedUntil).toBeUndefined();
  const res = await send(); expect(res.status).toBe(200); await res.text(); endpoint.stop(true);
});

test("malformed quota headers are ignored; body size is bounded", async () => {
  expect(claude.usage(new Headers({ "anthropic-ratelimit-unified-5h-utilization": "NaN" }))).toBeUndefined();
  const response = await proxy(s, creds, claude, new Request("http://x", { method: "POST", body: "a".repeat(100) }), "/v1/messages", { maxBody: 16, headerTimeout: 100, streamIdle: 100 });
  expect(response.status).toBe(413);
});

test("an exhausted quota window without a reset cannot permanently disable an account", async () => {
  const now = s.now();
  recordUsage(s, "a", { windows: [{ name: "5h", usedPct: 100 }], status: "exhausted" });
  expect(s.get("usage", "a")?.windows[0]?.resetsAt).toBe(now + 60000);
  s.now = () => now + 61000;
  const { choose } = await import("../src/llm/pool.ts"); expect(choose(s, "claude", "sonnet")?.id).toBe("a");
});

test("usage endpoint maps onto the quota windows and is polled only for idle accounts", async () => {
  const { parseUsage, pollUsage } = await import("../src/llm/claude.ts");
  expect(parseUsage({ five_hour: { utilization: 18, resets_at: "2026-10-02T12:30:00Z" }, seven_day: { utilization: 100, resets_at: null }, seven_day_cowork: { utilization: 50 }, seven_day_opus: null })).toEqual({
    windows: [{ name: "5h", usedPct: 18, resetsAt: Date.parse("2026-10-02T12:30:00Z") }, { name: "7d", usedPct: 100, resetsAt: undefined }],
    status: "exhausted",
  });
  expect(parseUsage({ five_hour: { utilization: 1, locked_reason: "x" } })).toMatchObject({ status: "exhausted", windows: [{ name: "5h", usedPct: 100 }] });
  expect(parseUsage({})).toBeUndefined();

  // A locked account is skipped by the pool; a lock on the Opus window only affects Opus.
  const { Store: S } = await import("../src/store.ts");
  const { choose, recordUsage } = await import("../src/llm/pool.ts");
  const p = new S(":memory:"); p.setLocal("node", "n");
  for (const id of ["claude-a", "claude-b"]) {
    p.put("account", id, { id, provider: "claude", label: id, enabled: true, priority: id === "claude-a" ? 1 : 0 });
    p.put("credential", id, { accountId: id, accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000, holder: "n" });
  }
  const later = new Date(Date.now() + 3600_000).toISOString();
  recordUsage(p, "claude-a", parseUsage({ five_hour: { utilization: 1, locked_reason: "x", resets_at: later } })!);
  expect(choose(p, "claude", "claude-sonnet-5")?.id).toBe("claude-b");
  recordUsage(p, "claude-b", parseUsage({ five_hour: { utilization: 1 }, seven_day_opus: { utilization: 1, locked_reason: "x", resets_at: later } })!);
  expect(choose(p, "claude", "claude-opus-5")).toBeUndefined();
  expect(choose(p, "claude", "claude-sonnet-5")?.id).toBe("claude-b");
  p.close();

  const { Store } = await import("../src/store.ts");
  const s = new Store(":memory:"); s.setLocal("node", "n");
  for (const id of ["claude-idle", "claude-busy"]) {
    s.put("account", id, { id, provider: "claude", label: id, enabled: true, priority: 0 });
    s.put("credential", id, { accountId: id, accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000, holder: "n" });
  }
  s.put("usage", "claude-busy", { accountId: "claude-busy", observedAt: Date.now(), observedBy: "n", windows: [], status: "ok" });
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ five_hour: { utilization: 42, resets_at: null } }))) as unknown as typeof fetch;
  try {
    await pollUsage(s, async (id) => { asked.push(id); return { accessToken: "t" }; });
    await pollUsage(s, async (id) => { asked.push(id); return { accessToken: "t" }; }); // not again within 10 minutes
  } finally { globalThis.fetch = realFetch; }
  expect(asked).toEqual(["claude-idle"]);
  expect(s.get("usage", "claude-idle")?.windows[0]?.usedPct).toBe(42);

  // Live traffic records newer usage while a poll is out: the poll's older answer is dropped.
  s.setLocal("usagePolled:claude-idle", undefined);
  s.put("usage", "claude-idle", { ...s.get("usage", "claude-idle")!, observedAt: Date.now() - 11 * 60_000 });
  let answer!: () => void;
  globalThis.fetch = (() => new Promise<Response>((r) => { answer = () => r(new Response(JSON.stringify({ five_hour: { utilization: 10 } }))); })) as unknown as typeof fetch;
  try {
    const poll = pollUsage(s, async () => ({ accessToken: "t" }));
    await Bun.sleep(5);
    const { recordUsage } = await import("../src/llm/pool.ts");
    recordUsage(s, "claude-idle", { windows: [{ name: "5h", usedPct: 98 }], status: "ok" });
    answer(); await poll;
  } finally { globalThis.fetch = realFetch; }
  expect(s.get("usage", "claude-idle")?.windows.find((w) => w.name === "5h")?.usedPct).toBe(98);

  // Stopping the daemon aborts the request and records nothing.
  s.setLocal("usagePolled:claude-idle", undefined);
  s.put("usage", "claude-idle", { ...s.get("usage", "claude-idle")!, observedAt: Date.now() - 11 * 60_000 });
  const stop = new AbortController();
  let sawAbort = false;
  globalThis.fetch = ((_: unknown, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal!.addEventListener("abort", () => { sawAbort = true; reject(new Error("aborted")); }))) as unknown as typeof fetch;
  try {
    const poll = pollUsage(s, async () => ({ accessToken: "t" }), stop.signal);
    await Bun.sleep(5); stop.abort(); await poll;
  } finally { globalThis.fetch = realFetch; }
  expect(sawAbort).toBe(true);
  expect(s.get("usage", "claude-idle")?.windows.find((w) => w.name === "5h")?.usedPct).toBe(98);
  s.close();
});
