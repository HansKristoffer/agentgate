import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountPatchSchema, aliasesSchema, settingsPatchSchema, settingsSchema } from "@agentgate/protocol";
import { patchSettings, revision } from "../src/configuration.ts";
import { Credentials } from "../src/credentials.ts";
import { deleteAccount, saveAccount } from "../src/operations.ts";
import { Store, exportBackup, importBackup } from "../src/store.ts";
import { cool, cooldowns, resetCooldown, retryAfterMs } from "../src/llm/policy.ts";
import { Quotas, exhausted, matchesWindow, recordUsage } from "../src/llm/quota.ts";
import { beginRoute, continuationAccount, earliestReset, filterModelList, rememberContinuation, resolveModel, route } from "../src/llm/routing.ts";
import { Telemetry, metrics, requestDetail, requests, streamObserver, tokenUsage } from "../src/llm/telemetry.ts";
import { proxy } from "../src/llm/pool.ts";
import { ProxyOperations } from "../src/llm/operations.ts";
import { parseQuota } from "../src/llm/codex.ts";
import { capabilities, type Provider } from "../src/llm/provider.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
function fixture(provider: "claude" | "codex" = "claude") {
  const s = new Store(":memory:"); cleanup.push(() => s.close()); s.setLocal("node", "n");
  for (const [id, priority] of [["a", 2], ["b", 1]] as const) {
    s.put("account", id, { id, provider, label: id, priority });
    s.put("credential", id, { accountId: id, accessToken: `access-${id}`, refreshToken: `refresh-${id}`, expiresAt: Date.now() + 3600000, holder: "n" });
  }
  const creds = new Credentials(s, async () => { throw new Error("No refresh expected"); }, async () => {});
  return { s, creds };
}
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const adapter: Provider = { name: "claude", prepare: (path, headers, body, c) => { headers.set("authorization", c.accessToken); return { url: path, headers, body }; }, pooled: () => true, usage: () => undefined, classify429: (_h, text) => text.includes("quota") ? "quota" : "rate", refresh: async () => { throw new Error("unsupported"); } };
function upstream(run: (req: Request) => Response | Promise<Response>) { const server = Bun.serve({ port: 0, fetch: run }); cleanup.unshift(() => server.stop(true)); return `http://127.0.0.1:${server.port}`; }
const client = (model = "sonnet", signal?: AbortSignal, extra: Record<string, unknown> = {}) => new Request("http://127.0.0.1/proxy", { method: "POST", signal, headers: { "content-type": "application/json", authorization: "Bearer agentgate" }, body: JSON.stringify({ model, ...extra }) });

test("partial configuration preserves omitted defaults and rejects stale concurrent drafts", () => {
  const { s } = fixture(); s.put("setting", "settings", { strategy: "priority", retryLimit: 0, sessionAffinity: true });
  const before = revision(s, "setting", "settings");
  expect(settingsPatchSchema.parse({ threshold: 80 })).toEqual({ threshold: 80 });
  expect(accountPatchSchema.parse({ label: "new" })).toEqual({ label: "new" });
  const saved = patchSettings(s, { threshold: 80 }, before);
  expect(saved.revision).toBe(revision(s, "setting", "settings"));
  expect(saved.revision).not.toBe(before);
  expect(s.settings()).toMatchObject({ threshold: 80, strategy: "priority", retryLimit: 0, sessionAffinity: true });
  expect(() => patchSettings(s, { retryLimit: 5 }, before)).toThrow("Configuration changed");
  expect(s.settings().retryLimit).toBe(0);
});

test("aliases reject duplicate and cyclic mappings and resolve before model eligibility", () => {
  const { s } = fixture(); const alias = { provider: "claude" as const, alias: "friendly", target: "sonnet" };
  expect(() => aliasesSchema.parse([alias, alias])).toThrow();
  expect(() => aliasesSchema.parse([alias, { ...alias, alias: "sonnet", target: "friendly" }])).toThrow();
  s.put("setting", "settings", { aliases: [alias] });
  s.put("account", "a", { ...s.get("account", "a")!, policy: { excludeModels: ["sonnet"] } });
  expect(resolveModel(s, "claude", "friendly")).toBe("sonnet");
  expect(route(s, "claude", "friendly")).toMatchObject({ account: "b", routedModel: "sonnet" });
  expect(route(s, "claude", "friendly").candidates[0]?.reasons).toContain("model excluded");
});

test("family quotas use identifier boundaries and reset availability keeps the observation", () => {
  const { s } = fixture(); let now = s.now(); s.now = () => now;
  recordUsage(s, "a", { windows: [{ name: "7d:opus", usedPct: 100, resetsAt: now + 5000 }], status: "exhausted" });
  expect(exhausted(s.get("usage", "a"), "claude-opus-4", now)).toBe(true);
  expect(exhausted(s.get("usage", "a"), "claude-notopus-4", now)).toBe(false);
  expect(exhausted(s.get("usage", "a"), "claude-sonnet-4", now)).toBe(false);
  now += 5001;
  expect(exhausted(s.get("usage", "a"), "claude-opus-4", now)).toBe(false);
  expect(s.get("usage", "a")!.windows[0]!.usedPct).toBe(100);
  expect(matchesWindow({ name: "specific", usedPct: 50, scope: { kind: "model", model: "Opus" } }, "opus")).toBe(false);
});

test("late observations cannot clear active exhaustion and reset timing combines blockers", () => {
  const { s } = fixture(); const now = s.now();
  recordUsage(s, "a", { windows: [{ name: "5h", usedPct: 100, resetsAt: now + 1000 }, { name: "7d", usedPct: 100, resetsAt: now + 5000 }], status: "exhausted" });
  recordUsage(s, "a", { windows: [{ name: "5h", usedPct: 10, resetsAt: now + 1000 }], status: "ok" });
  cool(s, "a", "rate", now + 7000);
  recordUsage(s, "b", { windows: [{ name: "5h", usedPct: 100, resetsAt: now + 9000 }], status: "exhausted" });
  expect(s.get("usage", "a")!.windows[0]!.usedPct).toBe(100);
  expect(earliestReset(s, "claude", "sonnet")).toBe(now + 7000);
});

test("quota polls coalesce and a late poll preserves newer live-response usage", async () => {
  const { s, creds } = fixture(); const result = gate<any>(), entered = gate<void>(); let count = 0;
  const quotas = new Quotas(s, creds, { claude: { ...adapter, fetchQuota: async () => { count++; entered.resolve(); return result.promise; } } });
  const signal = new AbortController().signal;
  const one = quotas.refresh("a", signal, true), two = quotas.refresh("a", signal, true); await entered.promise;
  recordUsage(s, "a", { windows: [{ name: "5h", usedPct: 90, resetsAt: s.now() + 100000 }], status: "limited" });
  result.resolve({ windows: [{ name: "5h", usedPct: 10 }], status: "ok" });
  expect(await Promise.all([one, two])).toEqual([true, true]); expect(count).toBe(1);
  expect(s.get("usage", "a")!.windows[0]!.usedPct).toBe(90);
});

test("quota work after deletion or relogin cannot resurrect usage or health", async () => {
  for (const change of ["delete", "relogin"] as const) {
    const { s, creds } = fixture(); const result = gate<any>(), entered = gate<void>();
    const quotas = new Quotas(s, creds, { claude: { ...adapter, fetchQuota: async () => { entered.resolve(); return result.promise; } } });
    const task = quotas.refresh("a", new AbortController().signal, true); await entered.promise;
    if (change === "delete") deleteAccount(s, "a"); else saveAccount(s, s.get("account", "a")!, { ...s.get("credential", "a")!, accessToken: "new-access" });
    result.resolve({ windows: [{ name: "5h", usedPct: 50 }], status: "ok" });
    expect(await task).toBe(false); expect(s.get("usage", "a")).toBeUndefined(); expect(s.local("quotaHealth:a")).toBeUndefined();
  }
});

test("quota credential failures retain previous measurements and report sanitized health", async () => {
  const { s } = fixture(); recordUsage(s, "a", { windows: [{ name: "5h", usedPct: 50 }], status: "ok" });
  const quotas = new Quotas(s, { token: async () => { throw new Error("refresh-secret"); } }, { claude: { ...adapter, fetchQuota: async () => undefined } });
  await expect(quotas.refresh("a", new AbortController().signal, true)).rejects.toThrow();
  expect(s.get("usage", "a")!.windows[0]!.usedPct).toBe(50);
  expect(s.local("quotaHealth:a")).toContain("Usage refresh failed"); expect(s.local("quotaHealth:a")).not.toContain("refresh-secret");
});

test("Codex quota polling is opt-in, holder-owned, and manual refresh works", async () => {
  const { s, creds } = fixture("codex"); let count = 0;
  const quotas = new Quotas(s, creds, { codex: { ...adapter, name: "codex", fetchQuota: async () => { count++; return { windows: [{ name: "5h", usedPct: 20 }], status: "ok" }; } } });
  const signal = new AbortController().signal;
  await quotas.poll(signal); expect(count).toBe(0);
  expect(await quotas.refresh("a", signal, true)).toBe(true); expect(count).toBe(1);
  s.put("setting", "settings", { codexQuotaPolling: true }); await quotas.poll(signal); expect(count).toBe(2);
});

test("Codex fixtures normalize read-only windows and reject malformed data", () => {
  const parsed = parseQuota({ rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: 2000000000 } }, additional_rate_limits: [{ limit_name: "gpt-5-codex", rate_limit: { secondary_window: { used_percent: 100, limit_window_seconds: 604800 } } }] });
  expect(parsed?.windows[0]).toMatchObject({ usedPct: 42, durationMs: 18000000, resetsAt: 2000000000000, scope: { kind: "account" } });
  expect(parsed?.windows[1]?.scope).toEqual({ kind: "model", model: "gpt-5-codex" });
  expect(parseQuota({ rate_limit: { primary_window: { used_percent: "42", limit_window_seconds: -1 } } })).toBeUndefined();
});

test("round robin, affinity expiry, eligible pins, and in-flight releases agree", () => {
  const { s } = fixture(); let now = s.now(); s.now = () => now;
  s.put("setting", "settings", { strategy: "round-robin", sessionAffinity: true, affinityTtlMs: 1000 });
  expect(route(s, "claude").account).toBe("a");
  const release = beginRoute(s, "claude", "a", "session");
  expect(route(s, "claude").account).toBe("b");
  expect(route(s, "claude", undefined, { session: "session" }).account).toBe("a");
  expect(route(s, "claude").candidates[0]!.inFlight).toBe(1);
  s.put("account", "b", { ...s.get("account", "b")!, pinned: true });
  expect(route(s, "claude", undefined, { session: "session" }).account).toBe("b");
  cool(s, "b", "transient", now + 10000); expect(route(s, "claude", undefined, { session: "session" }).account).toBe("a");
  resetCooldown(s, "b"); s.put("account", "b", { ...s.get("account", "b")!, pinned: false }); now += 1001;
  expect(route(s, "claude", undefined, { session: "session" }).account).toBe("b");
  release(); release(); expect(route(s, "claude").candidates[0]!.inFlight).toBe(0);
});

test("stale model discovery preserves automatic eligibility while explicit policies remain", () => {
  const { s } = fixture(); s.setLocal("models:a", JSON.stringify({ at: s.now(), models: ["opus"] }));
  expect(route(s, "claude", "sonnet").account).toBe("b");
  s.setLocal("models:a", JSON.stringify({ at: s.now() - 600001, models: ["opus"] }));
  expect(route(s, "claude", "sonnet").account).toBe("a");
  s.put("account", "a", { ...s.get("account", "a")!, policy: { allowModels: ["opus"] } });
  expect(route(s, "claude", "sonnet").account).toBe("b");
});

test("model cooldowns spare unrelated models and provider-wide discovery selection", () => {
  const { s } = fixture();
  for (const account of s.list("account")) cool(s, account.id, "model", s.now() + 10000, "opus");
  expect(route(s, "claude", "opus").account).toBeUndefined();
  expect(route(s, "claude", "opus").candidates.every(c => c.reasons.includes("model unavailable"))).toBe(true);
  expect(route(s, "claude", "sonnet").account).toBe("a"); expect(route(s, "claude").account).toBe("a");
});

test("advertised model lists preserve metadata, respect policy, and expose resolved aliases", async () => {
  const { s, creds } = fixture();
  for (const a of s.list("account")) s.put("account", a.id, { ...a, policy: { excludeModels: ["opus"] } });
  s.put("setting", "settings", { aliases: [{ provider: "claude", alias: "friendly", target: "sonnet" }] });
  const payload = { data: [{ id: "sonnet", display_name: "Sonnet", created_at: "2026-01-01" }, { id: "opus", display_name: "Opus" }], has_more: false };
  const result = filterModelList(s, "claude", payload, { collection: "data", id: "id" }) as typeof payload;
  expect(result.data.map(m => m.id)).toEqual(["sonnet", "friendly"]); expect(result.data[1]?.created_at).toBe("2026-01-01");
  const url = upstream(() => Response.json(payload));
  const res = await proxy(s, creds, { ...adapter, modelList: () => ({ collection: "data", id: "id" }) }, new Request("http://127.0.0.1/models"), url);
  expect((await res.json() as any).data.map((m: any) => m.id)).toEqual(["sonnet", "friendly"]);
});

test("telemetry byte retention includes attempts and never leaves orphan attempt rows", () => {
  const { s } = fixture(); s.put("setting", "settings", { logRetentionBytes: 65536 });
  const t = new Telemetry(s, "claude"); for (let i = 0; i < 400; i++) t.attempt("a", "rate-limit retry"); t.finish("failed", "rate");
  expect(requestDetail(s, t.request.id)).toBeUndefined(); expect(s.db.query("select count(*) as n from proxy_attempts").get()).toEqual({ n: 0 });
});

test("account retry zero overrides the global policy while inheritance retains bounded retries", async () => {
  const { s, creds } = fixture(); let count = 0;
  const url = upstream(() => { count++; return count % 2 ? new Response("rate", { status: 429, headers: { "retry-after": "0" } }) : new Response("ok"); });
  s.put("setting", "settings", { retryLimit: 1 }); s.put("account", "a", { ...s.get("account", "a")!, policy: { retryLimit: 0 } });
  expect((await proxy(s, creds, adapter, client(), url)).status).toBe(429); expect(count).toBe(1);
  count = 0; s.put("account", "a", { ...s.get("account", "a")!, policy: {} });
  await (await proxy(s, creds, adapter, client(), url)).text(); expect(count).toBe(2); expect(metrics(s).fallback).toBe(0);
});

test("relogin clears local backoff, affinity and continuation ownership without deleting in-flight work", () => {
  const { s } = fixture(); s.put("setting", "settings", { sessionAffinity: true });
  const release = beginRoute(s, "claude", "a", "session"); rememberContinuation(s, "resp-a", "a"); cool(s, "a", "model", s.now() + 10000, "sonnet");
  saveAccount(s, s.get("account", "a")!, { ...s.get("credential", "a")!, accessToken: "new" });
  expect(continuationAccount(s, "resp-a")).toBeUndefined(); expect(cooldowns(s, "a")).toEqual([]); release();
});

test("telemetry separates account fallback from same-account retries and redacts models", () => {
  const { s } = fixture(); const retry = new Telemetry(s, "claude"); retry.models("access-a", "https://secret.invalid"); retry.attempt("a", "priority"); retry.attempt("a", "priority"); retry.headers(200); retry.finish("success", undefined, "eof");
  const fallback = new Telemetry(s, "claude"); fallback.attempt("a", "automatic"); fallback.attempt("b", "automatic"); fallback.headers(200); fallback.finish("success", undefined, "completed");
  expect(metrics(s)).toMatchObject({ total: 2, succeeded: 2, fallback: 1 });
  const exported = JSON.stringify(requestDetail(s, retry.request.id)); expect(exported).not.toContain("access-a"); expect(exported).not.toContain("secret.invalid"); expect(exported).toContain("[redacted]");
  expect(s.changes(0).records.some(r => r.kind as string === "proxy_requests")).toBe(false);
  expect(JSON.stringify(exportBackup(s, false))).not.toContain(retry.request.id);
});

test("metrics exclude pending and expired requests and average only measured latency", () => {
  const { s } = fixture(); const now = s.now();
  s.now = () => now - 86400001;
  const expired = new Telemetry(s, "claude"); expired.attempt("a", "automatic"); expired.attempt("b", "automatic"); expired.finish("success");
  s.now = () => now;
  const pending = new Telemetry(s, "claude"); pending.attempt("a", "automatic"); pending.attempt("b", "automatic");
  const succeeded = new Telemetry(s, "claude"); succeeded.headers(200); succeeded.request.headersMs = 40; succeeded.request.firstByteMs = 15; succeeded.finish("success");
  const failed = new Telemetry(s, "claude"); failed.attempt("a", "automatic"); failed.attempt("b", "automatic"); failed.headers(502); failed.request.headersMs = 61; failed.finish("failed", "transient");
  const cancelled = new Telemetry(s, "claude"); cancelled.finish("cancelled", "cancelled");
  expect(metrics(s)).toMatchObject({ total: 3, succeeded: 1, failed: 1, interrupted: 0, cancelled: 1, fallback: 1, averageHeadersMs: 51, averageFirstByteMs: 15 });
  expect(metrics(s, now + 1)).toMatchObject({ total: 0, succeeded: 0, failed: 0, interrupted: 0, cancelled: 0, fallback: 0 });
  expect(metrics(s, now + 1).averageHeadersMs).toBeUndefined(); expect(metrics(s, now + 1).averageFirstByteMs).toBeUndefined();
});

test("request cursors remain stable during concurrent inserts and reset after retention", () => {
  const { s } = fixture(); const ids: string[] = [];
  for (let i = 0; i < 105; i++) { const t = new Telemetry(s, "claude"); t.models(`model-${i}`, `model-${i}`); t.attempt("a", "priority"); t.finish("success"); ids.push(t.request.id); }
  const first = requests(s, { limit: 5 }); const t = new Telemetry(s, "claude"); t.finish("success");
  const second = requests(s, { limit: 5, cursor: first.nextCursor });
  expect(second.requests.some(r => first.requests.some(x => x.id === r.id))).toBe(false); expect(second.requests.some(r => r.id === t.request.id)).toBe(false);
  s.put("setting", "settings", { logRetention: 100 }); const last = new Telemetry(s, "claude"); last.finish("success");
  expect(requestDetail(s, ids[0]!)).toBeUndefined(); expect(requests(s, { cursor: "1" }).cursorReset).toBe(true);
  expect(requests(s, { search: "%" }).requests).toEqual([]); expect(() => requests(s, { cursor: "abc" })).toThrow();
});

test("SSE observer handles split frames, ignores oversized events, and preserves failure terminal", () => {
  const ids: string[] = [], observer = streamObserver(id => ids.push(id)), bytes = (v: string) => new TextEncoder().encode(v);
  observer.chunk(bytes('data: {"type":"response.completed","response":{"id":"resp-a"}}\r\n')); observer.chunk(bytes('\r\n'));
  expect(observer.terminal).toBe("completed"); expect(ids).toEqual(["resp-a"]);
  observer.chunk(bytes('data: {"type":"error"}\n\n')); observer.chunk(bytes('event: message_stop\ndata: {}\n\n')); expect(observer.terminal).toBe("provider-error");
  const oversized = streamObserver(); oversized.chunk(bytes(`data: ${JSON.stringify({ type: "error", message: "x".repeat(200000) })}\n\n`)); expect(oversized.terminal).toBeUndefined();
  oversized.chunk(bytes('data: {"type":"message_stop"}\n\n')); expect(oversized.terminal).toBe("completed");
});

test("token usage is read from Claude and Codex streams, including oversized completions", () => {
  const bytes = (v: string) => new TextEncoder().encode(v);
  const claude = streamObserver();
  claude.chunk(bytes('event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":300,"output_tokens":1}}}\n\n'));
  claude.chunk(bytes('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"\\"usage\\":{\\"output_tokens\\":999}"}}\n\n'));
  claude.chunk(bytes('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n'));
  expect(claude.tokens).toEqual({ input: 10, output: 42, cacheRead: 300, cacheWrite: 20 });
  const codex = streamObserver(), output = "x".repeat(200000);
  codex.chunk(bytes('data: {"type":"response.created","response":{"usage":null}}\n\n'));
  codex.chunk(bytes(`data: {"type":"response.completed","response":{"output":[{"text":"${output}"}],"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":80},"output_tokens":7,"output_tokens_details":{"reasoning_tokens":3}},"metadata":{}}}\n\n`));
  expect(codex.tokens).toEqual({ input: 20, output: 7, cacheRead: 80, cacheWrite: 0 });
});

test("token usage sums per model per hour and filters by time", () => {
  const s = new Store(":memory:"); cleanup.push(() => s.close());
  let now = Date.UTC(2026, 0, 1, 10, 30); s.now = () => now;
  const use = (model: string, input: number) => { const t = new Telemetry(s, "claude"); t.models(model, model); t.tokens({ input, output: 1, cacheRead: 0, cacheWrite: 0 }); };
  use("sonnet", 10); use("sonnet", 5); use("opus", 1);
  now += 86400000; use("sonnet", 100);
  expect(tokenUsage(s)).toEqual([
    { provider: "claude", model: "sonnet", input: 115, output: 3, cacheRead: 0, cacheWrite: 0 },
    { provider: "claude", model: "opus", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  ]);
  expect(tokenUsage(s, now - 60000)).toEqual([{ provider: "claude", model: "sonnet", input: 100, output: 1, cacheRead: 0, cacheWrite: 0 }]);
});

test("quota fallback is one request with two attempts; aliases reach the upstream", async () => {
  const { s, creds } = fixture(); const seen: string[] = [];
  const url = upstream(async req => { const model = (await req.json() as any).model; seen.push(`${req.headers.get("authorization")}:${model}`); return req.headers.get("authorization") === "access-a" ? new Response("quota", { status: 429, headers: { "retry-after": "60" } }) : new Response('data: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } }); });
  s.put("setting", "settings", { aliases: [{ provider: "claude", alias: "friendly", target: "sonnet" }] });
  const response = await proxy(s, creds, adapter, client("friendly"), url); await response.text();
  expect(seen).toEqual(["access-a:sonnet", "access-b:sonnet"]);
  expect(metrics(s)).toMatchObject({ total: 1, succeeded: 1, fallback: 1 });
  const record = requests(s).requests[0]!; expect(record).toMatchObject({ requestedModel: "friendly", routedModel: "sonnet", attempts: 2, stream: "completed" }); expect(requestDetail(s, record.id)?.attempts[0]?.failure).toBe("quota");
});

test("Retry-After beyond bootstrap budget never retries early and shared backoff blocks peers", async () => {
  const { s, creds } = fixture(); let count = 0; const url = upstream(() => { count++; return new Response("rate", { status: 429, headers: { "retry-after": "86400" } }); });
  s.put("setting", "settings", { bootstrapTimeoutMs: 1000 });
  expect((await proxy(s, creds, adapter, client(), url)).status).toBe(429); expect(count).toBe(1);
  expect(cooldowns(s, "a")[0]!.retryAt - s.now()).toBeGreaterThan(86390000);
  cool(s, "b", "rate", s.now() + 86400000);
  const blocked = await proxy(s, creds, adapter, client(), url); expect(blocked.status).toBe(429); expect(await blocked.text()).toContain("rate limited"); expect(count).toBe(1);
  expect(retryAfterMs(new Headers({ "retry-after": "86400" }))).toBe(86400000);
});

test("account attempt limits prevent unbounded quota failover", async () => {
  const { s, creds } = fixture(); let count = 0; const url = upstream(() => { count++; return new Response("quota", { status: 429 }); });
  s.put("setting", "settings", { maxAccounts: 1 });
  expect((await proxy(s, creds, adapter, client(), url)).status).toBe(429); expect(count).toBe(1); expect(requests(s).requests[0]?.failure).toBe("budget");
});

test("uncertain network outcome never replays on another account", async () => {
  const { s, creds } = fixture(); let count = 0; const url = upstream(async () => { count++; await Bun.sleep(50); return new Response("late"); });
  const response = await proxy(s, creds, adapter, client(), url, { headerTimeout: 10, streamIdle: 1000, maxBody: 1024 });
  expect(response.status).toBe(502); expect(await response.text()).toContain("outcome uncertain"); expect(count).toBe(1); expect(metrics(s).fallback).toBe(0);
});

test("transient cooldown is separate from provider quota and reset preserves quota", async () => {
  const { s, creds } = fixture(); cool(s, "a", "transient", s.now() + 15000); cool(s, "b", "transient", s.now() + 15000);
  const response = await proxy(s, creds, adapter, client(), "http://127.0.0.1:1"); expect(response.status).toBe(503); expect(requests(s).requests[0]?.failure).toBe("transient");
  recordUsage(s, "a", { windows: [{ name: "5h", usedPct: 100, resetsAt: s.now() + 100000 }], status: "exhausted" }); resetCooldown(s, "a"); expect(exhausted(s.get("usage", "a"), "sonnet", s.now())).toBe(true);
});

test("stream provider error, idle timeout, and cancellation produce distinct final outcomes", async () => {
  for (const mode of ["error", "idle", "cancel"] as const) {
    const { s, creds } = fixture(); let cancelled = false;
    const url = upstream(() => new Response(mode === "error" ? 'data: {"type":"error"}\n\n' : new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: {}\n\n")); }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }));
    const abort = new AbortController(); const response = await proxy(s, creds, adapter, client("sonnet", abort.signal), url, { headerTimeout: 1000, streamIdle: 20, maxBody: 1024 });
    if (mode === "cancel") abort.abort();
    await response.text().catch(() => {});
    expect(requests(s).requests[0]).toMatchObject({ status: 200, outcome: mode === "error" ? "failed" : mode === "cancel" ? "cancelled" : "interrupted", stream: mode === "error" ? "provider-error" : mode === "cancel" ? "cancelled" : "idle-timeout" });
    expect(metrics(s).fallback).toBe(0);
  }
});

test("stateful continuations remain with their owner and fail explicitly when ownership is lost", async () => {
  const { s, creds } = fixture(); let count = 0;
  const url = upstream(() => { count++; return new Response('data: {"type":"response.completed","response":{"id":"resp-a"}}\n\n', { headers: { "content-type": "text/event-stream" } }); });
  const stateful = { ...adapter, stateful: (body: Record<string, unknown> | undefined) => !!body?.previous_response_id };
  await (await proxy(s, creds, stateful, client(), url)).text(); expect(continuationAccount(s, "resp-a")).toBe("a");
  cool(s, "a", "transient", s.now() + 10000);
  expect((await proxy(s, creds, stateful, client("sonnet", undefined, { previous_response_id: "resp-a" }), url)).status).toBe(409); expect(count).toBe(1);
  expect((await proxy(s, creds, stateful, client("sonnet", undefined, { previous_response_id: "unknown" }), url)).status).toBe(409);
});

test("verification reports capabilities, partial failures, and errors inside an HTTP 200 probe", async () => {
  const { s, creds } = fixture(); const url = upstream(() => new Response('data: {"type":"error"}\n\n', { headers: { "content-type": "text/event-stream" } }));
  const provider = { ...adapter, probe: { path: url, body: (model: string) => ({ model }) } };
  expect(capabilities(provider)).toEqual({ quota: false, models: false, session: false, probe: true });
  const ops = new ProxyOperations(s, creds, new Quotas(s, creds, { claude: provider }), { claude: provider, codex: provider });
  const result = await ops.verify("a", new AbortController().signal, { probe: true, model: "sonnet" });
  expect(result).toMatchObject({ node: "n", checks: { credential: { status: "ok" }, quota: { status: "unsupported" }, models: { status: "unsupported" }, probe: { status: "failed" } } });
  const batch = await ops.batch(["a", "missing", "a"], "enable", new AbortController().signal); expect(batch.map(r => r.ok)).toEqual([true, false]);
});

test("migration drops obsolete relay upload chunks and backup v4 preserves policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-policy-migration-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "db"); let s = new Store(path);
  s.put("account", "a", { id: "a", provider: "claude", label: "a", policy: { retryLimit: 0, excludeModels: ["opus"] } });
  s.put("setting", "settings", { sessionAffinity: true }); s.setLocal("relay:pushed", "123"); s.setLocal("relay:x:pushed", "123");
  s.db.run("create table relay_pending(grp text primary key,generation text,checkpoint integer,body text)"); s.db.run("insert into relay_pending values('old','generation',123,'obsolete')");
  s.db.run("pragma user_version = 1"); s.close(); s = new Store(path);
  try { expect(s.local("relay:pushed")).toBeUndefined(); expect(s.local("relay:x:pushed")).toBeUndefined(); expect(s.db.query("select * from relay_pending").all()).toEqual([]);
    const backup = exportBackup(s); expect(backup.agentgate).toBe(4); const restored = new Store(":memory:"); try { importBackup(restored, backup); expect(restored.get("account", "a")?.policy).toEqual({ retryLimit: 0, excludeModels: ["opus"] }); expect(restored.settings().sessionAffinity).toBe(true); } finally { restored.close(); }
  } finally { s.close(); }
});
