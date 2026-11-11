import { parseArgs } from "node:util";
import { factoryActionInputSchema, factoryItemInputSchema, itemActions, type ItemAction } from "@agentgate/protocol";
import { z } from "zod";
import {
  actionsOf,
  addItem,
  closeItem,
  endRun,
  finishItem,
  frozenHere,
  moveOn,
  namesFrozen,
  requireFolder,
  resumeRun,
  retryTarget,
  sendToThread,
  stopAsking,
  touched,
} from "./controller.ts";
import { ACTIVE, items, runs, type FactoryItem } from "./db.ts";
import { operation, UsageError, withItem, type FactoryRuntime } from "./runtime.ts";

/**
 * What a person does to an item: add one by hand, and approve, reject, retry or drop one, from the CLI, the app, an
 * agent's tool, a remote endpoint or a comment on its issue (intake.ts). The actions an item takes now are
 * `actionsOf` in controller.ts, which the comment asking the person lists too; `act` refuses any other.
 */

/** The input that names an item. */
export const itemRef = z.object({
  item: z.string().min(1).max(200).describe("The item's key (web-42), id or issue (owner/repo#42)"),
});

/** An item a person or an agent adds. An agent's waits for approval: no label let it in. */
function addManual(
  f: FactoryRuntime,
  { repo, title, body }: z.infer<typeof factoryItemInputSchema>,
  options: { hold?: boolean } = {},
) {
  const folder = requireFolder(f);
  const repos = Object.keys(folder.config.repositories);
  const known = repos.find((r) => r.toLowerCase() === repo.toLowerCase());
  if (!known) throw new Error(`${repo} is not one of the factory's repositories: ${repos.join(", ") || "none"}`);
  const key = `m-${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}`;
  const item = addItem(f, {
    source: "manual",
    repo: known,
    incoming: { externalId: crypto.randomUUID(), key, title, snapshot: { title, ...(body && { body }) } },
    ...(options.hold && { hold: true }),
  });
  if (!options.hold) touched(f, item, "add", "added by hand");
  return item;
}

/** An item by id, key, issue (`owner/repo#42`, `ENG-42`) or issue number (`42`, `#42`). A number two items share is
 * refused, naming both. */
export function findItem(f: FactoryRuntime, ref: string) {
  const { s } = f;
  const exact = items.get(s, ref) ?? items.byKey(s, ref.toLowerCase()) ?? items.byExternal(s, ref);
  if (exact) return exact;
  const lower = ref.toLowerCase();
  const byIssue = items.list(s).filter((i) => i.externalId.toLowerCase() === lower);
  if (byIssue.length === 1) return byIssue[0];
  const number = /^#?(\d+)$/.exec(ref)?.[1];
  if (!number) return undefined;
  const matches = items.list(s).filter((i) => new RegExp(`[#-]${number}$`).test(i.externalId));
  if (matches.length > 1)
    throw new Error(
      `${ref} names ${matches.length} items, ${matches.map((i) => i.key).join(" and ")}; name one by its key`,
    );
  return matches[0];
}

/** approve, reject, retry or drop an item, as one step of it. Returns what happened, for the CLI and API. */
async function itemAction(f: FactoryRuntime, ref: string, action: ItemAction, reason?: string): Promise<string> {
  const found = findItem(f, ref);
  if (!found) throw new Error(`${f.s.nodeId} has no factory item ${ref}`);
  return withItem(f, found.id, () => act(f, found.id, action, reason));
}

/** Why `act` refuses an action the item does not take now. */
function refusal(f: FactoryRuntime, item: FactoryItem, action: ItemAction) {
  if (action === "drop") return `${item.key} is already ${item.phase}`;
  // Any other action would start or wake a thread, which only the factory machine does.
  if (frozenHere(f))
    return `${item.key} is frozen on ${f.s.nodeId} while the factory runs on ${f.pointer()!.node}; move the factory back to go on with it, or drop it`;
  if (action === "retry")
    return item.phase === "shipped"
      ? `${item.key} shipped; there is nothing to retry`
      : `${item.key} has nothing to retry: retry takes an item that failed, went over its budget, stalled, is stuck, was handed off, was stopped or lost its thread`;
  const run = item.needsYou?.run ? runs.get(f.s, item.needsYou.run) : undefined;
  if (item.needsYou?.request !== undefined)
    return `Answer ${item.key}'s question in T3 Code${run?.threadLink ? `: ${run.threadLink}` : ""}`;
  return `${item.key} has nothing to ${action}`;
}

export async function act(f: FactoryRuntime, id: string, action: ItemAction, reason?: string): Promise<string> {
  const { s } = f;
  const item = items.get(s, id)!;
  if (!actionsOf(f, item).some((a) => a.name === action)) throw new Error(refusal(f, item, action));
  const because = reason ? `: ${reason}` : "";

  if (action === "drop") {
    if (frozenHere(f)) {
      // This machine is signed out of T3 Code, so the item's threads are left as they are. And no comment: the issue
      // is the factory machine's to take in again, which a `finished` marker from here would stop.
      for (const run of runs.forItem(s, item.id)) if (ACTIVE.includes(run.state)) endRun(f, run, "cancelled");
      await finishItem(f, item, "closed", {
        interrupt: false,
        reason: `${item.key} was dropped while frozen on ${s.nodeId}${because}`,
        note: true,
      });
      return `Dropped ${item.key}, which was frozen on ${s.nodeId}`;
    }
    await finishItem(f, item, "closed", {
      interrupt: true,
      reason: `Dropped by the maintainer${because}`,
      comment: { text: `The maintainer dropped it${because}.` },
    });
    return `Dropped ${item.key}`;
  }
  if (action === "retry") return item.phase === "closed" ? reopen(f, item) : retryStage(f, item);
  return answer(f, item, action, reason);
}

/**
 * The person's answer to what the item waits for, sent back where it was asked: a start goes ahead or the item closes,
 * a thread's card is answered in T3 Code, and a stage that reported a question or a blocker hears the answer in its own
 * thread and goes on. Approve with no text on a decision goes with the recommendation.
 */
async function answer(f: FactoryRuntime, item: FactoryItem, action: "approve" | "reject", text?: string) {
  const { s } = f;
  const approve = action === "approve";
  const because = text ? `: ${text}` : "";
  const wait = item.needsYou!;
  const run = wait.run ? runs.get(s, wait.run) : undefined;

  if (wait.kind === "start") {
    const held = item.phase === "held";
    const stage = held ? "triage" : (run?.kind ?? item.phase);
    if (!approve) {
      await closeItem(f, item, `The maintainer rejected it${because}.`);
      touched(f, item, "reject", held ? "rejected while held" : `rejected before ${stage}`);
      return `Rejected ${item.key}`;
    }
    if (held) {
      moveOn(f, item, "triage", { approved: true, clearWait: true });
      touched(f, item, "approve", "approved to start");
      return `Approved ${item.key}; triage is queued`;
    }
    // Its run is queued, and dispatch starts it once the wait is gone.
    stopAsking(f, item.id);
    touched(f, item, "approve", `approved to start ${stage}`);
    return `Approved ${item.key}; ${stage} starts`;
  }

  if (!run) throw new Error(`${item.key} has nothing to ${action}`);
  if (wait.request !== undefined) {
    await f.runKinds.get(run.kind)!.answer!(run, { approve, ...(text && { reason: text }) });
    // Answered here, so T3 showing the request again, or the thread going on, is not a second answer.
    runs.update(s, run.id, { answered: wait.request });
    stopAsking(f, item.id);
    touched(f, item, action, `${approve ? "approved" : "rejected"} what the ${run.kind} thread asked`);
    return `${approve ? "Approved" : "Rejected"} for ${item.key}`;
  }

  const reply = approve
    ? `The maintainer answered: ${text ?? (wait.recommendation ? "go with your recommendation" : "it is resolved")}.`
    : `The maintainer rejected your recommendation${because}.`;
  // Sent first: a send that fails, or a restart before it answers, leaves the run reported and the question open.
  await sendToThread(f, run, `${reply} Continue the ${run.kind} stage, then report again with \`factory_report\`.`);
  if (resumeRun(f, run))
    f.events.emit({
      kind: "run.resumed",
      run: run.id,
      item: item.id,
      text: `${item.key}'s ${run.kind} goes on with the maintainer's answer`,
    });
  stopAsking(f, item.id);
  touched(f, item, action, `answered the ${run.kind} thread's ${wait.recommendation ? "question" : "blocker"}`);
  return `Sent the answer to ${item.key}'s ${run.kind} thread`;
}

/** A finished item taken in again at triage. It is a new pass, whose moments post again. */
function reopen(f: FactoryRuntime, item: FactoryItem) {
  const { s } = f;
  s.db.run("delete from factory_writebacks where item=?", [item.id]);
  // The PR of the pass before is done with; this pass opens its own.
  items.update(s, item.id, { pr: undefined });
  moveOn(f, item, "triage", { approved: true, clearWait: true, moment: "taken" });
  touched(f, item, "retry", "taken in again after it finished");
  return `Retrying triage for ${item.key}`;
}

/** An item that stopped goes on (`retryTarget`). What is still queued for it, such as a launch that kept failing,
 * ends first. */
function retryStage(f: FactoryRuntime, item: FactoryItem) {
  const { s } = f;
  for (const run of runs.forItem(s, item.id))
    if (run.state === "queued" || run.state === "starting") endRun(f, run, "cancelled", { error: "retried" });
  stopAsking(f, item.id);
  const target = retryTarget(f, item);
  if ("pr" in target) {
    // The PR follower takes it from here: it nudges the PR's thread again and reviews the PR as before.
    items.update(s, item.id, { pr: { ...item.pr!, nudges: 0 } });
    touched(f, item, "retry", "retried with its PR");
    return `Retrying ${item.key} with its PR`;
  }
  const { kind } = target;
  // The item leaves its PR phase while the new implement thread takes the PR over, so the follower waits for its report.
  moveOn(f, item, kind, { approved: true });
  touched(f, item, "retry", `retried ${kind}`);
  return item.pr ? `Retrying implement for ${item.key}, taking its PR over` : `Retrying ${kind} for ${item.key}`;
}

/** What each item action does, for `agentgate factory help` and for an assistant on a remote endpoint. */
const ACTION_HELP: Record<ItemAction, { summary: string; remote: string }> = {
  approve: {
    summary: "start a held item, take what a stage recommends, approve a spec, or say what changed for a blocked item",
    remote:
      "Approve an item that waits for the maintainer: start a held item's stage, take a stage's recommendation (or give your answer as reason), approve a spec, or say what changed for a blocked item.",
  },
  reject: {
    summary: "turn a held item away, refuse a recommendation, or ask for spec changes",
    remote:
      "Reject an item that waits for the maintainer: turn a held item away, refuse a stage's recommendation, or ask for spec changes with reason as the feedback.",
  },
  retry: {
    summary:
      "take an item that stopped (failed, stalled, stuck, over budget, stopped) back to work, or start a closed one again",
    remote:
      "Take an item that stopped back to work (it failed, went over its token budget, stalled, got stuck, was stopped or handed off, or lost its thread), or start a closed item again at triage.",
  },
  drop: {
    summary: "stop an item's threads and close it; its PR stays open",
    remote: "Stop an item's threads and close it with a comment. Its PR, if it has one, stays open.",
  },
};

export function setup(f: FactoryRuntime): void {
  operation(f, {
    name: "add",
    summary: "add an item by hand; triage starts at once",
    input: factoryItemInputSchema,
    // An agent's item waits for approval; a person's, and a remote endpoint's the maintainer gave control, do not.
    run: async (input, caller) => {
      const item = addManual(f, input, { hold: caller.via === "tool" });
      return { id: item.id, key: item.key, repo: item.repo, phase: item.phase };
    },
    terminal: {
      usage: "add <owner/repo> <title> [--body <text>] [--json]",
      parse(args) {
        const { values, positionals } = parseArgs({
          args,
          options: { body: { type: "string" }, json: { type: "boolean" } },
          allowPositionals: true,
        });
        if (positionals.length !== 2) throw new UsageError();
        const { json, ...rest } = values;
        return { input: { repo: positionals[0], title: positionals[1], ...rest }, json };
      },
      print: (item, { json }) => [
        json
          ? JSON.stringify({ id: item.id, key: item.key })
          : `Added ${item.key} (${item.id}) to ${item.repo}: ${item.phase === "held" ? "held for approval" : "triage is queued"}`,
      ],
    },
    tool: {
      name: "factory_add",
      description:
        "Add an item to the software factory. It waits until the maintainer approves it, then is triaged in T3 Code like an issue from a source.",
      result(item) {
        const url = f.s.get("node", f.pointer()?.node ?? f.s.nodeId)?.url;
        return { item: item.id, key: item.key, ...(url && { link: `${url.replace(/\/$/, "")}/factory` }) };
      },
    },
    remote: {
      description:
        "Add a task for the factory in one of its repositories (factory__status lists them). It is triaged in a T3 Code thread like a labelled issue, then fixed or specced up to a pull request for the maintainer to merge.",
    },
  });

  for (const action of itemActions)
    operation(f, {
      name: action,
      summary: ACTION_HELP[action].summary,
      input: itemRef.extend(factoryActionInputSchema.shape),
      here: ({ item }) => namesFrozen(f, item),
      run: async ({ item, reason }) => ({ message: await itemAction(f, item, action, reason) }),
      terminal: {
        usage: `${action} <item> [--reason <text>]`,
        parse(args) {
          const { values, positionals } = parseArgs({
            args,
            options: { reason: { type: "string" } },
            allowPositionals: true,
          });
          if (positionals.length !== 1) throw new UsageError();
          return { input: { item: positionals[0], ...(values.reason && { reason: values.reason }) } };
        },
        print: ({ message }) => [message],
      },
      remote: { description: ACTION_HELP[action].remote, result: ({ message }) => message },
    });
}
