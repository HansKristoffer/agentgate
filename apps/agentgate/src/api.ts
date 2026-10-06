import {
  API_VERSION,
  accountSchema,
  projectSchema,
  providerSchema,
  settingsSchema,
  SkillConflict,
  decodedSize,
  projectIdSchema,
  skillIdSchema,
  type SkillPreviewResponse,
  type Status,
  type ToolPreview,
} from "@agentgate/protocol";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { homedir } from "node:os";
import { z } from "zod";
import { pkce } from "./credentials.ts";
import type { Ctx, Env } from "./daemon.ts";
import * as claude from "./llm/claude.ts";
import * as codex from "./llm/codex.ts";
import * as cursor from "./llm/cursor.ts";
import { accountStatus } from "./llm/pool.ts";
import { providerCapabilities, providerLogins } from "./llm/providers.ts";
import { requests, requestDetail, metrics, tokenUsage } from "./llm/telemetry.ts";
import { route } from "./llm/routing.ts";
import { checkRevision, patchSettings, revision } from "./configuration.ts";
import { failureSchema, modelIdSchema, ConfigurationConflict, accountPatchSchema, settingsPatchSchema } from "@agentgate/protocol";
import packageInfo from "../../../package.json";
import { updateNode } from "./update.ts";
import {
  aliasesFor,
  connect,
  listAllTools,
  needsLogin,
  serverHealth,
  renameInstance,
  scanRepos,
  toolName,
} from "./mcp/gateway.ts";
import { finishLogin, startLogin } from "./mcp/oauth.ts";
import { presets } from "./mcp/templates.ts";
import {
  createInstance,
  labelInstance,
  deleteAccount,
  deleteInstance,
  saveProject,
  setAccount,
} from "./operations.ts";
import * as desktop from "./desktop.ts";
import { deleteProject, disableRemote, enableRemote, publicProject, regenerate, regenerateAfterUnpair, rotateSecret, showRemote } from "./remote.ts";
import { jsonInput } from "./http.ts";
import {
  connectSkillRepo,
  deleteSkill,
  installSkills,
  setSkillRepoProjects,
  skillRepoSummaries,
  syncSkillRepo,
  searchSkills,
  setSkillProjects,
  skillSummaries,
  updateSkill,
  writeSkillMd,
  skillRevision,
} from "./skills.ts";
import { exportBackup, importBackup, SKILL_ID } from "./store.ts";
import { connectInput, t3State } from "./handoff/t3.ts";
import { allNodes, connectNode, disconnectNode, handoffJob, requestHandoff } from "./handoff/threads.ts";
import { join, lastSeen, pairCode, peers, tailscale, unpair } from "./sync.ts";
import {
  RelayBusy,
  RelayError,
  cleanupRelay,
  createRelay,
  installAndJoin,
  joinRelay,
  leaveRelay,
  newNodeName,
  parseJoin,
  reconcileRelay,
  relayInvite,
  relayNodes,
  relayStatus,
  rotateRelay,
  setServiceKey,
  via,
} from "./relay.ts";

const required = (value: unknown, name: string) => {
  if (!value) throw new HTTPException(404, { message: `No such ${name}` });
};
const moduleFor = <P extends keyof typeof providerLogins>(provider: P) => providerLogins[provider];
const detectedSource = { claude: "~/.claude", codex: "~/.codex", cursor: "~/.cursor" };
const readableEndpoint = (url?: string) => {
  if (!url) return "Local command";
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "HTTP server";
  }
};

/** JSON control plane. Provider/MCP credentials never appear in its status response. */
export function management(ctx: Ctx) {
  const { s } = ctx;
  const app = new Hono<Env>();
  const pending = new Map<
    string,
    {
      provider: z.infer<typeof providerSchema>;
      verifier: string;
      label?: string;
      at: number;
    }
  >();
  const json = jsonInput;
  const signal = (req: Request) => AbortSignal.any([req.signal, ctx.abort.signal]);
  const local = (listener: string) => {
    if (listener !== "loopback")
      throw new HTTPException(403, {
        message: "This operation requires a local connection",
      });
  };
  // Relay messages are sanitized summaries, safe for a signed-in administrator.
  const relayed = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof RelayBusy)
        throw new HTTPException(409, { message: error.message });
      if (error instanceof RelayError)
        throw new HTTPException(error.status ? 502 : 400, {
          message: error.message,
        });
      throw error;
    }
  };
  const optionalJson = async (req: Request) =>
    req.headers.get("content-type") ? json(req) : {};
  const tools = async (id: string) => {
    const inst = s.get("mcp", id);
    required(inst, "server");
    const client = await connect(inst!, process.cwd(), s);
    try {
      return await listAllTools(client);
    } finally {
      await client.close();
    }
  };
  // Operational input errors are safe to show to a signed-in administrator.
  const input = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof HTTPException || error instanceof SkillConflict || error instanceof ConfigurationConflict)
        throw error;
      throw new HTTPException(400, {
        message: error instanceof Error ? error.message : "Invalid operation",
      });
    }
  };
  const inputAsync = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      return input(() => { throw error; });
    }
  };
  app.get("/status", (c) => {
    const status: Status = {
      apiVersion: API_VERSION,
      daemon: { version: packageInfo.version, build: process.env.AGENTGATE_BUILD ?? "development", providers: providerCapabilities() },
      settingsRevision: revision(s, "setting", "settings"),
      metrics: metrics(s),
      node: s.nodeId,
      accounts: s.list("account").map((a) => accountStatus(s, a)),
      detected: providerSchema.options.flatMap((provider) => {
        const found = moduleFor(provider).detect();
        const pooled = found && s.list("account").some((a) => a.provider === provider && a.email?.toLowerCase() === found.email.toLowerCase());
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
        refreshError: s.local(`refreshError:mcpCredential:${i.id}`)
          ? "Token refresh failed"
          : undefined,
        };
      }),
      projects: s.list("project").map(p => publicProject(p, ctx.remote)),
      skills: skillSummaries(s),
      skillConflicts: ctx.skills.conflicts(),
      skillHealth: ctx.skills.health(),
      skillRepos: skillRepoSummaries(s),
      checkouts: Object.entries(ctx.skills.checkouts()).map(([path, project]) => ({ path, project, skills: ctx.skills.repoSkills(path), mirror: ctx.skills.mirroring(path) })),
      settings: s.settings(),
      nodes: s.list("node").map((n) => ({
        ...n,
        lastSeen: lastSeen(s, n.id),
        online: n.id === s.nodeId || s.now() - lastSeen(s, n.id) < 60_000,
        syncError: s.local(`syncError:${n.id}`) ? "Sync failed" : undefined,
        via: n.id === s.nodeId ? [] : via(s, n.id),
      })),
      relay: relayStatus(s),
      t3: t3State(s),
      peers: peers(s).map((p) => ({
        node: p.node,
        url: p.url,
        lastSeen: p.last_seen ?? 0,
        cursor: p.cursor,
        error: s.local(`syncError:${p.node}`) ? "Sync failed" : undefined,
      })),
      unknownQuota: Object.fromEntries(
        (["claude", "codex"] as const).map((p) => [
          p,
          s.local(`quotaUnknown:${p}`),
        ]),
      ),
      activity: s.db
        .query(
          "select at, provider, account, model, status, ms, note from request_log order by at desc limit 50",
        )
        .all() as Status["activity"],
    };
    return c.json(status);
  });
  app.patch("/accounts/:id", async (c) => {
    required(s.get("account", c.req.param("id")), "account");
    const patch = accountPatchSchema
      .extend({ revision: z.string().length(64).optional() })
      .strict()
      .parse(await json(c.req.raw));
    const { revision: expected, ...fields } = patch;
    if ((fields.label !== undefined || fields.priority !== undefined || fields.policy !== undefined) && !expected) throw new ConfigurationConflict();
    return c.json(input(() => s.transaction(() => {
      if (expected) checkRevision(s, "account", c.req.param("id"), expected);
      return setAccount(s, c.req.param("id"), fields);
    })));
  });
  app.get("/requests", (c) => {
    const f = z.object({ provider: providerSchema.optional(), account: z.string().max(512).optional(), model: modelIdSchema.optional(), outcome: z.enum(["pending", "success", "failed", "interrupted", "cancelled"]).optional(), failure: failureSchema.optional(), search: z.string().max(128).optional(), since: z.coerce.number().int().nonnegative().optional(), until: z.coerce.number().int().nonnegative().optional(), cursor: z.string().regex(/^\d{1,16}$/).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict().parse(c.req.query());
    return c.json(input(() => requests(s, f)));
  });
  app.get("/requests/:id", (c) => { const result = requestDetail(s, c.req.param("id")); required(result, "request"); return c.json(result!); });
  app.get("/proxy/metrics", (c) => c.json(metrics(s)));
  app.get("/proxy/tokens", (c) => c.json(tokenUsage(s, z.object({ since: z.coerce.number().int().nonnegative().optional() }).strict().parse(c.req.query()).since)));
  app.get("/proxy/route", (c) => {
    const f = z.object({ provider: z.enum(["claude", "codex"]), model: modelIdSchema.optional() }).strict().parse(c.req.query());
    return c.json(route(s, f.provider, f.model));
  });
  app.post("/accounts/batch", async (c) => {
    const f = z.object({ ids: z.array(z.string().min(1).max(512)).min(1).max(100), action: z.enum(["quota", "verify", "enable", "disable", "refresh", "models", "reset-cooldown"]) }).strict().parse(await json(c.req.raw));
    return c.json(await ctx.proxyOperations.batch(f.ids, f.action, AbortSignal.any([signal(c.req.raw), AbortSignal.timeout(90000)])));
  });
  app.post("/accounts/:id/verify", async (c) => {
    required(s.get("account", c.req.param("id")), "account");
    const f = z.object({ probe: z.boolean().default(false), model: modelIdSchema.optional() }).strict().parse(await optionalJson(c.req.raw));
    if (f.probe && !f.model) throw new HTTPException(400, { message: "Choose a model for the quota-consuming probe" });
    return c.json(await ctx.proxyOperations.verify(c.req.param("id"), AbortSignal.any([signal(c.req.raw), AbortSignal.timeout(90000)]), f));
  });
  app.delete("/accounts/:id", (c) => {
    required(s.get("account", c.req.param("id")), "account");
    deleteAccount(s, c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/accounts/import", async (c) => {
    local(c.env.listener);
    const f = z
      .object({
        provider: providerSchema,
        dir: z.string().min(1),
        label: z.string().optional(),
      })
      .parse(await json(c.req.raw));
    return c.json({
      id: await moduleFor(f.provider).importFrom(
        s,
        f.dir.replace(/^~/, homedir()),
        f.label,
      ),
    });
  });
  app.post("/accounts/login", async (c) => {
    const f = z
      .object({ provider: providerSchema, label: z.string().optional(), email: z.email().optional() })
      .parse(await json(c.req.raw));
    for (const [state, p] of pending)
      if (s.now() - p.at > 30 * 60_000) pending.delete(state);
    if (pending.size >= 128)
      throw new HTTPException(429, { message: "Too many pending logins" });
    const { verifier, challenge, state: oauthState } = await pkce();
    // Cursor names the attempt with a UUID that it polls on, rather than an OAuth state.
    const state = f.provider === "cursor" ? crypto.randomUUID() : oauthState;
    pending.set(state, { provider: f.provider, label: f.label, verifier, at: s.now() });
    return c.json({
      state,
      provider: f.provider,
      url: moduleFor(f.provider).authorizeUrl(challenge, state, f.email),
    });
  });
  app.delete("/accounts/login/:state", (c) => {
    pending.delete(c.req.param("state"));
    return c.json({ ok: true });
  });
  app.post("/accounts/login/finish", async (c) => {
    const f = z
      .object({ state: z.string().min(1), code: z.string().min(1).optional() })
      .parse(await json(c.req.raw));
    const p = pending.get(f.state);
    if (!p || s.now() - p.at > 30 * 60_000) {
      pending.delete(f.state);
      throw new HTTPException(400, {
        message: "That login expired; start again",
      });
    }
    // Cursor has no code to paste: wait for the browser sign-in, and answer `pending` before the client's request times out.
    if (p.provider === "cursor") {
      const id = await cursor.finish(s, f.state, p.verifier, p.label, signal(c.req.raw));
      if (id) pending.delete(f.state);
      return c.json(id ? { id } : { pending: true });
    }
    pending.delete(f.state);
    if (!f.code) throw new HTTPException(400, { message: "Paste the code shown after signing in" });
    return c.json({
      id: await moduleFor(p.provider).exchange(
        s,
        f.code,
        p.verifier,
        p.label,
        f.state,
      ),
    });
  });
  app.get("/presets", (c) => c.json(presets));
  app.post("/servers", async (c) => {
    const f = z
      .object({
        id: z.string().min(1),
        target: z.string().optional(),
        command: z.string().optional(),
        perSession: z.boolean().optional(),
        headers: z.string().optional(),
      })
      .strict()
      .parse(await json(c.req.raw));
    const { id: name, ...rest } = f;
    const inst = input(() => createInstance(s, { name, ...rest }));
    return c.json({ id: inst.id }, 201);
  });
  app.patch("/servers/:id", async (c) => {
    const f = z.object({ label: z.string() }).strict().parse(await json(c.req.raw));
    input(() => labelInstance(s, c.req.param("id"), f.label));
    return c.json({ ok: true });
  });
  app.post("/servers/:id/rename", async (c) => {
    const f = z.object({ id: z.string().min(1) }).parse(await json(c.req.raw));
    input(() => renameInstance(s, c.req.param("id"), f.id));
    return c.json({ ok: true });
  });
  app.post("/servers/:id/test", async (c) => {
    try {
      return c.json({ tools: await tools(c.req.param("id")) });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      throw new HTTPException(needsLogin(error) ? 401 : 502, {
        message: needsLogin(error)
          ? "This server needs a login. Click Sign in."
          : "Could not connect to this server. Check its URL or command and daemon service logs.",
      });
    }
  });
  app.post("/servers/:id/login", async (c) => {
    required(s.get("mcp", c.req.param("id")), "server");
    const url = await startLogin(
      s,
      c.req.param("id"),
      `${new URL(c.req.url).origin}/oauth/callback`,
    );
    return c.json({ url: url?.href, ok: !url });
  });
  app.delete("/servers/:id", (c) => {
    required(s.get("mcp", c.req.param("id")), "server");
    deleteInstance(s, c.req.param("id"));
    return c.json({ ok: true });
  });
  const skillRequired = (id: string) => { const skill = s.get("skill", id); required(skill, "skill"); return skill!; };
  const sourceInput = z.object({ source: z.string().trim().min(1).max(2048), skill: z.string().min(1).max(256).optional() });
  app.get("/skills/search", async (c) => {
    const q = z.string().trim().min(2).max(200).parse(c.req.query("q"));
    try {
      return c.json(await searchSkills(q, signal(c.req.raw)));
    } catch {
      throw new HTTPException(502, { message: "skills.sh search is unavailable; add a skill by its source instead" });
    }
  });
  // GitHub repositories the daemon keeps in sync. Not under /skills/, where a skill could be named "repos".
  const repoInput = z.object({ url: z.string().trim().min(1).max(512), projects: z.array(projectIdSchema).max(5000) }).strict();
  app.post("/skill-repos", async (c) => {
    const f = repoInput.parse(await json(c.req.raw));
    return c.json({ url: await inputAsync(() => connectSkillRepo(s, f.url, f.projects, undefined, signal(c.req.raw))) }, 201);
  });
  app.put("/skill-repos", async (c) => {
    const f = repoInput.parse(await json(c.req.raw));
    input(() => setSkillRepoProjects(s, f.url, f.projects));
    return c.json({ ok: true });
  });
  app.post("/skill-repos/sync", async (c) => {
    const f = repoInput.pick({ url: true }).parse(await json(c.req.raw));
    return c.json({ updated: await inputAsync(() => syncSkillRepo(s, f.url, undefined, signal(c.req.raw))) });
  });
  app.post("/skills/fetch", async (c) => {
    const f = sourceInput.strict().parse(await json(c.req.raw));
    try {
      const artifact = await ctx.imports.preview(f.source, f.skill, signal(c.req.raw));
      const preview: SkillPreviewResponse = { token: artifact.token, skills: artifact.skills.map(k => {
        const existing = s.get("skill", k.id);
        return {
          id: k.id, description: k.description, files: k.files.length,
          size: k.files.reduce((n, file) => n + decodedSize(file.data), 0),
          hash: k.hash, security: k.security, installed: !!existing,
          conflict: existing && existing.source !== f.source ? `Already exists ${existing.source ? `from ${existing.source}` : "as a handwritten skill"}` : undefined,
        };
      }) };
      return c.json(preview);
    } catch (error) {
      if (error instanceof SkillConflict) throw error;
      throw new HTTPException(502, { message: error instanceof Error ? error.message : "Could not fetch skills" });
    }
  });
  app.post("/skills", async (c) => {
    const f = z.object({ token: z.string().uuid(), ids: z.array(skillIdSchema).min(1).max(100), projects: z.array(projectIdSchema).max(5000).default([]) }).strict().parse(await json(c.req.raw));
    const artifact = ctx.imports.get(f.token);
    return c.json({ installed: input(() => installSkills(s, artifact.source, artifact.skills, f.ids, f.projects)) }, 201);
  });
  app.get("/skills/:id", (c) => {
    const skill = s.get("skill", c.req.param("id"));
    required(skill, "skill");
    const md = skill!.files.find((f) => f.path === "SKILL.md");
    return c.json({
      id: skill!.id,
      source: skill!.source,
      revision: skillRevision(s, skill!.id),
      skillMd: md ? Buffer.from(md.data, "base64").toString() : "",
      files: skill!.files.map((f) => ({ path: f.path, size: decodedSize(f.data) })),
    });
  });
  app.put("/skills/:id", async (c) => {
    const id = c.req.param("id");
    if (!SKILL_ID.test(id)) throw new HTTPException(400, { message: "Skill names use lowercase letters, digits, ., _ and -" });
    const f = z.object({ skillMd: z.string().max(1024 * 1024), revision: z.string().max(1024).nullable() }).strict().parse(await json(c.req.raw));
    input(() => writeSkillMd(s, id, f.skillMd, f.revision));
    return c.json({ ok: true });
  });
  app.put("/skills/:id/projects", async (c) => {
    skillRequired(c.req.param("id"));
    const f = z.object({ projects: z.array(projectIdSchema).max(5000) }).strict().parse(await json(c.req.raw));
    input(() => setSkillProjects(s, c.req.param("id"), f.projects));
    return c.json({ ok: true });
  });
  app.post("/skills/:id/update", async (c) => {
    if (!skillRequired(c.req.param("id")).source) throw new HTTPException(400, { message: "This skill was written by hand; edit it instead" });
    try {
      return c.json({ updated: await updateSkill(s, c.req.param("id"), ctx.imports.fetchFresh, signal(c.req.raw)) });
    } catch (error) {
      if (error instanceof SkillConflict) throw error;
      throw new HTTPException(502, { message: error instanceof Error ? error.message : "Update failed" });
    }
  });
  app.delete("/skills/:id", (c) => {
    skillRequired(c.req.param("id"));
    input(() => deleteSkill(s, c.req.param("id")));
    return c.json({ ok: true });
  });
  app.put("/projects", async (c) => {
    const f = projectSchema
      .pick({ id: true, mcp: true, inheritDefaults: true })
      // Optional, so a client that does not know skills cannot clear them.
      .extend({ skills: z.array(skillIdSchema).max(5000).optional() })
      .parse(await json(c.req.raw));
    const saved = input(() => saveProject(s, f.id, f));
    ctx.remote.reconcile();
    return c.json(publicProject(saved, ctx.remote));
  });
  // Virtual projects' endpoints. Every route that returns or changes a secret is loopback-only.
  const remoteId = (c: { req: { query(name: string): string | undefined } }) => z.string().min(1).max(80).parse(c.req.query("id"));
  const remoteBody = async (req: Request) => z.object({ id: z.string().min(1).max(80), servedBy: z.string().min(1).max(512).optional() }).strict().parse(await json(req));
  const remoteChanged = <T>(fn: () => T): T => { const out = input(fn); ctx.remote.reconcile(); return out; };
  app.post("/projects/remote", async (c) => {
    local(c.env.listener);
    const f = await remoteBody(c.req.raw);
    return c.json(remoteChanged(() => enableRemote(s, f.id, f.servedBy)));
  });
  app.get("/projects/remote", (c) => {
    local(c.env.listener);
    return c.json(input(() => showRemote(s, remoteId(c))));
  });
  app.post("/projects/remote/secret", async (c) => {
    local(c.env.listener);
    const f = await remoteBody(c.req.raw);
    return c.json(remoteChanged(() => rotateSecret(s, f.id)));
  });
  app.post("/projects/remote/regenerate", async (c) => {
    local(c.env.listener);
    const f = await remoteBody(c.req.raw);
    return c.json(remoteChanged(() => regenerate(s, f.id, f.servedBy)));
  });
  app.delete("/projects/remote", (c) => {
    remoteChanged(() => disableRemote(s, remoteId(c)));
    return c.json({ ok: true });
  });
  app.delete("/projects", (c) => {
    const id = z.string().min(1).parse(c.req.query("id"));
    deleteProject(s, id);
    ctx.remote.reconcile();
    return c.json({ ok: true });
  });
  app.post("/projects/scan", async (c) => {
    local(c.env.listener);
    const { dir } = z
      .object({ dir: z.string().min(1) })
      .parse(await json(c.req.raw));
    const repos = input(() => scanRepos(dir.replace(/^~/, homedir())));
    // Scanned checkouts receive their project's skills on this machine.
    for (const r of repos) ctx.skills.register(r.path, r.repo, false);
    ctx.skills.sync();
    return c.json({ repos });
  });
  app.put("/checkouts/mirroring", async (c) => {
    local(c.env.listener);
    const f = z.object({ path: z.string().min(1).max(4096), enabled: z.boolean() }).strict().parse(await json(c.req.raw));
    input(() => ctx.skills.setMirroring(f.path, f.enabled));
    return c.json({ ok: true });
  });
  app.get("/projects/tools", async (c) => {
    const result: ToolPreview[] = [];
    for (const [alias, id] of Object.entries(
      aliasesFor(s, c.req.query("id") ?? "*"),
    )) {
      const inst = s.get("mcp", id);
      if (inst?.mode === "perSession")
        result.push({
          name: `${alias}__*`,
          description: "Starts inside each session's worktree",
        });
      else
        try {
          for (const t of await tools(id))
            result.push({
              name: toolName(alias, t.name),
              description: t.description,
            });
        } catch {
          result.push({
            name: `${alias}__*`,
            error: "Could not connect; test the server or sign in again",
          });
        }
    }
    return c.json(result);
  });
  app.post("/nodes/pair", async (c) => {
    const f = z
      .object({
        method: z.enum(["tailnet", "relay"]).default("tailnet"),
        relayUrl: z.string().max(2000).optional(),
        name: z.string().max(63).optional(),
      })
      .strict()
      .parse(await optionalJson(c.req.raw));
    const name = f.name?.trim()
      ? await relayed(async () => newNodeName(s, f.name!.trim()))
      : undefined;
    if (f.method === "relay") {
      // The invite is a master key: only a local caller may see it.
      local(c.env.listener);
      const invite = await relayed(() => createRelay(s, f.relayUrl));
      return c.json({ command: installAndJoin(invite, name), method: "relay" });
    }
    const url = s.get("node", s.nodeId)?.url ?? (await tailscale())?.url;
    if (!url)
      throw new HTTPException(409, {
        message: "Start Tailscale before pairing",
      });
    return c.json({
      command: installAndJoin(`${url} ${pairCode(s)}`, name),
      method: "tailnet",
      expiresIn: 600,
    });
  });
  app.post("/nodes/join", async (c) => {
    const f = z
      .union([
        z.object({ command: z.string().min(1).max(4096) }).strict(),
        z.object({ url: z.url(), code: z.string().min(1) }).strict(),
      ])
      .parse(await json(c.req.raw));
    const target =
      "command" in f ? await relayed(async () => parseJoin(f.command)) : f;
    if ("invite" in target)
      return c.json(
        await relayed(() => joinRelay(s, target.invite, target.force)),
      );
    const self = s.get("node", s.nodeId)?.url ?? (await tailscale())?.url;
    if (!self)
      throw new HTTPException(409, {
        message: "Start Tailscale before pairing",
      });
    return c.json({ node: await join(s, target.url, target.code, self) });
  });
  app.post("/relay/reconcile", async (c) => {
    await relayed(() => reconcileRelay(s));
    return c.json({ ok: true });
  });
  app.post("/relay/rotate", async (c) => {
    local(c.env.listener);
    return c.json(await relayed(() => rotateRelay(s)));
  });
  app.post("/relay/leave", async (c) => {
    const f = z
      .object({ wipe: z.boolean().default(false) })
      .strict()
      .parse(await optionalJson(c.req.raw));
    return c.json(await relayed(() => leaveRelay(s, f.wipe)));
  });
  app.post("/relay/cleanup", async (c) => {
    const f = z
      .object({ abandon: z.boolean().default(false) })
      .strict()
      .parse(await optionalJson(c.req.raw));
    return c.json(await relayed(() => cleanupRelay(s, f.abandon)));
  });
  app.put("/relay/service-key", async (c) => {
    local(c.env.listener);
    const f = z
      .object({ key: z.string().min(1).max(512).nullable() })
      .strict()
      .parse(await json(c.req.raw));
    setServiceKey(s, f.key ?? undefined);
    return c.json({ ok: true });
  });
  app.patch("/nodes/:id", async (c) => {
    const f = z
      .object({ alwaysOn: z.boolean() })
      .strict()
      .parse(await json(c.req.raw));
    const n = s.get("node", c.req.param("id"));
    required(n, "node");
    return c.json(s.put("node", n!.id, { ...n!, ...f }));
  });
  // Not local-only: updating an always-on server from wherever you are is the point. The node runs the release
  // checks itself and refuses copies another tool owns.
  app.post("/nodes/:id/update", async (c) => {
    const n = s.get("node", c.req.param("id"));
    required(n, "node");
    return c.json(await inputAsync(() => updateNode(s, n!.id)));
  });
  app.delete("/nodes/:id", async (c) => {
    const id = c.req.param("id");
    // The removed machine knows every endpoint's credentials, so each gets a new URL (shown again locally).
    const endpoints = s.list("project").some(p => p.remote) ? (local(c.env.listener), regenerateAfterUnpair(s, id)) : [];
    if (endpoints.length) ctx.remote.reconcile();
    if (relayInvite(s) && relayNodes(s).some((n) => n.node === id)) {
      // A relay member can only be removed by moving everyone else to a new secret.
      local(c.env.listener);
      if (peers(s).some((p) => p.node === id)) unpair(s, id);
      const rotated = await relayed(() => rotateRelay(s));
      return c.json({ ok: true, rotated: true, ...rotated, endpoints });
    }
    input(() => unpair(s, id));
    return c.json({ ok: true, endpoints });
  });
  // Thread handoff. Connecting receives a T3 pairing token, a credential: local callers only.
  app.get("/t3", (c) => c.json(t3State(s)));
  app.post("/t3/connect", async (c) => {
    local(c.env.listener);
    const node = c.req.query("node");
    const input = connectInput.parse(await json(c.req.raw));
    return c.json(await inputAsync(() => connectNode(ctx.handoffs, node, input)));
  });
  app.delete("/t3", async (c) => {
    await inputAsync(() => disconnectNode(ctx.handoffs, c.req.query("node")));
    return c.json({ ok: true });
  });
  app.get("/threads", async (c) => c.json(await allNodes(ctx.handoffs)));
  app.get("/handoffs", (c) => c.json(ctx.handoffs.list().map((job) => ctx.handoffs.view(job))));
  app.post("/handoffs", async (c) => {
    const f = z.object({ threadId: z.string().min(1).max(512), node: z.string().min(1).max(512).optional(), to: z.string().min(1).max(512).optional() }).strict().parse(await json(c.req.raw));
    return c.json(await inputAsync(() => requestHandoff(ctx.handoffs, f)), 201);
  });
  app.get("/handoffs/:id", async (c) => {
    const job = await inputAsync(() => handoffJob(ctx.handoffs, c.req.param("id"), c.req.query("node")));
    required(job, "handoff");
    return c.json(job);
  });
  app.patch("/settings", async (c) => {
    const f = z.object({ revision: z.string().length(64), patch: settingsPatchSchema }).strict().parse(await json(c.req.raw));
    return c.json(patchSettings(s, f.patch, f.revision));
  });
  app.put("/settings", async (c) => {
    const f = settingsSchema.extend({ revision: z.string().length(64) }).strict().parse(await json(c.req.raw));
    const { revision: expected, ...settings } = f;
    return c.json(patchSettings(s, settings, expected));
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
  // Claude Desktop on this Mac. Loopback only: a remote connection must never drive another Mac's Desktop.
  app.get("/desktop", (c) => {
    local(c.env.listener);
    return c.json(desktop.status(s));
  });
  app.post("/desktop/capture", (c) => {
    local(c.env.listener);
    return c.json({ accountUuid: input(() => desktop.capture(s)) });
  });
  app.post("/desktop/add", async (c) => {
    local(c.env.listener);
    const f = z.object({ expected: z.string().max(320).optional() }).strict().parse(await json(c.req.raw));
    await inputAsync(() => desktop.add(s, f.expected));
    return c.json({ ok: true });
  });
  app.delete("/desktop/add", (c) => {
    local(c.env.listener);
    desktop.cancelAdd(s);
    return c.json({ ok: true });
  });
  app.post("/desktop/use", async (c) => {
    local(c.env.listener);
    const f = z.object({ accountUuid: z.string().min(1).max(64) }).strict().parse(await json(c.req.raw));
    await inputAsync(() => desktop.use(s, f.accountUuid));
    return c.json({ ok: true });
  });
  app.delete("/desktop/logins/:uuid", (c) => {
    local(c.env.listener);
    input(() => desktop.forget(s, c.req.param("uuid")));
    return c.json({ ok: true });
  });
  app.post("/desktop/gateway", async (c) => {
    local(c.env.listener);
    const f = z.object({ on: z.boolean() }).strict().parse(await json(c.req.raw));
    await inputAsync(() => desktop.gateway(s, f.on));
    return c.json({ ok: true });
  });
  return app;
}

/** Browser-only OAuth landing response, also used by headless CLI MCP logins. */
export function oauthCallback(ctx: Ctx) {
  return async (c: import("hono").Context<Env>) => {
    c.header("Cache-Control", "no-store");
    const { code, state, error } = c.req.query();
    if (error || !code || !state)
      return c.text("Login failed. Return to Agentgate and start again.", 400);
    try {
      await finishLogin(ctx.s, state, code);
      return c.text(
        "Logged in. You can close this window and return to Agentgate.",
      );
    } catch {
      return c.text(
        "Login failed or expired. Return to Agentgate and start again.",
        400,
      );
    }
  };
}
