import {
  modelSnapshotSchema,
  type QuotaWindow,
  type RouteExplanation,
} from "@agentgate/protocol";
import type { Account, Store } from "../store.ts";
import type { ProviderName } from "./provider.ts";
import { exhausted, relevant } from "./quota.ts";
import { cooldowns } from "./policy.ts";

interface NodeState {
  affinity: Map<string, { id: string; expires: number }>;
  counts: Map<string, number>;
  rotation: Map<string, string>;
  continuations: Map<string, { id: string; expires: number }>;
}
const states = new WeakMap<Store, NodeState>();
function state(s: Store) {
  let value = states.get(s);
  if (!value)
    states.set(
      s,
      (value = {
        affinity: new Map(),
        counts: new Map(),
        rotation: new Map(),
        continuations: new Map(),
      }),
    );
  return value;
}
export function resetRouting(s: Store, id: string) {
  const node = state(s);
  for (const [key, entry] of node.affinity)
    if (entry.id === id) node.affinity.delete(key);
  for (const [key, entry] of node.continuations)
    if (entry.id === id) node.continuations.delete(key);
  for (const [key, last] of node.rotation)
    if (last === id) node.rotation.delete(key);
}
export function modelsFor(s: Store, id: string) {
  const raw = s.local(`models:${id}`);
  return raw ? modelSnapshotSchema.parse(JSON.parse(raw)) : undefined;
}
export function resolveModel(
  s: Store,
  provider: ProviderName,
  model?: string,
): string | undefined {
  if (!model) return undefined;
  const map = new Map(
    s
      .settings()
      .aliases.filter((a) => a.provider === provider)
      .map((a) => [a.alias, a.target]),
  );
  const visited = new Set<string>();
  let next = model;
  while (map.has(next)) {
    if (visited.has(next)) throw new Error("Alias cycle");
    visited.add(next);
    next = map.get(next)!;
  }
  return next;
}
/** Evaluate eligibility and limiting quota from the same account observation. */
function assess(
  s: Store,
  account: Account,
  model?: string,
  exclude = new Set<string>(),
  now = s.now(),
) {
  const reasons: string[] = [];
  const credential = s.get("credential", account.id);
  const usage = s.get("usage", account.id);
  const windows = relevant(usage, model, now);
  const blocked = cooldowns(s, account.id, model).filter(
    (c) => c.scope === "account" || model !== undefined,
  );
  const snapshot = modelsFor(s, account.id);

  if (!account.enabled) reasons.push("disabled");
  if (!credential || credential.needsLogin) reasons.push("login unavailable");
  if (exclude.has(account.id)) reasons.push("already attempted");
  if (exhausted(usage, model, now)) reasons.push("quota exhausted");
  if (blocked.some((c) => c.reason === "model"))
    reasons.push("model unavailable");
  if (blocked.some((c) => c.reason !== "model")) reasons.push("cooldown");
  if (
    model &&
    (account.policy?.excludeModels?.includes(model) ||
      (account.policy?.allowModels?.length &&
        !account.policy.allowModels.includes(model)))
  )
    reasons.push("model excluded");
  if (
    model &&
    snapshot?.models.length &&
    now - snapshot.at < 600000 &&
    !snapshot.models.includes(model) &&
    !reasons.includes("model unavailable")
  )
    reasons.push("model unavailable");

  const window = windows.reduce<QuotaWindow | undefined>(
    (limiting, candidate) =>
      !limiting || candidate.usedPct > limiting.usedPct ? candidate : limiting,
    undefined,
  );
  const blockers = windows
    .filter((w) => w.usedPct >= 100)
    .map((w) => w.resetsAt ?? now + 60000);
  if (usage?.exhaustedUntil && usage.exhaustedUntil > now)
    blockers.push(usage.exhaustedUntil);
  blockers.push(...blocked.map((c) => c.retryAt));
  return {
    account,
    reasons,
    window,
    retryAt: blockers.length ? Math.max(...blockers) : undefined,
  };
}
export function eligibility(
  s: Store,
  account: Account,
  model?: string,
  exclude = new Set<string>(),
) {
  return assess(s, account, model, exclude).reasons;
}
export function candidates(
  s: Store,
  provider: ProviderName,
  model?: string,
  exclude = new Set<string>(),
) {
  return s
    .list("account")
    .filter(
      (a) =>
        a.provider === provider && !eligibility(s, a, model, exclude).length,
    );
}
export function route(
  s: Store,
  provider: ProviderName,
  model?: string,
  options: {
    exclude?: Set<string>;
    session?: string;
    requiredAccount?: string;
  } = {},
): RouteExplanation {
  const routedModel = resolveModel(s, provider, model),
    settings = s.settings(),
    node = state(s),
    now = s.now();
  for (const [key, entry] of node.affinity)
    if (entry.expires <= now || !s.get("account", entry.id))
      node.affinity.delete(key);
  const evaluated = s
    .list("account")
    .filter((a) => a.provider === provider)
    .map((account) => {
      const result = assess(s, account, routedModel, options.exclude, now);
      if (options.requiredAccount && account.id !== options.requiredAccount)
        result.reasons.push("continuation belongs to another account");
      return result;
    });
  const eligible = evaluated.filter((candidate) => !candidate.reasons.length);
  let selected = eligible.find((candidate) => candidate.account.pinned);
  let reason = selected ? "pinned" : "no eligible account";
  const affinity =
    options.session && settings.sessionAffinity
      ? node.affinity.get(`${provider}:${options.session}`)
      : undefined;
  if (!selected && affinity) {
    selected = eligible.find(
      (candidate) => candidate.account.id === affinity.id,
    );
    if (selected) reason = "session affinity";
  }
  if (!selected && settings.strategy === "priority") {
    selected = [...eligible].sort(
      (a, b) =>
        b.account.priority - a.account.priority ||
        a.account.id.localeCompare(b.account.id),
    )[0];
    if (selected) reason = "priority";
  }
  if (!selected && settings.strategy === "round-robin" && eligible.length) {
    const sorted = [...eligible].sort((a, b) =>
      a.account.id.localeCompare(b.account.id),
    );
    const last = node.rotation.get(provider);
    selected =
      sorted.find((candidate) => !last || candidate.account.id > last) ??
      sorted[0];
    reason = "round robin";
  }
  if (!selected) {
    const under = eligible.filter(
      (candidate) => (candidate.window?.usedPct ?? 0) < settings.threshold,
    );
    const active = s.local(`active:${provider}`);
    selected = under.find((candidate) => candidate.account.id === active);
    if (selected) reason = "active subscription below threshold";
    else {
      selected = [...(under.length ? under : eligible)].sort(
        (a, b) =>
          (a.window?.resetsAt ?? Infinity) - (b.window?.resetsAt ?? Infinity) ||
          b.account.priority - a.account.priority ||
          a.account.id.localeCompare(b.account.id),
      )[0];
      if (selected) reason = "earliest reset, then priority";
    }
  }
  return {
    provider,
    requestedModel: model,
    routedModel,
    strategy: settings.strategy,
    account: selected?.account.id,
    reason,
    candidates: evaluated.map(({ account, reasons }) => ({
      id: account.id,
      eligible: !reasons.length,
      reasons,
      inFlight: node.counts.get(account.id) ?? 0,
    })),
  };
}
export function choose(
  s: Store,
  provider: ProviderName,
  model?: string,
  exclude?: Set<string>,
) {
  const id = route(s, provider, model, { exclude }).account;
  return id ? s.get("account", id) : undefined;
}
/** Keep upstream model metadata, exposing only models the configured pool can currently serve. */
export function filterModelList(
  s: Store,
  provider: ProviderName,
  payload: unknown,
  shape: { collection: string; id: string },
): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const data = payload as Record<string, unknown>,
    list = data[shape.collection];
  if (!Array.isArray(list)) return payload;
  const entries = list.filter(
    (entry): entry is Record<string, unknown> =>
      !!entry &&
      typeof entry === "object" &&
      typeof entry[shape.id] === "string",
  );
  const allowed = entries.filter(
    (entry) => candidates(s, provider, String(entry[shape.id])).length,
  );
  const ids = new Set(allowed.map((entry) => entry[shape.id]));
  for (const alias of s
    .settings()
    .aliases.filter((alias) => alias.provider === provider)) {
    const target = resolveModel(s, provider, alias.alias);
    const entry = allowed.find((entry) => entry[shape.id] === target);
    if (entry && !ids.has(alias.alias)) {
      allowed.push({
        ...entry,
        [shape.id]: alias.alias,
        ...(typeof entry.display_name === "string"
          ? { display_name: alias.alias }
          : {}),
      });
      ids.add(alias.alias);
    }
  }
  return { ...data, [shape.collection]: allowed };
}
export function beginRoute(
  s: Store,
  provider: ProviderName,
  id: string,
  session?: string,
) {
  const node = state(s);
  node.rotation.set(provider, id);
  node.counts.set(id, (node.counts.get(id) ?? 0) + 1);
  if (session && s.settings().sessionAffinity) {
    const key = `${provider}:${session}`;
    node.affinity.delete(key);
    while (node.affinity.size >= 2000)
      node.affinity.delete(node.affinity.keys().next().value!);
    node.affinity.set(key, {
      id,
      expires: s.now() + s.settings().affinityTtlMs,
    });
  }
  let done = false;
  return () => {
    if (!done) {
      done = true;
      const count = Math.max(0, (node.counts.get(id) ?? 1) - 1);
      if (count) node.counts.set(id, count);
      else node.counts.delete(id);
    }
  };
}
export function continuationAccount(s: Store, id: string) {
  const node = state(s);
  for (const [key, value] of node.continuations)
    if (value.expires <= s.now()) node.continuations.delete(key);
  return node.continuations.get(id)?.id;
}
export function rememberContinuation(
  s: Store,
  responseId: string,
  accountId: string,
) {
  if (!/^[\w-]{1,200}$/.test(responseId)) return;
  const map = state(s).continuations;
  while (map.size >= 2000) map.delete(map.keys().next().value!);
  map.set(responseId, { id: accountId, expires: s.now() + 3600000 });
}
export function earliestReset(
  s: Store,
  provider: ProviderName,
  model?: string,
) {
  const now = s.now();
  const times = s
    .list("account")
    .filter((a) => a.provider === provider)
    .map((account) => assess(s, account, model, undefined, now))
    .flatMap((candidate) => {
      if (
        candidate.reasons.some(
          (reason) =>
            reason === "disabled" ||
            reason === "login unavailable" ||
            reason.startsWith("model"),
        )
      )
        return [];
      return candidate.retryAt === undefined ? [] : [candidate.retryAt];
    });
  return times.length ? Math.min(...times) : undefined;
}
