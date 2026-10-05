import { firstServer, handoffTargets, type HandoffJob, type NodeThreads, type T3NodeState, type T3Thread } from "@agentgate/protocol";
import { lastSeen } from "../sync.ts";
import { peerCall, transport, type Handoffs } from "./jobs.ts";
import { startHandoff, type SourceState } from "./source.ts";
import type { z } from "zod";
import { ACTIVE, T3Error, claudeHomes, connectT3, disconnectT3, pairing, t3Client, t3State, type connectInput } from "./t3.ts";

/** Threads on every node, and which node "server", "here" or a node id means. One rule set for the API, CLI,
 * MCP tools and app, so "To server" picks the same machine everywhere. */

const CACHE = 5 * 60_000;
const RECENT = 10 * 60_000;

async function cached<T>(h: Handoffs, key: string, fn: () => Promise<T>): Promise<T> {
  const hit = h.cache.get(key);
  if (hit && h.s.now() - hit.at < CACHE) return hit.value as T;
  const value = await fn();
  h.cache.set(key, { at: h.s.now(), value });
  return value;
}

async function localThreads(h: Handoffs): Promise<T3Thread[]> {
  const t3 = t3Client(h.s);
  const claudeIds = () => t3.rpc(async (call) => (await claudeHomes(call)).map(([id]) => id));
  const [shell, claude] = await Promise.all([t3.shell(), cached(h, "claude", claudeIds)]);

  // What T3's sidebar lists outside Settled: top-level threads. Subagents move with their parent.
  const listed = shell.threads.filter((t) => {
    const settled = t.settledOverride === "settled";
    const subagent = t.lineage?.relationshipToParent === "subagent";
    return !settled && !subagent;
  });
  const projects = new Map(shell.projects.map((p) => [p.id, projectLabel(p, shell.projects)]));
  return sidebarOrder(listed).map((t) => {
    const running = ACTIVE.has(t.status) || t.status === "queued";
    return {
      id: t.id, title: t.title, project: projects.get(t.projectId) ?? t.projectId, branch: t.branch, worktree: !!t.worktreePath,
      running, claude: claude.includes(t.providerInstanceId), updatedAt: t.updatedAt, node: h.s.nodeId,
      lastActivity: t.latestUserMessageAt ?? t.updatedAt,
      ...(running && t.activityRunStartedAt && { workingSince: t.activityRunStartedAt }),
    };
  });
}

type ProjectShell = { title: string; repositoryIdentity?: { canonicalKey?: string; displayName?: string; name?: string } | null };

/** T3's project label (client-runtime projectGrouping.ts deriveProjectGroupLabel) over the projects of the same
 * repository: a shared title unless it is just the repository's name, else `owner/repo`, else the name.
 * ponytail: T3 also groups projects from its other environments, which this node does not see; for a repository
 * open on several machines T3 may show the shorter name. */
function projectLabel(project: ProjectShell, all: ProjectShell[]) {
  const key = project.repositoryIdentity?.canonicalKey;
  const members = key ? all.filter((p) => p.repositoryIdentity?.canonicalKey === key) : [project];
  const unique = (values: (string | undefined)[]) => [...new Set(values.filter((v): v is string => !!v))];
  const titles = unique(members.map((m) => m.title));
  const displayNames = unique(members.map((m) => m.repositoryIdentity?.displayName));
  const names = unique(members.map((m) => m.repositoryIdentity?.name));
  if (titles.length === 1 && !displayNames.includes(titles[0]!) && !names.includes(titles[0]!)) return titles[0]!;
  if (displayNames.length === 1) return displayNames[0]!;
  if (names.length === 1) return names[0]!;
  return project.title;
}

type Ordered = {
  id: string;
  createdAt: string;
  unsettledAt?: string | null;
  pinnedAt?: string | null;
  pinOrderKey?: string | null;
  activeOrderKey?: string | null;
};

const time = (iso?: string | null) => (iso ? Date.parse(iso) || 0 : 0);
// Order keys are fractional indexes compared code unit by code unit, as T3 does; localeCompare would differ.
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Threads the user dragged into place, in key order, and the others newest first by `anchor`. */
function arranged<T extends Ordered>(threads: T[], key: (t: T) => string | null | undefined, anchor: (t: T) => number) {
  const keyed = threads.filter((t) => key(t) != null).sort((a, b) => byCode(key(a)!, key(b)!) || a.id.localeCompare(b.id));
  const loose = threads.filter((t) => key(t) == null).sort((a, b) => anchor(b) - anchor(a) || a.id.localeCompare(b.id));
  return { keyed, loose };
}

/** T3's default sidebar order (client-runtime threadSort.ts): pinned threads first, arranged ones before the rest;
 * then the others, the rest before arranged ones. Stable while threads run, unlike updatedAt.
 * ponytail: T3's optional "Working" shelf (a client setting) is not mirrored; threads stay in their inbox place. */
export function sidebarOrder<T extends Ordered>(threads: T[]): T[] {
  const pinned = arranged(threads.filter((t) => t.pinnedAt), (t) => t.pinOrderKey, (t) => time(t.createdAt));
  const active = arranged(threads.filter((t) => !t.pinnedAt), (t) => t.activeOrderKey, (t) => Math.max(time(t.createdAt), time(t.unsettledAt)));
  return [...pinned.keyed, ...pinned.loose, ...active.loose, ...active.keyed];
}

/** What this node tells the others (`GET /peer/threads`): its T3 connection, active threads and recent handoffs it drove. */
export async function localView(h: Handoffs): Promise<{ t3: T3NodeState; threads: T3Thread[]; jobs: HandoffJob[]; error?: string }> {
  const recent = (j: { step: string; updatedAt: number }) => !["done", "failed"].includes(j.step) || h.s.now() - j.updatedAt < RECENT;
  const jobs = h.list<SourceState>("source").filter(recent).map((j) => h.view(j));
  const t3 = t3State(h.s);
  if (!t3.connected) return { t3, threads: [], jobs };
  try {
    return { t3, threads: await localThreads(h), jobs };
  } catch (e) {
    return { t3: { ...t3, error: (e as Error).message }, threads: [], jobs };
  }
}

/** Every node's view. Unreachable nodes are listed with the reason instead of failing the whole answer. */
export async function allNodes(h: Handoffs): Promise<NodeThreads[]> {
  return Promise.all(h.s.list("node").map(async (n): Promise<NodeThreads> => {
    const online = n.id === h.s.nodeId || h.s.now() - lastSeen(h.s, n.id) < 60_000;
    const base = { node: n.id, server: n.alwaysOn, online, threads: [], jobs: [] };
    if (n.id === h.s.nodeId) return { ...base, ...(await localView(h)) };
    if (!transport(h.s, n.id)) return { ...base, error: "not paired with this machine over Tailscale or a relay" };
    if (!online) return { ...base, error: "offline" };
    try {
      return { ...base, ...(await peerCall<Awaited<ReturnType<typeof localView>>>(h.s, n.id, "/threads", { timeout: 8000 })) };
    } catch (e) {
      return { ...base, error: (e as Error).message };
    }
  }));
}

export async function resolveTarget(h: Handoffs, threadNode: string, to: string, views?: NodeThreads[]): Promise<string> {
  const list = handoffTargets(views ?? await allNodes(h), threadNode);
  if (to === "server") {
    const pick = firstServer(list);
    if (pick) return pick.node;
    const servers = list.filter((t) => t.server);
    throw new T3Error(servers.length
      ? `no server available: ${servers.map((t) => `${t.node} (${t.reason})`).join(", ")}`
      : "no server: mark an always-on node with agentgate init --always-on or on the Machines screen");
  }
  const node = to === "here" ? h.s.nodeId : to;
  if (node === threadNode) throw new T3Error(`the thread already runs on ${node}`);
  const target = list.find((t) => t.node === node);
  if (!target) throw new T3Error(`no node ${node}`);
  if (!target.available) throw new T3Error(`${node}: ${target.reason}`);
  return node;
}

/** Hand a thread on any node to `to`. The thread's own daemon drives it; "here" keeps meaning the node asked. */
export async function requestHandoff(h: Handoffs, input: { threadId: string; node?: string; to?: string }) {
  const views = await allNodes(h);
  const node = input.node ?? views.find((v) => v.threads.some((t) => t.id === input.threadId))?.node;
  if (!node) throw new T3Error(`no active thread ${input.threadId} on any node`);
  const to = await resolveTarget(h, node, input.to ?? "server", views);
  const handoffId = node === h.s.nodeId
    ? await startHandoff(h, input.threadId, to)
    : (await peerCall<{ handoffId: string }>(h.s, node, "/handoff/request", { json: { threadId: input.threadId, to }, timeout: 60_000 })).handoffId;
  return { handoffId, node, to };
}

/** Connect a node's agentgate to the T3 Code next to it. For another node the pairing token travels over the peer
 * channel, like every other credential, and that node redeems it with its own T3 Code. */
export async function connectNode(h: Handoffs, node: string | undefined, input: z.infer<typeof connectInput>) {
  if (!node || node === h.s.nodeId) return connectT3(h.s, pairing(input));
  return peerCall<T3NodeState>(h.s, node, "/t3/connect", { json: input });
}

export async function disconnectNode(h: Handoffs, node: string | undefined) {
  if (!node || node === h.s.nodeId) return disconnectT3(h.s);
  await peerCall(h.s, node, "/t3/disconnect", { method: "POST" });
}

/** A job by id, here or on the node that drives it. */
export async function handoffJob(h: Handoffs, id: string, node?: string): Promise<HandoffJob | undefined> {
  if (!node || node === h.s.nodeId) {
    const job = h.load("source", id) ?? h.load("destination", id);
    return job && h.view(job);
  }
  return peerCall<HandoffJob>(h.s, node, `/handoff/${encodeURIComponent(id)}/job`);
}
