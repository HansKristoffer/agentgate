import type { ModelTokens } from "@agentgate/protocol";
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { tokenHours, tokenUsage } from "../src/llm/telemetry.ts";
import { backfillTokens, publishTokens } from "../src/llm/token-history.ts";

const temp = mkdtempSync(join(tmpdir(), "agentgate-tokens-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const HOUR = 3_600_000,
  at = (h: number, ms = 0) => new Date(Date.UTC(2026, 9, 1, h) + ms).toISOString();
const jsonl = (path: string, lines: unknown[]) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};
const node = (name: string) => {
  const s = new Store(":memory:");
  s.setLocal("node", name);
  s.now = () => Date.UTC(2026, 9, 1, 12);
  return s;
};

test("history before the proxy counted comes from Claude Code and Codex logs, once", async () => {
  const s = node("a"),
    home = join(temp, "claude"),
    other = join(temp, "claude-agentgate"),
    codex = join(temp, "codex");
  const message = (id: string, h: number, input: number, output = 2) => ({
    type: "assistant",
    timestamp: at(h),
    requestId: `r-${id}`,
    message: {
      id,
      model: "opus",
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 4,
      },
    },
  });
  // One line per content block repeats the message, and the last has its final output; the same session can sit in
  // two homes.
  jsonl(join(home, "projects/p/s.jsonl"), [
    message("m1", 9, 10),
    message("m1", 9, 10, 5),
    { type: "user", timestamp: at(9), message: { content: "usage" } },
    message("m2", 10, 1),
    message("m3", 11, 99),
  ]);
  jsonl(join(other, "projects/p/s.jsonl"), [message("m1", 9, 10)]);
  // The proxy has counted Claude since 11:00, and never Codex: its logs count up to the current hour.
  s.db.run("insert into token_usage values (?, 'claude', 'opus', 5, 0, 0, 0)", [Date.UTC(2026, 9, 1, 11)]);
  const count = (h: number, input: number, total: number, ms = 0) => ({
    timestamp: at(h, ms),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: input, cached_input_tokens: 80, output_tokens: 7 },
        total_token_usage: { input_tokens: total },
      },
    },
  });
  jsonl(join(codex, "sessions/2026/10/01/rollout-a.jsonl"), [
    count(9, 100, 100), // before the first turn_context: still that turn's model
    { timestamp: at(9, 10), type: "turn_context", payload: { model: "gpt-6" } },
    count(10, 200, 300),
    count(10, 200, 300, 500), // the second is a replay: the running total did not move
    count(12, 500, 800), // the current hour is the proxy's
  ]);
  jsonl(join(codex, "sessions/2026/10/01/rollout-b.jsonl"), [
    { timestamp: at(10), type: "session_meta", payload: { forked_from_id: "a" } },
    count(10, 100, 100, 1),
    { timestamp: at(10, 2), type: "turn_context", payload: { model: "gpt-6" } },
    count(10, 200, 300, 3), // the parent's copied history
    count(10, 90, 390, 5000),
  ]);
  const dirs = { claude: [home, other, join(temp, "missing")], codex: [codex] };
  await backfillTokens(s, dirs);
  await backfillTokens(s, dirs);
  expect(tokenUsage(s)).toEqual([
    { provider: "codex", model: "gpt-6", input: 150, output: 21, cacheRead: 240, cacheWrite: 0 },
    { provider: "claude", model: "opus", input: 16, output: 7, cacheRead: 60, cacheWrite: 8 },
  ]);
});

test("a Codex rollout that logs only its running total counts each request's share of it", async () => {
  const s = node("a"),
    codex = join(temp, "codex-total");
  const total = (h: number, input: number, cached: number, output: number, ms = 0) => ({
    timestamp: at(h, ms),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
    },
  });
  jsonl(join(codex, "sessions/2026/10/01/rollout-c.jsonl"), [
    { timestamp: at(9), type: "turn_context", payload: { model: "gpt-6" } },
    total(9, 100, 40, 5),
    total(10, 250, 100, 12),
    total(10, 250, 100, 12, 500), // a replay
  ]);
  await backfillTokens(s, { claude: [], codex: [codex] });
  expect(tokenUsage(s)).toEqual([
    { provider: "codex", model: "gpt-6", input: 150, output: 12, cacheRead: 100, cacheWrite: 0 },
  ]);
});

test("each machine's totals reach the others, and Cursor's account-wide history counts once", () => {
  const a = node("a"),
    b = node("b");
  for (const s of [a, b]) for (const id of ["a", "b"]) s.put("node", id, { id, protocol: 3 });
  const hour = Date.UTC(2026, 9, 1, 10);
  a.db.run("insert into token_usage values (?, 'claude', 'opus', 1, 0, 0, 0)", [hour]);
  b.db.run("insert into token_usage values (?, 'claude', 'opus', 10, 0, 0, 0)", [hour + HOUR]);
  b.db.run("insert into token_usage values (?, 'codex', 'gpt-6', 20, 0, 0, 0)", [hour - 86_400_000]);
  // Both machines have held the Cursor login, so both read the same history.
  for (const s of [a, b]) s.db.run("insert into cursor_tokens values ('c1', ?, 'auto', 100, 0, 0, 0)", [hour]);
  const sync = (from: Store, to: Store) => {
    for (const r of from.changes(0).records) to.merge(r);
  };

  // A node on the previous version would stall on the new record kind.
  b.put("node", "c", { id: "c", protocol: 2 });
  publishTokens(b);
  expect(b.list("tokens")).toEqual([]);
  b.del("node", "c");

  publishTokens(a);
  publishTokens(b);
  expect(b.list("tokens").map((r) => r.id)).toEqual(["b:2026-09-30", "b:2026-10-01"]);
  const rev = b.record("tokens", "b:2026-10-01")!.rev;
  publishTokens(b);
  expect(b.record("tokens", "b:2026-10-01")!.rev).toBe(rev); // unchanged totals are not written again
  sync(b, a);
  sync(a, b);
  for (const s of [a, b])
    expect(tokenUsage(s)).toEqual([
      { provider: "cursor", model: "auto", input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
      { provider: "codex", model: "gpt-6", input: 20, output: 0, cacheRead: 0, cacheWrite: 0 },
      { provider: "claude", model: "opus", input: 11, output: 0, cacheRead: 0, cacheWrite: 0 },
    ]);
  expect(tokenUsage(a, hour + HOUR)).toEqual([
    { provider: "claude", model: "opus", input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
  ]);
  expect(tokenHours(a)).toEqual([
    [hour - 86_400_000, 20],
    [hour, 101],
    [hour + HOUR, 10],
  ]);
});

const paired = (...names: string[]) =>
  names.map((name) => {
    const s = node(name);
    for (const id of names) s.put("node", id, { id, protocol: 3 });
    return s;
  });
const syncSince = (from: Store, to: Store, since: number) => {
  for (const r of from.changes(since).records) to.merge(r);
  return from.seq();
};

test("another machine's newer totals replace its old ones, and a deleted day stops counting", () => {
  const [a, b] = paired("a", "b") as [Store, Store];
  const hour = Date.UTC(2026, 9, 1, 10);
  b.db.run("insert into token_usage values (?, 'claude', 'opus', 10, 0, 0, 0)", [hour]);
  publishTokens(b);
  let seen = syncSince(b, a, 0);
  expect(tokenHours(a)).toEqual([[hour, 10]]);

  b.db.run("update token_usage set input = 25");
  publishTokens(b);
  seen = syncSince(b, a, seen);
  expect(tokenHours(a)).toEqual([[hour, 25]]);

  b.del("tokens", "b:2026-10-01");
  syncSince(b, a, seen);
  expect(tokenHours(a)).toEqual([]);
});

test("days older than 90 fold into one record per month, and every machine's totals stay the same", () => {
  const [a, b] = paired("a", "b") as [Store, Store];
  // 120 days up to today, 2026-10-01: June 4 to 30 is a whole month older than 90 days, July 1 and 2 are not yet.
  for (let day = 0; day < 120; day++) {
    const hour = a.now() - day * 86_400_000 - 2 * HOUR;
    a.db.run("insert into token_usage values (?, 'claude', 'opus', 1, 2, 0, 0)", [hour]);
    if (day % 2) a.db.run("insert into cursor_tokens values ('c1', ?, 'auto', 3, 0, 0, 0)", [hour]);
  }
  b.db.run("insert into token_usage values (?, 'codex', 'gpt-6', 5, 0, 0, 0)", [Date.UTC(2026, 5, 10)]);
  b.now = () => Date.UTC(2026, 5, 10, 12); // published while it was recent, so it is a day record
  publishTokens(b);
  syncSince(b, a, 0);
  const theirs = a.record("tokens", "b:2026-06-10");

  publishTokens(a);
  const days = (s: Store) => s.list("tokens").map((r) => r.id);
  expect(days(a).filter((id) => id < "a:2026-07")).toEqual(["a:2026-06-30"]);
  expect(days(a).filter((id) => id.startsWith("a:"))).toHaveLength(1 + 31 + 31 + 30 + 1);
  expect(a.record("tokens", "b:2026-06-10")).toEqual(theirs);

  // b reads a's month with the same schema as before folding, and counts each hour once.
  let seen = syncSince(a, b, 0);
  expect(b.get("tokens", "a:2026-06-30")?.rows).toHaveLength(27 + 14);
  const totals: ModelTokens[] = [
    { provider: "claude", model: "opus", input: 120, output: 240, cacheRead: 0, cacheWrite: 0 },
    { provider: "cursor", model: "auto", input: 180, output: 0, cacheRead: 0, cacheWrite: 0 },
    { provider: "codex", model: "gpt-6", input: 5, output: 0, cacheRead: 0, cacheWrite: 0 },
  ];
  expect(tokenUsage(b)).toEqual(totals);

  // A backfill republishes every day, folded months included.
  a.setLocal("tokens:published", undefined);
  publishTokens(a);
  syncSince(a, b, seen);
  expect(days(a).filter((id) => id < "a:2026-07")).toEqual(["a:2026-06-30"]);
  expect(tokenUsage(b)).toEqual(totals);
});

// About 7 ms on a developer machine; the budget leaves room for a slow CI runner, and reading the records' JSON took
// over 100 ms.
test("a year of every machine's history reads in under 25 ms", () => {
  const a = node("a"),
    start = Date.UTC(2025, 9, 1);
  for (let i = 0; i < 800; i++) {
    const machine = `m${i % 3}`,
      day = start + Math.floor(i / 3) * 86_400_000,
      id = `${machine}:${new Date(day).toISOString().slice(0, 10)}`;
    const rows = Array.from({ length: 16 }, (_, h) => ({
      hour: day + (h % 8) * HOUR,
      provider: h < 8 ? ("claude" as const) : ("codex" as const),
      model: h < 8 ? "opus" : "gpt-6",
      input: 100,
      output: 10,
      cacheRead: 1000,
      cacheWrite: 50,
    }));
    a.put("tokens", id, { id, node: machine, rows });
  }
  tokenUsage(a); // fills the table from the records, and leaves the hours uncached
  const started = performance.now();
  const hours = tokenHours(a);
  const ms = performance.now() - started;
  expect(hours).toHaveLength(267 * 8);
  expect(ms).toBeLessThan(25);
});

test("token history is reused for a minute, unless another machine's totals arrive", () => {
  const a = node("a"),
    b = node("b");
  for (const s of [a, b]) for (const id of ["a", "b"]) s.put("node", id, { id, protocol: 3 });
  const hour = Date.UTC(2026, 9, 1, 10),
    start = a.now();
  a.db.run("insert into token_usage values (?, 'claude', 'opus', 1, 0, 0, 0)", [hour]);
  expect(tokenHours(a)).toEqual([[hour, 1]]);
  a.db.run("update token_usage set input = 5");
  expect(tokenHours(a)).toEqual([[hour, 1]]);

  b.db.run("insert into token_usage values (?, 'claude', 'opus', 10, 0, 0, 0)", [hour]);
  publishTokens(b);
  for (const r of b.changes(0).records) a.merge(r);
  expect(tokenHours(a)).toEqual([[hour, 15]]);

  a.db.run("update token_usage set input = 7");
  a.now = () => start + 59_000;
  expect(tokenHours(a)).toEqual([[hour, 15]]);
  a.now = () => start + 60_000;
  expect(tokenHours(a)).toEqual([[hour, 17]]);
});
