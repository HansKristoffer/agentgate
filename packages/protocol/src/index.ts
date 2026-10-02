import { z } from "zod";
import { skillIdSchema } from "./skills.ts";
export * from "./skills.ts";

export const API_VERSION = 2;
export const providerSchema = z.enum(["claude", "codex"]);
export type Provider = z.infer<typeof providerSchema>;
export const accountSchema = z.object({
  id: z.string(),
  provider: providerSchema,
  label: z.string(),
  email: z.string().optional(),
  plan: z.string().optional(),
  enabled: z.boolean().default(true),
  priority: z.number().finite().default(0),
  pinned: z.boolean().optional(),
});
export const projectSchema = z.object({
  id: z.string().min(1),
  mcp: z.record(z.string(), z.string()).default({}),
  /** Skill ids linked into this repo's checkouts; on `*`, linked for every session. */
  skills: z.array(skillIdSchema).max(5000).default([]).transform(ids => [...new Set(ids)]),
  inheritDefaults: z.boolean().default(true),
  seenAt: z.number().int().nonnegative().optional(),
  seenOn: z.string().optional(),
});
export const nodeSchema = z.object({
  id: z.string(),
  url: z.string().optional(),
  alwaysOn: z.boolean().default(false),
});
export const settingsSchema = z.object({
  threshold: z.number().min(1).max(100).default(98),
  whenExhausted: z.enum(["fail", "wait"]).default("fail"),
  retryLimit: z.number().int().min(0).max(10).default(3),
  logRetention: z.number().int().min(100).max(100000).default(5000),
});
export type Account = z.infer<typeof accountSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export interface AccountStatus {
  account: Account;
  windows: { name: string; usedPct: number; resetsAt?: number }[];
  active: boolean;
  exhausted: boolean;
  needsLogin: boolean;
  expired: boolean;
  exhaustedUntil?: number;
  observedBy?: string;
  holder?: string;
  expiresAt?: number;
  refreshError?: string;
}
export interface ServerSummary {
  id: string;
  template: string;
  transport: "http" | "stdio";
  mode: "shared" | "perSession";
  endpoint: string;
  loggedIn: boolean;
  needsLogin: boolean;
  refreshError?: string;
}
export interface SkillSummary {
  id: string;
  description: string;
  /** What `npx skills add` was given; absent for skills written by hand. */
  source?: string;
  hash?: string;
  contentHash?: string;
  updatedAt: number;
  size: number;
}
/** A skill found by `npx skills add`, not yet installed. */
export interface SkillPreview {
  id: string;
  description: string;
  files: number;
  size: number;
  hash?: string;
  /** The skills.sh audit, e.g. `{ gen: "low", socket: "0 alerts", details: url }`. */
  security?: Record<string, string>;
  installed: boolean;
  conflict?: string;
}
export interface SkillPreviewResponse { token: string; skills: SkillPreview[]; }
export interface SkillHealth {
  attemptedAt?: number;
  succeededAt?: number;
  errors: { path: string; message: string }[];
}
export interface SkillSearchResult {
  source: string;
  skill: string;
  installs: number;
}
export interface Preset {
  id: string;
  url?: string;
  command?: string;
  args?: string[];
  note?: string;
}
export interface Activity {
  at: number;
  provider: string;
  account: string;
  model: string;
  status: number;
  ms: number;
  note: string;
}
export interface Status {
  apiVersion: number;
  node: string;
  accounts: AccountStatus[];
  /** Claude Code / Codex logins on the daemon's machine that are not in the pool yet. Identity only, no tokens. */
  detected: { provider: Provider; email: string; plan?: string; source: string }[];
  servers: ServerSummary[];
  projects: Project[];
  skills: SkillSummary[];
  /** Skill links this node skipped because something else already uses the name. */
  skillConflicts: string[];
  skillHealth: SkillHealth;
  /** Local checkouts that receive project skills on this node, with the skills the repository itself contains. */
  checkouts: { path: string; project: string; skills: string[]; mirror: boolean }[];
  nodes: (z.infer<typeof nodeSchema> & {
    lastSeen: number;
    online: boolean;
    syncError?: string;
  })[];
  peers: {
    node: string;
    url: string;
    lastSeen: number;
    cursor: number;
    error?: string;
  }[];
  unknownQuota: Record<string, string | undefined>;
  settings: Settings;
  activity: Activity[];
}
export interface LoginStart {
  state: string;
  url: string;
  provider: Provider;
}
export interface ToolPreview {
  name: string;
  description?: string;
  error?: string;
}
export interface Connection {
  url: string;
  token?: string;
}

/** Validate native status before views access required fields from a remote daemon. */
export const statusSchema = z.object({
  apiVersion: z.literal(API_VERSION), node: z.string(),
  accounts: z.array(z.object({
    account: accountSchema,
    windows: z.array(z.object({ name: z.string(), usedPct: z.number(), resetsAt: z.number().optional() })),
    active: z.boolean(), exhausted: z.boolean(), needsLogin: z.boolean(), expired: z.boolean(),
    exhaustedUntil: z.number().optional(), observedBy: z.string().optional(), holder: z.string().optional(), expiresAt: z.number().optional(), refreshError: z.string().optional(),
  })),
  detected: z.array(z.object({ provider: providerSchema, email: z.string(), plan: z.string().optional(), source: z.string() })),
  servers: z.array(z.object({ id: z.string(), template: z.string(), transport: z.enum(["http", "stdio"]), mode: z.enum(["shared", "perSession"]), endpoint: z.string(), loggedIn: z.boolean(), needsLogin: z.boolean(), refreshError: z.string().optional() })),
  projects: z.array(projectSchema),
  skills: z.array(z.object({ id: skillIdSchema, description: z.string(), source: z.string().optional(), hash: z.string().optional(), contentHash: z.string().optional(), updatedAt: z.number(), size: z.number().int().nonnegative() })),
  skillConflicts: z.array(z.string()),
  skillHealth: z.object({ attemptedAt: z.number().optional(), succeededAt: z.number().optional(), errors: z.array(z.object({ path: z.string(), message: z.string() })) }),
  checkouts: z.array(z.object({ path: z.string(), project: z.string(), skills: z.array(z.string()), mirror: z.boolean() })),
  nodes: z.array(nodeSchema.extend({ lastSeen: z.number(), online: z.boolean(), syncError: z.string().optional() })),
  peers: z.array(z.object({ node: z.string(), url: z.string(), lastSeen: z.number(), cursor: z.number(), error: z.string().optional() })),
  unknownQuota: z.record(z.string(), z.string().optional()), settings: settingsSchema,
  activity: z.array(z.object({ at: z.number(), provider: z.string(), account: z.string(), model: z.string(), status: z.number(), ms: z.number(), note: z.string() })),
});
