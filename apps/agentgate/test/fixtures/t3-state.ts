import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp } from "./git.ts";

/** The tables of T3 Code's `statev2.sqlite` that a handoff's history copy reads and writes, as upstream T3 Code
 * creates them (projection_threads cut to the columns used). */
const SCHEMA = `
CREATE TABLE orchestration_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, aggregate_kind TEXT NOT NULL,
  stream_id TEXT NOT NULL, stream_version INTEGER NOT NULL, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL,
  command_id TEXT, causation_event_id TEXT, correlation_id TEXT, actor_kind TEXT NOT NULL, payload_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL, application_event_version INTEGER NOT NULL DEFAULT 1);
CREATE UNIQUE INDEX idx_orch_events_stream_version ON orchestration_events(aggregate_kind, stream_id, stream_version);
CREATE TABLE orchestration_v2_projection_messages (
  message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT, role TEXT NOT NULL,
  streaming INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE orchestration_v2_projection_turn_items (
  turn_item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT, provider_thread_id TEXT,
  provider_turn_id TEXT, parent_item_id TEXT, ordinal INTEGER NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
  updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE orchestration_v2_turn_item_positions (
  thread_id TEXT NOT NULL, turn_item_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
  PRIMARY KEY (thread_id, turn_item_id), UNIQUE (thread_id, ordinal));
CREATE TABLE orchestration_v2_projection_metadata (
  projection_name TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, last_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL, deleted_at TEXT);
INSERT INTO orchestration_v2_projection_metadata VALUES ('thread-projections', 2, 0, '2026-10-01T00:00:00.000Z');
`;

/** A T3 Code state folder for the server on `port`, holding `threads`, each with one finished run's turn item. */
export function t3StateDir(port: string, threads: string[]) {
  const dir = tmp();
  writeFileSync(join(dir, "server-runtime.json"), JSON.stringify({ version: 1, port: Number(port) }));
  const db = new Database(join(dir, "statev2.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  for (const id of threads) {
    db.run("INSERT INTO orchestration_v2_projection_threads VALUES (?, 'Fix the bug', NULL)", [id]);
    const item = { id: `item:${id}`, threadId: id, runId: "run-1", ordinal: 1_000_001, type: "assistant_message", text: "earlier" };
    const seq = db.query<{ sequence: number }, [string, string, string]>(`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id,
      stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
      VALUES (?, 'thread', ?, 0, 'turn-item.updated', '2026-10-01T00:00:00.000Z', 'provider', ?, '{}', 2) RETURNING sequence`)
      .get(`event:${id}`, id, JSON.stringify(item))!.sequence;
    db.run(`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES (?, ?, 'run-1', 1000001, 'assistant_message', 'completed', '2026-10-01T00:00:00.000Z', ?)`, [item.id, id, JSON.stringify(item)]);
    db.run("INSERT INTO orchestration_v2_turn_item_positions VALUES (?, ?, 1000001)", [id, item.id]);
    db.run("UPDATE orchestration_v2_projection_metadata SET last_sequence = ?", [seq]);
  }
  db.close();
  return dir;
}

/** A thread's timeline as T3 Code orders it: turn items by ordinal, with each message's role and text. */
export function timeline(dir: string, threadId: string) {
  const db = new Database(join(dir, "statev2.sqlite"), { readonly: true });
  try {
    return db.query<{ ordinal: number; payload_json: string }, [string]>(
      "SELECT ordinal, payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id = ? ORDER BY ordinal").all(threadId)
      .map((r) => { const p = JSON.parse(r.payload_json); return { ordinal: r.ordinal, type: p.type as string, text: p.text as string }; });
  } finally {
    db.close();
  }
}
