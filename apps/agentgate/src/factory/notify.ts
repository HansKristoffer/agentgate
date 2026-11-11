import { createHash } from "node:crypto";
import { z } from "zod";
import { webhookUrl } from "../operations.ts";
import { fetchHeaders } from "../runtime.ts";
import { runs, items, type FactoryItem } from "./db.ts";
import { claimWrite } from "./outbox.ts";
import { deleteSecret, getSecret, setSecret } from "./secrets.ts";
import { operation, SayOnce, shortError, UsageError, type FactoryRuntime, type PostResult } from "./runtime.ts";
import { t3Mcp } from "./t3-mcp.ts";

/**
 * Telling the person, the one place the factory reaches out from. Two moments are told: an item starts waiting for the
 * person (`ask` in controller.ts emits `item.needs-you`), and an item's PR is ready (`item.phase` to `ready`). Each goes
 * to every outlet, a post through the outbox so a failed one is sent again: the person's own notify URL, the webhook of each virtual project that offers the factory's tools
 * (`factoryWebhook`), and, for a question a run's thread asks, that thread marked unread in T3 Code. GitHub cannot be
 * one: the factory comments as the maintainer's own login (D42), and GitHub never notifies you of your own comments.
 * Only the factory machine drives items, so only it has these moments to tell.
 */

/** The person's notify URL, set once for every machine. A synced secret, not a setting: a webhook URL carries its
 * receiver's token, so it syncs only encrypted, stays out of `export --no-secrets`, and only its host is shown. */
const NOTIFY = "~notify";
export const notifyUrl = (f: FactoryRuntime) => getSecret(f.s, NOTIFY);

/** Replaced in tests; a receiver gets 10 seconds to answer. */
export const delivery = {
  post: (url: string, body: string) =>
    fetchHeaders(
      url,
      { method: "POST", headers: { "content-type": "application/json", "user-agent": "agentgate" }, body },
      10_000,
    ),
};

/** The question, or the rest of a line, cut short for a chat message. */
const cap = (text: string, max = 500) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The item as a receiver gets it. */
function itemUpdate(item: FactoryItem) {
  return {
    id: item.id,
    key: item.key,
    title: item.title,
    repo: item.repo,
    phase: item.phase,
    ...(item.url && { url: item.url }),
    ...(item.pr && { pr: item.pr.url }),
    ...(item.needsYou && {
      needsYou: {
        kind: item.needsYou.kind,
        cause: item.needsYou.cause,
        question: item.needsYou.question,
        ...(item.needsYou.recommendation && { recommendation: item.needsYou.recommendation }),
        ...(item.needsYou.options && { options: item.needsYou.options }),
      },
    }),
  };
}

/** Every URL a moment is posted to: the person's own and the factory endpoints'. */
function urls(f: FactoryRuntime) {
  const endpoints = f.s.list("project").flatMap((p) => (p.factoryTools && p.factoryWebhook ? [p.factoryWebhook] : []));
  return [...new Set([notifyUrl(f), ...endpoints].filter((u): u is string => !!u))];
}

/** A URL as the outbox names it: the URL is a secret, so its claim holds only this and finds it again to send. */
const urlKey = (url: string) => createHash("sha256").update(url).digest("hex").slice(0, 16);

/** One POST of a claimed notification (outbox.ts), whose `ref` is `<event seq>:<urlKey>`. A failed post is sent
 * again by the outbox: a second message is better than none. The URL may carry the receiver's token, and a fetch error
 * can repeat it: the result and the log name a status or the error's name. */
export async function sendNotification(f: FactoryRuntime, ref: string, body: string): Promise<PostResult> {
  const url = urls(f).find((u) => urlKey(u) === ref.slice(ref.indexOf(":") + 1));
  if (!url) return { status: "failed", error: "the URL is no longer set" };
  // Each URL's last failure, so one that keeps failing is logged once until it changes or works again.
  const failed = f.memory("notify failures said", () => new SayOnce());
  let result: PostResult;
  try {
    const response = await delivery.post(url, body);
    await response.body?.cancel().catch(() => {});
    result = response.ok ? { status: "posted" } : { status: "failed", error: `HTTP ${response.status}` };
  } catch (e) {
    result = { status: "unreachable", error: e instanceof Error ? e.name : "error" };
  }
  if (result.status === "posted") failed.clear(url);
  else if (failed.fresh(url, result.error))
    console.error(`factory: a notify URL did not take an update: ${result.error}`);
  return result;
}

/** Tells every outlet about one moment, each a write the outbox claims and sends after the item's current step. `text`
 * is one line a Slack-compatible incoming webhook shows as it is. */
function tell(f: FactoryRuntime, seq: number, kind: string, item: FactoryItem, text: string) {
  const body = JSON.stringify({
    type: "agentgate.factory.updates",
    node: f.s.nodeId,
    text,
    updates: [{ seq, at: new Date(f.s.now()).toISOString(), kind, text, item: itemUpdate(item) }],
  });
  for (const url of urls(f))
    claimWrite(f, item.id, "notify", `${seq}:${urlKey(url)}`, body, `The notification to ${new URL(url).host}`);
}

/** A question a run's thread on this machine asks: that thread is marked unread, where the person already works. A
 * wait whose thread is gone or on another machine has nothing to mark. */
async function markUnread(f: FactoryRuntime, item: FactoryItem) {
  const wait = item.needsYou;
  if (!wait?.run || wait.cause === "deleted" || wait.cause === "handed-off") return;
  const run = runs.get(f.s, wait.run);
  if (!run?.threadId || (run.node && run.node !== f.s.nodeId)) return;
  await t3Mcp(f)
    .call("t3_thread_organize", { threadId: run.threadId, action: "mark_unread" })
    .catch((e) =>
      f.events.emit({
        kind: "note",
        item: item.id,
        text: `Marking ${item.key}'s thread unread failed: ${shortError(e)}`,
      }),
    );
}

export function setup(f: FactoryRuntime) {
  f.events.on("item.needs-you", async (event, seq) => {
    const item = items.get(f.s, event.item);
    if (!item?.needsYou) return;
    // Where to answer: the asking thread, else the issue or the PR.
    const thread = item.needsYou.run ? runs.get(f.s, item.needsYou.run)?.threadLink : undefined;
    const link = item.needsYou.link ?? thread ?? item.url ?? item.pr?.url;
    tell(f, seq, event.kind, item, `${cap(event.text)}${link ? ` ${link}` : ""}`);
    await markUnread(f, item);
  });
  f.events.on("item.phase", (event, seq) => {
    const item = event.to === "ready" ? items.get(f.s, event.item) : undefined;
    if (!item) return;
    tell(
      f,
      seq,
      event.kind,
      item,
      `${item.key}'s PR is ready for you: ${cap(item.title, 200)} ${item.pr?.url ?? ""}`.trim(),
    );
  });

  operation(f, {
    name: "notify",
    summary: "post to your own https URL when an item waits for you or a PR is ready; off stops it",
    input: z.object({ url: z.string().max(2000).nullable().optional() }),
    // Set on every machine, and refused over the tailnet like every secret: the URL is one.
    local: true,
    loopbackOnly: true,
    run({ url }) {
      if (url === null) deleteSecret(f.s, NOTIFY);
      else if (url !== undefined) setSecret(f.s, NOTIFY, webhookUrl(url));
      const current = notifyUrl(f);
      return current ? { host: new URL(current).host } : {};
    },
    terminal: {
      usage: "notify [<https-url> | off]",
      parse(args) {
        if (args.length > 1) throw new UsageError();
        return { input: args[0] === undefined ? {} : { url: args[0] === "off" ? null : args[0] } };
      },
      print: ({ host }, { input }) =>
        input.url === null
          ? ["Notifications are off."]
          : host
            ? [`Posts to ${host} when an item waits for you or a PR is ready.`]
            : ["No notify URL is set: agentgate factory notify <https-url>"],
    },
  });
}
