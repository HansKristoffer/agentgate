import { changesSchema } from "@agentgate/protocol";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveProject, setAccount } from "../src/operations.ts";
import {
  changeServerProjects,
  createInstance,
  deleteInstance,
  labelInstance,
  renameInstance,
} from "../src/ops/servers.ts";
import { Store, exportBackup, importBackup, schemas } from "../src/store.ts";

test("choosing a server's projects keeps existing tool prefixes and refuses a prefix another server has", () => {
  const s = new Store(":memory:");
  for (const id of ["posthog", "other"]) createInstance(s, { name: id, target: "https://example.com/mcp" });
  s.put("project", "acme/web", { id: "acme/web", mcp: { ph: "posthog" } });
  s.put("project", "acme/api", { id: "acme/api", mcp: { posthog: "other" } });
  s.put("project", "acme/docs", { id: "acme/docs" });
  changeServerProjects(s, "posthog", { projects: ["*", "acme/web"] });
  expect(s.get("project", "*")?.mcp).toEqual({ posthog: "posthog" });
  expect(s.get("project", "acme/web")?.mcp).toEqual({ ph: "posthog" });
  changeServerProjects(s, "posthog", { projects: ["acme/docs"] });
  expect([s.get("project", "*")?.mcp, s.get("project", "acme/web")?.mcp]).toEqual([{}, {}]);
  expect(s.get("project", "acme/docs")?.mcp).toEqual({ posthog: "posthog" });
  expect(() => changeServerProjects(s, "posthog", { projects: ["acme/api"] })).toThrow(
    "already uses the tool prefix posthog for other",
  );
  expect(s.get("project", "acme/docs")?.mcp).toEqual({ posthog: "posthog" });
  s.close();
});

test("public inventories omit OAuth, headers, environment, arguments, and URL credentials", () => {
  const s = new Store(":memory:");
  s.put("mcp", "http", {
    id: "http",
    template: "custom-http",
    transport: "http",
    url: "https://secret:password@x/mcp?key=url-secret",
    headers: { Authorization: "header-secret" },
    oauth: {
      client: { client_id: "x", client_secret: "client-secret" },
      tokens: { access_token: "access-secret", refresh_token: "refresh-secret", token_type: "Bearer" },
    },
  });
  s.put("mcp", "stdio", {
    id: "stdio",
    template: "custom-stdio",
    transport: "stdio",
    command: "secret-command",
    args: ["arg-secret"],
    env: { KEY: "env-secret" },
    fields: { key: "field-secret" },
    secrets: { key: "secret-secret" },
  });
  s.put("credential", "a", {
    accountId: "a",
    accessToken: "llm-secret",
    refreshToken: "llm-refresh",
    holder: "a",
    expiresAt: 1,
  });
  const text = JSON.stringify(exportBackup(s, false));
  for (const value of [
    "password",
    "url-secret",
    "header-secret",
    "client-secret",
    "access-secret",
    "refresh-secret",
    "secret-command",
    "arg-secret",
    "env-secret",
    "field-secret",
    "secret-secret",
    "llm-secret",
  ])
    expect(text).not.toContain(value);
  s.close();
});

test("restore validates every record before applying and preserves sequence on failure", () => {
  const s = new Store(":memory:");
  const before = s.seq();
  expect(() =>
    importBackup(s, {
      agentgate: 2,
      records: [
        { kind: "account", id: "a", data: { id: "a", provider: "claude", label: "a" } },
        { kind: "setting", id: "settings", data: { threshold: 500 } },
      ],
    }),
  ).toThrow();
  expect(s.get("account", "a")).toBeUndefined();
  expect(s.seq()).toBe(before);
  expect(() =>
    s.merge({
      kind: "account",
      id: "a",
      rev: 5,
      node: "x",
      updated_at: 1,
      deleted: 0,
      data: '{"id":"a","provider":"unknown"}',
    }),
  ).toThrow();
  expect(() => s.put("account", "a", { id: "b", provider: "claude", label: "a" })).toThrow();
  s.close();
});

test("legacy MCP tokens migrate separately once and full backups round trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-migrate-")),
    path = join(dir, "db");
  let s = new Store(path);
  s.setLocal("node", "n");
  s.put("mcp", "m", {
    id: "m",
    template: "custom-http",
    transport: "http",
    url: "https://x/mcp",
    oauth: { tokens: { access_token: "access", refresh_token: "refresh", token_type: "Bearer" } },
  });
  s.db.run("pragma user_version = 0");
  s.close();
  s = new Store(path);
  expect(s.get("mcp", "m")?.oauth).toBeUndefined();
  expect(s.get("mcpCredential", "m")?.holder).toBe("n");
  const seq = s.seq();
  s.close();
  s = new Store(path);
  expect(s.seq()).toBe(seq);
  const restored = new Store(":memory:");
  importBackup(restored, exportBackup(s));
  expect(restored.get("mcpCredential", "m")?.tokens?.refresh_token).toBe("refresh");
  s.close();
  restored.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a deleted skill no longer exists, so a project can't be saved naming it", () => {
  const s = new Store(":memory:");
  for (const id of ["kept", "gone"])
    s.put("skill", id, { id, updatedAt: 0, files: [{ path: "SKILL.md", data: btoa("# skill") }] });
  s.del("skill", "gone");
  expect([s.has("skill", "kept"), s.has("skill", "gone"), s.has("skill", "missing"), s.has("mcp", "kept")]).toEqual([
    true,
    false,
    false,
    false,
  ]);
  expect(() => saveProject(s, "acme/web", { skills: ["kept", "gone"] })).toThrow("no skill gone");
  expect(saveProject(s, "acme/web", { skills: ["kept"] }).skills).toEqual(["kept"]);
  s.close();
});

test("change feed cursor and records use one SQLite snapshot despite another writer", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-snapshot-")),
    file = join(dir, "db");
  const s = new Store(file),
    other = new Store(file);
  s.put("account", "a", { id: "a", provider: "claude", label: "old" });
  const seq = s.seq.bind(s);
  let injected = false;
  s.seq = () => {
    const value = seq();
    if (!injected) {
      injected = true;
      other.put("account", "a", { id: "a", provider: "claude", label: "new" });
    }
    return value;
  };
  const snapshot = s.changes(0);
  expect(JSON.parse(snapshot.records[0]!.data).label).toBe("old");
  expect(snapshot.records[0]!.seq).toBeLessThanOrEqual(snapshot.seq);
  expect(JSON.parse(s.changes(snapshot.seq).records[0]!.data).label).toBe("new");
  s.close();
  other.close();
  rmSync(dir, { recursive: true, force: true });
});

test("shared operations preserve quoted args and preset headers, clean references and roll back conflicting renames", () => {
  const s = new Store(":memory:");
  const local = createInstance(s, { name: "local", command: 'bun "file with spaces.ts" --key \'a b\' ""' });
  expect([local.command, local.args]).toEqual(["bun", ["file with spaces.ts", "--key", "a b", ""]]);
  expect(() => createInstance(s, { name: "broken", command: 'bun "unfinished' })).toThrow("unfinished quote");
  expect(
    createInstance(s, { name: "posthog", target: "posthog", headers: "x-posthog-project-id: 123" }).headers?.[
      "x-posthog-project-id"
    ],
  ).toBe("123");
  s.put("project", "*", { id: "*", mcp: { posthog: "posthog", new: "posthog" } });
  expect(() => renameInstance(s, "posthog", "new")).toThrow();
  expect(s.get("mcp", "posthog")).toBeDefined();
  expect(s.get("mcp", "new")).toBeUndefined();
  s.put("mcpCredential", "posthog", { instanceId: "posthog", holder: "n" });
  deleteInstance(s, "posthog");
  expect(s.get("mcpCredential", "posthog")).toBeUndefined();
  expect(s.get("project", "*")?.mcp).toEqual({});
  // Any typed name works: its slug is the id and tool prefix, the name is kept for display, and relabelling leaves the id alone.
  const named = createInstance(s, { name: "PostHog Café Work", target: "posthog" });
  expect([named.id, named.label]).toEqual(["posthog-cafe-work", "PostHog Café Work"]);
  expect(() => createInstance(s, { name: "posthog cafe work", target: "posthog" })).toThrow("already exists");
  expect(() => createInstance(s, { name: "!!!", target: "posthog" })).toThrow();
  labelInstance(s, "posthog-cafe-work", "Work PostHog");
  expect(s.get("mcp", "posthog-cafe-work")?.label).toBe("Work PostHog");
  for (const id of ["a", "b"]) s.put("account", id, { id, provider: "codex", label: id, pinned: true });
  setAccount(s, "b", { pinned: true });
  expect(s.get("account", "a")?.pinned).toBe(false);
  s.close();
});

test("record writes announce the topics that show them, and a merge that loses announces nothing", () => {
  const s = new Store(":memory:");
  const bumps: string[] = [];
  s.onChange = (topic) => bumps.push(topic);
  s.put("mcp", "m", { id: "m", template: "custom-http", transport: "http", url: "https://x/mcp" });
  expect(bumps).toEqual(["status"]);
  bumps.length = 0;
  s.put("tokens", "n:2026-11-11", { id: "n:2026-11-11", node: "n", rows: [] });
  expect(bumps).toEqual(["activity"]);
  bumps.length = 0;
  const loser = { ...s.record("mcp", "m")!, rev: 0, node: "other" };
  expect(s.merge(loser)).toBe(false);
  expect(bumps).toEqual([]);
  s.close();
});

test("a merge parses a large record's data only when the record wins", () => {
  const s = new Store(":memory:");
  s.setLocal("node", "n");
  const day = { id: "n:2026-11-11", node: "n" };
  const rows = Array.from({ length: 10_000 }, (_, hour) => ({
    hour,
    provider: "claude" as const,
    model: "opus",
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
  }));
  s.put("tokens", day.id, { ...day, rows });
  s.put("tokens", day.id, { ...day, rows });
  const older = { ...s.record("tokens", day.id)!, rev: 1 };
  const parse = spyOn(schemas.tokens, "parse");
  try {
    expect(s.merge(older)).toBe(false);
    expect(parse).not.toHaveBeenCalled();
    expect(s.merge({ ...older, rev: 3 })).toBe(true);
    expect(parse).toHaveBeenCalledTimes(1);
  } finally {
    parse.mockRestore();
    s.close();
  }
});

test("a corrupt rotated-token row does not fail the merge of a credential", () => {
  const s = new Store(":memory:");
  const login = { accountId: "a", accessToken: "at-0", refreshToken: "rt-0", expiresAt: 1, holder: "n" };
  s.put("credential", "a", login);
  s.setLocal("rotated:credential:a", "{not json");
  const theirs = { ...login, accessToken: "at-1", refreshToken: "rt-1", holder: "other" };
  const incoming = { ...s.record("credential", "a")!, rev: 9, node: "other", data: JSON.stringify(theirs) };
  expect(s.merge(incoming)).toBe(true);
  expect(s.get("credential", "a")?.refreshToken).toBe("rt-1");
  s.close();
});

test("a change answer from an older or newer daemon parses", () => {
  expect(changesSchema.parse({ token: "1.0" })).toEqual({ token: "1.0" });
  const newer = { token: "2.0", versions: { status: 1, someday: 3 } };
  expect(changesSchema.parse(newer)).toEqual(newer);
});

test("a write from another process on the same file, as the CLI makes, is seen by the next read", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-cache-")),
    file = join(dir, "db");
  const daemon = new Store(file),
    cli = new Store(file);
  daemon.put("account", "a", { id: "a", provider: "claude", label: "old" });
  daemon.put("account", "b", { id: "b", provider: "claude", label: "kept" });
  expect(daemon.list("account").map((a) => a.label)).toEqual(["old", "kept"]);
  cli.put("account", "a", { id: "a", provider: "claude", label: "new" });
  expect(daemon.get("account", "a")?.label).toBe("new");
  cli.del("account", "b");
  expect(daemon.list("account").map((a) => a.label)).toEqual(["new"]);
  expect(daemon.get("account", "b")).toBeUndefined();
  cli.close();
  daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a record read from the store cannot be changed, since later reads share it", () => {
  const s = new Store(":memory:");
  s.put("project", "acme/web", { id: "acme/web", skills: ["a"] });
  const project = s.get("project", "acme/web")!;
  // @ts-expect-error read-only: copy before changing
  expect(() => project.skills.push("b")).toThrow(TypeError);
  // @ts-expect-error read-only: copy before changing
  expect(() => (s.list("project")[0]!.inheritDefaults = false)).toThrow(TypeError);
  expect(s.get("project", "acme/web")).toMatchObject({ skills: ["a"], inheritDefaults: true });
  s.close();
});
