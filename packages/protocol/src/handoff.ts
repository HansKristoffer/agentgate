import { z } from "zod";

/** Thread handoff between nodes: what the daemon, CLI and app exchange about T3 Code threads and handoff jobs. */

/** This node's connection to its own T3 Code server. Never carries the bearer token. */
export const t3NodeStateSchema = z.object({
  connected: z.boolean(),
  url: z.string().optional(),
  label: z.string().optional(),
  expiresAt: z.number().optional(),
  /** The bearer token expired or is about to; pair T3 Code again on that node. */
  repair: z.boolean().optional(),
  error: z.string().optional(),
  /** Why the last T3 project sync on this node could not add a project. */
  projectSyncError: z.string().optional(),
});
export type T3NodeState = z.infer<typeof t3NodeStateSchema>;

const t3ThreadSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** The project's name as T3 Code shows it. */
  project: z.string(),
  branch: z.string().nullable(),
  worktree: z.boolean(),
  running: z.boolean(),
  /** A Claude Code thread: the only kind a handoff can move today. */
  claude: z.boolean(),
  updatedAt: z.string(),
  /** What T3's sidebar dates a thread by: the last message, else the last change. */
  lastActivity: z.string(),
  /** Set while it works: when the current work started, for "Working 12m". */
  workingSince: z.string().optional(),
  node: z.string(),
});
export type T3Thread = z.infer<typeof t3ThreadSchema>;

const handoffStatusSchema = z.enum(["running", "imported", "done", "failed"]);
export const handoffJobSchema = z.object({
  id: z.string(),
  role: z.enum(["source", "destination"]),
  /** The node the job runs on. */
  node: z.string(),
  from: z.string(),
  to: z.string(),
  thread: z.string(),
  title: z.string().optional(),
  step: z.string(),
  /** `imported` is success for the user: the thread runs on `to`; the source still archives and stashes. */
  status: handoffStatusSchema,
  destThreadId: z.string().optional(),
  warnings: z.array(z.string()),
  error: z.string().optional(),
  /** Step durations on both sides, in the order they ran. */
  timings: z.array(z.object({ step: z.string(), node: z.string(), ms: z.number() })),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type HandoffJob = z.infer<typeof handoffJobSchema>;

/** One node's view for listings: its T3 connection, active threads and recent handoffs it drove. */
export const nodeThreadsSchema = z.object({
  node: z.string(),
  server: z.boolean(),
  online: z.boolean(),
  t3: t3NodeStateSchema.optional(),
  threads: z.array(t3ThreadSchema),
  jobs: z.array(handoffJobSchema),
  error: z.string().optional(),
});
export type NodeThreads = z.infer<typeof nodeThreadsSchema>;

type HandoffTargetInfo = { node: string; server: boolean; available: boolean; reason?: string };

/** Where a thread on `threadNode` can go. Available: online, reachable over Tailscale, T3 Code connected with a valid
 * token, and not the thread's own node. Shared by the daemon (API, CLI, MCP tools) and the app. */
export function handoffTargets(views: NodeThreads[], threadNode: string): HandoffTargetInfo[] {
  return views.filter((v) => v.node !== threadNode).map((v) => {
    const reason = v.error ?? (!v.t3?.connected ? (v.t3?.url ? "T3 Code token expired; pair T3 Code again there" : "T3 Code not connected") : undefined);
    return { node: v.node, server: v.server, available: !reason, ...(reason && { reason }) };
  }).sort((a, b) => a.node.localeCompare(b.node));
}
/** `to: "server"`: the first available always-on node by node id. */
export const firstServer = (targets: HandoffTargetInfo[]) => targets.find((t) => t.server && t.available);
