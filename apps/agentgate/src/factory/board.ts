import { factoryBoardSchema, itemPhases, type BoardThread, type FactoryBoard } from "@agentgate/protocol";
import type { Listener } from "../daemon.ts";
import { peerCall } from "../handoff/jobs.ts";
import { localView, peerView, type ViewThread } from "../handoff/threads.ts";
import { lastSeen } from "../sync.ts";
import { runs } from "./db.ts";
import { mirrorOf, timing } from "./mirror.ts";
import { FACTORY_PAGE } from "./page.ts";
import type { FactoryRuntime } from "./runtime.ts";

/**
 * The board: every machine's T3 threads and what the factory's features add through `f.boardParts`. One builder serves
 * the `/factory` page, `GET /api/factory`, `agentgate factory status` and the `factory_status` tool.
 */

/** How long other machines' threads, read through `/peer/threads`, are reused. */
const PEER_EVERY = 10_000;

export function setup(f: FactoryRuntime) {
  f.page = (req, listener) => respond(f, req, listener);
  f.api.get("/", async (c) => c.json(await boardView(f, { includeWebhookUrls: true })));
  // Paired machines may see webhook URLs: they already share every secret.
  f.peer.get("/board", async (c) => c.json(await buildBoard(f, { includeWebhookUrls: true })));
  f.commands.set("status", {
    usage: "status [--json]",
    local: true,
    async run(args, io) {
      if (args.some((a) => a !== "--json")) {
        io.out("usage: agentgate factory status [--json]");
        return 2;
      }
      const board = await boardView(f, { includeWebhookUrls: true });
      if (args.includes("--json")) io.out(JSON.stringify(board, null, 2));
      else boardText(board).forEach((line) => io.out(line));
      return 0;
    },
  });
  f.tools.set("factory_status", {
    name: "factory_status",
    description:
      "The software factory's board as short text: its items by phase, what waits on a person, capacity, sources and every machine's T3 Code threads.",
    inputSchema: { type: "object", properties: {} },
    local: true,
    call: async () => boardText(await boardView(f, { includeWebhookUrls: false }), { short: true }).join("\n"),
  });
  // Starts the mirror once the factory is turned on or T3 Code connected, and stops it when either goes.
  f.loops.push({ name: "t3-mirror", everyMs: timing.pollMs, where: "every-node", run: async () => void mirrorOf(f) });
}

/** The board as this machine shows it to the API and CLI: the factory machine's, when that is another machine. */
export async function boardView(f: FactoryRuntime, opts: { includeWebhookUrls: boolean }): Promise<FactoryBoard> {
  const pointer = f.pointer();
  if (!pointer || f.isFactoryNode()) return buildBoard(f, opts);
  try {
    const board = factoryBoardSchema.parse(await peerCall(f.s, pointer.node, "/factory/board", { timeout: 8000 }));
    return strip({ ...board, node: f.s.nodeId }, opts);
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
    metrics: { merged: 0, mergeRate: 0, reverts14d: 0, scorers: [] },
    events: f.events.recent(50),
  };
  const parts = await Promise.all(
    f.boardParts.map((part) =>
      part().catch((e) => {
        // The name only: a feature's error text can carry a token or a URL with credentials.
        console.error(`factory: a board part failed: ${e instanceof Error ? e.name : "error"}`);
        return {};
      }),
    ),
  );
  return strip(parts.reduce(merge, base), opts);
}

const defined = <T extends object>(o: T | undefined) =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

/** Arrays add up (items by id, the later part winning), `metrics`, `t3` and `capacity` merge key by key, and any
 * other key is the later part's. `t3` merges because the mirror and the T3 sign-in each report half of it. */
function merge(board: FactoryBoard, part: Partial<FactoryBoard>): FactoryBoard {
  const { items, sources, machines, events, metrics, t3, capacity, ...rest } = part;
  return {
    ...board,
    ...defined(rest),
    items: [...new Map([...board.items, ...(items ?? [])].map((i) => [i.id, i])).values()],
    sources: [...board.sources, ...(sources ?? [])],
    machines: [...board.machines, ...(machines ?? [])],
    events: [...board.events, ...(events ?? [])],
    metrics: {
      ...board.metrics,
      ...defined(metrics),
      scorers: [...board.metrics.scorers, ...(metrics?.scorers ?? [])],
    },
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
  return {
    repo: pointer.repo,
    path: pointer.path,
    ...(pointer.ref && { ref: pointer.ref }),
    node: pointer.node,
    online: f.s.now() - seen < 60_000,
    ...(seen > 0 && { lastSeenAt: seen }),
  };
}

/** This machine first, live from the mirror while the factory is on, then the others. */
async function machines(f: FactoryRuntime): Promise<FactoryBoard["machines"]> {
  const [here, others] = await Promise.all([localThreads(f), peerMachines(f)]);
  // A factory run's thread names its item.
  const byThread = new Map(runs.list(f.s).flatMap((r) => (r.threadId ? [[r.threadId, r] as const] : [])));
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
  if (!f.pointer()) return (await localView(f.ctx.handoffs)).threads.map(viewThread);
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
    return Response.json(await buildBoard(f, { includeWebhookUrls: false }), { headers });
  } catch (e) {
    console.error(`factory: the board failed: ${e instanceof Error ? e.name : "error"}`);
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

/** `text` when `value` is set, else nothing: the optional parts of a line. */
const when = (value: unknown, text: string) => (value ? text : "");

/** The board for a terminal or an agent. `short` leaves out each machine's threads and the event list. */
export function boardText(b: FactoryBoard, { short = false, now = Date.now() } = {}): string[] {
  const here = (node: string) => when(node === b.node, " (this machine)");
  const lines: string[] = [];

  const p = b.factory;
  if (!p) lines.push("Factory: off");
  else {
    const folder = `${p.repo}${when(p.path, `:${p.path}`)}${when(p.ref, ` at ${p.ref}`)}`;
    lines.push(`Factory: ${folder} on ${p.node}${here(p.node)}, ${p.online ? "online" : "offline"}`);
  }
  if (b.config)
    lines.push(`Config: ${b.config.name} at ${b.config.commit}${when(b.config.error, `, ${b.config.error}`)}`);
  lines.push(`T3 Code: stream ${b.t3.stream}, MCP ${b.t3.mcp}${when(b.t3.error, ` (${b.t3.error})`)}`);
  const c = b.capacity;
  const capacity = [
    `Capacity: ${c.working} of ${c.threads} threads working`,
    `${c.waitingForYou} of ${c.waitingForYouLimit} waiting for you`,
    `intake ${c.intake}`,
    c.quota === "ok" ? "quota ok" : "waiting for quota",
    ...(c.mainRed.length ? [`main is red in ${c.mainRed.join(", ")}`] : []),
  ];
  lines.push(capacity.join(", "));

  const waiting = b.items.flatMap((i) => (i.needsYou ? [{ ...i, needsYou: i.needsYou }] : []));
  if (waiting.length) lines.push("", "Needs you:");
  for (const { key, title, needsYou: n } of waiting)
    lines.push(`  ${key} ${title}: ${n.reason}${when(n.question, `: ${n.question}`)}${when(n.link, ` ${n.link}`)}`);

  if (b.items.length) lines.push("", "Items:");
  for (const phase of itemPhases)
    for (const i of b.items.filter((i) => i.phase === phase)) {
      const run = when(i.run, ` [${i.run?.kind} ${i.run?.state}]`);
      lines.push(`  ${phase.padEnd(9)} ${i.key} ${i.title}${run}${when(i.pr, ` ${i.pr?.url}`)}`);
    }

  if (b.sources.length) lines.push("", "Sources:");
  for (const s of b.sources) {
    const hook = s.webhook && (s.webhook.url ?? (s.webhook.configured ? "configured" : "not configured"));
    const polled = when(s.lastPollAt, `, polled ${ago(s.lastPollAt ?? 0, now)}`);
    lines.push(
      `  ${s.id} (${s.type}, ${s.repo})${polled}${when(hook, `, webhook ${hook}`)}${when(s.error, `: ${s.error}`)}`,
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
