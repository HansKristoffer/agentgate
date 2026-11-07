import { createHmac, timingSafeEqual } from "node:crypto";
import type { FactorySource } from "@agentgate/protocol";
import { remoteKey } from "@agentgate/protocol/remote";
import { randomToken } from "hanzio/crypto";
import { z } from "zod";
import { checkRelayUrl, relayUrl } from "../relay.ts";
import { hookUrl, queueDelete, type HookEndpoint } from "../remote.ts";
import { serialTask } from "../runtime.ts";
import { currentFolder } from "./config.ts";
import { admit, HELD_LIMIT, pollSource } from "./controller.ts";
import type { FactoryRuntime } from "./runtime.ts";
import { deleteSecret, getSecret, resolveSecretRef, setSecret } from "./secrets.ts";

/**
 * Webhooks: each webhook source, and each GitHub or Linear source with `webhook`, has a public relay URL,
 * `/hook/:key`, served over the factory machine's socket like a remote MCP endpoint. The relay checks nothing, so the
 * sender's signature is checked here. A webhook source's delivery becomes an item; a GitHub or Linear delivery only
 * polls that source now. Nothing is queued while the factory machine is offline.
 */

type HookSource = Extract<FactorySource, { type: "webhook" }> | (FactorySource & { webhook: { secret: string } });

/** The URL's relay credentials, kept as the synced `~hook:<source>` secret so the URL survives a move. */
const credentialsSchema = z.object({
  relay: z.string().min(1),
  key: remoteKey,
  token: z.string().min(1),
  secret: z.string().min(1),
});
type Credentials = z.infer<typeof credentialsSchema>;

const hookId = (source: string) => `~hook:${source}`;

function credentials(f: FactoryRuntime, source: string): Credentials | undefined {
  const raw = getSecret(f.s, hookId(source));
  if (!raw) return undefined;
  try {
    return credentialsSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

const hookSources = (f: FactoryRuntime) =>
  (currentFolder(f)?.config.sources ?? []).filter(
    (s): s is HookSource => s.type === "webhook" || ("webhook" in s && !!s.webhook),
  );

/** Gives every webhook-capable source its credentials, and deletes the URL of a source the folder no longer has. */
function ensureHooks(f: FactoryRuntime) {
  if (!f.isFactoryNode() || !currentFolder(f)) return;
  const wanted = new Set(hookSources(f).map((s) => s.id));
  for (const id of wanted)
    if (!credentials(f, id)) {
      const fresh: Credentials = {
        relay: checkRelayUrl(relayUrl(f.s)),
        key: randomToken(16),
        token: randomToken(32),
        secret: randomToken(32),
      };
      setSecret(f.s, hookId(id), JSON.stringify(fresh));
    }
  for (const { id } of f.s.list("secret")) {
    if (!id.startsWith("~hook:")) continue;
    const source = id.slice("~hook:".length);
    if (wanted.has(source)) continue;
    const old = credentials(f, source);
    if (old) queueDelete(f.s, old);
    deleteSecret(f.s, id);
  }
  f.ctx.remote.reconcile();
}

/** What this machine serves: every hook with credentials, while it runs the factory. */
function served(f: FactoryRuntime) {
  if (!f.isFactoryNode()) return [];
  return hookSources(f).flatMap((source) => {
    const c = credentials(f, source.id);
    const hook: HookEndpoint | undefined = c && {
      source: source.id,
      ...c,
      handle: (req) => handleHook(f, source.id, req),
    };
    return hook ? [hook] : [];
  });
}

// ---- signatures

/** GitHub and Linear sign with fixed headers; a webhook source names its own. */
function signatureOf(source: HookSource) {
  if (source.type === "webhook") return source.signature;
  if (source.type === "github")
    return {
      header: "x-hub-signature-256",
      encoding: "hex" as const,
      prefix: "sha256=",
      secret: source.webhook.secret,
    };
  return { header: "linear-signature", encoding: "hex" as const, prefix: "", secret: source.webhook.secret };
}

function signed(signature: NonNullable<ReturnType<typeof signatureOf>>, secret: string, req: Request, body: string) {
  const header = req.headers.get(signature.header)?.trim();
  if (!header?.startsWith(signature.prefix)) return false;
  const given = Buffer.from(header.slice(signature.prefix.length), signature.encoding);
  const expected = createHmac("sha256", secret).update(body, "utf8").digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ---- templates

const PLACEHOLDER = /\{\{\s*(body|headers|query)((?:\.[^\s.{}]+)*)\s*\}\}/g;

/** `{{body}}` is the raw body; `{{body.a.b}}`, `{{headers.x}}` and `{{query.x}}` read one value, "" when absent. */
function render(template: string, delivery: { body: string; json: unknown; headers: Headers; query: URLSearchParams }) {
  return template.replace(PLACEHOLDER, (_, root: string, path: string) => {
    const keys = path.split(".").slice(1);
    if (root === "headers") return keys.length === 1 ? (delivery.headers.get(keys[0]!) ?? "") : "";
    if (root === "query") return keys.length === 1 ? (delivery.query.get(keys[0]!) ?? "") : "";
    if (!keys.length) return delivery.body;
    let value = delivery.json;
    for (const key of keys)
      value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    if (value === undefined || value === null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const answer = (status: number, body: Record<string, unknown>) => Response.json(body, { status });
/** Sources whose held items reached HELD_LIMIT, so the refusal is noted once. */
const capped = new WeakMap<FactoryRuntime, Set<string>>();

// ---- deliveries

/** One poll pass at a time per source; a delivery during a pass runs one more after it. */
const polls = new WeakMap<FactoryRuntime, Map<string, () => Promise<void>>>();
function pollSoon(f: FactoryRuntime, source: string) {
  let bySource = polls.get(f);
  if (!bySource) polls.set(f, (bySource = new Map()));
  let poll = bySource.get(source);
  if (!poll) bySource.set(source, (poll = serialTask(() => pollSource(f, source))));
  return poll();
}

/** A delivery from the relay. Never routed through a listener: a public sender must not borrow loopback trust. */
export async function handleHook(f: FactoryRuntime, sourceId: string, req: Request): Promise<Response> {
  if (!f.isFactoryNode()) return answer(503, { error: "the factory does not run on this machine" });
  const source = hookSources(f).find((s) => s.id === sourceId);
  if (!source) return answer(404, { error: "no such webhook" });
  const body = await req.text();

  const signature = signatureOf(source);
  if (signature) {
    const secret = resolveSecretRef(f.s, signature.secret);
    if (!secret) {
      f.events.emit({
        kind: "note",
        text: `A delivery to ${source.id} was refused: ${signature.secret} is not set; run agentgate factory secret set`,
      });
      return answer(503, { error: "the factory cannot check this delivery's signature yet" });
    }
    if (!signed(signature, secret, req, body)) return answer(401, { error: "bad signature" });
  }

  if (source.type !== "webhook") {
    // The poll may take a while; the sender gets its answer now.
    void pollSoon(f, source.id).catch((e) => console.error(`factory: polling ${source.id} failed: ${e?.name}`));
    return answer(202, { ok: true });
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    // Not JSON: `{{body}}` still renders, and every `{{body.x}}` renders empty.
  }
  const delivery = { body, json, headers: req.headers, query: new URL(req.url).searchParams };
  const title = cut(render(source.title, delivery).trim(), 300);
  if (!title) {
    f.events.emit({ kind: "note", text: `A delivery to ${source.id} was refused: its title template rendered empty` });
    return answer(422, { error: "the delivery has no title" });
  }
  const dedupe = source.dedupe && cut(render(source.dedupe, delivery).trim(), 300);
  const admitted = admit(f, {
    source: source.id,
    repo: source.repo,
    intake: source.intake,
    dedupeWindow: source.dedupeWindow,
    incoming: {
      externalId: crypto.randomUUID(),
      key: `${source.id}-${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}`,
      title,
      snapshot: { title, body: cut(render(source.body, delivery), 32_000) },
      ...(dedupe && { dedupe }),
    },
  });
  let full = capped.get(f);
  if (!full) capped.set(f, (full = new Set()));
  if (admitted === "duplicate") return answer(200, { ok: true, duplicate: true });
  if (admitted === "full") {
    // Once per filling: a flood of deliveries would otherwise flood the event list too.
    if (!full.has(source.id))
      f.events.emit({
        kind: "note",
        text: `Deliveries to ${source.id} are refused while ${HELD_LIMIT} of its items wait for approval or rejection`,
      });
    full.add(source.id);
    return answer(429, { error: "too many deliveries wait for approval" });
  }
  full.delete(source.id);
  return answer(202, { ok: true, item: admitted.key });
}

export function setup(f: FactoryRuntime): void {
  f.ctx.remote.hooks = () => served(f);
  f.loops.push({ name: "factory-hooks", everyMs: 30_000, where: "factory-node", run: async () => ensureHooks(f) });
  f.boardParts.push(async () => ({
    sources: hookSources(f).map((source) => {
      const c = credentials(f, source.id);
      return {
        id: source.id,
        type: source.type,
        repo: source.repo,
        webhook: { configured: !!c, ...(c && { url: hookUrl(c) }) },
      };
    }),
  }));
}
