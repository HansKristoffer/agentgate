import type { FactoryRuntime, PostResult } from "./runtime.ts";
import { later, shortError } from "./runtime.ts";
import { currentFolder } from "./config.ts";
import { adapterOf } from "./controller.ts";
import { items } from "./db.ts";
import { createIssue, replyToConversation } from "./gh.ts";
import { defuse } from "./markers.ts";

/**
 * The outbox: every write to GitHub or Linear whose outcome can be uncertain (a comment on an item's issue, a reply in a
 * review conversation, an issue the factory files) goes through one claim. A write is claimed with its body, once per
 * item, moment and `ref`, in the step that decides it, and sent after that step:
 *
 * - `pending` is sent, by the step after the claim or by the loop: it was never attempted, or the service refused
 *   it, which wrote nothing, fewer than three times;
 * - `sending` was attempted, and a restart then leaves it as `uncertain`;
 * - `unreachable` certainly never reached the service (`gh` is logged out, the machine is offline), so the loop
 *   sends it again until it goes through, however many passes that takes;
 * - `uncertain` (the request may have been applied) is never sent again;
 * - `failed` is given up on: refused three times, or still unreachable a day after it was claimed.
 *
 * Writes that are safe to repeat, such as resolving a conversation or rewriting the PR body, do not need a claim.
 */

/** "reply": `ref` is `<conversation id>@<commit>`. "issue": a new issue (`fileIssue`), its body the JSON of repo,
 * title and text. Any other moment is a comment on the item's source. */
export type WriteMoment = string;

/** How many refusals end a write. */
const REFUSALS = 3;
/** How long after its claim an unreachable write is still sent: past a day, its moment has passed. */
const GIVE_UP = 86_400_000;
const EVERY = 2 * 60_000;

/** The writes this daemon is sending now, by item, moment and ref. */
const inFlight = new WeakMap<FactoryRuntime, Set<string>>();
const flying = (f: FactoryRuntime) => {
  let set = inFlight.get(f);
  if (!set) inFlight.set(f, (set = new Set()));
  return set;
};

/** Claims a write; false when this item, moment and `ref` already has one. The send follows the current step. */
export function claimWrite(
  f: FactoryRuntime,
  item: string,
  moment: WriteMoment,
  ref: string,
  body: string,
  what: string,
) {
  const claimed = f.s.db.run(
    "insert or ignore into factory_writebacks (item, moment, ref, status, body, what, claimed, at) values (?, ?, ?, 'pending', ?, ?, ?, ?)",
    [item, moment, ref, body, what, f.s.now(), f.s.now()],
  );
  if (!claimed.changes) return false;
  later(f, item, what, () => sendWrite(f, item, moment, ref));
  return true;
}

interface Row {
  status: string;
  body: string;
  what: string;
  refusals: number;
  claimed: number;
}

/** The statuses the loop sends. */
const UNSENT = ["pending", "unreachable"];

/** Sends an unsent write as a step of its item. */
async function sendWrite(f: FactoryRuntime, item: string, moment: WriteMoment, ref: string) {
  const { s } = f;
  const key = [item, moment, ref];
  const row = s.db
    .query("select status, body, what, refusals, claimed from factory_writebacks where item=? and moment=? and ref=?")
    .get(...key) as Row | null;
  if (!row || !UNSENT.includes(row.status)) return;
  s.db.run("update factory_writebacks set status='sending' where item=? and moment=? and ref=?", key);
  const id = JSON.stringify(key);
  flying(f).add(id);
  const result = await deliver(f, item, moment, ref, row.body)
    .catch((e): PostResult => ({ status: "uncertain", error: shortError(e) }))
    .finally(() => flying(f).delete(id));
  // A refusal wrote nothing, so the write goes back to pending until the service has refused it REFUSALS times. One
  // that never arrived stays unreachable, for the loop to send, until its claim is GIVE_UP old.
  const refusals = row.refusals + (result.status === "failed" ? 1 : 0);
  const expired = result.status === "unreachable" && s.now() - row.claimed >= GIVE_UP;
  const again = result.status === "failed" ? refusals < REFUSALS : result.status === "unreachable" && !expired;
  const status = expired ? "failed" : result.status === "failed" && again ? "pending" : result.status;
  s.db.run("update factory_writebacks set status=?, refusals=?, at=? where item=? and moment=? and ref=?", [
    status,
    refusals,
    s.now(),
    ...key,
  ]);
  // The loop sends an unreachable write every pass: its history says so when that starts, not each time.
  if (status === "unreachable" && row.status === "unreachable") return;
  f.events.emit({
    kind: "writeback",
    item,
    moment,
    status: result.status,
    text: `${row.what}: ${result.status}${result.error ? ` (${result.error})` : ""}${
      again ? "; it is tried again" : expired ? "; a day after it was claimed, it is given up" : ""
    }`,
  });
}

async function deliver(f: FactoryRuntime, id: string, moment: WriteMoment, ref: string, body: string) {
  if (moment === "reply") return replyToConversation(ref.slice(0, ref.lastIndexOf("@")), body);
  if (moment === "issue") {
    const issue = JSON.parse(body) as SuggestedIssue;
    return createIssue(issue.repo, issue.title, issue.body);
  }
  const item = items.get(f.s, id);
  const post = item && adapterOf(f, item)?.post;
  if (!item || !post) return { status: "failed", error: "its source no longer takes comments" } satisfies PostResult;
  return post(item, body);
}

export interface SuggestedIssue {
  repo: string;
  title: string;
  body: string;
}

/** The line that tells a person how to have the factory work an issue it filed in `repo`: a GitHub source's label. */
function labelHint(f: FactoryRuntime, repo: string) {
  const source = currentFolder(f)?.config.sources.find(
    (s) => s.type === "github" && s.repo.toLowerCase() === repo.toLowerCase(),
  );
  return source?.type === "github"
    ? `Add the label \`${source.label}\` to have the factory work it.`
    : "No factory source takes this repository's issues by label, so it waits for a person.";
}

/**
 * Claims an issue for work the factory found but leaves alone, filed without a source's label: labelling it is the
 * maintainer's approval, through the same gate as any other issue. Once per item and `ref`, like any claimed write.
 */
export function fileIssue(f: FactoryRuntime, item: string, ref: string, issue: SuggestedIssue, why: string) {
  const title = defuse(issue.title.split("\n")[0]!.trim(), 200);
  const body = [
    defuse(issue.body, 6000),
    defuse(why, 1000),
    `Filed by AgentGate's software factory. ${labelHint(f, issue.repo)}`,
  ].join("\n\n");
  return claimWrite(
    f,
    item,
    "issue",
    ref,
    JSON.stringify({ repo: issue.repo, title, body }),
    `The issue "${title.slice(0, 80)}" on ${issue.repo}`,
  );
}

/** Sends what a restart left pending, and again what a service refused or never received. */
function drain(f: FactoryRuntime) {
  const rows = f.s.db
    .query("select item, moment, ref from factory_writebacks where status in ('pending', 'unreachable')")
    .all() as {
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
    where: "factory-node",
    run: async () => {
      if (!started) settleInterrupted(f);
      started = true;
      drain(f);
    },
  });
}
