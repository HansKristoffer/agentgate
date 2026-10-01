import { afterEach, expect, test } from "bun:test";
import type { Status } from "@agentgate/protocol";
import { app, makeCtx, type Listener } from "../src/daemon.ts";
import { newInstance } from "../src/mcp/templates.ts";
import { exportBackup, Store } from "../src/store.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
function fixture() {
  const s = new Store(":memory:");
  s.setLocal("node", "test");
  s.setLocal("adminToken", "admin-secret");
  const ctx = makeCtx(s),
    handler = app(ctx);
  cleanup.push(async () => {
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
  return { s, call, handler };
}

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
  expect(status.apiVersion).toBe(1);
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
    (await call("/api/accounts/b", "PATCH", { pinned: true, priority: 10 }))
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
