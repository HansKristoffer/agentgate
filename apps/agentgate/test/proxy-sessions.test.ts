import { afterEach, expect, test } from "bun:test";
import { Credentials } from "../src/credentials.ts";
import { proxy } from "../src/llm/pool.ts";
import type { Provider } from "../src/llm/provider.ts";
import { recordSessionUsage, sessionUsage } from "../src/llm/sessions.ts";
import { tokenUsage, trimTelemetry } from "../src/llm/telemetry.ts";
import { Store } from "../src/store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function fixture() {
  const s = new Store(":memory:");
  cleanup.push(() => s.close());
  s.setLocal("node", "n");
  for (const provider of ["claude", "codex"] as const) {
    s.put("account", provider, { id: provider, provider, label: provider, priority: 1 });
    s.put("credential", provider, {
      accountId: provider,
      accessToken: `access-${provider}`,
      refreshToken: `refresh-${provider}`,
      expiresAt: Date.now() + 3600000,
      holder: "n",
    });
  }
  const creds = new Credentials(
    s,
    async () => {
      throw new Error("No refresh expected");
    },
    async () => {},
  );
  return { s, creds };
}

const claudeStream =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":300,"output_tokens":1}}}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
const codexStream =
  'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":80},"output_tokens":7}}}\n\n';

function upstream(stream: string) {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
  });
  cleanup.unshift(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

const adapter = (name: "claude" | "codex"): Provider => ({
  name,
  prepare: (path, headers, body, c) => {
    headers.set("authorization", c.accessToken);
    return { url: path, headers, body };
  },
  pooled: () => true,
  usage: () => undefined,
  classify429: () => "rate",
  refresh: async () => {
    throw new Error("unsupported");
  },
});

async function send(name: "claude" | "codex", headers: Record<string, string>, body: Record<string, unknown> = {}) {
  const { s, creds } = fixture();
  const url = upstream(name === "claude" ? claudeStream : codexStream);
  const request = new Request("http://127.0.0.1/proxy", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer agentgate", ...headers },
    body: JSON.stringify({ model: "sonnet", stream: true, ...body }),
  });
  await (await proxy(s, creds, adapter(name), request, url)).text();
  return s;
}

test("a Claude request's tokens count under its X-Claude-Code-Session-Id", async () => {
  const s = await send("claude", { "x-claude-code-session-id": "header-session" });
  expect(sessionUsage(s, ["header-session"])).toEqual([
    {
      session: "header-session",
      provider: "claude",
      model: "sonnet",
      input: 10,
      output: 42,
      cacheRead: 300,
      cacheWrite: 20,
      requests: 1,
      firstAt: expect.any(Number),
      lastAt: expect.any(Number),
    },
  ]);
});

test("without the header, a Claude session comes from metadata.user_id", async () => {
  const json = await send("claude", {}, { metadata: { user_id: JSON.stringify({ session_id: "json-session" }) } });
  expect(sessionUsage(json, ["json-session"])).toMatchObject([{ input: 10, output: 42 }]);
  const legacy = await send("claude", {}, { metadata: { user_id: "user_x_account_abc_session_legacy-session" } });
  expect(sessionUsage(legacy, ["legacy-session"])).toMatchObject([{ input: 10, output: 42 }]);
});

test("a Codex request counts under its session_id", async () => {
  const s = await send("codex", { session_id: "codex-session" });
  expect(sessionUsage(s, ["codex-session"])).toMatchObject([
    { provider: "codex", input: 20, output: 7, cacheRead: 80, cacheWrite: 0, requests: 1 },
  ]);
});

test("a request that names no session is not counted", async () => {
  const s = await send("claude", {});
  expect(tokenUsage(s)).toMatchObject([{ input: 10, output: 42 }]);
  expect(s.db.query("select count(*) as n from session_usage").get()).toEqual({ n: 0 });
});

test("sessions are summed per model, read together and trimmed after 90 days", () => {
  const s = new Store(":memory:");
  cleanup.push(() => s.close());
  let now = Date.UTC(2026, 0, 1);
  s.now = () => now;
  const tokens = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
  recordSessionUsage(s, { session: "a", provider: "claude", model: "opus", ...tokens, at: now });
  recordSessionUsage(s, { session: "a", provider: "claude", model: "opus", ...tokens, at: now + 1000 });
  recordSessionUsage(s, { session: "b", provider: "codex", model: "gpt", ...tokens, at: now + 2000 });
  recordSessionUsage(s, { session: "c", provider: "codex", model: "gpt", ...tokens, at: now });
  expect(sessionUsage(s, ["a", "b"])).toEqual([
    {
      session: "a",
      provider: "claude",
      model: "opus",
      input: 2,
      output: 4,
      cacheRead: 6,
      cacheWrite: 8,
      requests: 2,
      firstAt: now,
      lastAt: now + 1000,
    },
    { session: "b", provider: "codex", model: "gpt", ...tokens, requests: 1, firstAt: now + 2000, lastAt: now + 2000 },
  ]);
  now += 90 * 86_400_000 + 1500;
  trimTelemetry(s);
  expect(sessionUsage(s, ["a", "b", "c"]).map((r) => r.session)).toEqual(["b"]);
});
