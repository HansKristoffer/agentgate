import { z } from "zod";

export const API_VERSION = 1;
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
  servers: ServerSummary[];
  projects: Project[];
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
