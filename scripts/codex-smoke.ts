import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, makeCtx } from "../src/daemon.ts";
import { CODEX } from "../src/llm/codex.ts";
import { Store } from "../src/store.ts";

const observed: object[] = [];
const item = { id: "msg_review", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "review OK", annotations: [] }] };
const upstream = Bun.serve({
  hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.arrayBuffer();
    observed.push({ method: req.method, path: new URL(req.url).pathname, contentEncoding: req.headers.get("content-encoding"), bodyBytes: body.byteLength, fakeBearerInjected: req.headers.get("authorization") === "Bearer review-fake" });
    const events = [
      { type: "response.created", response: { id: "resp_review", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "review OK" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_review", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
    ];
    return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }
});
CODEX.api = `http://127.0.0.1:${upstream.port}`;
const s = new Store(":memory:"); s.setLocal("node", "review");
s.put("account", "a", { id: "a", provider: "codex", label: "review" });
s.put("credential", "a", { accountId: "a", accessToken: "review-fake", refreshToken: "review-fake-rt", expiresAt: Date.now() + 8 * 3600_000, holder: "review" });
const ctx = makeCtx(s), a = app(ctx);
const daemon = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => a.fetch(req, { listener: "loopback" }) });
const configDir = mkdtempSync(join(tmpdir(), "agentgate-codex-smoke-"));
await Bun.write(join(configDir, "config.toml"), `model_provider = "agentgate"\n[model_providers.agentgate]\nname = "agentgate"\nbase_url = "http://127.0.0.1:${daemon.port}/codex/backend-api/codex"\nwire_api = "responses"\n`);
let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
try {
  child = Bun.spawn(["codex", "exec", "--skip-git-repo-check", "--json", "-m", "gpt-5.4", "Reply exactly review OK. Do not use tools."], { cwd: configDir, env: { ...process.env, CODEX_HOME: configDir }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child!.kill(), 20_000);
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timer);
  if (exitCode !== 0 || !stdout.includes('"type":"turn.completed"') || !stdout.includes("review OK")) throw new Error(`Codex smoke failed: ${stderr.slice(-1000)}`);
  console.log(JSON.stringify({ exitCode, observed, completed: stdout.includes('"type":"turn.completed"'), returnedExpectedText: stdout.includes("review OK"), stdout: exitCode ? stdout.slice(-1500) : undefined, stderr: stderr.slice(-1500) }));
} finally { child?.kill(); await ctx.gateway.close(); daemon.stop(true); upstream.stop(true); s.close(); rmSync(configDir, { recursive: true, force: true }); }
