import { API_VERSION, providerSchema, settingsPatchSchema, type Status } from "@agentgate/protocol";
import { recordFromKeys } from "hanzio";
import { Hono } from "hono";
import { z } from "zod";
import packageInfo from "../../../../package.json";
import { filesErrors } from "../checkout-files.ts";
import { patchSettings, revision } from "../configuration.ts";
import { refreshFailure } from "../credentials.ts";
import type { Ctx, Env } from "../daemon.ts";
import { jsonInput as json } from "../http.ts";
import { lag } from "../lag.ts";
import { accountStatus } from "../llm/pool.ts";
import { providerCapabilities, providerLogins } from "../llm/providers.ts";
import { listLogins } from "../logins.ts";
import { serverHealth } from "../mcp/gateway.ts";
import { readableEndpoint } from "../mcp/templates.ts";
import { relayStatus, via } from "../relay.ts";
import { skillRepoSummaries, skillSummaries } from "../skills.ts";
import { exportBackup, importBackup } from "../store.ts";
import { lastSeen } from "../sync.ts";
import { nodeUpdate } from "../update.ts";
import { moduleFor } from "./accounts.ts";
import { input, local } from "./http.ts";
import { shownProject } from "./projects.ts";

const detectedSource = { claude: "~/.claude", codex: "~/.codex", cursor: "~/.cursor" };
/** The coding tools' own logins, read at most every 30 s: ~/.claude.json alone can be megabytes, and the app polls
 * status every second while something is under way. */
const detections = new Map<
  keyof typeof providerLogins,
  { at: number; found: ReturnType<(typeof providerLogins)[keyof typeof providerLogins]["detect"]> }
>();
function detect(provider: keyof typeof providerLogins) {
  const cached = detections.get(provider);
  if (cached && Date.now() - cached.at < 30_000) return cached.found;
  const found = moduleFor(provider).detect();
  detections.set(provider, { at: Date.now(), found });
  return found;
}

/** Status, the change feed, settings and backups. */
export function system(ctx: Ctx) {
  const { s } = ctx;
  const app = new Hono<Env>();
  // The app waits here and refreshes when something changed (changes.ts).
  app.get("/changes", async (c) => {
    const wait = Math.min(25, Math.max(0, Number(c.req.query("wait") ?? 25) || 0));
    await ctx.changes.wait(c.req.query("after"), wait * 1000, AbortSignal.any([c.req.raw.signal, ctx.abort.signal]));
    return c.json(ctx.changes.snapshot());
  });
  app.get("/status", (c) => {
    const status: Status = {
      apiVersion: API_VERSION,
      daemon: {
        version: packageInfo.version,
        build: process.env.AGENTGATE_BUILD ?? "development",
        providers: providerCapabilities(),
        lag: lag(),
      },
      settingsRevision: revision(s, "setting", "settings"),
      node: s.nodeId,
      accounts: s.list("account").map((a) => accountStatus(s, a)),
      detected: providerSchema.options.flatMap((provider) => {
        const found = detect(provider);
        const pooled =
          found &&
          s
            .list("account")
            .some((a) => a.provider === provider && a.email?.toLowerCase() === found.email.toLowerCase());
        return found && !pooled ? [{ provider, ...found, source: detectedSource[provider] }] : [];
      }),
      servers: s.list("mcp").map((i) => {
        const health = serverHealth(s, i.id);
        return {
          id: i.id,
          label: i.label,
          template: i.template,
          transport: i.transport,
          mode: i.mode,
          endpoint: readableEndpoint(i.url),
          loggedIn: !!s.get("mcpCredential", i.id)?.tokens,
          needsLogin: !!s.get("mcpCredential", i.id)?.needsLogin || !!health?.needsLogin,
          available: health?.ok,
          checkedAt: health?.at,
          refreshError: refreshFailure(s, "mcpCredential", i.id) ? "Token refresh failed" : undefined,
        };
      }),
      projects: s.list("project").map((p) => shownProject(ctx, p)),
      skills: skillSummaries(s),
      skillConflicts: ctx.skills.conflicts(),
      skillKept: ctx.skills.kept(),
      skillHealth: ctx.skills.health(),
      skillRepos: skillRepoSummaries(s),
      fileErrors: filesErrors(s),
      checkouts: Object.entries(ctx.skills.checkouts()).map(([path, project]) => ({
        path,
        project,
        skills: ctx.skills.repoSkills(path),
        mirror: ctx.skills.mirroring(path),
      })),
      settings: s.settings(),
      nodes: s.list("node").map((n) => ({
        ...n,
        lastSeen: lastSeen(s, n.id),
        online: n.id === s.nodeId || s.now() - lastSeen(s, n.id) < 60_000,
        syncError: s.local(`syncError:${n.id}`) ? "Sync failed" : undefined,
        via: n.id === s.nodeId ? [] : via(s, n.id),
        update: nodeUpdate(s, n.id),
      })),
      relay: relayStatus(s),
      logins: listLogins(s),
      unknownQuota: recordFromKeys(["claude", "codex"], (p) => s.local(`quotaUnknown:${p}`)),
      // Nothing reads these, and activity changed on every model request. An app on the current API_VERSION still
      // requires both, so they stay empty until the next bump removes them.
      peers: [],
      activity: [],
    };
    return c.json(status);
  });
  app.patch("/settings", async (c) => {
    const f = z
      .object({ revision: z.string().length(64).optional(), patch: settingsPatchSchema })
      .strict()
      .parse(await json(c.req.raw));
    return c.json(patchSettings(s, f.patch, f.revision));
  });
  app.get("/backup", (c) => {
    local(c.env.listener);
    return c.json(exportBackup(s, c.req.query("secrets") === "true"));
  });
  app.post("/backup", async (c) => {
    local(c.env.listener);
    const backup = await json(c.req.raw);
    return c.json({ restored: input(() => importBackup(s, backup)) });
  });
  return app;
}
