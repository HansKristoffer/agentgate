import { afterAll, beforeEach, expect, test } from "bun:test";
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
CLAUDE.api = `http://127.0.0.1:${upstream.port}`;
afterAll(() => upstream.stop(true));

let s: Store;
let creds: Credentials;

beforeEach(() => {
  modes = {};
  seen = [];
  s = new Store(":memory:");
  s.setLocal("node", "n1");
  for (const [id, prio] of [["a", 2], ["b", 1]] as const) {
    s.put("account", id, { id, provider: "claude", label: id, priority: prio });
    s.put("credential", id, { accountId: id, accessToken: `tok-${id}`, refreshToken: `rt-${id}`, expiresAt: Date.now() + 8 * 3600_000, accountUuid: `uuid-${id}`, holder: "n1" });
  }
  creds = new Credentials(s, () => Promise.reject(new Error("no refresh in this test")), async () => {});
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
