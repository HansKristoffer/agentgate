import type { FactoryRuntime, PostResult } from "./runtime.ts";
import { later, shortError } from "./runtime.ts";
import { adapterOf } from "./controller.ts";
import { items } from "./db.ts";
import { postIssueComment, replyToConversation } from "./gh.ts";

/**
 * The outbox: every write to GitHub or Linear whose outcome can be uncertain (a comment on an item's issue, a reply in a
 * review conversation, the note on a flawed learning PR) goes through one claim. A write is claimed with its body,
 * once per owner, moment and `ref`, in the step that decides it, and sent after that step:
 *
 * - `pending` was never attempted, so it is sent, by the step after the claim or by the loop after a restart;
 * - `sending` was attempted, and a restart then leaves it as `uncertain`;
 * - `uncertain` (the request may have been applied) is never sent again;
 * - `failed` (the service refused it, so nothing was written) goes back to `pending` until three attempts failed.
 *
 * Writes that are safe to repeat, such as resolving a conversation or rewriting the PR body, do not need a claim.
 */

/** "reply": `ref` is `<conversation id>@<commit>`. "learn": the owner is the learn run and `ref` its PR's number. Any
 * other moment is a comment on the owning item's source. */
export type WriteMoment = string;

const ATTEMPTS = 3;
const EVERY = 2 * 60_000;

/** The writes this daemon is sending now, by owner, moment and ref. */
const inFlight = new WeakMap<FactoryRuntime, Set<string>>();
const flying = (f: FactoryRuntime) => {
  let set = inFlight.get(f);
  if (!set) inFlight.set(f, (set = new Set()));
  return set;
};

/** Claims a write; false when this owner, moment and `ref` already has one. The send follows the current step. */
export function claimWrite(
  f: FactoryRuntime,
  owner: string,
  moment: WriteMoment,
  ref: string,
  body: string,
  what: string,
) {
  const claimed = f.s.db.run(
    "insert or ignore into factory_writebacks (item, moment, ref, status, body, what, at) values (?, ?, ?, 'pending', ?, ?, ?)",
    [owner, moment, ref, body, what, f.s.now()],
  );
  if (!claimed.changes) return false;
  later(f, owner, what, () => sendWrite(f, owner, moment, ref));
  return true;
}

interface Row {
  status: string;
  body: string;
  what: string;
  attempts: number;
}

/** Sends a pending write as a step of its owner. */
async function sendWrite(f: FactoryRuntime, owner: string, moment: WriteMoment, ref: string) {
  const { s } = f;
  const key = [owner, moment, ref];
  const row = s.db
    .query("select status, body, what, attempts from factory_writebacks where item=? and moment=? and ref=?")
    .get(...key) as Row | null;
  if (row?.status !== "pending") return;
  s.db.run(
    "update factory_writebacks set status='sending', attempts=attempts+1 where item=? and moment=? and ref=?",
    key,
  );
  const id = JSON.stringify(key);
  flying(f).add(id);
  const result = await deliver(f, owner, moment, ref, row.body)
    .catch((e): PostResult => ({ status: "uncertain", error: shortError(e) }))
    .finally(() => flying(f).delete(id));
  const retry = result.status === "failed" && row.attempts + 1 < ATTEMPTS;
  s.db.run("update factory_writebacks set status=?, at=? where item=? and moment=? and ref=?", [
    retry ? "pending" : result.status,
    s.now(),
    ...key,
  ]);
  const item = items.get(s, owner);
  f.events.emit({
    kind: "writeback",
    ...(item ? { item: owner } : { run: owner }),
    moment,
    status: result.status,
    text: `${row.what}: ${result.status}${result.error ? ` (${result.error})` : ""}${retry ? "; it is tried again" : ""}`,
  });
}

async function deliver(f: FactoryRuntime, owner: string, moment: WriteMoment, ref: string, body: string) {
  if (moment === "reply") return replyToConversation(ref.slice(0, ref.lastIndexOf("@")), body);
  if (moment === "learn") {
    const repo = f.pointer()?.repo;
    return repo
      ? postIssueComment(repo, Number(ref), body)
      : ({ status: "failed", error: "the factory is off" } satisfies PostResult);
  }
  const item = items.get(f.s, owner);
  const post = item && adapterOf(f, item)?.post;
  if (!item || !post) return { status: "failed", error: "its source no longer takes comments" } satisfies PostResult;
  return post(item, body);
}

/** Sends what a restart left pending, and retries what a service refused. */
function drain(f: FactoryRuntime) {
  const rows = f.s.db.query("select item, moment, ref from factory_writebacks where status='pending'").all() as {
    item: string;
    moment: string;
    ref: string;
  }[];
  for (const row of rows) later(f, row.item, "Sending a write", () => sendWrite(f, row.item, row.moment, row.ref));
}

/** A send a restart cut off may have reached the service: it is uncertain, and never sent again. */
function settleInterrupted(f: FactoryRuntime) {
  const rows = f.s.db.query("select item, moment, ref from factory_writebacks where status='sending'").all() as {
    item: string;
    moment: string;
    ref: string;
  }[];
  for (const { item, moment, ref } of rows)
    if (!flying(f).has(JSON.stringify([item, moment, ref])))
      f.s.db.run("update factory_writebacks set status='uncertain' where item=? and moment=? and ref=?", [
        item,
        moment,
        ref,
      ]);
}

export function setup(f: FactoryRuntime): void {
  let started = false;
  f.loops.push({
    name: "factory-outbox",
    everyMs: EVERY,
    where: "every-node",
    run: async () => {
      if (!started) settleInterrupted(f);
      started = true;
      drain(f);
    },
  });
}
