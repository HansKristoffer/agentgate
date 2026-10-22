import { existsSync, readFileSync } from "node:fs";
import { clamp } from "hanzio";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Credentials, InvalidGrant, jwtClaims, pkce, type Tokens } from "../credentials.ts";
import { saveAccount } from "../operations.ts";
import { fetchHeaders, readBody, sleep } from "../runtime.ts";
import type { Store } from "../store.ts";
import type { Observation, Provider } from "./provider.ts";

// Undocumented upstream details from the Cursor CLI and IDE bundles, kept in one place. Mutable so tests can point them at fakes.
export const CURSOR = {
  api: "https://api2.cursor.sh",
  website: "https://cursor.com",
  clientId: "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB",
  pollMs: 2000,
  usageEvents: "https://cursor.com/api/dashboard/get-filtered-usage-events",
  usagePage: 1000,
  // One request for all history does not finish before the read is abandoned, so the year is taken a week at a time.
  historyChunk: 7 * 86400_000,
  historySpan: 366 * 86400_000,
};

function toTokens(accessToken: string, refreshToken: string): Tokens {
  const exp = jwtClaims(accessToken).exp;
  return { accessToken, refreshToken, expiresAt: typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? Math.floor(exp * 1000) : Date.now() + 3600_000 };
}

/** A Connect unary call in Cursor's JSON encoding. `path` is the service method, such as `/agent.v1.AgentService/GetUsableModels`. */
async function connect(path: string, accessToken: string, signal: AbortSignal, body = "{}", timeoutMs = 10_000, maxBytes = 256 * 1024) {
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "connect-protocol-version": "1", "x-cursor-client-type": "cli" };
  const res = await fetchHeaders(`${CURSOR.api}${path}`, { method: "POST", headers, body, signal, redirect: "manual" }, timeoutMs);
  if (!res.ok) { await res.body?.cancel(); throw new Error(`Cursor ${path.split("/").pop()} failed (${res.status})`); }
  return JSON.parse(new TextDecoder().decode(await readBody(res.body, maxBytes, signal)));
}

function dashboard(method: string, accessToken: string, signal: AbortSignal) {
  return connect(`/aiserver.v1.DashboardService/${method}`, accessToken, signal);
}

const text = (value: unknown) => typeof value === "string" && value ? value : undefined;
const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Model ids from `GetUsableModels`. Display-only rows are skipped. */
export function parseModels(payload: unknown): string[] {
  const models = record(payload)?.models;
  if (!Array.isArray(models)) throw new Error("Unrecognized model response");
  return models.flatMap((m) => { const id = text(record(m)?.modelId); return id ? [id] : []; });
}

/** The model a Cursor request asked for: the probe's `modelName`, or the agent run's model details. */
export function requestedModel(body: Record<string, unknown> | undefined): string | undefined {
  if (!body) return undefined;
  return text(body.modelName) ?? text(record(body.modelDetails)?.modelId) ?? text(record(body.requestedModel)?.modelId) ?? text(body.model);
}

/** Put a resolved alias back into the same field `requestedModel` read. */
export function rewriteModel(body: Record<string, unknown>, model: string): Record<string, unknown> {
  if (text(body.modelName)) return { ...body, modelName: model };
  const details = record(body.modelDetails);
  if (details && text(details.modelId)) return { ...body, modelDetails: { ...details, modelId: model } };
  const requested = record(body.requestedModel);
  if (requested && text(requested.modelId)) return { ...body, requestedModel: { ...requested, modelId: model } };
  return { ...body, model };
}

// Agent runs and the model-status probe are the calls that spend a subscription. Other paths keep a caller's own login.
const POOLED_PATH = /^\/(?:agent\.v1\.AgentService\/Run(?:SSE|Poll)?|aiserver\.v1\.AiService\/TestModelStatus)(?:\?|$)/;

/** Plan usage for the billing cycle. Cursor splits it into auto and API pools; the total is what the account has left. */
export function parseQuota(payload: unknown): Observation | undefined {
  const body = payload as { billingCycleEnd?: unknown; planUsage?: { totalPercentUsed?: unknown } } | null;
  const used = body?.planUsage?.totalPercentUsed;
  if (typeof used !== "number" || !Number.isFinite(used)) return undefined;
  const reset = Number(body?.billingCycleEnd);
  const usedPct = clamp(used, 0, 100);
  return { windows: [{ name: "month", usedPct, resetsAt: Number.isFinite(reset) && reset > 0 ? reset : undefined, scope: { kind: "account" } }], status: usedPct >= 100 ? "exhausted" : "ok" };
}

/** Cursor logins, usage, model discovery, and pooled agent runs. Quota is the billing-cycle read, not response headers. */
export const cursor: Provider = {
  name: "cursor",
  headerQuota: false,
  fetchQuota: async (credential, signal) => parseQuota(await dashboard("GetCurrentPeriodUsage", credential.accessToken, signal)),
  discoverModels: async (credential, signal) => parseModels(await connect("/agent.v1.AgentService/GetUsableModels", credential.accessToken, signal)),
  requestedModel,
  rewriteModel,
  session: (_headers, body) => {
    const id = text(body?.conversationId);
    return id && id.length <= 128 ? new Bun.CryptoHasher("sha256").update(id).digest("hex") : undefined;
  },
  probe: { path: "/aiserver.v1.AiService/TestModelStatus", body: model => ({ modelName: model }) },
  prepare(path, headers, body, cred) {
    headers.set("authorization", `Bearer ${cred.accessToken}`);
    if (!headers.has("connect-protocol-version")) headers.set("connect-protocol-version", "1");
    if (!headers.has("x-cursor-client-type")) headers.set("x-cursor-client-type", "cli");
    return { url: CURSOR.api + path, headers, body };
  },
  usage: () => undefined,
  pooled: path => POOLED_PATH.test(path),
  classify429: () => "rate",

  async refresh(refreshToken) {
    const res = await fetch(`${CURSOR.api}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: CURSOR.clientId, refresh_token: refreshToken }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = new TextDecoder().decode(await readBody(res.body, 1024 * 1024, AbortSignal.timeout(30_000)));
    const body = (() => { try { return JSON.parse(text) as { access_token?: unknown; shouldLogout?: unknown }; } catch { return {}; } })();
    if (body.shouldLogout === true) throw new InvalidGrant("Cursor ended this login");
    if (!res.ok || typeof body.access_token !== "string" || !body.access_token) throw new Error(`Cursor token endpoint returned ${res.status}`);
    // The IDE keeps the new access token as its refresh token too.
    return toTokens(body.access_token, body.access_token);
  },
};

const pollResponse = z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1) });

/** Where the browser sign-in starts. `uuid` names this attempt when polling; Cursor has no login hint, so `email` is unused. */
export function authorizeUrl(challenge: string, uuid: string, _email?: string) {
  return `${CURSOR.website}/loginDeepControl?${new URLSearchParams({ challenge, uuid, mode: "login", redirectTarget: "cli" })}`;
}

/** Wait up to `ms` for the browser sign-in started at `authorizeUrl`. Undefined when it is not finished yet; poll again. */
export async function finish(s: Store, uuid: string, verifier: string, label: string | undefined, signal: AbortSignal, ms = 90_000): Promise<string | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const res = await fetchHeaders(`${CURSOR.api}/auth/poll?${new URLSearchParams({ uuid, verifier })}`, { headers: { "x-cursor-client-type": "cli" }, signal, redirect: "manual" }, 10000);
    if (res.ok) {
      const t = pollResponse.parse(JSON.parse(new TextDecoder().decode(await readBody(res.body, 64 * 1024, signal))));
      return save(s, toTokens(t.accessToken, t.refreshToken), label);
    }
    await res.body?.cancel();
    // 404 means not signed in yet; Cursor's CLI retries server errors the same way.
    if (res.status !== 404 && res.status < 500) throw new Error(`Cursor sign-in failed (${res.status})`);
    await sleep(clamp(deadline - Date.now(), 0, CURSOR.pollMs), signal);
  }
  return undefined;
}

async function save(s: Store, tokens: Tokens, label?: string) {
  const signal = AbortSignal.timeout(10_000);
  const me = await dashboard("GetMe", tokens.accessToken, signal).catch(() => ({})) as { authId?: unknown; email?: unknown };
  const plan = await dashboard("GetPlanInfo", tokens.accessToken, signal).then(p => p?.planInfo?.planName, () => undefined);
  const subject = typeof me.authId === "string" && me.authId ? me.authId : jwtClaims(tokens.accessToken).sub;
  if (typeof subject !== "string" || !subject) throw new Error("Cursor login did not identify the account");
  const email = typeof me.email === "string" && me.email ? me.email : undefined;
  // Same Cursor account signed in twice → same record, fresh tokens.
  const id = `cursor-${new Bun.CryptoHasher("sha256").update(subject).digest("hex").slice(0, 8)}`;
  const prev = s.get("account", id);
  return saveAccount(s, { ...prev, id, provider: "cursor", enabled: prev?.enabled ?? true, priority: prev?.priority ?? 0, label: label ?? prev?.label ?? email ?? id, email: email ?? prev?.email, plan: typeof plan === "string" && plan ? plan : prev?.plan }, { accountId: id, ...tokens, holder: s.nodeId });
}

/** Who the Cursor CLI is signed in as on this machine. Reads only its settings file, never the Keychain or tokens. */
export function detect(file = join(homedir(), ".cursor", "cli-config.json")): { email: string; plan?: string } | undefined {
  try {
    const email = JSON.parse(readFileSync(file, "utf8")).authInfo?.email;
    return typeof email === "string" && email ? { email } : undefined;
  } catch { return undefined; }
}

/** Take over a Cursor CLI login kept in a file (`auth.json`: Linux, or `AGENT_CLI_CREDENTIAL_STORE=file`). */
export async function importFrom(s: Store, dir: string, label?: string) {
  const file = join(dir, "auth.json");
  if (!existsSync(file)) throw new Error(`no auth.json in ${dir} (on macOS the Cursor CLI keeps its login in the Keychain; use agentgate login cursor)`);
  const t = pollResponse.safeParse(await Bun.file(file).json());
  if (!t.success) throw new Error(`${file} has no Cursor login`);
  return save(s, toTokens(t.data.accessToken, t.data.refreshToken), label);
}

/** `agentgate login cursor`: print the sign-in page and wait for it. Works on a headless server too. */
export async function login(s: Store, label?: string) {
  const { verifier, challenge } = await pkce(), uuid = crypto.randomUUID();
  console.log(`Open this page to sign in to Cursor:\n\n  ${authorizeUrl(challenge, uuid)}\n`);
  const id = await finish(s, uuid, verifier, label, AbortSignal.timeout(310_000), 300_000);
  if (!id) throw new Error("Cursor sign-in timed out; start again");
  return id;
}

const HOUR = 3600_000, DAY = 86400_000, TOKENS_EVERY = 15 * 60_000, LATE = 7 * 86400_000;
type Hourly = Map<string, { hour: number; model: string; input: number; output: number; cacheRead: number; cacheWrite: number }>;
const count = (value: unknown) => {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Cursor token count");
  return value;
};
// Connect JSON sends int64 as a decimal string.
const whole = (value: unknown) => count(typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value);
const includedKind = (kind: unknown) => {
  const name = typeof kind === "number" ? { 3: "INCLUDED_IN_PRO", 4: "INCLUDED_IN_BUSINESS", 8: "INCLUDED_IN_PRO_PLUS", 9: "INCLUDED_IN_ULTRA" }[kind]
    : typeof kind === "string" ? kind.replace(/^USAGE_EVENT_KIND_/, "") : undefined;
  return name === "INCLUDED_IN_PRO" || name === "INCLUDED_IN_BUSINESS" || name === "INCLUDED_IN_PRO_PLUS" || name === "INCLUDED_IN_ULTRA";
};

function addTokens(hours: Hourly, hour: number, model: string, input: number, output: number, cacheRead: number, cacheWrite: number) {
  const key = `${hour}:${model}`;
  const sum = hours.get(key) ?? { hour, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  sum.input += input; sum.output += output; sum.cacheRead += cacheRead; sum.cacheWrite += cacheWrite;
  hours.set(key, sum);
}

/** Tokens in the included allowance, per model per day. The usage-event list often omits them: included calls have no per-request breakdown, while the API pool does. */
async function includedSpend(accessToken: string, since: number, until: number, signal: AbortSignal) {
  const body = await connect("/aiserver.v1.DashboardService/GetDailySpendByCategory", accessToken, signal, JSON.stringify({
    periodStartMs: String(since), periodEndMs: String(until), groupBy: "SPEND_GROUP_BY_CATEGORY_MODEL", spendType: "SPEND_TYPE_INCLUDED",
  }), 30_000, 4 * 1024 * 1024);
  const rows = record(body)?.dailySpend ?? record(body)?.daily_spend;
  if (!Array.isArray(rows)) throw new Error("Unrecognized Cursor included usage");
  return rows;
}

/** Hourly token totals per model between `since` and `until`, from the usage history Cursor's dashboard shows.
 * That endpoint takes the session cookie the website sets, built from the same access token. Included-pool
 * tokens come from the daily spend series and are added on top of the per-request API pool. */
export async function usageHistory(accessToken: string, since: number, until: number, signal: AbortSignal): Promise<Hourly> {
  const userId = String(jwtClaims(accessToken).sub ?? "").split("|").at(-1);
  if (!userId || !/^[\w-]+$/.test(userId)) throw new Error("Cursor login did not identify the account");
  const cookie = `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${accessToken}`)}`;
  const hours: Hourly = new Map(), included = new Map<string, number>();
  let page = 1;
  for (; page <= 1000; page++) {
    const res = await fetchHeaders(CURSOR.usageEvents, {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", origin: "https://cursor.com", cookie },
      body: JSON.stringify({ startDate: String(since), endDate: String(until), page, pageSize: CURSOR.usagePage }),
    }, 30_000);
    if (!res.ok) { await res.body?.cancel(); throw new Error(`Cursor usage history returned ${res.status}`); }
    const body = JSON.parse(new TextDecoder().decode(await readBody(res.body, 16 * 1024 * 1024, signal))) as { usageEventsDisplay?: unknown; totalUsageEventsCount?: unknown };
    const rows = body.usageEventsDisplay ?? [], total = count(body.totalUsageEventsCount);
    // A short page would silently drop usage, so the window is not saved at all.
    if (!Array.isArray(rows) || rows.length > CURSOR.usagePage || rows.length < Math.min(CURSOR.usagePage, total - (page - 1) * CURSOR.usagePage)) throw new Error("Incomplete Cursor usage history");
    for (const row of rows as { timestamp?: unknown; model?: unknown; kind?: unknown; tokenUsage?: Record<string, unknown> | null }[]) {
      // Request-based included calls have no token breakdown; the daily series below counts them.
      if (!row?.tokenUsage) continue;
      const at = Number(row.timestamp);
      if (!Number.isSafeInteger(at) || typeof row.model !== "string" || !row.model) throw new Error("Invalid Cursor usage event");
      if (at < since || at > until) continue;
      const input = count(row.tokenUsage.inputTokens), output = count(row.tokenUsage.outputTokens);
      const cacheRead = count(row.tokenUsage.cacheReadTokens), cacheWrite = count(row.tokenUsage.cacheWriteTokens);
      addTokens(hours, at - (at % HOUR), row.model, input, output, cacheRead, cacheWrite);
      if (includedKind(row.kind)) {
        const day = at - (at % DAY), key = `${day}:${row.model}`;
        included.set(key, (included.get(key) ?? 0) + input + output + cacheRead + cacheWrite);
      }
    }
    if (page * CURSOR.usagePage >= total) break;
  }
  if (page > 1000) throw new Error("Cursor usage history is too long to read");
  for (const row of await includedSpend(accessToken, since, until, signal) as { day?: unknown; category?: unknown; totalTokens?: unknown; total_tokens?: unknown }[]) {
    if (row?.day === undefined || row.day === null || typeof row.category !== "string" || !row.category) throw new Error("Invalid Cursor included usage");
    const at = whole(row.day);
    if (at < since || at > until) continue;
    const day = at - (at % DAY);
    // One total per model per day, kept on input. Included events that already had a breakdown are subtracted.
    const extra = whole(row.totalTokens ?? row.total_tokens) - (included.get(`${day}:${row.category}`) ?? 0);
    if (extra > 0) addTokens(hours, at - (at % HOUR), row.category, extra, 0, 0, 0);
  }
  return hours;
}

/** Replace one half-open window `[since, until)` and remember how far back this account has been read. */
function saveWindow(s: Store, accountId: string, since: number, until: number, hours: Hourly, key: string, coveredTo: number, readAt: number) {
  s.transaction(() => {
    if (!s.get("account", accountId)) return;
    s.db.run("delete from cursor_tokens where account = ? and hour >= ? and hour < ?", [accountId, since, until]);
    for (const h of hours.values()) {
      if (h.hour < since || h.hour >= until) continue;
      s.db.run("insert into cursor_tokens values (?,?,?,?,?,?,?)", [accountId, h.hour, h.model, h.input, h.output, h.cacheRead, h.cacheWrite]);
    }
    s.setLocal(key, JSON.stringify({ readAt, triedAt: s.now(), coveredTo }));
  });
}

/** Cursor's token usage is read from Cursor for every account this node holds. The first reads walk back a year,
 * a week at a time, because one request for the whole span does not finish. Later reads replace the last week,
 * which is where Cursor publishes usage late. */
export async function pollTokens(s: Store, creds: Pick<Credentials, "token">, signal: AbortSignal) {
  for (const account of s.list("account")) {
    if (signal.aborted) return;
    const c = s.get("credential", account.id);
    if (account.provider !== "cursor" || !account.enabled || !c || c.needsLogin || c.holder !== s.nodeId) continue;
    const key = `cursorTokens:${account.id}`, state = JSON.parse(s.local(key) ?? "{}") as { readAt?: number; triedAt?: number; coveredTo?: number };
    // A read that saved nothing is retried on the next pass. A finished read waits 15 minutes.
    if (state.coveredTo !== undefined && s.now() - (state.triedAt ?? 0) < TOKENS_EVERY) continue;
    s.setLocal(key, JSON.stringify({ ...state, triedAt: s.now() }));
    const end = s.now() + 1, floor = end - CURSOR.historySpan, alignedFloor = floor - (floor % HOUR);
    let older = state.coveredTo ?? end;
    try {
      const token = await creds.token(account.id);
      const read = async (since: number, until: number) => {
        const hours = await usageHistory(token.accessToken, since, until - 1, AbortSignal.any([signal, AbortSignal.timeout(45_000)]));
        saveWindow(s, account.id, since, until, hours, key, Math.min(older, since), end - 1);
      };
      // Once any week is stored, the latest week is read again; Cursor publishes some of it late.
      if (state.coveredTo !== undefined) {
        const recent = end - LATE, since = recent - (recent % HOUR);
        await read(since, end);
      }
      while (older > alignedFloor) {
        if (signal.aborted) return;
        const since = Math.max(alignedFloor, older - CURSOR.historyChunk);
        const aligned = since - (since % HOUR);
        await read(aligned, older);
        older = aligned;
      }
    } catch (e) {
      if (!signal.aborted) s.log("cursor", account.id, "", 0, 0, (e instanceof Error ? e.message : "usage history read failed").slice(0, 200));
    }
  }
}
