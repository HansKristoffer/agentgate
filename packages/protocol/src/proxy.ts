import { z } from "zod";

export const providerSchema = z.enum(["claude", "codex", "cursor"]);
export type Provider = z.infer<typeof providerSchema>;

export const modelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/,
    "Use a model identifier, not a URL or arbitrary text",
  )
  .refine((value) => !value.includes("://"), "URLs are not model identifiers");
export const modelPolicySchema = z
  .object({
    retryLimit: z.number().int().min(0).max(10).optional(),
    allowModels: z.array(modelIdSchema).max(200).optional(),
    excludeModels: z.array(modelIdSchema).max(200).optional(),
  })
  .strict();
export const aliasSchema = z
  .object({
    provider: z.enum(["claude", "codex"]),
    alias: modelIdSchema,
    target: modelIdSchema,
  })
  .strict();
export const aliasesSchema = z
  .array(aliasSchema)
  .max(200)
  .superRefine((rows, ctx) => {
    const map = new Map<string, string>();
    for (const [index, row] of rows.entries()) {
      const key = `${row.provider}:${row.alias}`;
      if (map.has(key))
        ctx.addIssue({
          code: "custom",
          path: [index, "alias"],
          message: "Duplicate alias",
        });
      map.set(key, row.target);
    }
    for (const [index, row] of rows.entries()) {
      const seen = new Set<string>();
      let next: string | undefined = row.alias;
      while (next !== undefined) {
        if (seen.has(next)) {
          ctx.addIssue({
            code: "custom",
            path: [index],
            message: "Alias cycle",
          });
          break;
        }
        seen.add(next);
        next = map.get(`${row.provider}:${next}`);
      }
    }
  });
export const quotaWindowSchema = z.object({
  name: z.string().min(1).max(128),
  usedPct: z.number().finite().min(0).max(100),
  resetsAt: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().positive().optional(),
  scope: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("account") }),
      z.object({ kind: z.literal("family"), family: modelIdSchema }),
      z.object({ kind: z.literal("model"), model: modelIdSchema }),
    ])
    .optional(),
  inferredReset: z.boolean().optional(),
});
export type QuotaWindow = z.infer<typeof quotaWindowSchema>;
/** Interpret legacy window names once, shared by routing and quota presentation. */
export function normalizeQuotaWindow(window: QuotaWindow): QuotaWindow {
  const [duration = "", family] = window.name.split(":");
  const durationMs =
    duration === "5h"
      ? 5 * 3600000
      : duration === "7d"
        ? 7 * 86400000
        : /^\d+m$/.test(duration)
          ? Number(duration.slice(0, -1)) * 60000
          : undefined;
  return {
    ...window,
    durationMs: window.durationMs ?? durationMs,
    scope:
      window.scope ??
      (family ? { kind: "family", family } : { kind: "account" }),
  };
}
export function matchesQuotaWindow(
  window: QuotaWindow,
  model?: string,
): boolean {
  const scope = normalizeQuotaWindow(window).scope!;
  if (scope.kind === "account") return true;
  if (!model) return false;
  if (scope.kind === "model") return model === scope.model;
  // A family is a whole identifier segment: "notopus" does not match "opus".
  return model
    .toLowerCase()
    .split(/[-._/]/)
    .includes(scope.family.toLowerCase());
}
export const failureSchema = z.enum([
  "quota",
  "rate",
  "login",
  "model",
  "transient",
  "request",
  "cancelled",
  "budget",
  "stateful",
]);
export type Failure = z.infer<typeof failureSchema>;
export const cooldownSchema = z.object({
  accountId: z.string(),
  scope: z.enum(["account", "model"]),
  model: z.string().optional(),
  reason: failureSchema,
  retryAt: z.number(),
  observedAt: z.number(),
});
export type Cooldown = z.infer<typeof cooldownSchema>;
export const capabilitiesSchema = z.object({
  quota: z.boolean(),
  models: z.boolean(),
  session: z.boolean(),
  probe: z.boolean(),
});
export type ProviderCapabilities = z.infer<typeof capabilitiesSchema>;
export const requestOutcomeSchema = z.enum([
  "pending",
  "success",
  "failed",
  "interrupted",
  "cancelled",
]);
export const proxyRequestSchema = z.object({
  id: z.string(),
  at: z.number(),
  provider: providerSchema,
  requestedModel: z.string(),
  routedModel: z.string(),
  account: z.string(),
  selection: z.string(),
  status: z.number(),
  outcome: requestOutcomeSchema,
  failure: failureSchema.optional(),
  attempts: z.number(),
  headersMs: z.number().optional(),
  firstByteMs: z.number().optional(),
  durationMs: z.number().optional(),
  stream: z
    .enum([
      "none",
      "eof",
      "completed",
      "provider-error",
      "idle-timeout",
      "upstream-error",
      "cancelled",
    ])
    .optional(),
});
export type ProxyRequest = z.infer<typeof proxyRequestSchema>;
export const proxyAttemptSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  number: z.number(),
  account: z.string(),
  selection: z.string(),
  at: z.number(),
  status: z.number(),
  headersMs: z.number(),
  failure: failureSchema.optional(),
});
export type ProxyAttempt = z.infer<typeof proxyAttemptSchema>;
export interface RequestPage {
  requests: ProxyRequest[];
  nextCursor?: string;
  cursorReset: boolean;
}
export interface RequestDetail {
  request: ProxyRequest;
  attempts: ProxyAttempt[];
}
export interface ProxyMetrics {
  since: number;
  total: number;
  succeeded: number;
  failed: number;
  interrupted: number;
  cancelled: number;
  fallback: number;
  averageHeadersMs?: number;
  averageFirstByteMs?: number;
}
/** Tokens one model used on this node, summed over every account. */
export interface ModelTokens {
  provider: Provider;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface RouteExplanation {
  provider: Provider;
  requestedModel?: string;
  routedModel?: string;
  strategy: "automatic" | "priority" | "round-robin";
  account?: string;
  reason: string;
  candidates: {
    id: string;
    eligible: boolean;
    reasons: string[];
    inFlight: number;
  }[];
}
export const checkSchema = z.object({
  status: z.enum(["ok", "failed", "unsupported", "obsolete"]),
  message: z.string(),
});
export type Check = z.infer<typeof checkSchema>;
export interface Verification {
  accountId: string;
  at: number;
  node: string;
  checks: { credential: Check; quota: Check; models: Check; probe?: Check };
}
export interface BatchResult {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}
export const quotaHealthSchema = z.object({
  attemptedAt: z.number().optional(),
  succeededAt: z.number().optional(),
  error: z.string().optional(),
});
export const modelSnapshotSchema = z.object({
  at: z.number(),
  models: z.array(modelIdSchema).max(1000),
});
export type ModelSnapshot = z.infer<typeof modelSnapshotSchema>;
export class ConfigurationConflict extends Error {
  constructor() {
    super("Configuration changed. Reload or reapply your draft.");
  }
}
