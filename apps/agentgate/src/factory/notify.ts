import { fetchHeaders } from "../runtime.ts";
import { items } from "./db.ts";
import type { FactoryRuntime } from "./runtime.ts";

/**
 * Factory updates posted to the webhooks of virtual projects that offer the factory's tools (`factoryWebhook`), so an
 * assistant such as Grok hears about them without asking. Every machine posts the updates in its own event log: an
 * item added, moved to another phase, or waiting for the maintainer. Only the factory machine drives items, so they
 * happen in its log; a machine the factory left still posts what it had not sent yet. Each URL keeps a cursor in this
 * machine's local state. A failed post is sent again with the same updates after a backoff, so a receiver may see
 * an update twice and dedupes by `node` and `seq`. A URL seen for the first time starts at the newest event, and a
 * removed URL's cursor is forgotten, so setting a webhook never replays the history.
 */

const KINDS = ["item.created", "item.phase", "item.needs-you"];
const BATCH = 50;
const CURSOR = "factory:webhook:";

/** Replaced in tests; a receiver gets 10 seconds to answer. */
export const delivery = {
  post: (url: string, body: string) =>
    fetchHeaders(
      url,
      { method: "POST", headers: { "content-type": "application/json", "user-agent": "agentgate" }, body },
      10_000,
    ),
};

/** A failed URL waits 30 s, doubling to 15 minutes. */
const retryDelay = (failures: number) => Math.min(15 * 60_000, 30_000 * 2 ** (failures - 1));

interface Backoff {
  failures: number;
  nextAt: number;
  error?: string;
}
const backoffs = new WeakMap<FactoryRuntime, Map<string, Backoff>>();

const cursorKey = (url: string) => CURSOR + new Bun.CryptoHasher("sha256").update(url).digest("hex").slice(0, 32);

/** One update as a receiver gets it: the event, and its item as it is now. */
function update(f: FactoryRuntime, row: { seq: number; at: number; item: string | null; kind: string; text: string }) {
  const item = row.item ? items.get(f.s, row.item) : undefined;
  return {
    seq: row.seq,
    at: new Date(row.at).toISOString(),
    kind: row.kind,
    text: row.text,
    ...(item && {
      item: {
        id: item.id,
        key: item.key,
        title: item.title,
        repo: item.repo,
        phase: item.phase,
        ...(item.url && { url: item.url }),
        ...(item.prUrl && { pr: item.prUrl }),
        ...(item.needsYou && { needsYou: { reason: item.needsYou.reason, question: item.needsYou.question } }),
      },
    }),
  };
}

export async function deliver(f: FactoryRuntime) {
  const { s } = f;
  const urls = [
    ...new Set(s.list("project").flatMap((p) => (p.factoryTools && p.factoryWebhook ? [p.factoryWebhook] : []))),
  ];
  const keys = new Map(urls.map((url) => [cursorKey(url), url]));
  for (const { key } of s.db.query("select key from local where key like ?").all(`${CURSOR}%`) as { key: string }[])
    if (!keys.has(key)) s.setLocal(key, undefined);
  let failing = backoffs.get(f);
  if (!failing) backoffs.set(f, (failing = new Map()));
  for (const url of failing.keys()) if (!urls.includes(url)) failing.delete(url);

  for (const [key, url] of keys) {
    const backoff = failing.get(url);
    if (backoff && s.now() < backoff.nextAt) continue;
    const cursor = s.local(key);
    if (cursor === undefined) {
      const newest = s.db.query("select coalesce(max(seq), 0) as seq from factory_events").get() as { seq: number };
      s.setLocal(key, String(newest.seq));
      continue;
    }
    const rows = s.db
      .query(
        `select seq, at, item, kind, text from factory_events where seq > ? and kind in (${KINDS.map(() => "?").join(", ")}) order by seq limit ?`,
      )
      .all(Number(cursor), ...KINDS, BATCH) as {
      seq: number;
      at: number;
      item: string | null;
      kind: string;
      text: string;
    }[];
    if (!rows.length) continue;
    const body = JSON.stringify({
      type: "agentgate.factory.updates",
      node: s.nodeId,
      updates: rows.map((r) => update(f, r)),
    });
    try {
      const response = await delivery.post(url, body);
      await response.body?.cancel().catch(() => {});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      s.setLocal(key, String(rows.at(-1)!.seq));
      failing.delete(url);
    } catch (e) {
      // The URL may carry the receiver's token, and a fetch error can repeat it: log a status or the error's name.
      const error =
        e instanceof Error && /^HTTP \d{3}$/.test(e.message) ? e.message : e instanceof Error ? e.name : "error";
      const failures = (backoff?.failures ?? 0) + 1;
      if (backoff?.error !== error) console.error(`factory: a webhook did not take its updates: ${error}`);
      failing.set(url, { failures, nextAt: s.now() + retryDelay(failures), error });
    }
  }
}

export function setup(f: FactoryRuntime) {
  f.loops.push({ name: "factory-webhooks", everyMs: 10_000, where: "every-node", run: () => deliver(f) });
}
