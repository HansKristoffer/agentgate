import { validId } from "./mcp/templates.ts";
import { getUniqueValues } from "hanzio";
import type { Account, Credential, Project, Store } from "./store.ts";
import { isVirtual, projectIdSchema } from "@agentgate/protocol";
import { checkRevision } from "./configuration.ts";
import { BUILTIN_ALIAS, FACTORY_ALIAS, canonicalProject } from "./mcp/gateway.ts";
import { resetCooldown } from "./llm/policy.ts";
import { resetRouting } from "./llm/routing.ts";

/** Record changes with more than one caller: a control operation (ops/) and the daemon's own code, or two families.
 * A change only one operation makes lives with that operation. */

export function saveAccount(s: Store, account: Account, credential: Credential) {
  return s.transaction(() => {
    s.put("account", account.id, account);
    s.put("credential", account.id, credential);
    s.del("usage", account.id);
    s.del("refreshRequest", `credential:${account.id}`);
    s.setLocal(`refreshError:credential:${account.id}`, undefined);
    for (const key of ["models", "modelError", "quotaHealth"]) s.setLocal(`${key}:${account.id}`, undefined);
    resetCooldown(s, account.id);
    resetRouting(s, account.id);
    return account.id;
  });
}
export function setAccount(s: Store, id: string, patch: Partial<Account>) {
  return s.transaction(() => {
    const account = s.get("account", id);
    if (!account) throw new Error(`no account ${id}`);
    if (patch.pinned)
      for (const a of s.list("account"))
        if (a.pinned && a.provider === account.provider && a.id !== id) s.put("account", a.id, { ...a, pinned: false });
    return s.put("account", id, { ...account, ...patch, id });
  });
}

/** `expected` is the revision the caller's form started from (configuration.ts); the CLI leaves it out. */
export function saveProject(s: Store, id: string, patch: Partial<Project>, expected?: string) {
  id = canonicalProject(s, projectIdSchema.parse(id));
  if (expected !== undefined) checkRevision(s, "project", id, expected);
  const virtual = isVirtual(id);
  const prev = s.get("project", id) ?? { id, mcp: {}, skills: [], inheritDefaults: !virtual };
  for (const [alias, target] of Object.entries(patch.mcp ?? {})) {
    if (!validId(alias)) throw new Error(`invalid tool prefix ${alias}`);
    if (virtual && alias === "skills") throw new Error("the prefix skills is reserved for the built-in skill tools");
    if (virtual && alias === FACTORY_ALIAS)
      throw new Error(`the prefix ${FACTORY_ALIAS} is reserved for the software factory's tools`);
    if (!virtual && alias === BUILTIN_ALIAS)
      throw new Error(`the prefix ${BUILTIN_ALIAS} is reserved for agentgate's own tools`);
    if (!s.get("mcp", target)) throw new Error(`no MCP instance ${target}`);
  }
  for (const skill of patch.skills ?? []) if (!s.has("skill", skill)) throw new Error(`no skill ${skill}`);
  // Virtual projects list their servers explicitly; `*` defaults never leak into a public endpoint.
  return s.put("project", id, {
    ...prev,
    ...patch,
    ...(patch.skills && { skills: getUniqueValues(patch.skills) }),
    ...(virtual && { inheritDefaults: false }),
    id,
  });
}

/** Sets or clears the URL every machine posts the factory's updates to (factory/notify.ts). Only `https`, without
 * credentials in the authority: a token belongs in the path or query, which the API never shows. */
export function setFactoryWebhook(s: Store, id: string, url: string | undefined) {
  return s.transaction(() => {
    const p = s.get("project", id);
    if (!isVirtual(id) || !p?.factoryTools)
      throw new Error(`${id} does not offer the factory's tools; turn them on first`);
    const { factoryWebhook: _, ...rest } = p;
    if (!url) return s.put("project", id, rest);
    return s.put("project", id, { ...rest, factoryWebhook: webhookUrl(url) });
  });
}

/** A webhook URL the factory may post to (factory/notify.ts): `https`, without credentials in the authority, since
 * only the path and query are kept out of what agentgate shows. Errors never repeat the URL. */
export function webhookUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The webhook must be a URL");
  }
  if (parsed.protocol !== "https:") throw new Error("The webhook must be an https URL");
  if (parsed.username || parsed.password)
    throw new Error("Put the receiver's token in the webhook's path or query, not before the host");
  if (url.length > 2000) throw new Error("The webhook URL is too long");
  return parsed.href;
}
