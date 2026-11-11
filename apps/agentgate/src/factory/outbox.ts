import { createHash } from "node:crypto";
import type { FactoryReport, MarkerPayload, Moment, StageName } from "@agentgate/protocol";
import { later, shortError, type FactoryRuntime, type PostResult, type SourceAdapter } from "./runtime.ts";
import { currentFolder, folderFor } from "./config.ts";
import { isStage, items, type FactoryItem } from "./db.ts";
import { createIssue, replyToConversation } from "./gh.ts";
import { defuse, renderComment } from "./markers.ts";

/**
 * The outbox: every write to GitHub or Linear whose outcome can be uncertain (a comment on an item's issue, a reply in a
 * review conversation, an issue the factory files) goes through one claim. A write is claimed with its body, once per
 * item, moment and `ref`, in the step that decides it, and sent after that step:
 *
 * - `pending` is sent, by the step after the claim or by the loop: it was never attempted, the service's rate limit
 *   turned it away, or the service refused it fewer than three times. None of those wrote anything;
 * - `sending` was attempted, and a restart then leaves it as `uncertain`;
 * - `unreachable` certainly never reached the service (`gh` is logged out, the machine is offline), so the loop
 *   sends it again until it goes through, however many passes that takes;
 * - `uncertain` (the request may have been applied) is never sent again;
 * - `failed` is given up on: refused three times, or still unreachable a day after it was claimed.
 *
 * Writes that are safe to repeat, such as resolving a conversation or rewriting the PR body, do not need a claim.
 */

/** The stage a moment's marker names, when not the phase the item is in. */
const MOMENT_STAGE: Partial<Record<Moment, StageName>> = {
  triaged: "triage",
  "spec-approved": "spec",
  "pr-opened": "implement",
  ready: "review",
};

function sourceOf(f: FactoryRuntime, item: Pick<FactoryItem, "source" | "configCommit">) {
  return folderFor(f, item.configCommit)?.config.sources.find((x) => x.id === item.source);
}
/** The adapter of the source the item came from, as the folder it started under names it. */
export function adapterOf(f: FactoryRuntime, item: FactoryItem): SourceAdapter | undefined {
  const type = item.source === "manual" ? "manual" : sourceOf(f, item)?.type;
  return type ? f.sources.get(type) : undefined;
}

/** A `waiting` comment's `ref`: one comment per question a run asks. */
export const questionRef = (run: string, question: string) =>
  `${run}:${createHash("sha256").update(question).digest("hex").slice(0, 12)}`;

/**
 * The comment for a moment, claimed in the outbox now and posted after the current step of the item: at
 * most once per item, moment and `ref`, and never again once its outcome is uncertain. A source with nothing to post
 * to skips it.
 */
export function writeBack(
  f: FactoryRuntime,
  item: FactoryItem,
  moment: Moment,
  input: { report?: FactoryReport; text?: string; commit?: string; ref?: string } = {},
): void {
  const { s } = f;
  const adapter = adapterOf(f, item);
  if (!adapter?.post) return;
  const ref = input.ref ?? "";
  const { report } = input;
  const stage = moment === "taken" ? null : (MOMENT_STAGE[moment] ?? (isStage(item.phase) ? item.phase : null));
  const marker: MarkerPayload = {
    item: item.id,
    key: item.key,
    stage,
    outcome: report?.outcome ?? null,
    route: report?.result?.kind === "triage" ? report.result.route : null,
    commit: input.commit ?? null,
    factory: item.configCommit.slice(0, 7),
    node: s.nodeId,
    state: moment === "shipped" || moment === "closed" ? "finished" : "open",
    pr: item.pr?.url ?? null,
  };
  const body = renderComment(moment, item, {
    ...(report?.summary && { summary: report.summary }),
    ...(input.text && { extra: input.text }),
    marker,
  });
  claimWrite(f, item.id, moment, ref, body, `The ${moment} comment on ${item.key}`);
}

/** "reply": `ref` is `<conversation id>@<commit>`. "issue": a new issue (`fileIssue`), its body the JSON of repo,
 * title and text. Any other moment is a comment on the item's source. */
export type WriteMoment = string;

/** How many refusals end a write. */
const REFUSALS = 3;
/** How long after its claim an unreachable write is still sent: past a day, its moment has passed. */
const GIVE_UP = 86_400_000;
const EVERY = 2 * 60_000;

/** The writes this daemon is sending now, by item, moment and ref. */
const flying = (f: FactoryRuntime) => f.memory("writes in flight", () => new Set<string>());

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
  f.s.bump("factory");
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
  s.bump("factory");
  const id = JSON.stringify(key);
  flying(f).add(id);
  const result = await deliver(f, item, moment, ref, row.body)
    .catch((e): PostResult => ({ status: "uncertain", error: shortError(e) }))
    .finally(() => flying(f).delete(id));
  // A refusal wrote nothing, so the write goes back to pending until the service has refused it REFUSALS times; one a
  // rate limit turned away goes back to pending without counting. One that never arrived stays unreachable, for the
  // loop to send, until its claim is GIVE_UP old.
  const refused = result.status === "failed";
  const refusals = row.refusals + (refused ? 1 : 0);
  const unreachable = result.status === "unreachable";
  const expired = unreachable && s.now() - row.claimed >= GIVE_UP;
  const again = result.status === "limited" || (refused && refusals < REFUSALS) || (unreachable && !expired);
  const status = expired ? "failed" : again && !unreachable ? "pending" : result.status;
  s.db.run("update factory_writebacks set status=?, refusals=?, at=? where item=? and moment=? and ref=?", [
    status,
    refusals,
    s.now(),
    ...key,
  ]);
  s.bump("factory");
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
