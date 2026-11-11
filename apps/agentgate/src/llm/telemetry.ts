import {
  modelIdSchema,
  type Failure,
  type ModelTokens,
  type TokenHour,
  type ProxyAttempt,
  type ProxyRequest,
  type RequestDetail,
  type RequestPage,
} from "@agentgate/protocol";
import { clamp, safeJsonParse, startTimer } from "hanzio";
import type { Data, Rec, Store } from "../store.ts";
import type { ProviderName } from "./provider.ts";

export class Telemetry {
  readonly request: ProxyRequest;
  private elapsed = startTimer();
  private ended = false;
  constructor(
    readonly s: Store,
    provider: ProviderName,
    private sensitive: string[] = [],
  ) {
    this.request = {
      id: crypto.randomUUID(),
      at: s.now(),
      provider,
      requestedModel: "",
      routedModel: "",
      account: "",
      selection: "",
      status: 0,
      outcome: "pending",
      attempts: 0,
    };
    this.save();
  }
  private safeModel(value?: string) {
    if (!value) return "";
    const parsed = modelIdSchema.safeParse(value);
    if (
      !parsed.success ||
      /^(sk-|sk_ant|eyJ[A-Za-z0-9_-]+\.)/.test(parsed.data) ||
      this.sensitive.some((token) => token && value.includes(token)) ||
      this.s
        .list("credential")
        .some(
          (c) => (c.accessToken && value.includes(c.accessToken)) || (c.refreshToken && value.includes(c.refreshToken)),
        )
    )
      return "[redacted]";
    return parsed.data;
  }
  models(requested?: string, routed?: string) {
    this.request.requestedModel = this.safeModel(requested);
    this.request.routedModel = this.safeModel(routed);
    this.save();
  }
  attempt(account: string, selection: string): ProxyAttempt {
    const attempt = {
      id: crypto.randomUUID(),
      requestId: this.request.id,
      number: ++this.request.attempts,
      account: account.slice(0, 128),
      selection,
      at: this.s.now(),
      status: 0,
      headersMs: 0,
    };
    this.request.account = attempt.account;
    this.request.selection = selection;
    this.save();
    this.saveAttempt(attempt);
    return attempt;
  }
  saveAttempt(attempt: ProxyAttempt) {
    if (this.s.closed) return;
    const data = JSON.stringify(attempt);
    this.s.db.run("insert or replace into proxy_attempts values (?, ?, ?, ?, ?)", [
      attempt.id,
      attempt.requestId,
      attempt.number,
      Buffer.byteLength(data),
      data,
    ]);
  }
  headers(status: number) {
    this.request.status = status;
    this.request.headersMs = Math.round(this.elapsed());
    this.save();
  }
  firstByte() {
    if (this.request.firstByteMs === undefined) this.request.firstByteMs = Math.round(this.elapsed());
  }
  finish(outcome: ProxyRequest["outcome"], failure?: Failure, stream?: ProxyRequest["stream"]) {
    if (this.ended) return;
    this.ended = true;
    Object.assign(this.request, {
      outcome,
      failure,
      stream,
      durationMs: Math.round(this.elapsed()),
    });
    this.save();
    if (this.s.closed) return;
    trimTelemetry(this.s);
    bumpActivity(this.s);
  }
  /** The model a response's tokens count under. */
  get tokenModel() {
    return this.request.routedModel || this.request.requestedModel || "unknown";
  }
  /** Adds a response's token counts to this hour's total for its model. */
  tokens(t: Tokens) {
    if (this.s.closed || !(t.input + t.output + t.cacheRead + t.cacheWrite)) return;
    const now = this.s.now(),
      model = this.tokenModel;
    this.s.db.run(
      "insert into token_usage values (?,?,?,?,?,?,?) on conflict(hour, provider, model) do update set input=input+excluded.input, output=output+excluded.output, cache_read=cache_read+excluded.cache_read, cache_write=cache_write+excluded.cache_write",
      [now - (now % 3600000), this.request.provider, model, t.input, t.output, t.cacheRead, t.cacheWrite],
    );
  }
  private save() {
    if (this.s.closed) return;
    const r = this.request,
      data = JSON.stringify(r);
    this.s.db.run(
      "insert into proxy_requests (id,at,provider,account,model,outcome,failure,bytes,data) values (?,?,?,?,?,?,?,?,?) on conflict(id) do update set account=excluded.account, model=excluded.model, outcome=excluded.outcome, failure=excluded.failure, bytes=excluded.bytes, data=excluded.data",
      [r.id, r.at, r.provider, r.account, r.routedModel, r.outcome, r.failure ?? null, Buffer.byteLength(data), data],
    );
  }
}
/** Each store's open throttle window: a busy proxy finishes many requests a second, and the app needs one refresh. */
const activityWindows = new WeakMap<Store, { again: boolean }>();
/** Bumps `activity` at once, then at most once a second: a finish inside the window gets one bump at its end, so the
 * last change is never lost. */
function bumpActivity(s: Store) {
  const current = activityWindows.get(s);
  if (current) return void (current.again = true);
  s.bump("activity");
  const opened = { again: false };
  activityWindows.set(s, opened);
  setTimeout(() => {
    activityWindows.delete(s);
    if (opened.again && !s.closed) bumpActivity(s);
  }, 1000).unref();
}
export interface RequestFilter {
  provider?: string;
  account?: string;
  model?: string;
  outcome?: string;
  failure?: string;
  search?: string;
  since?: number;
  until?: number;
  cursor?: string;
  limit?: number;
}
export function requests(s: Store, filter: RequestFilter = {}): RequestPage {
  const where: string[] = [],
    args: (string | number)[] = [];
  for (const key of ["provider", "account", "model", "outcome", "failure"] as const)
    if (filter[key]) {
      where.push(`${key} = ?`);
      args.push(filter[key]!);
    }
  if (filter.since !== undefined) {
    where.push("at >= ?");
    args.push(filter.since);
  }
  if (filter.until !== undefined) {
    where.push("at <= ?");
    args.push(filter.until);
  }
  if (filter.search) {
    where.push("(id like ? escape '\\' or model like ? escape '\\' or account like ? escape '\\')");
    const search = `%${filter.search.replace(/[\\%_]/g, "\\$&")}%`;
    args.push(search, search, search);
  }
  const minimum = s.db.query<{ n: number | null }, []>("select min(seq) as n from proxy_requests").get()!.n;
  const cursor = filter.cursor ? Number(filter.cursor) : undefined;
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 1)) throw new Error("Invalid request cursor");
  if (cursor !== undefined) {
    where.push("seq < ?");
    args.push(cursor);
  }
  const limit = clamp(filter.limit ?? 50, 1, 100);
  const rows = s.db
    .query<{ seq: number; data: string }, (string | number)[]>(
      `select seq,data from proxy_requests ${where.length ? `where ${where.join(" and ")}` : ""} order by seq desc limit ?`,
    )
    .all(...args, limit + 1);
  return {
    requests: rows.slice(0, limit).map((r) => JSON.parse(r.data)),
    nextCursor: rows.length > limit ? String(rows[limit - 1]!.seq) : undefined,
    cursorReset: cursor !== undefined && (minimum === null || cursor <= minimum),
  };
}
export function requestDetail(s: Store, id: string): RequestDetail | undefined {
  const row = s.db.query<{ data: string }, [string]>("select data from proxy_requests where id=?").get(id);
  return row
    ? {
        request: JSON.parse(row.data),
        attempts: s.db
          .query<{ data: string }, [string]>("select data from proxy_attempts where request_id=? order by number")
          .all(id)
          .map((r) => JSON.parse(r.data)),
      }
    : undefined;
}

/** Every hourly token count this node knows after `?1`, summed by `key`: its own, the `tokens` records other nodes
 * publish (`?2` is this node), and Cursor's account-wide history, which may come from more than one node, once per
 * account and hour. Each source is summed before the union, so the final sort is over groups rather than every row. */
const tokenSums = (key: string) => {
  const sums =
    "sum(input) as input, sum(output) as output, sum(cache_read) as cache_read, sum(cache_write) as cache_write";
  return `select ${key}, ${sums} from (
    select ${key}, ${sums} from token_usage where hour > ?1 group by ${key}
    union all select ${key}, ${sums} from token_records where hour > ?1 and node != ?2 and provider != 'cursor' group by ${key}
    union all select ${key}, ${sums} from (
      select hour, 'cursor' as provider, model, max(input) as input, max(output) as output, max(cache_read) as cache_read, max(cache_write) as cache_write from (
        select account, hour, model, input, output, cache_read, cache_write from cursor_tokens where hour > ?1
        union all select account, hour, model, input, output, cache_read, cache_write from token_records where hour > ?1 and node != ?2 and provider = 'cursor'
      ) group by account, hour, model
    ) group by ${key}
  ) group by ${key}`;
};
const HOUR = 3600000;

/** The rows of every `tokens` record, kept in a node-local table so a read is an indexed sum rather than a parse of
 * every record's JSON. Records arrive through sync, the relay, backups and the CLI's own connection, so instead of
 * hooking each, a read first replaces the rows of the records written since the last one, by `seq`. Never synced or
 * backed up: the records are the source, and a store without the table refills it from them. */
const tokenTables = new WeakSet<Store>();
function refreshTokenRecords(s: Store) {
  if (!tokenTables.has(s)) {
    s.db.run(
      "create table if not exists token_records (record text not null, node text not null, hour integer not null, provider text not null, model text not null, account text not null, input integer not null, output integer not null, cache_read integer not null, cache_write integer not null, primary key (hour, record, provider, model, account)) without rowid",
    );
    s.db.run("create index if not exists token_records_record on token_records(record)");
    // Cursor's few rows are read apart from the rest, to count each account's hour once.
    s.db.run("create index if not exists token_records_cursor on token_records(hour) where provider = 'cursor'");
    tokenTables.add(s);
  }
  const from = Number(s.local("tokens:table") ?? 0);
  if (!s.db.query("select 1 from records where seq > ? and kind = 'tokens' limit 1").get(from)) return;
  s.transaction(() => {
    const high = s.seq(),
      insert = s.db.prepare("insert into token_records values (?,?,?,?,?,?,?,?,?,?)");
    for (const r of s.db
      .query<Pick<Rec, "id" | "deleted" | "data">, [number, number]>(
        "select id, deleted, data from records where seq > ? and seq <= ? and kind = 'tokens'",
      )
      .all(from, high)) {
      s.db.run("delete from token_records where record = ?", [r.id]);
      if (r.deleted) continue;
      const data = JSON.parse(r.data) as Data<"tokens">;
      for (const row of data.rows)
        insert.run(
          r.id,
          data.node,
          row.hour,
          row.provider,
          row.model,
          row.account ?? "",
          row.input,
          row.output,
          row.cacheRead,
          row.cacheWrite,
        );
    }
    s.setLocal("tokens:table", String(high));
  });
}
/** A read sums every hour of history, about 7 ms for a year from three machines, and the app reads on every activity
 * change, up to once a second while the proxy is busy. An answer is reused for a minute unless a `tokens` record
 * changed since; this node's own counts may lag that minute. */
const tokenCache = new WeakMap<Store, Map<string, { at: number; seq: number; value: unknown }>>();
function cachedTokens<T>(s: Store, name: string, since: number, read: (after: number) => T): T {
  // An hour bucket counts if any of it is after `since`, so every `since` within one hour selects the same buckets and
  // the app's "now minus 7 days" shares one entry an hour.
  const after = since - HOUR,
    key = `${name}:${Math.floor(after / HOUR)}`,
    now = s.now(),
    seq = s.db
      .query<{ seq: number }, []>("select coalesce(max(seq), 0) as seq from records where kind = 'tokens'")
      .get()!.seq;
  let cache = tokenCache.get(s);
  if (!cache) tokenCache.set(s, (cache = new Map()));
  const hit = cache.get(key);
  if (hit && hit.seq === seq && now - hit.at < 60000) return hit.value as T;
  refreshTokenRecords(s);
  const value = read(after);
  cache.delete(key);
  cache.set(key, { at: now, seq, value });
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  return value;
}

/** Token totals per model since a time, over every machine. */
export function tokenUsage(s: Store, since = 0): ModelTokens[] {
  return cachedTokens(s, "usage", since, (after) =>
    s.db
      .query<ModelTokens, [number, string]>(
        `select provider, model, input, output, cache_read as cacheRead, cache_write as cacheWrite
          from (${tokenSums("provider, model")}) order by input + output + cache_read + cache_write desc`,
      )
      .all(after, s.nodeId),
  );
}

/** Total tokens per hour since a time, over every machine; the app groups them into its own local days. */
export function tokenHours(s: Store, since = 0): TokenHour[] {
  return cachedTokens(
    s,
    "hours",
    since,
    (after) =>
      s.db
        .query(`select hour, input + output + cache_read + cache_write from (${tokenSums("hour")}) order by hour`)
        .values(after, s.nodeId) as TokenHour[],
  );
}

/** Requests a previous daemon left pending ended with it: mark them, so retention and metrics count them again. */
export function interruptPending(s: Store) {
  s.db.run(
    "update proxy_requests set outcome = 'interrupted', data = json_set(data, '$.outcome', 'interrupted') where outcome = 'pending'",
  );
}

/** Keeps the newest requests within the count and byte limits, counting each request's attempts with it; requests
 * still pending are kept wherever they fall. Trimming walks the whole table, so it runs on every 100th finish or once
 * an hour has passed. */
const trims = new WeakMap<Store, { finishes: number; at: number }>();
function trimTelemetry(s: Store) {
  const last = trims.get(s) ?? { finishes: 0, at: s.now() };
  if (++last.finishes < 100 && s.now() - last.at < HOUR) return void trims.set(s, last);
  trims.set(s, { finishes: 0, at: s.now() });
  const { logRetention, logRetentionBytes } = s.settings();
  const size = s.db
    .query<{ n: number; bytes: number }, []>(
      "select (select count(*) from proxy_requests) as n, (select coalesce(sum(bytes), 0) from proxy_requests) + (select coalesce(sum(bytes), 0) from proxy_attempts) as bytes",
    )
    .get()!;
  if (size.n <= logRetention && size.bytes <= logRetentionBytes) return;
  s.transaction(() => {
    s.db.run(
      `delete from proxy_requests where seq in (
        select seq from (
          select r.seq, r.outcome, row_number() over w as n, sum(r.bytes + coalesce(a.bytes, 0)) over w as total
          from proxy_requests r
          left join (select request_id, sum(bytes) as bytes from proxy_attempts group by request_id) a
            on a.request_id = r.id
          window w as (order by r.seq desc)
        ) where outcome != 'pending' and (n > ?1 or total > ?2)
      )`,
      [logRetention, logRetentionBytes],
    );
    // An attempt is written after its request, so the only attempts without one are those just trimmed.
    s.db.run("delete from proxy_attempts where request_id not in (select id from proxy_requests)");
  });
}
export type Tokens = Omit<ModelTokens, "provider" | "model">;
/** An event larger than this keeps only its head (for its name) and tail (for its usage). */
const EVENT_LIMIT = 65536,
  HEAD = 4096,
  TAIL = 8192;
/** The event's name: its `event:` line, else the leading `type` of its data, which every Claude and Codex event has. */
const EVENT_NAME = /^event:[ \t]*(\S+)/m,
  DATA_TYPE = /^data:[ \t]*\{\s*"type"\s*:\s*"([^"]+)"/m;
/** Bounded SSE observation only; the original bytes continue to the client unchanged. */
export function streamObserver(onResponse?: (id: string) => void) {
  const decoder = new TextDecoder();
  let buffer = "",
    /** The start of the event in progress, once it has outgrown EVENT_LIMIT. */
    head: string | undefined;
  let terminal: "completed" | "provider-error" | undefined;
  const tokens: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  /** Claude reports usage in message_start and cumulatively in message_delta, Codex once in
   * response.completed, so the largest value per field is the total. Read from text rather than JSON
   * because Codex's response.completed carries the whole output and is often too large to parse;
   * its usage sits at the end, inside the tail kept below. */
  const readUsage = (event: string) => {
    const at = event.lastIndexOf('"usage":');
    if (at < 0) return;
    const usage = event.slice(at),
      field = (name: string) => Number(new RegExp(`"${name}":\\s*(\\d+)`).exec(usage)?.[1] ?? 0);
    const cached = field("cached_tokens"); // Codex counts cached tokens inside input_tokens
    tokens.input = Math.max(tokens.input, field("input_tokens") - cached);
    tokens.output = Math.max(tokens.output, field("output_tokens"));
    tokens.cacheRead = Math.max(tokens.cacheRead, field("cache_read_input_tokens") + cached);
    tokens.cacheWrite = Math.max(tokens.cacheWrite, field("cache_creation_input_tokens"));
  };
  /** `start` is the event's beginning and `rest` what is kept of it: the same text, or its tail when it was too large. */
  const settle = (start: string, rest: string) => {
    readUsage(rest);
    const name = EVENT_NAME.exec(start)?.[1] ?? DATA_TYPE.exec(start)?.[1];
    if (name === "response.failed" || name === "response.incomplete" || name === "error") terminal = "provider-error";
    else if ((name === "response.completed" || name === "message_stop") && terminal !== "provider-error")
      terminal = "completed";
    else if (name === "response.created" && start === rest) {
      // The continuation id; this event is small and arrives first, unlike the answer-sized response.completed.
      const data = rest
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      const response = safeJsonParse<{ response?: { id?: unknown } }>(data).data?.response;
      if (typeof response?.id === "string") onResponse?.(response.id);
    }
  };
  return {
    get terminal() {
      return terminal;
    },
    tokens,
    chunk(bytes: Uint8Array) {
      for (let offset = 0; offset < bytes.length; offset += 16384) {
        buffer += decoder.decode(bytes.subarray(offset, offset + 16384), { stream: true });
        let from = 0;
        for (const match of buffer.matchAll(/\r?\n\r?\n/g)) {
          const event = buffer.slice(from, match.index);
          settle(head ?? event, event);
          head = undefined;
          from = match.index + match[0].length;
        }
        buffer = buffer.slice(from);
        if (buffer.length > EVENT_LIMIT) {
          head ??= buffer.slice(0, HEAD);
          buffer = buffer.slice(-TAIL);
        }
      }
    },
  };
}
