import {
  modelIdSchema,
  type Failure,
  type ProxyAttempt,
  type ProxyMetrics,
  type ProxyRequest,
  type RequestDetail,
  type RequestPage,
} from "@agentgate/protocol";
import type { Store } from "../store.ts";
import type { ProviderName } from "./provider.ts";

export class Telemetry {
  readonly request: ProxyRequest;
  private started = performance.now();
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
          (c) =>
            (c.accessToken && value.includes(c.accessToken)) ||
            (c.refreshToken && value.includes(c.refreshToken)),
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
    this.s.db.run(
      "insert or replace into proxy_attempts values (?, ?, ?, ?, ?)",
      [
        attempt.id,
        attempt.requestId,
        attempt.number,
        Buffer.byteLength(data),
        data,
      ],
    );
  }
  headers(status: number) {
    this.request.status = status;
    this.request.headersMs = Math.round(performance.now() - this.started);
    this.save();
  }
  firstByte() {
    if (this.request.firstByteMs === undefined)
      this.request.firstByteMs = Math.round(performance.now() - this.started);
  }
  finish(
    outcome: ProxyRequest["outcome"],
    failure?: Failure,
    stream?: ProxyRequest["stream"],
  ) {
    if (this.ended) return;
    this.ended = true;
    Object.assign(this.request, {
      outcome,
      failure,
      stream,
      durationMs: Math.round(performance.now() - this.started),
    });
    this.save();
    if (!this.s.closed) trimTelemetry(this.s);
  }
  private save() {
    if (this.s.closed) return;
    const r = this.request,
      data = JSON.stringify(r);
    this.s.db.run(
      "insert into proxy_requests (id,at,provider,account,model,outcome,failure,bytes,data) values (?,?,?,?,?,?,?,?,?) on conflict(id) do update set account=excluded.account, model=excluded.model, outcome=excluded.outcome, failure=excluded.failure, bytes=excluded.bytes, data=excluded.data",
      [
        r.id,
        r.at,
        r.provider,
        r.account,
        r.routedModel,
        r.outcome,
        r.failure ?? null,
        Buffer.byteLength(data),
        data,
      ],
    );
  }
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
  for (const key of [
    "provider",
    "account",
    "model",
    "outcome",
    "failure",
  ] as const)
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
    where.push(
      "(id like ? escape '\\' or model like ? escape '\\' or account like ? escape '\\')",
    );
    const search = `%${filter.search.replace(/[\\%_]/g, "\\$&")}%`;
    args.push(search, search, search);
  }
  const minimum = (
    s.db.query("select min(seq) as n from proxy_requests").get() as {
      n: number | null;
    }
  ).n;
  const cursor = filter.cursor ? Number(filter.cursor) : undefined;
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 1))
    throw new Error("Invalid request cursor");
  if (cursor !== undefined) {
    where.push("seq < ?");
    args.push(cursor);
  }
  const limit = Math.max(1, Math.min(100, filter.limit ?? 50));
  const rows = s.db
    .query(
      `select seq,data from proxy_requests ${where.length ? `where ${where.join(" and ")}` : ""} order by seq desc limit ?`,
    )
    .all(...args, limit + 1) as { seq: number; data: string }[];
  return {
    requests: rows.slice(0, limit).map((r) => JSON.parse(r.data)),
    nextCursor: rows.length > limit ? String(rows[limit - 1]!.seq) : undefined,
    cursorReset:
      cursor !== undefined && (minimum === null || cursor <= minimum),
  };
}
export function requestDetail(s: Store, id: string): RequestDetail | undefined {
  const row = s.db
    .query("select data from proxy_requests where id=?")
    .get(id) as { data: string } | null;
  return row
    ? {
        request: JSON.parse(row.data),
        attempts: (
          s.db
            .query(
              "select data from proxy_attempts where request_id=? order by number",
            )
            .all(id) as { data: string }[]
        ).map((r) => JSON.parse(r.data)),
      }
    : undefined;
}
export function metrics(s: Store, since = s.now() - 86400000): ProxyMetrics {
  const row = s.db
    .query(
      `
    select count(*) as total,
      coalesce(sum(outcome = 'success'), 0) as succeeded,
      coalesce(sum(outcome = 'failed'), 0) as failed,
      coalesce(sum(outcome = 'interrupted'), 0) as interrupted,
      coalesce(sum(outcome = 'cancelled'), 0) as cancelled,
      coalesce(sum((
        select count(distinct json_extract(attempt.data, '$.account'))
        from proxy_attempts as attempt where attempt.request_id = request.id
      ) > 1), 0) as fallback,
      round(avg(json_extract(data, '$.headersMs'))) as averageHeadersMs,
      round(avg(json_extract(data, '$.firstByteMs'))) as averageFirstByteMs
    from proxy_requests as request where at >= ? and outcome != 'pending'
  `,
    )
    .get(since) as Omit<
    ProxyMetrics,
    "since" | "averageHeadersMs" | "averageFirstByteMs"
  > & { averageHeadersMs: number | null; averageFirstByteMs: number | null };
  return {
    ...row,
    since,
    averageHeadersMs: row.averageHeadersMs ?? undefined,
    averageFirstByteMs: row.averageFirstByteMs ?? undefined,
  };
}

export function trimTelemetry(s: Store) {
  const settings = s.settings();
  s.transaction(() => {
    const rows = s.db
      .query(
        "select seq,id,bytes,outcome from proxy_requests order by seq desc",
      )
      .all() as { seq: number; id: string; bytes: number; outcome: string }[];
    const attemptBytes = new Map(
      (
        s.db
          .query(
            "select request_id as id,sum(bytes) as bytes from proxy_attempts group by request_id",
          )
          .all() as { id: string; bytes: number }[]
      ).map((r) => [r.id, r.bytes]),
    );
    let bytes = 0,
      count = 0;
    for (const r of rows) {
      bytes += r.bytes + (attemptBytes.get(r.id) ?? 0);
      count++;
      if (
        r.outcome !== "pending" &&
        (count > settings.logRetention || bytes > settings.logRetentionBytes)
      ) {
        s.db.run("delete from proxy_attempts where request_id=?", [r.id]);
        s.db.run("delete from proxy_requests where seq=?", [r.seq]);
      }
    }
  });
}
/** Bounded SSE observation only; the original bytes continue to the client unchanged. */
export function streamObserver(onResponse?: (id: string) => void) {
  const decoder = new TextDecoder();
  let buffer = "",
    discarding = false;
  let terminal: "completed" | "provider-error" | undefined;
  return {
    get terminal() {
      return terminal;
    },
    chunk(bytes: Uint8Array) {
      for (let offset = 0; offset < bytes.length; offset += 16384) {
        buffer += decoder.decode(bytes.subarray(offset, offset + 16384), {
          stream: true,
        });
        for (;;) {
          const match = /\r?\n\r?\n/.exec(buffer);
          if (!match) break;
          const event = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          if (discarding || event.length > 65536) {
            discarding = false;
            continue;
          }
          const data = event
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          try {
            const value = JSON.parse(data);
            if (
              ["response.completed", "message_stop"].includes(value.type) &&
              terminal !== "provider-error"
            )
              terminal = "completed";
            if (
              ["response.failed", "response.incomplete", "error"].includes(
                value.type,
              )
            )
              terminal = "provider-error";
            const id = value.response?.id;
            if (typeof id === "string") onResponse?.(id);
          } catch {}
          if (
            event.includes("event: message_stop") &&
            terminal !== "provider-error"
          )
            terminal = "completed";
        }
        if (buffer.length > 65536) {
          buffer = buffer.slice(-3);
          discarding = true;
        }
      }
    },
  };
}
