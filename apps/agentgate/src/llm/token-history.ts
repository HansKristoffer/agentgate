import { join } from "node:path";
import { CLAUDE_DIR, CODEX_DIR, PRIMARY_CLAUDE_DIR, PRIMARY_CODEX_DIR } from "../setup.ts";
import { parseData, type Data, type Store } from "../store.ts";
import type { Tokens } from "./telemetry.ts";

const HOUR = 3_600_000, DAY = 86_400_000;
/** The node protocol that understands `tokens` records (see NODE_PROTOCOL in remote.ts). */
export const TOKENS_PROTOCOL = 3;
/** The Claude Code and Codex homes whose session logs hold this machine's usage: the user's own, and agentgate's. */
export const LOG_DIRS = { claude: [PRIMARY_CLAUDE_DIR, CLAUDE_DIR], codex: [PRIMARY_CODEX_DIR, CODEX_DIR] };

type Hours = Map<string, Tokens & { hour: number; model: string }>;
function add(hours: Hours, at: number, model: string, t: Tokens) {
  if (!(t.input + t.output + t.cacheRead + t.cacheWrite)) return;
  const hour = at - (at % HOUR), key = `${hour}\0${model}`;
  const sum = hours.get(key) ?? { hour, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  sum.input += t.input; sum.output += t.output; sum.cacheRead += t.cacheRead; sum.cacheWrite += t.cacheWrite;
  hours.set(key, sum);
}
const n = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0);

/** A log's lines in batches, read 1 MiB at a time: whole session logs can be hundreds of MiB. */
async function* lines(path: string) {
  const file = Bun.file(path), decoder = new TextDecoder();
  let carry = "";
  for (let at = 0; at < file.size; at += 1 << 20) {
    const batch = decoder.decode(await file.slice(at, at + (1 << 20)).arrayBuffer(), { stream: true }).split("\n");
    batch[0] = carry + batch[0];
    carry = batch.pop()!;
    yield batch;
  }
  yield [carry + decoder.decode()];
}

/** Claude Code writes one line per content block, each repeating the message's usage: count each message once. */
async function claudeFile(path: string, before: number, hours: Hours, seen: Set<number>) {
  for await (const batch of lines(path)) for (const line of batch) {
    if (!line.includes('"usage"')) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const at = Date.parse(r?.timestamp), m = r?.message, u = m?.usage;
    if (r.type !== "assistant" || typeof m?.id !== "string" || !u || !(at < before)) continue;
    // A 52-bit hash keeps the set small over millions of messages; a collision drops one message.
    const key = Number(BigInt(Bun.hash(`${m.id}:${r.requestId ?? ""}`)) & 0xfffffffffffffn);
    if (seen.has(key)) continue;
    seen.add(key);
    add(hours, at, typeof m.model === "string" && m.model ? m.model : "unknown", {
      input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens),
    });
  }
}

/** Codex logs a token_count per request with that request's usage (`last_token_usage`) and the session's running total. */
async function codexFile(path: string, before: number, hours: Hours) {
  let model: string | undefined, total = "", seeded = false, previous = 0;
  // Usage logged before a rollout's first turn_context belongs to that turn's model.
  const early: [number, Tokens][] = [];
  for await (const batch of lines(path)) for (const line of batch) {
    // A forked or subagent rollout starts with a copy of its parent's history, written in one burst. It ends at the
    // first gap longer than a model round trip; counting it would bill the parent's usage again.
    const at = Date.parse(/^\{"timestamp":"([^"]+)"/.exec(line)?.[1] ?? "");
    if (seeded && at - previous > 1500) seeded = false;
    if (at) previous = at;
    if (!line.includes('"token_count"') && !line.includes('"turn_context"') && !line.includes('"session_meta"')) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const p = r?.payload;
    if (r.type === "session_meta" && p?.forked_from_id) seeded = true;
    if (r.type === "turn_context" && typeof p?.model === "string" && p.model) {
      model = p.model;
      for (const [time, t] of early.splice(0)) add(hours, time, p.model, t);
    }
    if (r.type !== "event_msg" || p?.type !== "token_count" || !p.info) continue;
    // Some Codex versions log the same request twice; the running total does not move for the copy.
    const next = JSON.stringify(p.info.total_token_usage ?? null), replay = next === total && next !== "null";
    total = next;
    const u = p.info.last_token_usage;
    if (seeded || replay || !u || !(at < before)) continue; // ponytail: total-only rollouts (no last_token_usage) are not counted
    // input_tokens includes the cached and cache-written tokens.
    const cacheRead = n(u.cached_input_tokens) || n(u.cache_read_input_tokens), cacheWrite = n(u.cache_write_input_tokens);
    const t = { input: Math.max(0, n(u.input_tokens) - cacheRead - cacheWrite), output: n(u.output_tokens), cacheRead, cacheWrite };
    if (model) add(hours, at, model, t); else early.push([at, t]);
  }
  for (const [time, t] of early) add(hours, time, "unknown", t);
}

/** The proxy counts tokens from the hour this node started counting them; usage from before that is read once from
 * the session logs, so the history goes back as far as the logs do. */
// ponytail: a few GiB of logs take seconds and leave the daemon's RSS a few hundred MiB higher; run it in a child process if that matters.
export async function backfillTokens(s: Store, dirs = LOG_DIRS, signal?: AbortSignal) {
  for (const provider of ["claude", "codex"] as const) {
    const key = `tokens:backfill:${provider}`;
    if (s.local(key)) continue;
    const first = (s.db.query("select min(hour) as hour from token_usage where provider = ?").get(provider) as { hour: number | null }).hour;
    const before = first ?? s.now() - (s.now() % HOUR), hours: Hours = new Map(), seen = new Set<number>();
    for (const dir of new Set(dirs[provider])) {
      const root = join(dir, provider === "claude" ? "projects" : "sessions");
      try {
        for await (const path of new Bun.Glob("**/*.jsonl").scan({ cwd: root, absolute: true })) {
          if (signal?.aborted || s.closed) return;
          await (provider === "claude" ? claudeFile(path, before, hours, seen) : codexFile(path, before, hours)).catch(() => {});
        }
      } catch {} // no such home
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

/** Each node publishes its own hourly totals, one `tokens` record per UTC day, so every machine can show all of them.
 * Cursor rows carry their account: its history is account-wide, and whichever node holds the login reads it. */
export function publishTokens(s: Store) {
  // An older daemon stalls its Tailscale sync on a record kind it does not know.
  const nodes = s.list("node");
  if (!nodes.some((n) => n.id === s.nodeId) || nodes.some((n) => (n.protocol ?? 0) < TOKENS_PROTOCOL)) return;
  const from = Number(s.local("tokens:published") ?? 0);
  const rows = s.db.query(
    `select hour, provider, model, null as account, input, output, cache_read as cacheRead, cache_write as cacheWrite from token_usage where hour >= ?1
     union all select hour, 'cursor', model, account, input, output, cache_read, cache_write from cursor_tokens where hour >= ?1
     order by hour, provider, model, account`,
  ).all(from) as (Data<"tokens">["rows"][number] & { account: string | null })[];
  const days = new Map<string, Data<"tokens">["rows"]>();
  for (const { account, ...row } of rows) {
    const day = new Date(row.hour).toISOString().slice(0, 10), list = days.get(day) ?? [];
    list.push(account ? { ...row, account } : row);
    days.set(day, list);
  }
  for (const [day, dayRows] of days) {
    const id = `${s.nodeId}:${day}`, data = parseData("tokens", id, { id, node: s.nodeId, rows: dayRows });
    if (s.record("tokens", id)?.data !== JSON.stringify(data)) s.put("tokens", id, data);
  }
  // Recheck the last week each time: Cursor publishes some usage late.
  const recheck = s.now() - 8 * DAY;
  s.setLocal("tokens:published", String(recheck - (recheck % DAY)));
}
