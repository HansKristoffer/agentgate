import type { Failure, ProviderCapabilities, QuotaWindow } from "@agentgate/protocol";
import type { Tokens } from "../credentials.ts";
import type { Credential, Usage } from "../store.ts";
export type ProviderName = "claude" | "codex" | "cursor";
export type Window = QuotaWindow;
export type Observation = { windows: Window[]; status: Usage["status"] };
export interface Provider {
  name: ProviderName;
  prepare(path: string, headers: Headers, body: Uint8Array | undefined, cred: Credential): { url: string; headers: Headers; body?: Uint8Array };
  usage(headers: Headers): Observation | undefined;
  classify429(headers: Headers, body: string): "quota" | "rate";
  classifyFailure?(status: number, headers: Headers, body: string): Failure;
  refresh(refreshToken: string): Promise<Tokens>;
  pooled(path: string): boolean;
  fetchQuota?(credential: Credential, signal: AbortSignal): Promise<Observation | undefined>;
  discoverModels?(credential: Credential, signal: AbortSignal): Promise<string[]>;
  modelList?(path: string): { collection: "data" | "models"; id: "id" | "slug" } | undefined;
  /** Model id in a request body. The pool uses the top-level `model` field when this is absent. */
  requestedModel?(body: Record<string, unknown> | undefined): string | undefined;
  /** Write a resolved alias back into the field `requestedModel` read. */
  rewriteModel?(body: Record<string, unknown>, model: string): Record<string, unknown>;
  session?(headers: Headers, body: Record<string, unknown> | undefined): string | undefined;
  stateful?(body: Record<string, unknown> | undefined): boolean;
  probe?: { path: string; body: (model: string) => Record<string, unknown> };
  /** When false, a pooled success without quota headers is normal: quota is read another way. */
  headerQuota?: boolean;
}
export function capabilities(provider: Provider): ProviderCapabilities {
  return { quota: !!provider.fetchQuota, models: !!provider.discoverModels, session: !!provider.session, probe: !!provider.probe };
}
export function classify(provider: Provider, status: number, headers: Headers, body: string): Failure {
  if (status === 429) return provider.classify429(headers, body);
  if (status === 401) return "login";
  if (provider.classifyFailure) return provider.classifyFailure(status, headers, body);
  return status >= 500 ? "transient" : "request";
}
