import { join } from "node:path";
import { groupBy, typedEntries } from "hanzio";
import { listClaudeCodeFiles, listCodexFiles, parseClaudeCodeFile, parseCodexFile } from "llm-usage-extraction";
import { CLAUDE_DIR, CODEX_DIR, PRIMARY_CLAUDE_DIR, PRIMARY_CODEX_DIR } from "../setup.ts";
import { nodesBelow, parseData, type Data, type Rec, type Store } from "../store.ts";
import type { Tokens } from "./telemetry.ts";

const HOUR = 3_600_000,
  DAY = 86_400_000;
/** The node protocol that understands `tokens` records (see NODE_PROTOCOL in remote.ts). */
export const TOKENS_PROTOCOL = 3;
/** The Claude Code and Codex homes whose session logs hold this machine's usage: the user's own, and agentgate's. */
export const LOG_DIRS = { claude: [PRIMARY_CLAUDE_DIR, CLAUDE_DIR], codex: [PRIMARY_CODEX_DIR, CODEX_DIR] };

type Hours = Map<string, Tokens & { hour: number; model: string }>;
function add(hours: Hours, at: number, model: string, t: Tokens) {
  if (!(t.input + t.output + t.cacheRead + t.cacheWrite)) return;
  const hour = at - (at % HOUR),
    key = `${hour}\0${model}`;
  const sum = hours.get(key) ?? { hour, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  sum.input += t.input;
  sum.output += t.output;
  sum.cacheRead += t.cacheRead;
  sum.cacheWrite += t.cacheWrite;
  hours.set(key, sum);
}

/** One session log's usage from before `before`. The parsers are tokenmaxxing's, shared through llm-usage-extraction;
 * its user events carry no tokens. */
async function logFile(provider: "claude" | "codex", path: string, before: number, hours: Hours, seen: Set<number>) {
  const { events } = await (provider === "claude" ? parseClaudeCodeFile : parseCodexFile)({ path, byteOffset: 0 });
  for (const e of events) {
    if (e.messageType === "user" || !(e.timestamp < before)) continue;
    // The parser counts a Claude message once per file, but the same session can sit in both homes. A 52-bit hash
    // keeps the set small over millions of messages; a collision drops one message.
    if (provider === "claude") {
      const key = Number(BigInt(Bun.hash(`${e.messageId}:${e.requestId ?? ""}`)) & 0xfffffffffffffn);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    add(hours, e.timestamp, e.model, {
      input: e.inputTokens,
      output: e.outputTokens,
      cacheRead: e.cacheReadTokens,
      cacheWrite: e.cacheCreationTokens,
    });
  }
}

/** The proxy counts tokens from the hour this node started counting them; usage from before that is read once from
 * the session logs, so the history goes back as far as the logs do. */
// ponytail: a few GiB of logs take seconds and leave the daemon's RSS a few hundred MiB higher; run it in a child process if that matters.
export async function backfillTokens(s: Store, dirs = LOG_DIRS, signal?: AbortSignal) {
  for (const provider of ["claude", "codex"] as const) {
    const key = `tokens:backfill:${provider}`;
    if (s.local(key)) continue;
    const first = s.db
      .query<{ hour: number | null }, [string]>("select min(hour) as hour from token_usage where provider = ?")
      .get(provider)!.hour;
    const before = first ?? s.now() - (s.now() % HOUR),
      hours: Hours = new Map(),
      seen = new Set<number>();
    for (const dir of new Set(dirs[provider])) {
      const root = join(dir, provider === "claude" ? "projects" : "sessions");
      for (const path of await (provider === "claude" ? listClaudeCodeFiles : listCodexFiles)(root)) {
        if (signal?.aborted || s.closed) return;
        await logFile(provider, path, before, hours, seen).catch(() => {});
      }
    }
    s.transaction(() => {
      for (const h of hours.values())
        s.db.run(
          "insert into token_usage values (?,?,?,?,?,?,?) on conflict(hour, provider, model) do update set input=input+excluded.input, output=output+excluded.output, cache_read=cache_read+excluded.cache_read, cache_write=cache_write+excluded.cache_write",
          [h.hour, provider, h.model, h.input, h.output, h.cacheRead, h.cacheWrite],
        );
      s.setLocal(key, String(before));
      s.setLocal("tokens:published", undefined); // publish the new history too
    });
  }
}

const FOLD_AFTER = 90 * DAY;
/** Well under the relay's 1 MiB record limit; a month heavier than this stays in days. */
const MAX_MONTH = 512 * 1024;

/** Days older than 90 fold into one record per month, so the synced history stops growing by a record a day. A month
 * folds once all of it is that old, under the ID of its last day: that ID then never belongs to a live day record, and
 * a node on the previous version, which skips records whose date is before the range it reads, still reads the month
 * for any range that reaches into it. The month's rows are its days' rows, so the totals do not change; the days
 * become tombstones. */
function foldTokens(s: Store) {
  const prefix = `${s.nodeId}:`,
    months = new Map<string, Rec[]>();
  // `;` follows `:`, so the range is every ID with this node's prefix.
  for (const r of s.db
    .query<Rec, [string, string]>("select * from records where kind = 'tokens' and deleted = 0 and id > ? and id < ?")
    .all(prefix, `${s.nodeId};`)) {
    const day = r.id.slice(prefix.length);
    if (!/^\d{4}-\d\d-\d\d$/.test(day)) continue;
    const date = new Date(day),
      monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1);
    if (monthEnd > s.now() - FOLD_AFTER) continue;
    const month = new Date(monthEnd - DAY).toISOString().slice(0, 10);
    months.set(month, [...(months.get(month) ?? []), r]);
  }
  for (const [month, records] of months) {
    const id = `${prefix}${month}`;
    if (records.length === 1 && records[0]!.id === id) continue;
    // Keyed, so a row in both the month and a day counts once. The month's own record sorts last and is read first: a
    // day that a full republish rewrote is newer.
    const rows = new Map<string, Data<"tokens">["rows"][number]>();
    for (const r of records.toReversed())
      for (const row of parseData("tokens", r.id, JSON.parse(r.data)).rows)
        rows.set(`${row.hour}\0${row.provider}\0${row.model}\0${row.account ?? ""}`, row);
    const data = parseData("tokens", id, {
      id,
      node: s.nodeId,
      rows: [...rows.values()].sort((a, b) => a.hour - b.hour),
    });
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_MONTH) continue;
    s.transaction(() => {
      s.put("tokens", id, data);
      for (const r of records) if (r.id !== id) s.del("tokens", r.id);
    });
  }
}

/** Each node publishes its own hourly totals, one `tokens` record per UTC day and later per month (`foldTokens`), so
 * every machine can show all of them. Cursor rows carry their account: its history is account-wide, and whichever node
 * holds the login reads it. */
export function publishTokens(s: Store) {
  // An older daemon stalls its Tailscale sync on a record kind it does not know.
  if (!s.has("node", s.nodeId) || nodesBelow(s, TOKENS_PROTOCOL).length) return;
  const from = Number(s.local("tokens:published") ?? 0);
  const rows = s.db
    .query<Data<"tokens">["rows"][number] & { account: string | null }, [number]>(
      `select hour, provider, model, null as account, input, output, cache_read as cacheRead, cache_write as cacheWrite from token_usage where hour >= ?1
     union all select hour, 'cursor', model, account, input, output, cache_read, cache_write from cursor_tokens where hour >= ?1
     order by hour, provider, model, account`,
    )
    .all(from);
  const tokenRows: Data<"tokens">["rows"] = rows.map(({ account, ...row }) => (account ? { ...row, account } : row));
  const days = groupBy(tokenRows, (row) => new Date(row.hour).toISOString().slice(0, 10));
  for (const [day, dayRows = []] of typedEntries(days)) {
    const id = `${s.nodeId}:${day}`,
      data = parseData("tokens", id, { id, node: s.nodeId, rows: dayRows });
    if (s.record("tokens", id)?.data !== JSON.stringify(data)) s.put("tokens", id, data);
  }
  // Recheck the last week each time: Cursor publishes some usage late.
  const recheck = s.now() - 8 * DAY;
  s.setLocal("tokens:published", String(recheck - (recheck % DAY)));
  // After publishing: a full republish (after a backfill) rewrites folded months as days, which this folds again.
  foldTokens(s);
}
