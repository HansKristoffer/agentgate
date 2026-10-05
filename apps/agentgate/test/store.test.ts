import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInstance, deleteInstance, labelInstance, parseCommand, renameInstance, setAccount } from "../src/operations.ts";
import { Store, exportBackup, importBackup } from "../src/store.ts";

test("public inventories omit OAuth, headers, environment, arguments, and URL credentials", () => {
  const s = new Store(":memory:");
  s.put("mcp", "http", { id: "http", template: "custom-http", transport: "http", url: "https://secret:password@x/mcp?key=url-secret", headers: { Authorization: "header-secret" }, oauth: { client: { client_id: "x", client_secret: "client-secret" }, tokens: { access_token: "access-secret", refresh_token: "refresh-secret", token_type: "Bearer" } } });
  s.put("mcp", "stdio", { id: "stdio", template: "custom-stdio", transport: "stdio", command: "secret-command", args: ["arg-secret"], env: { KEY: "env-secret" }, fields: { key: "field-secret" }, secrets: { key: "secret-secret" } });
  s.put("credential", "a", { accountId: "a", accessToken: "llm-secret", refreshToken: "llm-refresh", holder: "a", expiresAt: 1 });
  const text = JSON.stringify(exportBackup(s, false));
  for (const value of ["password", "url-secret", "header-secret", "client-secret", "access-secret", "refresh-secret", "secret-command", "arg-secret", "env-secret", "field-secret", "secret-secret", "llm-secret"]) expect(text).not.toContain(value);
  s.close();
});

test("restore validates every record before applying and preserves sequence on failure", () => {
  const s = new Store(":memory:"); const before = s.seq();
  expect(() => importBackup(s, { agentgate: 2, records: [{ kind: "account", id: "a", data: { id: "a", provider: "claude", label: "a" } }, { kind: "setting", id: "settings", data: { threshold: 500 } }] })).toThrow();
  expect(s.get("account", "a")).toBeUndefined(); expect(s.seq()).toBe(before);
  expect(() => s.merge({ kind: "account", id: "a", rev: 5, node: "x", updated_at: 1, deleted: 0, data: '{"id":"a","provider":"unknown"}' })).toThrow();
  expect(() => s.put("account", "a", { id: "b", provider: "claude", label: "a" })).toThrow(); s.close();
});

test("legacy MCP tokens migrate separately once and full backups round trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-migrate-")), path = join(dir, "db");
  let s = new Store(path); s.setLocal("node", "n");
  s.put("mcp", "m", { id: "m", template: "custom-http", transport: "http", url: "https://x/mcp", oauth: { tokens: { access_token: "access", refresh_token: "refresh", token_type: "Bearer" } } });
  s.db.run("pragma user_version = 0"); s.close(); s = new Store(path);
  expect(s.get("mcp", "m")?.oauth).toBeUndefined(); expect(s.get("mcpCredential", "m")?.holder).toBe("n");
  const seq = s.seq(); s.close(); s = new Store(path); expect(s.seq()).toBe(seq);
  const restored = new Store(":memory:"); importBackup(restored, exportBackup(s));
  expect(restored.get("mcpCredential", "m")?.tokens?.refresh_token).toBe("refresh");
  s.close(); restored.close(); rmSync(dir, { recursive: true, force: true });
});

test("change feed cursor and records use one SQLite snapshot despite another writer", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-snapshot-")), file = join(dir, "db");
  const s = new Store(file), other = new Store(file);
  s.put("account", "a", { id: "a", provider: "claude", label: "old" });
  const seq = s.seq.bind(s); let injected = false;
  s.seq = () => { const value = seq(); if (!injected) { injected = true; other.put("account", "a", { id: "a", provider: "claude", label: "new" }); } return value; };
  const snapshot = s.changes(0); expect(JSON.parse(snapshot.records[0]!.data).label).toBe("old");
  expect(snapshot.records[0]!.seq).toBeLessThanOrEqual(snapshot.seq);
  expect(JSON.parse(s.changes(snapshot.seq).records[0]!.data).label).toBe("new");
  s.close(); other.close(); rmSync(dir, { recursive: true, force: true });
});

test("shared operations preserve quoted args and preset headers, clean references and roll back conflicting renames", () => {
  const s = new Store(":memory:");
  expect(parseCommand('bun "file with spaces.ts" --key \'a b\' ""')).toEqual(["bun", "file with spaces.ts", "--key", "a b", ""]);
  expect(() => parseCommand('bun "unfinished')).toThrow();
  expect(createInstance(s, { name: "posthog", target: "posthog", headers: "x-posthog-project-id: 123" }).headers?.["x-posthog-project-id"]).toBe("123");
  s.put("project", "*", { id: "*", mcp: { posthog: "posthog", new: "posthog" } });
  expect(() => renameInstance(s, "posthog", "new")).toThrow(); expect(s.get("mcp", "posthog")).toBeDefined(); expect(s.get("mcp", "new")).toBeUndefined();
  s.put("mcpCredential", "posthog", { instanceId: "posthog", holder: "n" }); deleteInstance(s, "posthog");
  expect(s.get("mcpCredential", "posthog")).toBeUndefined(); expect(s.get("project", "*")?.mcp).toEqual({});
  // Any typed name works: its slug is the id and tool prefix, the name is kept for display, and relabelling leaves the id alone.
  const named = createInstance(s, { name: "PostHog Café Work", target: "posthog" });
  expect([named.id, named.label]).toEqual(["posthog-cafe-work", "PostHog Café Work"]);
  expect(() => createInstance(s, { name: "posthog cafe work", target: "posthog" })).toThrow("already exists");
  expect(() => createInstance(s, { name: "!!!", target: "posthog" })).toThrow();
  labelInstance(s, "posthog-cafe-work", "Work PostHog");
  expect(s.get("mcp", "posthog-cafe-work")?.label).toBe("Work PostHog");
  for (const id of ["a", "b"]) s.put("account", id, { id, provider: "codex", label: id, pinned: true });
  setAccount(s, "b", { pinned: true }); expect(s.get("account", "a")?.pinned).toBe(false); s.close();
});
