import type { Failure, Provider as ProviderName, ProviderCapabilities, QuotaWindow } from "@agentgate/protocol";
import { isRecord, safeJsonParse } from "hanzio";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tokens } from "../credentials.ts";
import { saveAccount } from "../operations.ts";
import type { Credential, Store, Usage } from "../store.ts";
export type { ProviderName };
export type Window = QuotaWindow;
export type Observation = { windows: Window[]; status: Usage["status"] };
export interface Provider {
  name: ProviderName;
  /** `json` is `body` already parsed, when it is a JSON object; return `body` itself unless the bytes must change. */
  prepare(
    path: string,
    headers: Headers,
    body: Uint8Array | undefined,
    cred: Credential,
    json?: Record<string, unknown>,
  ): { url: string; headers: Headers; body?: Uint8Array };
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
  /** The client's own session id, unhashed. The pool keys account affinity on its hash and counts session usage under it. */
  session?(headers: Headers, body: Record<string, unknown> | undefined): string | undefined;
  stateful?(body: Record<string, unknown> | undefined): boolean;
  probe?: { path: string; body: (model: string) => Record<string, unknown> };
  /** When false, a pooled success without quota headers is normal: quota is read another way. */
  headerQuota?: boolean;
}
export function capabilities(provider: Provider): ProviderCapabilities {
  return {
    quota: !!provider.fetchQuota,
    models: !!provider.discoverModels,
    session: !!provider.session,
    probe: !!provider.probe,
  };
}
export function classify(provider: Provider, status: number, headers: Headers, body: string): Failure {
  if (status === 429) return provider.classify429(headers, body);
  if (status === 401) return "login";
  if (provider.classifyFailure) return provider.classifyFailure(status, headers, body);
  return status >= 500 ? "transient" : "request";
}

/** A JWT's payload, unverified: read only for its expiry and identity hints. */
export function jwtClaims(jwt: unknown): Record<string, unknown> {
  if (typeof jwt !== "string") return {};
  const claims = safeJsonParse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString()).data;
  return isRecord(claims) ? claims : {};
}

/** Expiry from `expiresIn` seconds when the provider sends it, else from the access token's JWT `exp`, else an hour. */
export function toTokens(accessToken: string, refreshToken: string, expiresIn?: number): Tokens {
  const exp = jwtClaims(accessToken).exp;
  return {
    accessToken,
    refreshToken,
    expiresAt:
      expiresIn !== undefined
        ? Date.now() + expiresIn * 1000
        : typeof exp === "number" && Number.isFinite(exp) && exp > 0
          ? Math.floor(exp * 1000)
          : Date.now() + 3600_000,
  };
}

/** Save a login under a stable id: the same account logged in again keeps its settings and gets fresh tokens. */
export function upsertAccount(
  s: Store,
  provider: ProviderName,
  id: string,
  who: { label?: string; email?: string; plan?: string },
  credential: Tokens & Pick<Credential, "accountUuid" | "chatgptAccountId">,
) {
  const prev = s.get("account", id);
  return saveAccount(
    s,
    {
      ...prev,
      id,
      provider,
      enabled: prev?.enabled ?? true,
      priority: prev?.priority ?? 0,
      label: who.label ?? prev?.label ?? who.email ?? id,
      email: who.email ?? prev?.email,
      plan: who.plan ?? prev?.plan,
    },
    { accountId: id, ...credential, holder: s.nodeId },
  );
}

/** Run a tool's own login with its config in a throwaway folder, then import it. The folder is deleted only once the
 * import succeeded, so a failed import can be retried from it. */
export async function loginInTempDir(
  tool: "claude" | "codex",
  command: string[],
  /** The environment variable that points the tool at its config folder. */
  configVar: string,
  importFrom: (dir: string) => Promise<string>,
  setup?: (dir: string) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), `agentgate-${tool}-`));
  let imported = false;
  try {
    setup?.(dir);
    const p = Bun.spawn(command, {
      env: { ...process.env, [configVar]: dir },
      stdio: ["inherit", "inherit", "inherit"],
    });
    if ((await p.exited) !== 0) throw new Error(`${tool} login failed`);
    const id = await importFrom(dir);
    imported = true;
    return id;
  } catch (e) {
    throw new Error(`Login was not imported: ${e}. Temporary login retained at ${dir}; retry import from that folder.`);
  } finally {
    if (imported) rmSync(dir, { recursive: true, force: true });
  }
}
