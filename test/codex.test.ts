import { expect, test } from "bun:test";
import { Credentials } from "../src/credentials.ts";
import { codex, exchange } from "../src/llm/codex.ts";
import { proxy } from "../src/llm/pool.ts";
import { Store } from "../src/store.ts";

test("Codex quota windows use duration and family with malformed values ignored", () => {
  const headers = new Headers({ "x-codex-secondary-used-percent": "99", "x-codex-secondary-window-minutes": "300", "x-codex-primary-used-percent": "25", "x-codex-primary-window-minutes": "10080", "x-codex-mini-primary-used-percent": "80", "x-codex-mini-primary-window-minutes": "300", "x-broken-primary-used-percent": "NaN", "x-broken-primary-window-minutes": "300" });
  expect(codex.usage(headers)?.windows.map(w => [w.name, w.usedPct]).sort()).toEqual([["5h", 99], ["5h:mini", 80], ["7d", 25]]);
});

test("Codex pooling recovers 401, switches on quota, injects account header, and streams", async () => {
  const s = new Store(":memory:"); s.setLocal("node", "n"); const seen: string[] = [];
  for (const id of ["a", "b"]) { s.put("account", id, { id, provider: "codex", label: id, priority: id === "a" ? 2 : 1 }); s.put("credential", id, { accountId: id, accessToken: id, refreshToken: id, expiresAt: Date.now() + 3600000, holder: "n", chatgptAccountId: `account-${id}` }); }
  const server = Bun.serve({
    port: 0, fetch(req) {
      const token = req.headers.get("authorization")!; seen.push(`${token}:${req.headers.get("chatgpt-account-id")}`);
      if (token === "Bearer a") return new Response("401", { status: 401 });
      if (token === "Bearer refreshed") return new Response('{"error":{"type":"usage_limit_reached"}}', { status: 429, headers: { "x-codex-primary-used-percent": "100", "x-codex-primary-window-minutes": "300", "retry-after": "60" } });
      return new Response('data: {"type":"response.completed"}\n\n', { headers: { "content-type": "text/event-stream" } });
    }
  });
  const provider = { ...codex, prepare: (...args: Parameters<typeof codex.prepare>) => ({ ...codex.prepare(...args), url: `http://127.0.0.1:${server.port}` }) };
  const creds = new Credentials(s, async () => ({ accessToken: "refreshed", refreshToken: "new", expiresAt: Date.now() + 3600000 }), async () => { });
  try { const res = await proxy(s, creds, provider, new Request("http://x", { method: "POST", body: '{"model":"gpt-5"}' }), "/backend-api/codex/responses"); expect(res.status).toBe(200); expect(await res.text()).toContain("response.completed"); expect(seen).toEqual(["Bearer a:account-a", "Bearer refreshed:account-a", "Bearer b:account-b"]); } finally { server.stop(true); s.close(); }
});

test("Codex login rejects a mismatched callback state before requesting tokens", async () => {
  const s = new Store(":memory:"); await expect(exchange(s, "http://localhost:1455/auth/callback?code=x&state=wrong", "verifier", undefined, "expected")).rejects.toThrow("state"); s.close();
});
