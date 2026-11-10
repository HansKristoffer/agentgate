import { isRecord } from "hanzio";
import type { Store } from "../store.ts";

/** Token totals for one coding-agent session and model, so the factory can sum what a run's threads used. Node-local:
 * each machine counts the sessions it proxied, and the factory asks the machine that ran them. */
export interface SessionUsage {
  session: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
  firstAt: number;
  lastAt: number;
}

const RETENTION = 90 * 86_400_000,
  SESSION_ID = /^[\w-]{1,128}$/;

/** Claude Code's session id inside `metadata.user_id`, which is either JSON or `user_…_account_<uuid>_session_<id>`. */
export function claudeMetadataSession(body: unknown) {
  const metadata = isRecord(body) ? body.metadata : undefined,
    userId = isRecord(metadata) ? metadata.user_id : undefined;
  if (typeof userId !== "string") return undefined;
  try {
    const parsed = JSON.parse(userId);
    if (typeof parsed?.session_id === "string") return parsed.session_id as string;
  } catch {
    // Not JSON: the older underscore form below.
  }
  return userId.match(/_session_([\w-]{1,128})$/)?.[1];
}

export function codexSession(headers: Headers) {
  const id = headers.get("session_id") ?? headers.get("x-codex-session-id");
  return id && id.length <= 128 ? id : undefined;
}

/** The session id the client named, unhashed, so it matches `CLAUDE_CODE_SESSION_ID` or Codex's own id. Cursor's
 * conversation id names no agent session the factory tracks. */
export function sessionFromRequest(provider: "claude" | "codex" | "cursor", headers: Headers, body: unknown) {
  const id =
    provider === "claude"
      ? (headers.get("x-claude-code-session-id") ?? claudeMetadataSession(body))
      : provider === "codex"
        ? codexSession(headers)
        : undefined;
  return id && SESSION_ID.test(id) ? id : undefined;
}

const ready = new WeakSet<Store>();
function table(s: Store) {
  if (ready.has(s)) return;
  s.db.run(
    "create table if not exists session_usage (session text not null, provider text not null, model text not null, input integer not null, output integer not null, cache_read integer not null, cache_write integer not null, requests integer not null, first_at integer not null, last_at integer not null, primary key (session, provider, model))",
  );
  s.db.run("create index if not exists session_usage_last_at on session_usage (last_at)");
  ready.add(s);
}

/** Adds one response's tokens to its session. It runs as the response ends, so a failure is dropped rather than
 * reaching the request: losing a count is better than failing a request that already succeeded. */
export function recordSessionUsage(
  s: Store,
  row: {
    session: string;
    provider: string;
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    at: number;
  },
) {
  if (s.closed || !(row.input + row.output + row.cacheRead + row.cacheWrite)) return;
  try {
    table(s);
    s.db.run(
      "insert into session_usage values (?,?,?,?,?,?,?,1,?,?) on conflict(session, provider, model) do update set input=input+excluded.input, output=output+excluded.output, cache_read=cache_read+excluded.cache_read, cache_write=cache_write+excluded.cache_write, requests=requests+1, last_at=max(last_at, excluded.last_at)",
      [row.session, row.provider, row.model, row.input, row.output, row.cacheRead, row.cacheWrite, row.at, row.at],
    );
  } catch {
    // A closed or busy database: this response goes uncounted.
  }
}

/** Every model's totals for the given sessions. */
export function sessionUsage(s: Store, sessions: string[]): SessionUsage[] {
  if (!sessions.length) return [];
  table(s);
  return s.db
    .query(
      `select session, provider, model, input, output, cache_read as cacheRead, cache_write as cacheWrite, requests, first_at as firstAt, last_at as lastAt
      from session_usage where session in (select value from json_each(?)) order by session, provider, model`,
    )
    .all(JSON.stringify(sessions)) as SessionUsage[];
}

/** Runs are kept for 90 days, and so are the sessions behind them. */
export function trimSessionUsage(s: Store) {
  table(s);
  s.db.run("delete from session_usage where last_at < ?", [s.now() - RETENTION]);
}
