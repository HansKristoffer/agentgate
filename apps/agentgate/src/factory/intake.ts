import type { MarkerPayload, NeedsYou } from "@agentgate/protocol";
import { act } from "./actions.ts";
import { currentFolder, durationMs, limits } from "./config.ts";
import { addItem, holdsNewItems, intakeState } from "./controller.ts";
import { items, type FactoryItem } from "./db.ts";
import { adapterOf, questionRef } from "./outbox.ts";
import { Backoff, shortError, withItem, type FactoryRuntime, type IncomingItem } from "./runtime.ts";

/**
 * Intake: what the sources list becomes items. The intake loop polls each source, backing off one that fails, and reads
 * the answers people gave on their issues; webhook deliveries and scouts' findings come in through `admit`.
 */

interface Poll {
  lastPollAt?: number;
  error?: string;
  /** Why the last poll left issues out, shown as the row's error. */
  capped?: string;
  /** Each listed issue's newest factory marker as last read, kept while the issue's `updatedAt` stays the same. */
  markers: Map<string, { updatedAt: string; marker: MarkerPayload | undefined }>;
}
/** Per source, its last poll, which the board shows; and when one that failed is polled again. */
const memory = (f: FactoryRuntime) =>
  f.memory("intake", () => ({
    polls: new Map<string, Poll>(),
    backoff: new Backoff(f.s, { baseMs: 2 * 60_000, maxMs: 3600_000 }),
  }));

/** The most of one source's items that wait for approval before it takes no more: a webhook URL that leaked, or a
 * noisy scout, could otherwise fill the board and pause every other source's intake. */
export const HELD_LIMIT = 20;

/**
 * Admission for what arrives outside a poll, a webhook delivery or a scout's finding: one with the dedupe key of the
 * source's item that is open, or finished within `dedupeWindow`, is a duplicate; it waits for approval when its source
 * holds items or intake is not on (paused, or too many items wait for the maintainer); and a source that already holds
 * `HELD_LIMIT` items takes no more.
 */
export function admit(f: FactoryRuntime, input: Admission & { repo: string; incoming: IncomingItem }) {
  const decided = admission(f, { ...input, dedupe: input.incoming.dedupe });
  if (typeof decided === "string") return decided;
  return addItem(f, { source: input.source, repo: input.repo, incoming: input.incoming, hold: decided.hold });
}

interface Admission {
  source: string;
  intake: "auto" | "hold";
  dedupeWindow: string;
}

/** What `admit` would do, writing nothing: also what `factory source test` says of a sample delivery. */
export function admission(
  f: FactoryRuntime,
  input: Admission & { dedupe?: string },
): "duplicate" | "full" | { hold: boolean } {
  const since = f.s.now() - durationMs(input.dedupeWindow);
  if (input.dedupe && items.hasDedupe(f.s, input.source, input.dedupe, since)) return "duplicate";
  const hold = holdsNewItems(f, input.intake) || intakeState(f) !== "on";
  if (hold && items.heldCount(f.s, input.source) >= HELD_LIMIT) return "full";
  return { hold };
}

/**
 * One intake pass for one source now; it adds nothing while intake is not on. An issue is left out only when its newest
 * factory marker says `finished`, here before the trim or on another machine. An `open` marker keeps nothing away: only
 * the factory machine drives items, so an open marker on an issue this machine has no item for belongs to an item that
 * is frozen on a machine the factory left, or was lost with its tables, and the issue is taken in again from triage. A
 * marker is read again only when its issue changed.
 */
export async function pollSource(f: FactoryRuntime, sourceId: string): Promise<void> {
  const { s } = f;
  const source = currentFolder(f)?.config.sources.find((x) => x.id === sourceId);
  if (!source) throw new Error(`The factory has no source ${sourceId}`);
  const adapter = f.sources.get(source.type);
  if (!adapter?.poll) return;
  const { polls, backoff } = memory(f);
  const st: Poll = polls.get(source.id) ?? { markers: new Map() };
  polls.set(source.id, st);
  try {
    const markers: typeof st.markers = new Map();
    const polled = await adapter.poll(source);
    st.capped = polled.capped;
    for (const incoming of polled.items) {
      if (items.byExternal(s, incoming.externalId)) continue;
      const cached = st.markers.get(incoming.externalId);
      const marker =
        incoming.updatedAt && cached?.updatedAt === incoming.updatedAt
          ? cached.marker
          : (
              await adapter.check?.({ source: source.id, externalId: incoming.externalId, repo: source.repo })
            )?.markers.at(-1);
      if (incoming.updatedAt) markers.set(incoming.externalId, { updatedAt: incoming.updatedAt, marker });
      // Intake is asked after the read: the item before, a pause or a move may have ended it meanwhile.
      if (marker?.state === "finished" || intakeState(f) !== "on") continue;
      addItem(f, { source: source.id, repo: source.repo, incoming, hold: holdsNewItems(f, source.intake) });
    }
    st.markers = markers;
    if (backoff.ok(source.id)) console.log(`factory: the source ${source.id} works again`);
    Object.assign(st, { lastPollAt: s.now(), error: undefined });
  } catch (e) {
    const error = shortError(e);
    if (st.error !== error) console.error(`factory: the source ${source.id} failed: ${error}`);
    st.error = error;
    backoff.failed(source.id);
  }
  // The board shows each source's last poll and error, which live only in memory.
  s.bump("factory");
}

/** Every source's poll. Paused for the maintainer (too many items wait), it still reads each source, so its row on the
 * board stays current, and adds nothing; paused by the maintainer, or waiting to move, it reads nothing. */
async function intake(f: FactoryRuntime) {
  const folder = currentFolder(f);
  if (!folder) return;
  // An answer is the person's action, like one from the CLI, so it is read while intake is off too.
  await readAnswers(f);
  if (intakeState(f) === "off") return;
  for (const source of folder.config.sources) if (memory(f).backoff.due(source.id)) await pollSource(f, source.id);
}

/** The newest issue comment `readAnswers` used for each item, so no comment is used twice. */
const ANSWER_SEEN = "factory:answer-seen:";

/** An issue comment as an answer: `/approve` or `/reject`, each with optional text, or free text, which answers
 * only a question (it goes to the thread as the answer). */
function issueAnswer(body: string, kind: NeedsYou["kind"]) {
  const text = body.trim();
  const command = /^\/(approve|reject)\b([\s\S]*)$/.exec(text);
  if (command)
    return { action: command[1] as "approve" | "reject", ...(command[2]!.trim() && { text: command[2]!.trim() }) };
  return kind === "answer" && text ? { action: "approve" as const, text } : undefined;
}

/** Whether the item's question is on its issue: its `waiting` comment was posted, so a later comment can answer it. */
const askedOnIssue = (f: FactoryRuntime, item: FactoryItem, wait: NeedsYou) =>
  (
    f.s.db
      .query("select status from factory_writebacks where item=? and moment='waiting' and ref=?")
      .get(item.id, questionRef(wait.run ?? wait.cause, wait.question)) as { status: string } | null
  )?.status === "posted";

/**
 * Answers given on the issue (N3): for each item that waits for a start or an answer, at most
 * `limits.waitingForYou` per pass and one issue read each, the trusted comments after the factory's newest one. The
 * first that reads as an answer is taken as if the person had typed it in the CLI, so the next comment the factory
 * posts is the acknowledgement. A comment is used at most once, even when the answer is refused.
 */
async function readAnswers(f: FactoryRuntime) {
  const waiting = items
    .list(f.s, { open: true })
    .filter((i) => i.needsYou?.kind === "start" || (i.needsYou?.kind === "answer" && askedOnIssue(f, i, i.needsYou)))
    .slice(0, limits(f).waitingForYou);
  for (const item of waiting) {
    const replies = adapterOf(f, item)?.replies;
    if (!replies) continue;
    const seen = ANSWER_SEEN + item.id;
    let found: Awaited<ReturnType<typeof replies>>;
    try {
      found = await replies(item, f.s.local(seen));
    } catch (e) {
      f.events.emit({
        kind: "note",
        item: item.id,
        text: `Reading answers on ${item.key}'s issue failed: ${shortError(e)}`,
      });
      continue;
    }
    for (const reply of found) {
      f.s.setLocal(seen, reply.id);
      const answer = issueAnswer(reply.body, item.needsYou!.kind);
      if (!answer) continue;
      await withItem(f, item.id, async () => {
        // Answered another way since the list was read.
        if (items.get(f.s, item.id)?.needsYou?.since !== item.needsYou!.since) return;
        const done = await act(f, item.id, answer.action, answer.text);
        f.events.emit({ kind: "note", item: item.id, text: `${done}, from a comment on its issue` });
      }).catch((e) =>
        f.events.emit({
          kind: "note",
          item: item.id,
          text: `The answer on ${item.key}'s issue was not taken: ${shortError(e)}`,
        }),
      );
      break;
    }
  }
}

export function setup(f: FactoryRuntime): void {
  f.loops.push({ name: "factory-intake", everyMs: 2 * 60_000, where: "factory-node", run: () => intake(f) });
  // Each source's row on the board; the webhook feature merges its part into it later.
  f.boardParts.push(async () => ({
    sources: (currentFolder(f)?.config.sources ?? []).map((source) => {
      const st = memory(f).polls.get(source.id);
      const error = st?.error ?? st?.capped;
      return {
        id: source.id,
        type: source.type,
        repo: source.repo,
        ...(st?.lastPollAt && { lastPollAt: st.lastPollAt }),
        ...(error && { error }),
      };
    }),
  }));
}
