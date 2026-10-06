import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { tokenHours, tokenUsage } from "../src/llm/telemetry.ts";
import { backfillTokens, publishTokens } from "../src/llm/token-history.ts";

const temp = mkdtempSync(join(tmpdir(), "agentgate-tokens-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const HOUR = 3_600_000, at = (h: number, ms = 0) => new Date(Date.UTC(2026, 9, 1, h) + ms).toISOString();
const jsonl = (path: string, lines: unknown[]) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n"); };
const node = (name: string) => { const s = new Store(":memory:"); s.setLocal("node", name); s.now = () => Date.UTC(2026, 9, 1, 12); return s; };

test("history before the proxy counted comes from Claude Code and Codex logs, once", async () => {
  const s = node("a"), home = join(temp, "claude"), other = join(temp, "claude-agentgate"), codex = join(temp, "codex");
  const message = (id: string, h: number, input: number) => ({ type: "assistant", timestamp: at(h), requestId: `r-${id}`, message: { id, model: "opus", usage: { input_tokens: input, output_tokens: 2, cache_read_input_tokens: 30, cache_creation_input_tokens: 4 } } });
  // One line per content block repeats the message; the same session can sit in two homes.
  jsonl(join(home, "projects/p/s.jsonl"), [message("m1", 9, 10), message("m1", 9, 10), { type: "user", timestamp: at(9), message: { content: "usage" } }, message("m2", 10, 1), message("m3", 11, 99)]);
  jsonl(join(other, "projects/p/s.jsonl"), [message("m1", 9, 10)]);
  // The proxy has counted Claude since 11:00, and never Codex: its logs count up to the current hour.
  s.db.run("insert into token_usage values (?, 'claude', 'opus', 5, 0, 0, 0)", [Date.UTC(2026, 9, 1, 11)]);
  const count = (h: number, input: number, total: number, ms = 0) => ({ timestamp: at(h, ms), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: input, cached_input_tokens: 80, output_tokens: 7 }, total_token_usage: { input_tokens: total } } } });
  jsonl(join(codex, "sessions/2026/10/01/rollout-a.jsonl"), [
    count(9, 100, 100), // before the first turn_context: still that turn's model
    { timestamp: at(9, 10), type: "turn_context", payload: { model: "gpt-6" } },
    count(10, 200, 300), count(10, 200, 300, 500), // the second is a replay: the running total did not move
    count(12, 500, 800), // the current hour is the proxy's
  ]);
  jsonl(join(codex, "sessions/2026/10/01/rollout-b.jsonl"), [
    { timestamp: at(10), type: "session_meta", payload: { forked_from_id: "a" } },
    count(10, 100, 100, 1), { timestamp: at(10, 2), type: "turn_context", payload: { model: "gpt-6" } }, count(10, 200, 300, 3), // the parent's copied history
    count(10, 90, 390, 5000),
  ]);
  const dirs = { claude: [home, other, join(temp, "missing")], codex: [codex] };
  await backfillTokens(s, dirs);
  await backfillTokens(s, dirs);
  expect(tokenUsage(s)).toEqual([
    { provider: "codex", model: "gpt-6", input: 150, output: 21, cacheRead: 240, cacheWrite: 0 },
    { provider: "claude", model: "opus", input: 16, output: 4, cacheRead: 60, cacheWrite: 8 },
  ]);
});

test("each machine's totals reach the others, and Cursor's account-wide history counts once", () => {
  const a = node("a"), b = node("b");
  for (const s of [a, b]) for (const id of ["a", "b"]) s.put("node", id, { id, protocol: 3 });
  const hour = Date.UTC(2026, 9, 1, 10);
  a.db.run("insert into token_usage values (?, 'claude', 'opus', 1, 0, 0, 0)", [hour]);
  b.db.run("insert into token_usage values (?, 'claude', 'opus', 10, 0, 0, 0)", [hour + HOUR]);
  b.db.run("insert into token_usage values (?, 'codex', 'gpt-6', 20, 0, 0, 0)", [hour - 86_400_000]);
  // Both machines have held the Cursor login, so both read the same history.
  for (const s of [a, b]) s.db.run("insert into cursor_tokens values ('c1', ?, 'auto', 100, 0, 0, 0)", [hour]);
  const sync = (from: Store, to: Store) => { for (const r of from.changes(0).records) to.merge(r); };

  // A node on the previous version would stall on the new record kind.
  b.put("node", "c", { id: "c", protocol: 2 });
  publishTokens(b);
  expect(b.list("tokens")).toEqual([]);
  b.del("node", "c");

  publishTokens(a); publishTokens(b);
  expect(b.list("tokens").map((r) => r.id)).toEqual(["b:2026-09-30", "b:2026-10-01"]);
  const rev = b.record("tokens", "b:2026-10-01")!.rev;
  publishTokens(b);
  expect(b.record("tokens", "b:2026-10-01")!.rev).toBe(rev); // unchanged totals are not written again
  sync(b, a); sync(a, b);
  for (const s of [a, b])
    expect(tokenUsage(s)).toEqual([
      { provider: "cursor", model: "auto", input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
      { provider: "codex", model: "gpt-6", input: 20, output: 0, cacheRead: 0, cacheWrite: 0 },
      { provider: "claude", model: "opus", input: 11, output: 0, cacheRead: 0, cacheWrite: 0 },
    ]);
  expect(tokenUsage(a, hour + HOUR)).toEqual([{ provider: "claude", model: "opus", input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }]);
  expect(tokenHours(a)).toEqual([[hour - 86_400_000, 20], [hour, 101], [hour + HOUR, 10]]);
});
