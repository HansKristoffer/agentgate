import { itemPhases, movingLabel, type BoardThread, type FactoryBoard } from "@agentgate/protocol";
import { z } from "zod";
import type { Listener } from "../daemon.ts";
import { peerCall } from "../handoff/jobs.ts";
import { localView, peerView, type ViewThread } from "../handoff/threads.ts";
import { lastSeen } from "../sync.ts";
import { frozenItems } from "./controller.ts";
import { runs } from "./db.ts";
import { folderStore } from "./folder-store.ts";
import { mirrorOf, timing } from "./mirror.ts";
import { needsYouLines } from "./needs-you.ts";
import { FACTORY_PAGE } from "./page.ts";
import { logError, operation, UsageError, type FactoryRuntime } from "./runtime.ts";
import { needsSignIn } from "./t3-mcp.ts";

/**
 * The board: every machine's T3 threads and what the factory's features add through `f.boardParts`. One builder serves
 * the `/factory` page, `GET /api/factory`, which the app polls, and the `status` operation.
 */

/** How long other machines' threads, read through `/peer/threads`, are reused. */
const PEER_EVERY = 10_000;
/** How long the token-less page's board is reused: every open page asks for it. */
const PAGE_EVERY = 5000;

export function setup(f: FactoryRuntime) {
  f.page = (req, listener) => respond(f, req, listener);
  f.api.get("/", async (c) => c.json(await boardView(f, { includeWebhookUrls: true })));
  // Paired machines may see webhook URLs: they already share every secret.
  f.peer.get("/board", async (c) => c.json(await buildBoard(f, { includeWebhookUrls: true })));
  // Local: `boardView` asks the factory machine for its board itself, and adds what only this machine knows.
  const short = (board: FactoryBoard) => boardText(board, { short: true }).join("\n");
  operation(f, {
    name: "status",
    summary: "the board: items by phase, what waits for you, capacity, sources and every machine's threads",
    input: z.object({}),
    local: true,
    // A person at this machine or in the app sees the webhook URLs; an agent and a remote endpoint do not.
    run: (_, caller) => boardView(f, { includeWebhookUrls: caller.via === "terminal" || caller.via === "api" }),
    terminal: {
      usage: "status [--json]",
      parse(args) {
        if (args.some((a) => a !== "--json")) throw new UsageError();
        return { input: {}, json: args.includes("--json") };
      },
      print: (board, { json }) => (json ? [JSON.stringify(board, null, 2)] : boardText(board)),
    },
    tool: {
      name: "factory_status",
      description:
        "The software factory's board as short text: its items by phase, what waits on a person, capacity, sources and every machine's T3 Code threads.",
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
export async function boardView(f: FactoryRuntime, opts: { includeWebhookUrls: boolean }): Promise<FactoryBoard> {
  const pointer = f.pointer();
  if (!pointer || f.isFactoryNode()) return buildBoard(f, opts);
  try {
    // A paired machine's own board, passed through: parsing it here again would show a newer factory machine, whose
    // board has a field or value this one does not know, as offline.
    const board = await peerCall<FactoryBoard>(f.s, pointer.node, "/factory/board", { timeout: 8000 });
    const frozen = frozenItems(f);
    return strip({ ...board, node: f.s.nodeId, frozen: frozen.length ? frozen : undefined }, opts);
  } catch {
    // The factory machine is unreachable or runs an older agentgate: show this machine's board, the factory offline.
    const board = await buildBoard(f, opts);
    return { ...board, factory: board.factory && { ...board.factory, online: false } };
  }
}

export async function buildBoard(f: FactoryRuntime, opts: { includeWebhookUrls: boolean }): Promise<FactoryBoard> {
  const { stream, error } = mirrorOf(f).status();
  const base: FactoryBoard = {
    node: f.s.nodeId,
    factory: pointerRow(f),
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
    machines: await machines(f),
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
  return strip(parts.reduce(merge, base), opts);
}

const defined = <T extends object>(o: T | undefined) =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

/** Arrays add up (items by id, the later part winning), sources by id key by key, `t3` and `capacity` merge key by
 * key, and any other key is the later part's. `t3` merges because the mirror and the T3 sign-in each report half of
 * it, and a source row because the controller reports its polls and the webhooks its URL. */
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

/** Webhook URLs carry the hook's key, so the token-less page and agents never see them. */
function strip(board: FactoryBoard, { includeWebhookUrls }: { includeWebhookUrls: boolean }): FactoryBoard {
  if (includeWebhookUrls) return board;
  return {
    ...board,
    sources: board.sources.map(({ webhook, ...source }) =>
      webhook ? { ...source, webhook: { configured: webhook.configured } } : source,
    ),
  };
}

function pointerRow(f: FactoryRuntime): FactoryBoard["factory"] {
  const pointer = f.pointer();
  if (!pointer) return null;
  const seen = lastSeen(f.s, pointer.node);
  const { moveTo: _, ...rest } = pointer;
  return {
    ...rest,
    label: folderStore(f, pointer).label,
    online: f.s.now() - seen < 60_000,
    ...(seen > 0 && { lastSeenAt: seen }),
  };
}

/** This machine first, live from the mirror while it drives factory work, then the others. */
async function machines(f: FactoryRuntime): Promise<FactoryBoard["machines"]> {
  const [here, others] = await Promise.all([localThreads(f), peerMachines(f)]);
  // A factory run's thread names its item.
  const ids = [...here, ...others.flatMap((m) => m.threads)].map((t) => t.id);
  const byThread = new Map(runs.byThreads(f.s, ids).map((r) => [r.threadId!, r]));
  const linked = (t: BoardThread): BoardThread => {
    const run = byThread.get(t.id);
    return run ? { ...t, ...(run.item && { item: run.item }), ...(run.threadLink && { link: run.threadLink }) } : t;
  };
  return [{ node: f.s.nodeId, online: true, threads: here }, ...others].map((m) => ({
    ...m,
    threads: m.threads.map(linked),
  }));
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

const peerCache = new WeakMap<FactoryRuntime, { at: number; machines: Promise<FactoryBoard["machines"]> }>();

function peerMachines(f: FactoryRuntime) {
  const cached = peerCache.get(f);
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
  peerCache.set(f, { at: f.s.now(), machines });
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
    return Response.json(await pageBoard(f), { headers });
  } catch (e) {
    console.error(`factory: the board failed: ${logError(e)}`);
    return Response.json({ error: "the board could not be built" }, { status: 500, headers });
  }
}

const pageCache = new WeakMap<FactoryRuntime, { at: number; board: Promise<FactoryBoard> }>();

/** The page's board, built at most every 5 seconds however many pages are open. */
function pageBoard(f: FactoryRuntime) {
  const cached = pageCache.get(f);
  if (cached && f.s.now() - cached.at < PAGE_EVERY) return cached.board;
  const board = buildBoard(f, { includeWebhookUrls: false });
  pageCache.set(f, { at: f.s.now(), board });
  board.catch(() => pageCache.delete(f));
  return board;
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

  const waiting = b.items.filter((i) => i.needsYou || i.phase === "ready");
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
    const hook = s.webhook && (s.webhook.url ?? (s.webhook.configured ? "configured" : "not configured"));
    const polled = when(s.lastPollAt, `, polled ${ago(s.lastPollAt ?? 0, now)}`);
    const scout = s.scout && scoutText(s.scout, now);
    lines.push(
      `  ${s.id} (${s.type}, ${s.repo})${polled}${when(scout, `, ${scout}`)}${when(hook, `, webhook ${hook}`)}${when(s.error, `: ${s.error}`)}`,
    );
  }

  lines.push("", "Machines:");
  for (const m of b.machines) {
    const needYou = m.threads.filter((t) => t.needsYou).length;
    const summary = m.online ? `${m.threads.length} threads${when(needYou, `, ${needYou} need you`)}` : "offline";
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
