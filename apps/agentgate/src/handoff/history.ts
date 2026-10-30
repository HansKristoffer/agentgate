import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** A thread that comes back to a machine reuses the T3 Code thread it had there, which lacks the messages it got
 * elsewhere. T3 Code cannot add history to an existing thread (its session import only creates threads), so these are
 * written into T3 Code's own SQLite state, the way that import writes them: per message a `message.updated` and a
 * `turn-item.updated` event, their projection rows and turn-item position, and the projection high-water mark, in one
 * transaction. Upstream T3 Code does not support this; the `t3HandoffHistory` setting turns it off. */

export class HistoryError extends Error {}

export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

/** T3's session import keeps this many messages of a session. */
const MAX_MESSAGES = 200;
const PREFIX = "agentgate-handoff";
/** T3 sends a moved thread's first message with its context handoff for the agent in front of what the user wrote. */
const HANDOFF_CONTEXT = "Context handoff (";
const USER_MESSAGE = "\n\nUser message:\n";

const record = z
  .object({
    type: z.string(),
    isSidechain: z.boolean().nullish(),
    isMeta: z.boolean().nullish(),
    isCompactSummary: z.boolean().nullish(),
    timestamp: z.string().nullish(),
    message: z
      .object({
        content: z
          .union([z.string(), z.array(z.object({ type: z.string(), text: z.string().nullish() }).passthrough())])
          .nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

/** The complete records in a Claude session file. Claude only appends, so a count marks what a thread had. */
export const sessionLines = (text: string) => text.split("\n").length - 1;

/** The messages T3's import would show for the records after the first `from`; undefined when the file has fewer
 * records, because then it was rewritten and what is new is unknown. */
export function sessionMessages(text: string, from: number, now: string): SessionMessage[] | undefined {
  const lines = text.split("\n");
  if (lines.length - 1 < from) return undefined;
  const messages: SessionMessage[] = [];
  for (const line of lines.slice(from)) {
    let parsed;
    try {
      parsed = record.safeParse(JSON.parse(line));
    } catch {
      continue; // the empty piece after the last newline
    }
    const r = parsed.data;
    if (!r || r.isSidechain || r.isMeta || r.isCompactSummary || (r.type !== "user" && r.type !== "assistant"))
      continue;
    const content = r.message?.content;
    let body =
      typeof content === "string"
        ? content.trim()
        : (content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => b.text?.trim() ?? "")
            .filter(Boolean)
            .join("\n");
    if (r.type === "user" && body.startsWith(HANDOFF_CONTEXT) && body.includes(USER_MESSAGE)) {
      body = body.slice(body.lastIndexOf(USER_MESSAGE) + USER_MESSAGE.length).trim();
    }
    if (!body) continue; // tool results and thinking
    const at = r.timestamp && !Number.isNaN(Date.parse(r.timestamp)) ? new Date(r.timestamp).toISOString() : now;
    messages.push({ role: r.type, text: body, createdAt: at });
  }
  return messages.slice(-MAX_MESSAGES);
}

/** The database of the T3 Code agentgate is connected to: its state folder must belong to the server on that port. */
export function t3Database(stateDir: string, url: string | undefined): string {
  let port: unknown;
  try {
    port = JSON.parse(readFileSync(join(stateDir, "server-runtime.json"), "utf8")).port;
  } catch {
    throw new HistoryError(`T3 Code's state was not found in ${stateDir}`);
  }
  if (!url || String(port) !== new URL(url).port)
    throw new HistoryError(`the T3 Code at ${url} keeps its state outside ${stateDir}`);
  return join(stateDir, "statev2.sqlite");
}

/** The columns written or read, by table. A T3 Code whose tables lack one has changed shape: write nothing. */
const COLUMNS: Record<string, string[]> = {
  orchestration_events: [
    "sequence",
    "event_id",
    "aggregate_kind",
    "stream_id",
    "stream_version",
    "event_type",
    "occurred_at",
    "command_id",
    "causation_event_id",
    "correlation_id",
    "actor_kind",
    "payload_json",
    "metadata_json",
    "application_event_version",
  ],
  orchestration_v2_projection_messages: [
    "message_id",
    "thread_id",
    "run_id",
    "node_id",
    "role",
    "streaming",
    "created_at",
    "updated_at",
    "payload_json",
  ],
  orchestration_v2_projection_turn_items: [
    "turn_item_id",
    "thread_id",
    "run_id",
    "node_id",
    "provider_thread_id",
    "provider_turn_id",
    "parent_item_id",
    "ordinal",
    "type",
    "status",
    "updated_at",
    "payload_json",
  ],
  orchestration_v2_turn_item_positions: ["thread_id", "turn_item_id", "ordinal"],
  orchestration_v2_projection_metadata: ["projection_name", "schema_version", "last_sequence", "updated_at"],
  orchestration_v2_projection_threads: ["thread_id", "deleted_at"],
};
/** T3 numbers a run's turn items from `run ordinal × this`; items after the thread's last one stay in its last band. */
const RUN_BAND = 1_000_000;

/** Append `messages` to the end of thread `threadId`'s history. `key` names this copy: a repeated call writes nothing.
 * Returns how many messages were added. */
export function appendToThread(
  dbPath: string,
  threadId: string,
  key: string,
  messages: SessionMessage[],
  now: string,
): number {
  if (!messages.length) return 0;
  let db: Database;
  try {
    db = new Database(dbPath, { readwrite: true, create: false });
  } catch {
    throw new HistoryError(`T3 Code's database ${dbPath} could not be opened`);
  }
  try {
    // T3's own writer takes the write lock with BEGIN IMMEDIATE and waits this long for it too.
    db.run("PRAGMA busy_timeout = 5000");
    return db.transaction(() => append(db, threadId, key, messages, now)).immediate();
  } finally {
    db.close();
  }
}

function append(db: Database, threadId: string, key: string, messages: SessionMessage[], now: string): number {
  for (const [table, columns] of Object.entries(COLUMNS)) {
    const have = new Set(
      db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name),
    );
    if (columns.some((c) => !have.has(c))) throw new HistoryError(`T3 Code's ${table} table has changed`);
  }
  const meta = db
    .query<{ schema_version: number; last_sequence: number }, []>(
      "SELECT schema_version, last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name = 'thread-projections'",
    )
    .get();
  if (meta?.schema_version !== 2) throw new HistoryError("T3 Code's thread projections have changed");
  const latest = db
    .query<{ sequence: number | null }, []>(
      "SELECT MAX(sequence) AS sequence FROM orchestration_events WHERE application_event_version = 2 AND aggregate_kind = 'thread'",
    )
    .get();
  // T3 rebuilds its projections at startup when they lag its events; writing now could be lost or replayed out of order.
  if (meta.last_sequence !== (latest?.sequence ?? 0))
    throw new HistoryError("T3 Code's thread projections are behind its events");
  if (
    !db
      .query("SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ? AND deleted_at IS NULL")
      .get(threadId)
  ) {
    throw new HistoryError("the thread is not in T3 Code's database");
  }

  const id = (kind: string, i: number) => `${PREFIX}:${kind}:${threadId}:${key}:${String(i).padStart(6, "0")}`;
  if (db.query("SELECT 1 FROM orchestration_events WHERE event_id = ?").get(id("message", 0))) return 0;

  const last =
    db
      .query<{ ordinal: number | null }, [string, string]>(
        `SELECT MAX(ordinal) AS ordinal FROM (
    SELECT MAX(ordinal) AS ordinal FROM orchestration_v2_turn_item_positions WHERE thread_id = ?
    UNION ALL SELECT MAX(ordinal) FROM orchestration_v2_projection_turn_items WHERE thread_id = ?)`,
      )
      .get(threadId, threadId)?.ordinal ?? 0;
  if ((last % RUN_BAND) + messages.length >= RUN_BAND)
    throw new HistoryError("the thread has no room for more items in its last turn");

  const insertEvent = db.query<{ sequence: number }, [string, string, string, string, string]>(`
    INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id,
      causation_event_id, correlation_id, actor_kind, payload_json, metadata_json, application_event_version)
    VALUES (?1, 'thread', ?2, COALESCE((SELECT MAX(stream_version) + 1 FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ?2), 0), ?3, ?4, NULL, NULL, NULL, 'server', ?5, '{}', 2)
    RETURNING sequence`);
  let sequence = 0;
  messages.forEach((m, i) => {
    const at = m.createdAt,
      ordinal = last + 1 + i,
      user = m.role === "user";
    const messageId = id("msg", i),
      turnItemId = id("turn-item", i);
    const message = {
      createdBy: user ? "user" : "agent",
      creationSource: "server",
      id: messageId,
      threadId,
      runId: null,
      nodeId: null,
      role: m.role,
      text: m.text,
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
    };
    const common = {
      id: turnItemId,
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed",
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
    };
    const item = user
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: m.text,
          attachments: [],
        }
      : { ...common, type: "assistant_message", messageId, text: m.text, streaming: false };

    insertEvent.get(id("message", i), threadId, "message.updated", at, JSON.stringify(message));
    sequence = insertEvent.get(id("turn-item", i), threadId, "turn-item.updated", at, JSON.stringify(item))!.sequence;
    db.run(
      `INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (?, ?, NULL, NULL, ?, 0, ?, ?, ?)`,
      [messageId, threadId, m.role, at, at, JSON.stringify(message)],
    );
    db.run(
      `INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
      parent_item_id, ordinal, type, status, updated_at, payload_json) VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, 'completed', ?, ?)`,
      [turnItemId, threadId, ordinal, item.type, at, JSON.stringify(item)],
    );
    db.run("INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal) VALUES (?, ?, ?)", [
      threadId,
      turnItemId,
      ordinal,
    ]);
  });
  db.run(
    "UPDATE orchestration_v2_projection_metadata SET last_sequence = ?, updated_at = ? WHERE projection_name = 'thread-projections'",
    [sequence, now],
  );
  return messages.length;
}
