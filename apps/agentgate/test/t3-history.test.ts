import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { HistoryError, appendToThread, sessionLines, sessionMessages, t3Database } from "../src/handoff/history.ts";
import { t3StateDir, timeline } from "./fixtures/t3-state.ts";

const NOW = "2026-10-15T08:00:00.000Z";
const line = (r: unknown) => JSON.stringify(r) + "\n";

test("the records added after a count become the messages T3 Code's import would show", () => {
  const before = line({ type: "user", message: { content: "earlier" } });
  const after = [
    line({
      type: "user",
      timestamp: "2026-10-14T21:46:04.425Z",
      message: {
        content:
          "Context handoff (manual_context):\nProvider context handoff. Thread: x.\n\nUser message:\nThis thread just moved here.",
      },
    }),
    line({
      type: "assistant",
      timestamp: "2026-10-14T21:46:05.000Z",
      message: {
        content: [
          { type: "thinking", thinking: "hm" },
          { type: "text", text: " Ready " },
        ],
      },
    }),
    line({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
    line({ type: "user", isMeta: true, message: { content: "<command-name>/clear</command-name>" } }),
    line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagent" }] } }),
    line({ type: "summary", summary: "a title" }),
    line({ type: "user", timestamp: "not a time", message: { content: "Skriv ready igen!" } }),
  ].join("");
  const text = before + after;

  expect(sessionLines(before)).toBe(1);
  expect(sessionMessages(text, 1, NOW)).toEqual([
    { role: "user", text: "This thread just moved here.", createdAt: "2026-10-14T21:46:04.425Z" },
    { role: "assistant", text: "Ready", createdAt: "2026-10-14T21:46:05.000Z" },
    { role: "user", text: "Skriv ready igen!", createdAt: NOW },
  ]);
  expect(sessionMessages(text, sessionLines(text), NOW)).toEqual([]);
  // Fewer records than counted: the file was rewritten, so what is new is unknown.
  expect(sessionMessages(before, 2, NOW)).toBeUndefined();
});

test("messages are appended after the thread's last item, as T3 Code's import writes them, once per key", () => {
  const dir = t3StateDir("3773", ["thread-1"]);
  const db = t3Database(dir, "http://127.0.0.1:3773");
  const messages = [
    { role: "user", text: "what's next?", createdAt: NOW },
    { role: "assistant", text: "Tests.", createdAt: NOW },
  ] as const;

  expect(appendToThread(db, "thread-1", "job-1", [...messages], NOW)).toBe(2);
  expect(appendToThread(db, "thread-1", "job-1", [...messages], NOW)).toBe(0);
  expect(appendToThread(db, "thread-1", "job-2", [{ role: "user", text: "and again", createdAt: NOW }], NOW)).toBe(1);

  expect(timeline(dir, "thread-1")).toEqual([
    { ordinal: 1_000_001, type: "assistant_message", text: "earlier" },
    { ordinal: 1_000_002, type: "user_message", text: "what's next?" },
    { ordinal: 1_000_003, type: "assistant_message", text: "Tests." },
    { ordinal: 1_000_004, type: "user_message", text: "and again" },
  ]);
  // What T3 checks at startup: the projections are at its latest event, and every item has its position.
  const check = new Database(join(dir, "statev2.sqlite"), { readonly: true });
  const meta = check
    .query<{ last_sequence: number }, []>("SELECT last_sequence FROM orchestration_v2_projection_metadata")
    .get()!;
  const events = check
    .query<{ n: number; seq: number; versions: string }, []>(
      "SELECT COUNT(*) AS n, MAX(sequence) AS seq, GROUP_CONCAT(stream_version) AS versions FROM orchestration_events WHERE stream_id = 'thread-1'",
    )
    .get()!;
  expect(meta.last_sequence).toBe(events.seq);
  expect(events).toMatchObject({ n: 7, versions: "0,1,2,3,4,5,6" });
  expect(
    check
      .query("SELECT ordinal FROM orchestration_v2_turn_item_positions WHERE thread_id = 'thread-1' ORDER BY ordinal")
      .values()
      .flat(),
  ).toEqual([1_000_001, 1_000_002, 1_000_003, 1_000_004]);
  const message = check
    .query<{ payload_json: string }, []>(
      "SELECT payload_json FROM orchestration_v2_projection_messages WHERE role = 'assistant'",
    )
    .get()!;
  expect(JSON.parse(message.payload_json)).toMatchObject({
    createdBy: "agent",
    role: "assistant",
    text: "Tests.",
    runId: null,
    streaming: false,
  });
  check.close();
});

test("a T3 Code whose state is not as expected gets nothing written", () => {
  const dir = t3StateDir("3773", ["thread-1"]);
  const path = t3Database(dir, "http://127.0.0.1:3773");
  const message = [{ role: "user" as const, text: "hi", createdAt: NOW }];
  const fails = (threadId: string) =>
    expect(() => appendToThread(path, threadId, "job", message, NOW)).toThrow(HistoryError);

  fails("no-such-thread");
  const db = new Database(path);
  db.run("UPDATE orchestration_v2_projection_metadata SET last_sequence = last_sequence - 1");
  db.close();
  fails("thread-1");

  const changed = t3StateDir("3773", ["thread-1"]);
  const other = new Database(join(changed, "statev2.sqlite"));
  other.run("ALTER TABLE orchestration_v2_projection_messages DROP COLUMN node_id");
  other.close();
  expect(() => appendToThread(join(changed, "statev2.sqlite"), "thread-1", "job", message, NOW)).toThrow(
    "orchestration_v2_projection_messages table has changed",
  );

  expect(timeline(dir, "thread-1")).toHaveLength(1);
  // The state folder must belong to the T3 Code agentgate is connected to.
  expect(() => t3Database(dir, "http://127.0.0.1:3774")).toThrow(HistoryError);
  expect(() => t3Database(join(dir, "missing"), "http://127.0.0.1:3773")).toThrow(HistoryError);
});
