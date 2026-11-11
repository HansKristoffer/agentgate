import { itemPhases, movingLabel, waitsForYou, type BoardThread, type FactoryBoard } from "@agentgate/protocol";
import { z } from "zod";
import type { Listener } from "../daemon.ts";
import { peerCall } from "../handoff/jobs.ts";
import { localView, peerView, type ViewThread } from "../handoff/threads.ts";
import { lastSeen } from "../sync.ts";
import { runs } from "./db.ts";
import { mirrorOf, timing } from "./mirror.ts";
import { needsYouLines } from "./needs-you.ts";
import { FACTORY_PAGE } from "./page.ts";
import { logError, operation, UsageError, type FactoryRuntime } from "./runtime.ts";
import { preflight, unreachableCheck } from "./preflight.ts";
import { needsSignIn } from "./t3-mcp.ts";
import { frozenItems } from "./view.ts";

/**
 * The board: each machine's T3 threads of factory runs (every thread with `allThreads`) and what the factory's
 * features add through `f.boardParts`. One builder serves the `/factory` page, `GET /api/factory`, which the app
 * polls, and the `status` operation.
 */

/** How long other machines' threads, read through `/peer/threads`, are reused. */
const PEER_EVERY = 10_000;
/** How long a board is reused when nothing in the factory changed (`buildBoard`). */
const BUILD_EVERY = 2000;
/** A factory machine heard from within this long is asked for its board; sync hears from it every 15 s. */
const SEEN_WITHIN = 60_000;

export function setup(f: FactoryRuntime) {
  f.page = (req, listener) => respond(f, req, listener);
  f.api.get("/", async (c) => c.json(await boardView(f, { includeWebhookUrls: true })));
  // Paired machines may see webhook URLs: they already share every secret.
  f.peer.get("/board", async (c) =>
    c.json(await buildBoard(f, { includeWebhookUrls: true, allThreads: c.req.query("all") === "1" })),
  );
  // Local: `boardView` asks the factory machine for its board itself, and adds what only this machine knows.
  const short = (board: FactoryBoard) => boardText(board, { short: true }).join("\n");
  operation(f, {
    name: "status",
    summary: "the board: items by phase, what waits for you, capacity, sources and the factory's threads",
    input: z.object({ all: z.boolean().optional() }),
    local: true,
    // A person at this machine or in the app sees the webhook URLs; an agent and a remote endpoint do not.
    run: ({ all }, caller) =>
      boardView(f, { includeWebhookUrls: caller.via === "terminal" || caller.via === "api", allThreads: all }),
    terminal: {
      usage: "status [--all] [--json]",
      parse(args) {
        if (args.some((a) => a !== "--json" && a !== "--all")) throw new UsageError();
        return { input: args.includes("--all") ? { all: true } : {}, json: args.includes("--json") };
      },
      print: (board, { json }) => (json ? [JSON.stringify(board, null, 2)] : boardText(board)),
    },
    tool: {
      name: "factory_status",
      description:
        "The software factory's board as short text: its items by phase, what waits on a person, capacity, sources and the factory's T3 Code threads on each machine.",
      result: short,
    },
    remote: {
      description:
        "The software factory's board: the repositories it works, its items by phase with their PRs, what waits for the maintainer, capacity and sources.",
      result: short,
    },
  });
  // Starts the mirror once this machine drives factory work and T3 Code is connected, and stops it when either goes.
  f.loops.push({
    name: "t3-mirror",
    everyMs: timing.pollMs,
    where: "every-node",
    whenOff: true,
    run: async () => void mirrorOf(f),
  });
}

/** The board as this machine shows it to the API and CLI: the factory machine's, when that is another machine, with
 * the items frozen in this machine's own tables, which that machine's board cannot know. */
export async function boardView(f: FactoryRuntime, opts: BoardOptions): Promise<FactoryBoard> {
  const pointer = f.pointer();
  if (!pointer || f.isFactoryNode()) return buildBoard(f, opts);
  // A paired machine's own board, passed through: parsing it here again would show a newer factory machine, whose
  // board has a field or value this one does not know, as offline. A machine unseen for a minute is not asked, or
  // every board read would wait out the timeout.
  const path = `/factory/board${opts.allThreads ? "?all=1" : ""}`;
  const remote =
    f.s.now() - lastSeen(f.s, pointer.node) <= SEEN_WITHIN
      ? await peerCall<FactoryBoard>(f.s, pointer.node, path, { timeout: 8000 }).catch(() => undefined)
      : undefined;
  if (remote) {
    const frozen = frozenItems(f);
    return strip({ ...remote, node: f.s.nodeId, frozen: frozen.length ? frozen : undefined }, opts);
  }
  // Unseen, unreachable or an older agentgate: this machine's board, the factory offline, with a failing check, since
  // without that machine's items it looks empty and healthy.
  const board = await buildBoard(f, opts);
  return {
    ...board,
    checks: [unreachableCheck(f, pointer.node), ...board.checks],
    factory: board.factory && { ...board.factory, online: false },
  };
}

/** `allThreads` lists every open thread under Machines, not only the factory's: `factory status --all`. */
type BoardOptions = { includeWebhookUrls: boolean; allThreads?: boolean };

/** This machine's board. It is built once per change to the `factory` topic, and at most every 2 s however often it
 * is read: the app asks for it on every change, and quota, preflight and other machines' threads change without one. */
export function buildBoard(f: FactoryRuntime, opts: BoardOptions): Promise<FactoryBoard> {
  const version = f.ctx.changes.snapshot().versions.factory;
  const all = !!opts.allThreads;
  const built = cache(f).built;
  let last = built.get(all);
  if (!last || last.version !== version || f.s.now() - last.at >= BUILD_EVERY) {
    const board = assemble(f, all);
    last = { version, at: f.s.now(), board };
    built.set(all, last);
    board.catch(() => built.get(all)?.board === board && built.delete(all));
  }
  return last.board.then((board) => strip(board, opts));
}

async function assemble(f: FactoryRuntime, allThreads: boolean): Promise<FactoryBoard> {
  const { stream, error } = mirrorOf(f).status();
  const base: FactoryBoard = {
    node: f.s.nodeId,
    // Only the factory machine's preflight: another machine's T3 Code and gh do no factory work.
    checks: f.isFactoryNode() ? await preflight(f, { fresh: false }) : [],
    factory: null, // config.ts's part
    config: null,
    t3: { stream, mcp: "off", ...(error && { error }) },
    capacity: {
      threads: 0,
      working: 0,
      waitingForYou: 0,
      waitingForYouLimit: 0,
      quota: "ok",
      intake: "off",
      mainRed: [],
    },
    items: [],
    machines: await machines(f, allThreads),
    sources: [],
    metrics: { merged: 0, mergeRate: 0, reverts14d: 0 },
    events: f.events.recent(50),
  };
  const parts = await Promise.all(
    f.boardParts.map((part) =>
      part().catch((e) => {
        console.error(`factory: a board part failed: ${logError(e)}`);
        return {};
      }),
    ),
  );
  return parts.reduce(merge, base);
}

const defined = <T extends object>(o: T | undefined) =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

/** Arrays add up (items by id, the later part winning), sources by id key by key, `t3` and `capacity` merge key by
 * key, and any other key is the later part's. `t3` merges because the mirror and the T3 sign-in each report half of
 * it, and a source row because intake reports its polls and the webhooks its URL. */
function merge(board: FactoryBoard, part: Partial<FactoryBoard>): FactoryBoard {
  const { items, sources, machines, events, t3, capacity, ...rest } = part;
  const byId = new Map(board.sources.map((row) => [row.id, row]));
  for (const row of sources ?? []) byId.set(row.id, { ...byId.get(row.id), ...row });
  return {
    ...board,
    ...defined(rest),
    items: [...new Map([...board.items, ...(items ?? [])].map((i) => [i.id, i])).values()],
    sources: [...byId.values()],
    machines: [...board.machines, ...(machines ?? [])],
    events: [...board.events, ...(events ?? [])],
    t3: { ...board.t3, ...defined(t3) },
    capacity: { ...board.capacity, ...defined(capacity) },
  };
}

/** Webhook URLs carry the hook's key, so the token-less page and agents never see them, nor a socket's error text. */
function strip(board: FactoryBoard, { includeWebhookUrls }: { includeWebhookUrls: boolean }): FactoryBoard {
  if (includeWebhookUrls) return board;
  return {
    ...board,
    sources: board.sources.map(({ webhook, ...source }) => {
      if (!webhook) return source;
      const { url: _, error: __, ...state } = webhook;
      return { ...source, webhook: state };
    }),
  };
}

/** This machine first, live from the mirror while it drives factory work, then the others. A thread is the factory's
 * when one of its runs launched it; the rest are counted, not listed, unless `all`: the token-less page and the CLI
 * listed every project's thread titles before anything about the factory. */
async function machines(f: FactoryRuntime, all: boolean): Promise<FactoryBoard["machines"]> {
  const [here, others] = await Promise.all([localThreads(f), peerMachines(f)]);
  // A factory run's thread names its item.
  const ids = [...here, ...others.flatMap((m) => m.threads)].map((t) => t.id);
  const byThread = new Map(runs.byThreads(f.s, ids).map((r) => [r.threadId!, r]));
  const linked = (t: BoardThread): BoardThread => {
    const run = byThread.get(t.id);
    return run ? { ...t, ...(run.item && { item: run.item }), ...(run.threadLink && { link: run.threadLink }) } : t;
  };
  return [{ node: f.s.nodeId, online: true, threads: here }, ...others].map((m) => {
    const threads = all ? m.threads : m.threads.filter((t) => byThread.has(t.id));
    const hidden = m.threads.length - threads.length;
    return { ...m, threads: threads.map(linked), ...(hidden > 0 && { hidden }) };
  });
}

async function localThreads(f: FactoryRuntime): Promise<BoardThread[]> {
  if (!needsSignIn(f)) return (await localView(f.ctx.handoffs)).threads.map(viewThread);
  const mirror = mirrorOf(f);
  // What T3's sidebar lists outside Settled and Archived: top-level threads.
  return mirror
    .threads()
    .filter((t) => !t.archived && !t.settled && !t.parentThreadId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((t) => {
      const project = t.projectId && mirror.projectTitle(t.projectId);
      return {
        id: t.id,
        title: t.title,
        ...(project && { project }),
        status: t.status,
        needsYou: t.needsYou,
        updatedAt: t.updatedAt,
      };
    });
}

const viewThread = (t: ViewThread): BoardThread => ({
  id: t.id,
  title: t.title,
  project: t.project,
  status: t.needsYou ? "waiting" : t.running ? "running" : "idle",
  needsYou: !!t.needsYou,
  updatedAt: Date.parse(t.updatedAt) || 0,
});

/** The last read of the other machines' threads, and the last board built with and without `allThreads`, with the
 * `factory` topic's version it was built at. */
const cache = (f: FactoryRuntime) =>
  f.memory("board cache", () => ({
    peers: undefined as { at: number; machines: Promise<FactoryBoard["machines"]> } | undefined,
    built: new Map<boolean, { version: number; at: number; board: Promise<FactoryBoard> }>(),
  }));

function peerMachines(f: FactoryRuntime) {
  const cached = cache(f).peers;
  if (cached && f.s.now() - cached.at < PEER_EVERY) return cached.machines;
  const machines = Promise.all(
    f.s
      .list("node")
      .filter((n) => n.id !== f.s.nodeId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(async (n) => {
        const view = await peerView(f.ctx.handoffs, n);
        return { node: n.id, online: !view.error, threads: view.threads.map(viewThread) };
      }),
  );
  cache(f).peers = { at: f.s.now(), machines };
  return machines;
}

/** GET /factory: read-only and token-less, so like /health it is served only while this machine's dashboard switch
 * is on, and the tailnet listener accepts only an address or this machine's own tailnet name as the Host. */
async function respond(f: FactoryRuntime, req: Request, listener: Listener) {
  const node = f.s.get("node", f.s.nodeId);
  if (!node?.healthDashboard) return new Response("Not found", { status: 404 });
  if (listener === "tailnet" && !ownHost(req.headers.get("host"), node.url))
    return new Response("forbidden host", { status: 403 });
  const headers = { "cache-control": "no-store" };
  if (req.headers.get("accept")?.includes("text/html"))
    return new Response(FACTORY_PAGE, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
  try {
    return Response.json(await buildBoard(f, { includeWebhookUrls: false }), { headers });
  } catch (e) {
    console.error(`factory: the board failed: ${logError(e)}`);
    return Response.json({ error: "the board could not be built" }, { status: 500, headers });
  }
}

/** The rule health.ts applies to /health (DNS rebinding): an IPv4 address or this node's own tailnet name. */
function ownHost(host: string | null, url: string | undefined) {
  const name = host?.replace(/:\d+$/, "");
  if (!name) return false;
  return /^\d+\.\d+\.\d+\.\d+$/.test(name) || (!!url && URL.canParse(url) && name === new URL(url).hostname);
}

const ago = (at: number, now: number) => {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};

const inTime = (at: number, now: number) => {
  const minutes = Math.round((at - now) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
};

/** A scout's schedule, its next run and what its last one filed. */
function scoutText(scout: NonNullable<FactoryBoard["sources"][number]["scout"]>, now: number) {
  const next = scout.enabled ? when(scout.nextAt, `, next ${inTime(scout.nextAt ?? 0, now)}`) : ", disabled";
  const last = scout.lastRun;
  const ran = last
    ? `, last run ${ago(last.at, now)} ${last.state === "reported" ? `filed ${last.filed}${when(last.skipped, ` (skipped ${last.skipped})`)}` : last.state}`
    : "";
  return `${scout.schedule}${next}${ran}`;
}

/** `text` when `value` is set, else nothing: the optional parts of a line. */
const when = (value: unknown, text: string) => (value ? text : "");

/** A webhook's URL, or whether it has one, then whether a delivery can reach it, and its last delivery. */
function webhookText(hook: NonNullable<FactoryBoard["sources"][number]["webhook"]>, now: number) {
  const reach =
    hook.relayServes === false
      ? "the relay does not serve webhook URLs"
      : hook.connected === false
        ? `not connected to the relay${when(hook.error, `: ${hook.error}`)}`
        : undefined;
  const last = hook.lastDelivery
    ? `last delivery ${ago(hook.lastDelivery.at, now)} (${hook.lastDelivery.status})`
    : hook.configured && "no delivery yet";
  return [hook.url ?? (hook.configured ? "configured" : "not configured"), reach, last].filter(Boolean).join(", ");
}

const percent = (rate: number) => `${Math.round(rate * 100)}%`;
const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));

/** The last 7 days' outcomes. */
function metricsText(m: FactoryBoard["metrics"]): string {
  const outcomes = [
    `${m.merged} merged`,
    `merge rate ${percent(m.mergeRate)}`,
    `${m.reverts14d} reverted within 14 days`,
    ...(m.medianHoursToMerge !== undefined ? [`median ${m.medianHoursToMerge.toFixed(1)}h to merge`] : []),
    ...(m.humanTouchesPerItem !== undefined ? [`${m.humanTouchesPerItem.toFixed(1)} human touches per item`] : []),
    ...(m.tokensPerMergedPr !== undefined ? [`${tokens(m.tokensPerMergedPr)} tokens per merged PR`] : []),
  ];
  return `Last 7 days: ${outcomes.join(", ")}`;
}

/** The board for a terminal or an agent. `short` leaves out each machine's threads and the event list. */
export function boardText(b: FactoryBoard, { short = false, now = Date.now() } = {}): string[] {
  const here = (node: string) => when(node === b.node, " (this machine)");
  const lines: string[] = [];
  const failing = b.checks.filter((c) => c.state === "fail");
  if (failing.length)
    lines.push(
      "Failing checks (agentgate factory doctor says how to fix each):",
      ...failing.map((c) => `  ${c.title}${when(c.detail, `: ${c.detail}`)}`),
      "",
    );

  const p = b.factory;
  if (!p) lines.push("Factory: off");
  else {
    lines.push(`Factory: ${p.label} on ${p.node}${here(p.node)}, ${p.online ? "online" : "offline"}`);
    if (p.moving) lines.push(`${movingLabel(p.moving)}; nothing new is taken in until then`);
  }
  if (p && b.frozen?.length) {
    const [count, them] = b.frozen.length === 1 ? ["1 item", "it"] : [`${b.frozen.length} items`, "them"];
    lines.push(
      `Frozen on ${b.node}: ${count}. The factory now runs on ${p.node}, so nothing works on ${them}. agentgate factory move ${b.node} resumes ${them}; agentgate factory drop <id>, run on ${b.node}, closes one.`,
    );
    // By id: a key names the factory machine's item, which may be a new item of the same issue.
    for (const i of b.frozen)
      lines.push(`  ${i.phase.padEnd(9)} ${i.key} ${i.title} (${i.id})${when(i.pr, ` ${i.pr?.url}`)}`);
  }
  if (b.config)
    lines.push(`Config: ${b.config.name} at ${b.config.commit}${when(b.config.error, `, ${b.config.error}`)}`);
  if (b.config?.repositories?.length) lines.push(`Repositories: ${b.config.repositories.join(", ")}`);
  lines.push(`T3 Code: stream ${b.t3.stream}, MCP ${b.t3.mcp}${when(b.t3.error, ` (${b.t3.error})`)}`);
  const c = b.capacity;
  const capacity = [
    ...(c.paused ? ["Paused (agentgate factory resume)"] : []),
    `Capacity: ${c.working} of ${c.threads} threads working`,
    `${c.waitingForYou} of ${c.waitingForYouLimit} waiting for you`,
    `intake ${c.intake}`,
    c.quota === "ok" ? "quota ok" : "waiting for quota",
    ...(c.mainRed.length ? [`main is red in ${c.mainRed.join(", ")}`] : []),
  ];
  lines.push(capacity.join(", "));
  if (p) lines.push(metricsText(b.metrics));

  const waiting = b.items.filter(waitsForYou);
  if (waiting.length) lines.push("", "Needs you:");
  for (const { key, title, needsYou: n, pr, actions } of waiting) {
    lines.push(
      `  ${key} ${title}${n ? when(n.link, ` ${n.link}`) : `: ready for your review${when(pr, ` ${pr?.url}`)}`}`,
    );
    if (n) lines.push(...needsYouLines(key, n, actions).map((l) => `    ${l}`));
  }

  if (b.items.length) lines.push("", "Items:");
  for (const phase of itemPhases)
    for (const i of b.items.filter((i) => i.phase === phase)) {
      const run = i.waiting ? `: ${i.waiting.text}` : when(i.run, ` [${i.run?.kind} ${i.run?.state}]`);
      const unknown = when(i.tokensUnknown, " (tokens unknown)");
      lines.push(`  ${phase.padEnd(9)} ${i.key} ${i.title}${run}${when(i.pr, ` ${i.pr?.url}`)}${unknown}`);
    }

  if (b.sources.length) lines.push("", "Sources:");
  for (const s of b.sources) {
    const hook = s.webhook && webhookText(s.webhook, now);
    const polled = when(s.lastPollAt, `, polled ${ago(s.lastPollAt ?? 0, now)}`);
    const scout = s.scout && scoutText(s.scout, now);
    lines.push(
      `  ${s.id} (${s.type}, ${s.repo})${polled}${when(scout, `, ${scout}`)}${when(hook, `, webhook ${hook}`)}${when(s.error, `: ${s.error}`)}`,
    );
  }

  lines.push("", "Machines:");
  for (const m of b.machines) {
    const needYou = m.threads.filter((t) => t.needsYou).length;
    const hidden = when(m.hidden, `; ${m.hidden} other threads (--all lists them)`);
    const summary = m.online
      ? `${m.threads.length} threads${when(needYou, `, ${needYou} need you`)}${hidden}`
      : "offline";
    lines.push(`  ${m.node}${here(m.node)}: ${summary}`);
    if (short) continue;
    for (const t of m.threads)
      lines.push(
        `    ${t.needsYou ? "!" : "-"} ${t.title}${when(t.project, ` [${t.project}]`)}: ${t.needsYou ? "needs you" : t.status}`,
      );
  }

  if (!short && b.events.length) {
    lines.push("", "Recent:");
    for (const e of b.events.slice(0, 10)) lines.push(`  ${ago(e.at, now)}: ${e.text}`);
  }
  return lines;
}
