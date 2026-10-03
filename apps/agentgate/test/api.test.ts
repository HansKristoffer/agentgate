import { revision } from "../src/configuration.ts";
import { afterEach, expect, test } from "bun:test";
import { API_VERSION, statusSchema, type SkillPreviewResponse, type Status } from "@agentgate/protocol";
import { app, makeCtx, type Listener } from "../src/daemon.ts";
import { newInstance } from "../src/mcp/templates.ts";
import { choose } from "../src/llm/pool.ts";
import { SkillImports } from "../src/skill-import.ts";
import { writeSkillMd } from "../src/skills.ts";
import { exportBackup, Store } from "../src/store.ts";
import { Telemetry } from "../src/llm/telemetry.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
function fixture(options: Parameters<typeof makeCtx>[1] = {}) {
  const s = new Store(":memory:");
  s.setLocal("node", "test");
  s.setLocal("adminToken", "admin-secret");
  const ctx = makeCtx(s, options),
    handler = app(ctx);
  cleanup.push(async () => {
    ctx.abort.abort(); ctx.skills.close(); ctx.imports.close();
    await ctx.imports.drain();
    await ctx.gateway.close();
    s.close();
  });
  const call = (
    path: string,
    method = "GET",
    body?: unknown,
    listener: Listener = "loopback",
    headers: Record<string, string> = {},
  ) =>
    handler.fetch(
      new Request(`http://127.0.0.1:7878${path}`, {
        method,
        headers: {
          host: "127.0.0.1:7878",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { listener },
    );
  return { s, call, handler, ctx };
}

test("proxy management returns validated capabilities, revision-safe patches, and filtered diagnostics", async () => {
  const { s, call } = fixture();
  s.put("account", "a", { id: "a", provider: "claude", label: "a", priority: 4 });
  s.put("credential", "a", { accountId: "a", accessToken: "private-token", refreshToken: "private-refresh", holder: "test", expiresAt: s.now() + 3600000 });
  const initial = await (await call("/api/status")).json() as Status;
  expect(statusSchema.safeParse(initial).success).toBe(true);
  expect(initial.daemon?.providers.claude).toMatchObject({ quota: true, models: true, probe: true });
  const savedResponse = await call("/api/settings", "PATCH", { revision: initial.settingsRevision, patch: { strategy: "priority", retryLimit: 0 } });
  expect(savedResponse.status).toBe(200);
  const saved = await savedResponse.json() as { strategy: string; retryLimit: number; revision: string };
  expect(saved).toMatchObject({ strategy: "priority", retryLimit: 0, revision: revision(s, "setting", "settings") });
  expect(s.get("setting", "settings")).not.toHaveProperty("revision");
  expect((await call("/api/settings", "PATCH", { revision: initial.settingsRevision, patch: { threshold: 50 } })).status).toBe(409);
  expect((await call("/api/accounts/a", "PATCH", { label: "changed" })).status).toBe(409);
  const accountRevision = revision(s, "account", "a");
  expect((await call("/api/accounts/a", "PATCH", { revision: accountRevision, policy: { retryLimit: 0, excludeModels: ["opus"] } })).status).toBe(200);
  expect(s.get("account", "a")).toMatchObject({ label: "a", priority: 4, enabled: true });
  expect((await call("/api/accounts/a", "PATCH", { revision: accountRevision, label: "stale" })).status).toBe(409);
  expect((await call("/api/proxy/route?provider=claude&model=opus")).status).toBe(200);
  const t = new Telemetry(s, "claude"); t.models("sonnet", "sonnet"); t.attempt("a", "priority"); t.headers(200); t.finish("success");
  const page = await (await call("/api/requests?provider=claude&outcome=success&search=sonnet&limit=1")).json() as any;
  expect(page.requests.map((r: any) => r.id)).toEqual([t.request.id]);
  const detail = await (await call(`/api/requests/${t.request.id}`)).json(); expect(JSON.stringify(detail)).not.toContain("private-token");
  expect((await call("/api/requests?limit=1000")).status).toBe(400); expect((await call("/api/requests/missing")).status).toBe(404);
  expect((await call("/api/accounts/a/verify", "POST", { probe: true })).status).toBe(400);
  const batch = await (await call("/api/accounts/batch", "POST", { ids: ["a", "missing"], action: "disable" })).json() as any[];
  expect(batch.map(r => r.ok)).toEqual([true, false]);
});

test("proxy management retains authentication and browser-origin guards", async () => {
  const { call } = fixture();
  for (const path of ["/api/requests", "/api/proxy/metrics", "/api/proxy/route?provider=claude"]) {
    expect((await call(path, "GET", undefined, "tailnet")).status).toBe(401);
    expect((await call(path, "GET", undefined, "tailnet", { authorization: "Bearer admin-secret" })).status).toBe(200);
    expect((await call(path, "GET", undefined, "loopback", { origin: "https://example.com" })).status).toBe(403);
  }
  expect((await call("/api/accounts/batch", "POST", { ids: ["a"], action: "disable" }, "loopback", { origin: "https://example.com" })).status).toBe(403);
});

test("cancelled native OAuth attempts cannot finish later", async () => {
  const { call } = fixture();
  const login = await (await call("/api/accounts/login", "POST", { provider: "claude" })).json() as { state: string };
  expect((await call(`/api/accounts/login/${login.state}`, "DELETE")).status).toBe(200);
  expect((await call("/api/accounts/login/finish", "POST", { state: login.state, code: "unused" })).status).toBe(400);
});

test("subscription selection switches each provider independently and keeps quota fallback", async () => {
  const { s, call } = fixture();
  for (const provider of ["claude", "codex"] as const) {
    for (const label of ["personal", "work"]) {
      const id = `${provider}-${label}`;
      s.put("account", id, { id, provider, label });
      s.put("credential", id, {
        accountId: id, accessToken: id, refreshToken: id,
        expiresAt: s.now() + 3600000, holder: "test",
      });
    }
    s.setLocal(`active:${provider}`, `${provider}-personal`);
    expect((await call(`/api/accounts/${provider}-work`, "PATCH", { pinned: true })).status).toBe(200);
    expect(choose(s, provider, undefined)?.id).toBe(`${provider}-work`);
  }
  // Switching Claude leaves the Codex preference intact and replaces the old pin.
  expect((await call("/api/accounts/claude-personal", "PATCH", { pinned: true })).status).toBe(200);
  expect(s.get("account", "claude-work")?.pinned).toBe(false);
  expect(choose(s, "codex", undefined)?.id).toBe("codex-work");
  // A selected subscription at its limit falls back without clearing the preference.
  s.put("usage", "codex-work", {
    accountId: "codex-work", windows: [], status: "exhausted",
    exhaustedUntil: s.now() + 60000, observedAt: s.now(), observedBy: "test",
  });
  expect(choose(s, "codex", undefined)?.id).toBe("codex-personal");
  expect(s.get("account", "codex-work")?.pinned).toBe(true);
  // Automatic selection clears the pin and respects the account used most recently.
  s.setLocal("active:claude", "claude-work");
  expect((await call("/api/accounts/claude-personal", "PATCH", { pinned: false })).status).toBe(200);
  expect(choose(s, "claude", undefined)?.id).toBe("claude-work");
  const status = await (await call("/api/status")).json() as Status;
  expect(status.accounts.filter(a => a.account.pinned).map(a => a.account.id)).toEqual(["codex-work"]);
});

test("web pages, assets, and cookie login are removed", async () => {
  const { call } = fixture();
  for (const path of [
    "/",
    "/accounts",
    "/servers",
    "/projects",
    "/nodes",
    "/settings",
    "/login",
    "/style.css",
  ])
    expect((await call(path)).status).toBe(404);
  expect((await call("/login", "POST", { token: "admin-secret" })).status).toBe(
    404,
  );
  expect(
    (
      await call("/api/status", "GET", undefined, "tailnet", {
        cookie: "agentgate_admin=admin-secret",
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await call("/api/status", "GET", undefined, "tailnet", {
        authorization: "Bearer wrong",
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await call("/api/status", "GET", undefined, "tailnet", {
        authorization: "Bearer admin-secret",
      })
    ).status,
  ).toBe(200);
});

test("browser-origin reads, JSON writes and preflights are rejected before any side effects", async () => {
  const { s, call } = fixture();
  for (const listener of ["loopback", "tailnet"] as const) {
    const browserHeaders: Record<string, string>[] = [
      { origin: "http://127.0.0.1:7878" },
      { origin: "https://evil.test" },
      { "sec-fetch-site": "same-origin" },
    ];
    for (const headers of browserHeaders) {
      const extra = { ...headers, authorization: "Bearer admin-secret" };
      expect(
        (await call("/api/status", "GET", undefined, listener, extra)).status,
      ).toBe(403);
      expect(
        (
          await call(
            "/api/servers",
            "POST",
            { id: "evil", command: "touch /tmp/evil" },
            listener,
            extra,
          )
        ).status,
      ).toBe(403);
    }
    const preflight = await call(
      "/api/servers",
      "OPTIONS",
      undefined,
      listener,
      { origin: "https://evil.test" },
    );
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  }
  expect(s.list("mcp")).toEqual([]);
});

test("status contains native data and omits provider, peer and MCP secrets", async () => {
  const { s, call } = fixture();
  s.put("account", "a", { id: "a", provider: "claude", label: "Work" });
  s.put("credential", "a", {
    accountId: "a",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: Date.now() + 3600000,
    holder: "test",
  });
  s.put("mcp", "server", {
    ...newInstance({
      id: "server",
      url: "https://user:password@example.com/mcp?key=url-secret",
    }),
    headers: { Authorization: "header-secret" },
    env: { API_KEY: "env-secret" },
  });
  s.put("node", "test", { id: "test" });
  const response = await call("/api/status");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  const status = JSON.parse(text) as Status;
  expect(status.apiVersion).toBe(API_VERSION);
  expect(statusSchema.safeParse(status).success).toBe(true);
  expect(status.servers[0]?.endpoint).toBe("https://example.com/mcp");
  expect(status.accounts[0]?.account.label).toBe("Work");
  expect(status.nodes[0]?.online).toBe(true);
  expect(status).not.toHaveProperty("html");
  for (const secret of [
    "admin-secret",
    "access-secret",
    "refresh-secret",
    "password",
    "url-secret",
    "header-secret",
    "env-secret",
  ])
    expect(text).not.toContain(secret);
});

test("native operations validate JSON and update accounts, projects and server references together", async () => {
  const { s, call } = fixture();
  for (const id of ["a", "b"])
    s.put("account", id, { id, label: id, provider: "codex" });
  expect(
    (await call("/api/accounts/a", "PATCH", { pinned: true })).status,
  ).toBe(200);
  expect(
    (await call("/api/accounts/b", "PATCH", { pinned: true, priority: 10, revision: revision(s, "account", "b") }))
      .status,
  ).toBe(200);
  expect(s.get("account", "a")?.pinned).toBe(false);
  expect(
    (await call("/api/accounts/b", "PATCH", { provider: "claude" })).status,
  ).toBe(400);
  expect(s.get("account", "b")?.provider).toBe("codex");
  expect(
    (await call("/api/servers", "POST", { id: "fs", target: "filesystem" }))
      .status,
  ).toBe(201);
  expect(
    (
      await call("/api/projects", "PUT", {
        id: "owner/repo",
        mcp: { files: "fs" },
        inheritDefaults: false,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call("/api/projects", "PUT", {
        id: "other/repo",
        mcp: { invalid: "missing" },
      })
    ).status,
  ).toBe(400);
  expect(s.get("project", "other/repo")).toBeUndefined();
  expect(
    (await call("/api/servers/fs/rename", "POST", { id: "files" })).status,
  ).toBe(200);
  expect(s.get("project", "owner/repo")?.mcp).toEqual({ files: "files" });
  expect((await call("/api/servers/files", "DELETE")).status).toBe(200);
  expect(s.get("project", "owner/repo")?.mcp).toEqual({});
  expect((await call("/api/accounts/missing", "DELETE")).status).toBe(404);
});

test("local backup round trips and remote clients cannot export secrets, restore or import local logins", async () => {
  const { s, call } = fixture();
  s.put("account", "a", { id: "a", provider: "claude", label: "a" });
  s.put("credential", "a", {
    accountId: "a",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: Date.now() + 3600000,
    holder: "test",
  });
  expect(await (await call("/api/backup")).text()).not.toContain(
    "access-secret",
  );
  const backup = await (await call("/api/backup?secrets=true")).json();
  s.del("account", "a");
  s.del("credential", "a");
  expect((await call("/api/backup", "POST", backup)).status).toBe(200);
  expect(s.get("credential", "a")?.accessToken).toBe("access-secret");
  const invalid = exportBackup(s);
  invalid.records.push({
    ...invalid.records[0]!,
    kind: "account",
    data: { provider: "unsupported" },
  });
  const seq = s.seq();
  expect((await call("/api/backup", "POST", invalid)).status).toBe(400);
  expect(s.seq()).toBe(seq);
  for (const [path, method, body] of [
    ["/api/backup?secrets=true", "GET", undefined],
    ["/api/backup", "POST", backup],
    ["/api/accounts/import", "POST", { provider: "claude", dir: "~/.claude" }],
  ] as const) {
    expect(
      (
        await call(path, method, body, "tailnet", {
          authorization: "Bearer admin-secret",
        })
      ).status,
    ).toBe(403);
  }
});

test("malformed JSON and form submissions get clear errors without changing settings", async () => {
  const { s, handler } = fixture();
  for (const [body, type, code] of [
    ["{", "application/json", 400],
    ["threshold=10", "application/x-www-form-urlencoded", 415],
  ] as const) {
    const response = await handler.fetch(
      new Request("http://127.0.0.1:7878/api/settings", {
        method: "PUT",
        body,
        headers: { host: "127.0.0.1:7878", "content-type": type },
      }),
      { listener: "loopback" },
    );
    expect(response.status).toBe(code);
    expect(((await response.json()) as { error: string }).error).toBeTruthy();
  }
  expect(s.get("setting", "settings")).toBeUndefined();
});

test("Claude Desktop endpoints are local only", async () => {
  const { host } = await import("../src/desktop.ts");
  const installed = host.installed;
  host.installed = () => false; // never read this Mac's real Claude Desktop
  cleanup.push(async () => { host.installed = installed; });
  const { call } = fixture();
  const remote = { authorization: "Bearer admin-secret" };
  for (const [path, method, body] of [["/api/desktop", "GET"], ["/api/desktop/use", "POST", { accountUuid: "x" }], ["/api/desktop/gateway", "POST", { on: true }], ["/api/desktop/add", "POST", {}]] as const)
    expect((await call(path, method, body, "tailnet", remote)).status).toBe(403);
  const local = await call("/api/desktop");
  expect(local.status).toBe(200);
  expect(await local.json()).toHaveProperty("mode");
  expect((await call("/api/desktop/use", "POST", { accountUuid: "nobody" })).status).toBe(400);
});

test("signed-in Claude Code and Codex logins are detected by identity only, and pre-selected at sign-in", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const claude = await import("../src/llm/claude.ts"), codex = await import("../src/llm/codex.ts");
  const dir = mkdtempSync(join((await import("node:os")).tmpdir(), "agentgate-detect-"));
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@b.dk", organizationType: "claude_max" } }));
  const claims = Buffer.from(JSON.stringify({ email: "c@d.dk", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } })).toString("base64url");
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: `x.${claims}.y`, refresh_token: "secret" } }));
  expect(claude.detect(dir)).toEqual({ email: "a@b.dk", plan: "claude_max" });
  expect(codex.detect(dir)).toEqual({ email: "c@d.dk", plan: "pro" });
  expect(codex.detect(join(dir, "missing"))).toBeUndefined();
  for (const mod of [claude, codex]) {
    expect(new URL(mod.authorizeUrl("c", "s", "a@b.dk")).searchParams.get("login_hint")).toBe("a@b.dk");
    expect(new URL(mod.authorizeUrl("c", "s")).searchParams.has("login_hint")).toBe(false);
  }
});

test("checkout writes share the browser guard, JSON validation, and loopback restriction", async () => {
  const { call, ctx } = fixture();
  let registered = 0;
  ctx.skills.register = () => { registered++; return "/repo"; };
  const body = { path: "/repo", project: "owner/repo" };
  for (const headers of [{ origin: "https://example.com" }, { "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
    expect((await call("/api/checkout", "POST", body, "loopback", headers)).status).toBe(403);
  }
  expect((await call("/api/checkout", "POST", body, "loopback", { "content-type": "text/plain" })).status).toBe(415);
  expect((await call("/api/checkout", "POST", { ...body, project: "invalid" })).status).toBe(400);
  expect((await call("/api/checkout", "POST", body, "tailnet", { authorization: "Bearer admin-secret" })).status).toBe(404);
  expect(registered).toBe(0);
  expect((await call("/api/checkout", "POST", body)).status).toBe(200);
  expect(registered).toBe(1);
});

test("installation uses the reviewed artifact and expired previews never refetch implicitly", async () => {
  let now = 0, fetches = 0;
  const imports = new SkillImports(async () => {
    fetches++;
    return [{ id: "x", description: "x", files: [{ path: "SKILL.md", data: Buffer.from(`version-${fetches}`).toString("base64") }] }];
  }, () => now);
  const { call, s } = fixture({ imports });
  const preview = await (await call("/api/skills/fetch", "POST", { source: "owner/pack" })).json() as SkillPreviewResponse;
  expect(preview.skills[0]!.size).toBe(9);
  expect((await call("/api/skills", "POST", { token: preview.token, ids: ["x"], projects: ["owner/repo"] })).status).toBe(201);
  expect(fetches).toBe(1);
  expect(Buffer.from(s.get("skill", "x")!.files[0]!.data, "base64").toString()).toBe("version-1");
  now = 10 * 60_000;
  expect((await call("/api/skills", "POST", { token: preview.token, ids: ["x"] })).status).toBe(409);
  expect(fetches).toBe(1);
  expect((await call("/api/skills", "POST", { source: "owner/pack", ids: ["x"] })).status).toBe(400);
  const different = await (await call("/api/skills/fetch", "POST", { source: "different/pack" })).json() as SkillPreviewResponse;
  expect(different.skills[0]!.conflict).toContain("owner/pack");
  expect((await call("/api/skills", "POST", { token: different.token, ids: ["x"] })).status).toBe(409);
});

test("skill editor requires revision preconditions and preserves newer content", async () => {
  const { call, s } = fixture();
  expect((await call("/api/skills/x", "PUT", { skillMd: "first", revision: null })).status).toBe(200);
  const first = await (await call("/api/skills/x")).json() as { revision: string };
  expect(typeof first.revision).toBe("string");
  expect((await call("/api/skills/x", "PUT", { skillMd: "unguarded" })).status).toBe(400);
  expect((await call("/api/skills/x", "PUT", { skillMd: "duplicate creation", revision: null })).status).toBe(409);
  expect((await call("/api/skills/x", "PUT", { skillMd: "newer", revision: first.revision })).status).toBe(200);
  expect((await call("/api/skills/x", "PUT", { skillMd: "stale", revision: first.revision })).status).toBe(409);
  expect(Buffer.from(s.get("skill", "x")!.files[0]!.data, "base64").toString()).toBe("newer");
});

test("omitted project skills preserve explicit assignments and malformed status fails validation", async () => {
  const { call, s } = fixture();
  writeSkillMd(s, "x", "instructions");
  s.put("project", "Owner/Repo", { id: "Owner/Repo", skills: ["x"] });
  expect((await call("/api/projects", "PUT", { id: "owner/repo", mcp: {}, inheritDefaults: false })).status).toBe(200);
  expect(s.get("project", "Owner/Repo")!.skills).toEqual(["x"]);
  expect(s.get("project", "owner/repo")).toBeUndefined();
  const data = await (await call("/api/status")).json() as Status;
  expect(statusSchema.safeParse(data).success).toBe(true);
  expect(statusSchema.safeParse({ ...data, apiVersion: API_VERSION - 1 }).success).toBe(false);
  const { skills, ...missing } = data;
  expect(statusSchema.safeParse(missing).success).toBe(false);
});
