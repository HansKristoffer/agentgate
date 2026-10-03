import { modelSnapshotSchema, type BatchResult, type Check, type Verification } from "@agentgate/protocol";
import type { Credentials } from "../credentials.ts";
import type { Store } from "../store.ts";
import { revision } from "../configuration.ts";
import { readBody } from "../runtime.ts";
import { setAccount } from "../operations.ts";
import { abortable, resetCooldown } from "./policy.ts";
import { proxy } from "./pool.ts";
import { bounded, type Quotas } from "./quota.ts";
import type { Provider, ProviderName } from "./provider.ts";
import { streamObserver } from "./telemetry.ts";

export class ProxyOperations {
  private discovery = new Map<string, Promise<string[]>>();
  constructor(readonly s: Store, readonly creds: Credentials, readonly quotas: Quotas, readonly providers: Record<ProviderName, Provider>) {}
  discover(id: string, signal: AbortSignal): Promise<string[]> {
    const existing = this.discovery.get(id); if (existing) return abortable(existing, signal);
    const task = (async () => {
      const a = this.s.get("account", id); if (!a) throw new Error("Account does not exist");
      const adapter = this.providers[a.provider]; if (!adapter.discoverModels) throw new Error("Model discovery is unsupported");
      const combined = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
      const token = await abortable(this.creds.token(id), combined), before = revision(this.s, "credential", id);
      try {
        const models = [...new Set(await adapter.discoverModels(token, combined))]; combined.throwIfAborted();
        const snapshot = modelSnapshotSchema.parse({ at: this.s.now(), models });
        if (this.s.closed || !this.s.get("account", id) || revision(this.s, "credential", id) !== before) throw new Error("Account changed during discovery");
        this.s.setLocal(`models:${id}`, JSON.stringify(snapshot)); this.s.setLocal(`modelError:${id}`, undefined); return snapshot.models;
      } catch (error) {
        if (!this.s.closed && !signal.aborted && this.s.get("account", id) && revision(this.s, "credential", id) === before) this.s.setLocal(`modelError:${id}`, "Model discovery failed; previous results retained");
        throw error;
      }
    })();
    this.discovery.set(id, task); void task.finally(() => this.discovery.delete(id)).catch(() => {}); return task;
  }
  async verify(id: string, signal: AbortSignal, options: { probe?: boolean; model?: string } = {}): Promise<Verification> {
    const account = this.s.get("account", id); if (!account) throw new Error("Account does not exist");
    const adapter = this.providers[account.provider], checks: Verification["checks"] = { credential: { status: "failed", message: "Login unavailable" }, quota: { status: "unsupported", message: "Usage refresh unsupported" }, models: { status: "unsupported", message: "Model discovery unsupported" } };
    const checked = async (fn: () => Promise<unknown>, message: string): Promise<Check> => { try { await fn(); return { status: "ok", message }; } catch { return { status: "failed", message: signal.aborted ? "Check cancelled or timed out" : "Check failed; inspect account health" }; } };
    checks.credential = await checked(() => abortable(this.creds.token(id), signal), "Coordinated login is usable");
    const credentialRevision = revision(this.s, "credential", id);
    if (checks.credential.status === "ok") {
      await Promise.all([
        adapter.fetchQuota ? checked(() => this.quotas.refresh(id, signal, true), "Read-only usage check passed").then(c => { checks.quota = c; }) : undefined,
        adapter.discoverModels ? checked(() => this.discover(id, signal), "Model discovery passed").then(c => { checks.models = c; }) : undefined,
      ]);
      if (options.probe) {
        if (!adapter.probe || !options.model) checks.probe = { status: "unsupported", message: "Choose a model for the inference probe" };
        else checks.probe = await checked(async () => {
          const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
          const response = await proxy(this.s, this.creds, adapter, new Request("http://127.0.0.1/probe", { method: "POST", signal: probeSignal, headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", authorization: "Bearer agentgate" }, body: JSON.stringify(adapter.probe!.body(options.model!)) }), adapter.probe!.path, { maxBody: 16384, headerTimeout: 15000, streamIdle: 15000 }, { accountId: id });
          const body = await readBody(response.body, 128 * 1024, probeSignal);
          const observer = streamObserver();
          if (response.headers.get("content-type")?.includes("text/event-stream")) observer.chunk(body);
          if (!response.ok || observer.terminal === "provider-error") throw new Error("Inference probe rejected");
        }, "Inference probe reached the requested account");
      }
    }
    if (this.s.closed || !this.s.get("account", id) || revision(this.s, "credential", id) !== credentialRevision) for (const key of Object.keys(checks) as (keyof typeof checks)[]) checks[key] = { status: "obsolete", message: "Account changed; verify again" };
    return { accountId: id, at: this.s.now(), node: this.s.nodeId, checks };
  }
  async batch(ids: string[], action: "quota" | "verify" | "enable" | "disable" | "refresh" | "models" | "reset-cooldown", signal: AbortSignal): Promise<BatchResult[]> {
    return bounded([...new Set(ids)], async id => {
      try {
        signal.throwIfAborted(); if (!this.s.get("account", id)) throw new Error("Account does not exist");
        let result: unknown;
        if (action === "quota") result = await this.quotas.refresh(id, signal, true);
        else if (action === "verify") result = await this.verify(id, signal);
        else if (action === "models") result = await this.discover(id, signal);
        else if (action === "refresh") { await abortable(this.creds.refresh(id), signal); result = { refreshed: true }; }
        else if (action === "reset-cooldown") { resetCooldown(this.s, id); result = { reset: true }; }
        else { setAccount(this.s, id, { enabled: action === "enable" }); result = { enabled: action === "enable" }; }
        const verification = action === "verify" ? result as Verification : undefined;
        return { id, ok: verification ? Object.values(verification.checks).every(c => c.status === "ok" || c.status === "unsupported") : true, result };
      } catch { return { id, ok: false, error: signal.aborted ? "Operation cancelled or timed out" : "Operation failed; inspect account health" }; }
    });
  }
}
