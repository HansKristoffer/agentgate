import { z } from "zod";
import { skillIdSchema } from "./skills.ts";
import { aliasesSchema, modelPolicySchema, quotaWindowSchema, cooldownSchema, quotaHealthSchema, modelSnapshotSchema, capabilitiesSchema } from "./proxy.ts";
export * from "./skills.ts";
export * from "./proxy.ts";

export const API_VERSION = 3;
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
  policy: modelPolicySchema.optional(),
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
  logRetentionBytes: z.number().int().min(65536).max(256 * 1024 * 1024).default(16 * 1024 * 1024),
  strategy: z.enum(["automatic", "priority", "round-robin"]).default("automatic"),
  sessionAffinity: z.boolean().default(false),
  affinityTtlMs: z.number().int().min(1000).max(86400000).default(1800000),
  maxAccounts: z.number().int().min(1).max(1000).default(100),
  bootstrapTimeoutMs: z.number().int().min(1000).max(900000).default(660000),
  aliases: aliasesSchema.default([]),
  codexQuotaPolling: z.boolean().default(false),
});
/** Remove defaults before making patches optional: omission must never reset a field. */
export const accountPatchSchema = z.object({
  label: accountSchema.shape.label.optional(), enabled: accountSchema.shape.enabled.removeDefault().optional(),
  priority: accountSchema.shape.priority.removeDefault().optional(), pinned: accountSchema.shape.pinned, policy: accountSchema.shape.policy,
}).strict();
export const settingsPatchSchema = z.object({
  threshold: settingsSchema.shape.threshold.removeDefault().optional(), whenExhausted: settingsSchema.shape.whenExhausted.removeDefault().optional(),
  retryLimit: settingsSchema.shape.retryLimit.removeDefault().optional(), logRetention: settingsSchema.shape.logRetention.removeDefault().optional(),
  logRetentionBytes: settingsSchema.shape.logRetentionBytes.removeDefault().optional(), strategy: settingsSchema.shape.strategy.removeDefault().optional(),
  sessionAffinity: settingsSchema.shape.sessionAffinity.removeDefault().optional(), affinityTtlMs: settingsSchema.shape.affinityTtlMs.removeDefault().optional(),
  maxAccounts: settingsSchema.shape.maxAccounts.removeDefault().optional(), bootstrapTimeoutMs: settingsSchema.shape.bootstrapTimeoutMs.removeDefault().optional(),
  aliases: settingsSchema.shape.aliases.removeDefault().optional(), codexQuotaPolling: settingsSchema.shape.codexQuotaPolling.removeDefault().optional(),
}).strict();
export type Account = z.infer<typeof accountSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Settings = z.infer<typeof settingsSchema>;
/** Saved settings plus the revision produced by the same transaction. */
export type SettingsUpdateResult = Settings & { revision: string };
export const accountStatusSchema = z.object({
  account: accountSchema,
  windows: z.array(quotaWindowSchema),
  revision: z.string().optional(),
  quotaState: z.enum(["unknown", "stale", "fresh"]).optional(),
  quotaHealth: quotaHealthSchema.optional(),
  cooldowns: z.array(cooldownSchema).optional(),
  models: modelSnapshotSchema.optional(),
  modelError: z.string().optional(),
  active: z.boolean(),
  exhausted: z.boolean(),
  needsLogin: z.boolean(),
  expired: z.boolean(),
  exhaustedUntil: z.number().optional(),
  observedAt: z.number().optional(),
  observedBy: z.string().optional(),
  observationSource: z.enum(["headers", "poll", "manual"]).optional(),
  holder: z.string().optional(),
  expiresAt: z.number().optional(),
  refreshError: z.string().optional(),
});
export type AccountStatus = z.infer<typeof accountStatusSchema>;
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
    /** Observed paths to this node; not proof of membership. */
    via?: ("tailnet" | "relay")[];
  })[];
  relay?: RelayStatus;
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
  settingsRevision?: string;
  daemon?: { version: string; build: string; providers: Record<Provider, import("./proxy.ts").ProviderCapabilities> };
  metrics?: import("./proxy.ts").ProxyMetrics;
}
export interface RelayStatus {
  url: string;
  hosted: boolean;
  generation?: string;
  cursor: number;
  pushed: number;
  reconciling: boolean;
  rotating: boolean;
  cleanupPending: boolean;
  pushError?: string;
  pullError?: string;
  /** Entries that could not be decrypted or validated since the last full read. */
  skipped?: number;
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

/** A Claude Desktop login saved on this Mac (never synced). */
export interface DesktopLogin {
  accountUuid: string;
  /** The pool account with the same Claude account, when there is one. */
  accountId?: string;
  label?: string;
  email?: string;
  capturedAt: number;
  sessionExpiresAt?: number;
  expired: boolean;
  /** Set when this login cannot be used, e.g. after a Desktop update changed its storage. */
  problem?: string;
}
/** How Claude Desktop uses Claude: its own sign-in, agentgate's pool (gateway mode), or another gateway. */
export type DesktopMode = "signed-in" | "pool" | "other-gateway";
export interface DesktopStatus {
  /** macOS with Claude.app installed. */
  available: boolean;
  version?: string;
  running: boolean;
  mode: DesktopMode;
  /** The account Desktop is signed in to now (signed-in mode). */
  current?: { accountUuid: string; accountId?: string; label?: string; email?: string; saved: boolean };
  /** Desktop was signed in through agentgate and is now signed out, e.g. after Log out in Desktop. */
  signedOut: boolean;
  logins: DesktopLogin[];
  /** An "add account" is waiting for the user to sign in in Desktop. */
  pendingAdd?: { since: number; expected?: string };
  /** The last "add account" asked for `expected` but Desktop was signed in to another account (which was saved anyway). */
  addMismatch?: { expected: string; accountUuid: string; accountId?: string; label?: string; email?: string };
  /** Claude Code's ~/.claude/settings.json uses the pool (setup --primary). */
  routing: boolean;
  /** ~/.claude.json has the agentgate MCP server (setup --mcp or --primary). */
  mcp: boolean;
}
/** Validate native status before views access required fields from a remote daemon. */
export const statusSchema = z.object({
  apiVersion: z.literal(API_VERSION), node: z.string(),
  accounts: z.array(accountStatusSchema),
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
  settingsRevision: z.string().optional(),
  daemon: z.object({ version: z.string(), build: z.string(), providers: z.object({ claude: capabilitiesSchema, codex: capabilitiesSchema }) }).optional(),
  metrics: z.object({ since: z.number(), total: z.number(), succeeded: z.number(), failed: z.number(), interrupted: z.number(), cancelled: z.number(), fallback: z.number(), averageHeadersMs: z.number().optional(), averageFirstByteMs: z.number().optional() }).optional(),
});
