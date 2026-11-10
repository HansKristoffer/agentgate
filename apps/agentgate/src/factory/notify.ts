import { z } from "zod";
import { webhookUrl } from "../operations.ts";
import { fetchHeaders } from "../runtime.ts";
import { runs, items, type FactoryItem } from "./db.ts";
import { deleteSecret, getSecret, setSecret } from "./secrets.ts";
import { operation, shortError, UsageError, type FactoryRuntime } from "./runtime.ts";
import { t3Mcp } from "./t3-mcp.ts";

/**
 * Telling the person, the one place the factory reaches out from. Two moments are told: an item starts waiting for the
 * person (`ask` in controller.ts emits `item.needs-you`), and an item's PR is ready (`item.phase` to `ready`). Each goes
 * to every outlet: the person's own notify URL, the webhook of each virtual project that offers the factory's tools
 * (`factoryWebhook`), and, for a question a run's thread asks, that thread marked unread in T3 Code. GitHub cannot be
 * one: the factory comments as the maintainer's own login (D42), and GitHub never notifies you of your own comments.
 * Only the factory machine drives items, so only it has these moments to tell.
 */

/** The person's notify URL, set once for every machine. A synced secret, not a setting: a webhook URL carries its
 * receiver's token, so it syncs only encrypted, stays out of `export --no-secrets`, and only its host is shown. */
const NOTIFY = "~notify";
export const notifyUrl = (f: FactoryRuntime) => getSecret(f.s, NOTIFY);

/** Replaced in tests; a receiver gets 10 seconds to answer, and one more try `retryMs` later. */
export const delivery = {
  post: (url: string, body: string) =>
    fetchHeaders(
      url,
      { method: "POST", headers: { "content-type": "application/json", "user-agent": "agentgate" }, body },
      10_000,
    ),
  retryMs: 5000,
};

/** Each URL's last failure, so one that keeps failing is logged once until it changes or works again. */
const failures = new WeakMap<FactoryRuntime, Map<string, string>>();

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
    ...(item.prUrl && { pr: item.prUrl }),
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

/** One POST, tried again once after a short wait. The URL may carry the receiver's token, and a fetch error can
 * repeat it: the log names a status or the error's name. */
async function post(f: FactoryRuntime, url: string, body: string) {
  let failed = failures.get(f);
  if (!failed) failures.set(f, (failed = new Map()));
  let error = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await Bun.sleep(delivery.retryMs);
    if (f.s.closed) return;
    try {
      const response = await delivery.post(url, body);
      await response.body?.cancel().catch(() => {});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      failed.delete(url);
      return;
    } catch (e) {
      error = e instanceof Error && /^HTTP \d{3}$/.test(e.message) ? e.message : e instanceof Error ? e.name : "error";
    }
  }
  if (failed.get(url) !== error) console.error(`factory: a notify URL did not take an update: ${error}`);
  failed.set(url, error);
}

/** Every URL a moment is posted to: the person's own and the factory endpoints'. */
function urls(f: FactoryRuntime) {
  const endpoints = f.s.list("project").flatMap((p) => (p.factoryTools && p.factoryWebhook ? [p.factoryWebhook] : []));
  return [...new Set([notifyUrl(f), ...endpoints].filter((u): u is string => !!u))];
}

/** Tells every outlet about one moment. `text` is one line a Slack-compatible incoming webhook shows as it is. */
async function tell(f: FactoryRuntime, seq: number, kind: string, item: FactoryItem, text: string) {
  const body = JSON.stringify({
    type: "agentgate.factory.updates",
    node: f.s.nodeId,
    text,
    updates: [{ seq, at: new Date(f.s.now()).toISOString(), kind, text, item: itemUpdate(item) }],
  });
  await Promise.all(urls(f).map((url) => post(f, url, body)));
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
    const link = item.needsYou.link ?? thread ?? item.url ?? item.prUrl;
    await Promise.all([
      tell(f, seq, event.kind, item, `${cap(event.text)}${link ? ` ${link}` : ""}`),
      markUnread(f, item),
    ]);
  });
  f.events.on("item.phase", async (event, seq) => {
    const item = event.to === "ready" ? items.get(f.s, event.item) : undefined;
    if (!item) return;
    await tell(
      f,
      seq,
      event.kind,
      item,
      `${item.key}'s PR is ready for you: ${cap(item.title, 200)} ${item.prUrl ?? ""}`.trim(),
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
