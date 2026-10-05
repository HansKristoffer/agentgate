import { z } from "zod";
import { skillIdSchema, skillRepoSchema } from "./skills.ts";
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
const b64url = (bytes: number) => z.string().length(Math.ceil(bytes * 4 / 3)).regex(/^[A-Za-z0-9_-]+$/);
export const remoteSchema = z.object({
  /** Names the relay endpoint: `/mcp/<key>`. */
  key: b64url(16),
  /** What the client sends as `Authorization: Bearer <secret>`. */
  secret: b64url(32),
  /** What the serving node authenticates to the relay with. */
  token: b64url(32),
  enabled: z.boolean(),
  servedBy: z.string().min(1).max(512),
  /** Relay base URL, fixed when the endpoint is created. */
  relay: z.string().url().max(2000),
});
export const projectSchema = z.object({
  id: z.string().min(1),
  mcp: z.record(z.string(), z.string()).default({}),
  /** Skill ids linked into this repo's checkouts; on `*`, linked for every session. */
  skills: z.array(skillIdSchema).max(5000).default([]).transform(ids => [...new Set(ids)]),
  /** GitHub repositories whose skills the daemon keeps installed and linked here. Older daemons drop this field. */
  skillRepos: z.array(skillRepoSchema).max(100).default([]).transform(urls => [...new Set(urls)]),
  inheritDefaults: z.boolean().default(true),
  /** Virtual projects only: the public endpoint on the relay. Secrets never leave the daemon in API responses. */
  remote: remoteSchema.optional(),
  seenAt: z.number().int().nonnegative().optional(),
  seenOn: z.string().optional(),
});
/** A virtual project's endpoint as the API shows it: no key material, plus the serving node's live state. */
export const remoteSummarySchema = z.object({
  enabled: z.boolean(),
  servedBy: z.string(),
  url: z.string(),
  /** Known only on the serving node. */
  connected: z.boolean().optional(),
  /** The relay has not acknowledged the current secret yet. */
  updating: z.boolean().optional(),
  error: z.string().optional(),
  /** Servers that could not be reached on the serving node at the last request. */
  failedAliases: z.array(z.string()).optional(),
  lastCall: z.number().optional(),
});
export type RemoteSummary = z.infer<typeof remoteSummarySchema>;
export const publicProjectSchema = projectSchema.extend({ remote: remoteSummarySchema.optional() });
export type PublicProject = z.infer<typeof publicProjectSchema>;
export const nodeSchema = z.object({
  id: z.string(),
  url: z.string().optional(),
  alwaysOn: z.boolean().default(false),
  /** Sync features this node's daemon understands; 2 = remote MCP endpoints. Absent on older daemons. */
  protocol: z.number().int().optional(),
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
  /** The name the user gave it; `id` is its slug and tool prefix. */
  label?: string;
  template: string;
  transport: "http" | "stdio";
  mode: "shared" | "perSession";
  endpoint: string;
  loggedIn: boolean;
  needsLogin: boolean;
  /** Whether this node reached it when it last connected (Test or a session); absent until then. */
  available?: boolean;
  checkedAt?: number;
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
/** A connected GitHub repository; `projects` are where its skills are linked when they first appear. */
export interface SkillRepoSummary {
  url: string;
  projects: string[];
  skills: string[];
  commit?: string;
  syncedAt?: number;
  error?: string;
  /** Skills in the repository that could not be installed, with the reason. */
  skipped: string[];
}
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
  label: string;
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
  projects: PublicProject[];
  skills: SkillSummary[];
  /** Skill links this node skipped because something else already uses the name. */
  skillConflicts: string[];
  skillHealth: SkillHealth;
  skillRepos: SkillRepoSummary[];
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
  servers: z.array(z.object({ id: z.string(), label: z.string().optional(), template: z.string(), transport: z.enum(["http", "stdio"]), mode: z.enum(["shared", "perSession"]), endpoint: z.string(), loggedIn: z.boolean(), needsLogin: z.boolean(), available: z.boolean().optional(), checkedAt: z.number().optional(), refreshError: z.string().optional() })),
  projects: z.array(publicProjectSchema),
  skills: z.array(z.object({ id: skillIdSchema, description: z.string(), source: z.string().optional(), hash: z.string().optional(), contentHash: z.string().optional(), updatedAt: z.number(), size: z.number().int().nonnegative() })),
  skillConflicts: z.array(z.string()),
  skillRepos: z.array(z.object({ url: z.string(), projects: z.array(z.string()), skills: z.array(z.string()), commit: z.string().optional(), syncedAt: z.number().optional(), error: z.string().optional(), skipped: z.array(z.string()) })).default([]),
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
