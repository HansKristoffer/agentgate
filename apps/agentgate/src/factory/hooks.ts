import { createHmac, timingSafeEqual } from "node:crypto";
import { parseArgs } from "node:util";
import type { FactoryCheck, FactorySource } from "@agentgate/protocol";
import { remoteKey } from "@agentgate/protocol/remote";
import { randomToken } from "hanzio/crypto";
import { z } from "zod";
import { checkRelayUrl, relayUrl } from "../relay.ts";
import { hookUrl, lastRequest, queueDelete, type HookEndpoint } from "../remote.ts";
import { fetchHeaders, readBody, serialTask } from "../runtime.ts";
import { currentFolder } from "./config.ts";
import { admission, admit, HELD_LIMIT, pollSource } from "./intake.ts";
import { operation, SayOnce, UsageError, type FactoryRuntime } from "./runtime.ts";
import { deleteSecret, getSecret, resolveSecretRef, setSecret } from "./secrets.ts";

/**
 * Webhooks: each webhook source, and each GitHub or Linear source with `webhook`, has a public relay URL,
 * `/hook/:key`, served over the factory machine's socket like a remote MCP endpoint. The relay checks nothing, so the
 * sender's signature is checked here. A webhook source's delivery becomes an item; a GitHub or Linear delivery only
 * polls that source now. Nothing is queued while the factory machine is offline. `factory source test` renders a sample
 * delivery without adding it, or sends it through the relay; `factory deliver` takes one on loopback.
 */

/** The outbound requests here, the relay probe and `source test --send`: the seam tests stub. */
export const http = { fetch: fetchHeaders };

type WebhookSource = Extract<FactorySource, { type: "webhook" }>;
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

const hmac = (secret: string, body: string) => createHmac("sha256", secret).update(body, "utf8").digest();

function signed(signature: NonNullable<ReturnType<typeof signatureOf>>, secret: string, req: Request, body: string) {
  const header = req.headers.get(signature.header)?.trim();
  if (!header?.startsWith(signature.prefix)) return false;
  const given = Buffer.from(header.slice(signature.prefix.length), signature.encoding);
  const expected = hmac(secret, body);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ---- templates

const PLACEHOLDER = /\{\{\s*(body|headers|query)((?:\.[^\s.{}]+)*)\s*\}\}/g;

/** A delivery as the relay forwards it, or as `source test` and `deliver` were given it. */
interface Delivery {
  body: string;
  headers: Headers;
  query: URLSearchParams;
}

/** `{{body}}` is the raw body; `{{body.a.b}}`, `{{headers.x}}` and `{{query.x}}` read one value, "" when absent. */
function render(template: string, delivery: Delivery & { json: unknown }) {
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

// ---- deliveries

/** One poll pass at a time per source; a delivery during a pass runs one more after it. */
function pollSoon(f: FactoryRuntime, source: string) {
  const bySource = f.memory("hook polls", () => new Map<string, () => Promise<void>>());
  let poll = bySource.get(source);
  if (!poll) bySource.set(source, (poll = serialTask(() => pollSource(f, source))));
  return poll();
}

/** A webhook source's delivery through its templates: what `take` admits and `source test` prints. */
function rendered(source: WebhookSource, given: Delivery) {
  let json: unknown;
  try {
    json = JSON.parse(given.body);
  } catch {
    // Not JSON: `{{body}}` still renders, and every `{{body.x}}` renders empty.
  }
  const delivery = { ...given, json };
  const only = source.only && render(source.only.value, delivery).trim();
  const dedupe = source.dedupe && cut(render(source.dedupe, delivery).trim(), 300);
  return {
    title: cut(render(source.title, delivery).trim(), 300),
    body: cut(render(source.body, delivery), 32_000),
    ...(dedupe && { dedupe }),
    ...(source.only && { only: { value: only ?? "", kept: source.only.in.includes(only ?? "") } }),
  };
}

/** What became of a delivery. */
type Taken =
  | { kind: "polled" }
  | { kind: "ignored"; value: string }
  | { kind: "untitled" }
  | { kind: "duplicate" }
  | { kind: "full" }
  | { kind: "added"; item: string; held: boolean };

/** A delivery whose signature was checked, or that `deliver` got on loopback: an item, or a poll of its source. */
function take(f: FactoryRuntime, source: HookSource, delivery: Delivery): Taken {
  if (source.type !== "webhook") {
    // The poll may take a while; the sender gets its answer now.
    void pollSoon(f, source.id).catch((e) => console.error(`factory: polling ${source.id} failed: ${e?.name}`));
    return { kind: "polled" };
  }
  const r = rendered(source, delivery);
  // A sender that posts every change to a record: only the changes the folder names mean new work.
  if (r.only && !r.only.kept) return { kind: "ignored", value: r.only.value };
  if (!r.title) {
    f.events.emit({ kind: "note", text: `A delivery to ${source.id} was refused: its title template rendered empty` });
    return { kind: "untitled" };
  }
  const admitted = admit(f, {
    source: source.id,
    repo: source.repo,
    intake: source.intake,
    dedupeWindow: source.dedupeWindow,
    incoming: {
      externalId: crypto.randomUUID(),
      key: `${source.id}-${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}`,
      title: r.title,
      snapshot: { title: r.title, body: r.body },
      ...(r.dedupe && { dedupe: r.dedupe }),
    },
  });
  // Sources whose held items reached HELD_LIMIT: once per filling, or a flood of deliveries would flood the event
  // list too.
  const full = f.memory("full hook sources said", () => new SayOnce());
  if (admitted === "duplicate") return { kind: "duplicate" };
  if (admitted === "full") {
    if (full.fresh(source.id))
      f.events.emit({
        kind: "note",
        text: `Deliveries to ${source.id} are refused while ${HELD_LIMIT} of its items wait for approval or rejection`,
      });
    return { kind: "full" };
  }
  full.clear(source.id);
  return { kind: "added", item: admitted.key, held: admitted.phase === "held" };
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

  const taken = take(f, source, { body, headers: req.headers, query: new URL(req.url).searchParams });
  switch (taken.kind) {
    case "polled":
      return answer(202, { ok: true });
    case "ignored":
      return answer(200, { ok: true, ignored: true });
    case "untitled":
      return answer(422, { error: "the delivery has no title" });
    case "duplicate":
      return answer(200, { ok: true, duplicate: true });
    case "full":
      return answer(429, { error: "too many deliveries wait for approval" });
    case "added":
      return answer(202, { ok: true, item: taken.item });
  }
}

// ---- whether a delivery can reach the factory

/** What a relay answered a GET on a hook URL: `serves` (405, it routes `/hook`), `old` (404, it was deployed before
 * webhook URLs), `unreachable`, or `unknown` with the status. */
interface Probe {
  at: number;
  state: "serves" | "old" | "unreachable" | "unknown";
  status?: number;
}
const probes = (f: FactoryRuntime) => f.memory("hook relays", () => new Map<string, Probe>());
/** A relay that serves hooks is asked again after this; one that does not, every hooks pass, so a deploy shows soon. */
const PROBE_EVERY = 5 * 60_000;

/** Asks each relay a hook URL is on whether it routes `/hook`. A GET is answered by the relay's router, 405 for a
 * POST-only route, without reaching the endpoint, so it costs the relay nothing and tells nothing but that. */
async function probeRelays(f: FactoryRuntime) {
  const byRelay = new Map<string, string>();
  for (const { id } of hookSources(f)) {
    const c = credentials(f, id);
    if (c && !byRelay.has(c.relay)) byRelay.set(c.relay, hookUrl(c));
  }
  const known = probes(f);
  for (const relay of known.keys()) if (!byRelay.has(relay)) known.delete(relay);
  await Promise.all(
    [...byRelay].map(async ([relay, url]) => {
      const last = known.get(relay);
      if (last?.state === "serves" && f.s.now() - last.at < PROBE_EVERY) return;
      let probe: Omit<Probe, "at">;
      try {
        const res = await http.fetch(url, {}, 10_000);
        await res.body?.cancel();
        probe =
          res.status === 405
            ? { state: "serves" }
            : res.status === 404
              ? { state: "old" }
              : { state: "unknown", status: res.status };
      } catch {
        probe = { state: "unreachable" };
      }
      known.set(relay, { at: f.s.now(), ...probe });
    }),
  );
}

/** A hook source's row on the board: its URL, whether a delivery can reach it, and its last delivery. */
function hookState(f: FactoryRuntime, id: string) {
  const c = credentials(f, id);
  if (!c) return { configured: false };
  const probe = probes(f).get(c.relay)?.state;
  const socket = f.ctx.remote.hookState(id);
  const last = lastRequest(f.s, hookId(id));
  return {
    configured: true,
    url: hookUrl(c),
    ...(probe === "serves" && { relayServes: true }),
    ...(probe === "old" && { relayServes: false }),
    ...(socket && { connected: socket.connected }),
    ...(socket?.error && { error: socket.error }),
    ...(last && { lastDelivery: last }),
  };
}

const RANK = { ok: 0, unknown: 1, warn: 2, fail: 3 } as const;

/** One check for every hook URL: the relay routes `/hook`, and this machine's socket for each URL is open. The socket's
 * error text stays on the board's row, which only the API and CLI show. */
function reachable(f: FactoryRuntime): FactoryCheck[] {
  const sources = hookSources(f);
  if (!sources.length) return [];
  const rows: { state: FactoryCheck["state"]; detail: string; fix?: string }[] = [];
  const relays = new Set<string>();
  for (const { id } of sources) {
    const c = credentials(f, id);
    if (!c) {
      rows.push({ state: "unknown", detail: `${id} has no URL yet; the factory makes one within a minute` });
      continue;
    }
    const relay = new URL(c.relay).host;
    relays.add(relay);
    const probe = probes(f).get(c.relay);
    const socket = f.ctx.remote.hookState(id);
    if (probe?.state === "old")
      rows.push({
        state: "fail",
        detail: `the relay ${relay} answers 404 on /hook: it was deployed before webhook URLs, so it loses every delivery`,
        fix: "deploy the relay from this release (docs/operations/relay.md); meanwhile a script on this machine can use agentgate factory deliver <id>",
      });
    else if (probe?.state === "unreachable")
      rows.push({
        state: "fail",
        detail: `the relay ${relay} did not answer`,
        fix: "check this machine's network and the relay URL",
      });
    else if (probe?.state === "unknown")
      rows.push({ state: "unknown", detail: `the relay ${relay} answered ${probe.status} on /hook` });
    else if (!probe) rows.push({ state: "unknown", detail: `the relay ${relay} was not asked yet` });
    if (socket?.connected) continue;
    if (socket?.error)
      rows.push({
        state: "fail",
        detail: `${id}'s connection to the relay is down`,
        fix: "agentgate factory status shows why",
      });
    else rows.push({ state: "unknown", detail: `${id} is connecting to the relay` });
  }
  const state = rows.reduce<FactoryCheck["state"]>((worst, r) => (RANK[r.state] > RANK[worst] ? r.state : worst), "ok");
  // Sources on one relay share its answer, which is said once.
  const details = [...new Set(rows.map((r) => r.detail))];
  const fixes = [...new Set(rows.flatMap((r) => (r.fix ? [r.fix] : [])))];
  return [
    {
      id: "webhooks",
      title: "The webhook URLs can receive deliveries",
      state,
      detail: details.length
        ? details.join("; ")
        : `${sources.length} ${sources.length === 1 ? "URL" : "URLs"} on ${[...relays].join(", ")}`,
      ...(fixes.length && { fix: fixes.join("; ") }),
    },
  ];
}

// ---- trying a source: `source test` and `deliver`

const deliveryInput = z.object({
  id: z.string().min(1),
  body: z.string().max(1024 * 1024),
  headers: z.record(z.string(), z.string().max(8192)).optional(),
  query: z.string().max(8192).optional(),
});
type DeliveryInput = z.infer<typeof deliveryInput>;

function hookSource(f: FactoryRuntime, id: string) {
  const source = hookSources(f).find((s) => s.id === id);
  if (!source) throw new Error(`The factory has no webhook source ${id}, nor a GitHub or Linear one with webhook`);
  return source;
}

function deliveryOf(input: DeliveryInput): Delivery {
  let headers: Headers;
  try {
    headers = new Headers(input.headers);
  } catch {
    throw new Error("A header's name or value is not valid in HTTP");
  }
  return { body: input.body, headers, query: new URLSearchParams(input.query) };
}

/** The words both commands take: the source, `--header 'Name: value'` (repeatable) and `--query a=b&c=d`; the body
 * comes on stdin. */
function deliveryWords(args: string[], stdin: string | undefined, withSend: boolean) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        header: { type: "string", multiple: true },
        query: { type: "string" },
        json: { type: "boolean" },
        ...(withSend && { send: { type: "boolean" as const } }),
      },
      allowPositionals: true,
    });
  } catch {
    throw new UsageError();
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1 || stdin === undefined) throw new UsageError();
  const headers: Record<string, string> = {};
  for (const line of values.header ?? []) {
    const at = line.indexOf(":");
    if (at < 1) throw new UsageError();
    headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return {
    input: {
      id: positionals[0]!,
      body: stdin,
      ...(Object.keys(headers).length && { headers }),
      ...(values.query && { query: values.query.replace(/^\?/, "") }),
      ...("send" in values && values.send && { send: true }),
    },
    json: values.json,
  };
}

interface SourceTest {
  source: string;
  /** `--send`: the answer the public URL gave. */
  sent?: { status: number; body: string };
  /** A GitHub or Linear source: a valid delivery polls it now and adds nothing itself. */
  polls?: true;
  rendered?: ReturnType<typeof rendered>;
  signature?: { header: string; secret: string; set: boolean };
  /** Whether it would become an item now, held for approval or started; and why not. */
  admitted?: { held: boolean };
  refused?: string;
}

/** `source test`: what the source makes of a delivery, through `take`'s own rendering and `admit`'s own decision,
 * adding nothing; or, with `send`, the delivery posted to the source's URL, signed as the source expects. */
async function testSource(f: FactoryRuntime, input: DeliveryInput & { send?: boolean }): Promise<SourceTest> {
  const source = hookSource(f, input.id);
  if (input.send) return { source: source.id, sent: await send(f, source, input) };
  const sig = signatureOf(source);
  const signature = sig && {
    header: sig.header,
    secret: sig.secret.slice("secret:".length),
    set: !!resolveSecretRef(f.s, sig.secret),
  };
  const base = { source: source.id, ...(signature && { signature }) };
  if (source.type !== "webhook") return { ...base, polls: true };
  const r = rendered(source, deliveryOf(input));
  const refused =
    r.only && !r.only.kept
      ? `only takes ${source.only!.in.join(", ")}, and its value is "${r.only.value}"`
      : !r.title
        ? "its title template rendered empty"
        : undefined;
  if (refused) return { ...base, rendered: r, refused };
  const decided = admission(f, {
    source: source.id,
    intake: source.intake,
    dedupeWindow: source.dedupeWindow,
    ...(r.dedupe && { dedupe: r.dedupe }),
  });
  if (decided === "duplicate")
    return {
      ...base,
      rendered: r,
      refused: `an item with its dedupe key is open, or finished within ${source.dedupeWindow}`,
    };
  if (decided === "full") return { ...base, rendered: r, refused: `${HELD_LIMIT} of its items wait for approval` };
  return { ...base, rendered: r, admitted: { held: decided.hold } };
}

/** Posts the delivery to the source's public URL, through the relay and back to this factory, which proves the round
 * trip. It is signed with the source's secret when it has one, as its sender would; only the result is printed. */
async function send(f: FactoryRuntime, source: HookSource, input: DeliveryInput) {
  const c = credentials(f, source.id);
  if (!c) throw new Error(`${source.id} has no URL yet; the factory machine makes one within a minute`);
  const headers = deliveryOf(input).headers;
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  const signature = signatureOf(source);
  if (signature) {
    const secret = resolveSecretRef(f.s, signature.secret);
    const name = signature.secret.slice("secret:".length);
    if (!secret) throw new Error(`${name} is not set; run agentgate factory secret set ${name}`);
    headers.set(signature.header, `${signature.prefix}${hmac(secret, input.body).toString(signature.encoding)}`);
  }
  const url = `${hookUrl(c)}${input.query ? `?${input.query}` : ""}`;
  const res = await http.fetch(url, { method: "POST", headers, body: input.body }, 15_000);
  let text: string;
  try {
    text = new TextDecoder().decode(await readBody(res.body, 64 * 1024, AbortSignal.timeout(15_000)));
  } catch {
    text = "";
  }
  return { status: res.status, body: cut(text.trim(), 2000) };
}

function testText(t: SourceTest): string[] {
  if (t.sent) return [`The URL answered ${t.sent.status}${t.sent.body ? `: ${t.sent.body}` : ""}`];
  const lines: string[] = [];
  if (t.signature)
    lines.push(
      `Signature: ${t.signature.header}, with ${t.signature.secret}${t.signature.set ? "" : ", which is not set yet: every delivery is refused until agentgate factory secret set"}. A dry run does not check it; --send signs it.`,
    );
  if (t.polls) return [...lines, `A valid delivery makes the factory poll ${t.source} now; it adds no item itself.`];
  const r = t.rendered!;
  lines.push(`Title: ${r.title || "(empty)"}`);
  if (r.dedupe) lines.push(`Dedupe key: ${r.dedupe}`);
  if (r.only) lines.push(`Only: "${r.only.value}" ${r.only.kept ? "is" : "is not"} one of the values it takes`);
  lines.push(
    t.admitted
      ? `It would be added, ${t.admitted.held ? "waiting for your approval" : "starting at triage"}.`
      : `It would not be added: ${t.refused}.`,
    "Nothing was added.",
    "",
    "Body:",
    r.body,
  );
  return lines;
}

function takenText(t: Taken, id: string): { lines: string[]; code: number } {
  switch (t.kind) {
    case "polled":
      return { lines: [`Polling ${id} now.`], code: 0 };
    case "ignored":
      return { lines: [`Ignored: ${id}'s only rule does not take "${t.value}".`], code: 0 };
    case "untitled":
      return { lines: ["Refused: its title template rendered empty."], code: 1 };
    case "duplicate":
      return {
        lines: ["A duplicate: an item with its dedupe key is open or finished recently. Nothing added."],
        code: 0,
      };
    case "full":
      return { lines: [`Refused: ${HELD_LIMIT} of ${id}'s items wait for approval.`], code: 1 };
    case "added":
      return { lines: [`Added ${t.item}${t.held ? ", waiting for your approval" : ""}.`], code: 0 };
  }
}

export function setup(f: FactoryRuntime): void {
  f.ctx.remote.hooks = () => served(f);
  f.loops.push({
    name: "factory-hooks",
    everyMs: 30_000,
    where: "factory-node",
    run: async () => {
      ensureHooks(f);
      await probeRelays(f);
    },
  });
  f.checks.push({ name: "Webhooks", run: () => reachable(f) });
  f.boardParts.push(async () => ({
    sources: hookSources(f).map((source) => ({
      id: source.id,
      type: source.type,
      repo: source.repo,
      webhook: hookState(f, source.id),
    })),
  }));
  operation(f, {
    name: "source test",
    summary:
      "what a webhook source makes of a delivery on stdin, adding nothing; --send posts it to the source's URL instead",
    input: deliveryInput.extend({ send: z.boolean().optional() }),
    run: (input) => testSource(f, input),
    terminal: {
      usage: "source test <id> [--header 'Name: value']... [--query a=b] [--send] [--json] < delivery.json",
      stdin: true,
      parse: (args, stdin) => deliveryWords(args, stdin, true),
      print: (result, { json }) => (json ? [JSON.stringify(result, null, 2)] : testText(result)),
    },
  });
  operation(f, {
    name: "deliver",
    summary: "take a delivery on stdin for a source as its URL would, from a script on this machine",
    input: deliveryInput,
    // Anyone who can deliver adds items, as the URL's holder can; over the tailnet, that would be every paired user.
    loopbackOnly: true,
    run: (input) => {
      if (!f.isFactoryNode()) throw new Error("The factory is off; turn it on with agentgate factory use <owner/repo>");
      return take(f, hookSource(f, input.id), deliveryOf(input));
    },
    terminal: {
      usage: "deliver <id> [--header 'Name: value']... [--query a=b] [--json] < delivery.json",
      stdin: true,
      parse: (args, stdin) => deliveryWords(args, stdin, false),
      print: (result, { input, json }) =>
        json ? { lines: [JSON.stringify(result)], code: 0 } : takenText(result, input.id),
    },
  });
}
