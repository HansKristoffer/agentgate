import { expect, test } from "bun:test";
import { scrubDevStore } from "../../../scripts/seed-dev-store.ts";
import { ensureFactoryTables, items } from "../src/factory/db.ts";
import { recordSessionUsage, sessionUsage } from "../src/llm/sessions.ts";
import { Store } from "../src/store.ts";

test("a seeded dev store keeps no factory pointer, factory items or session usage, so a dev daemon cannot act on the live factory", () => {
  const s = new Store(":memory:");
  s.setLocal("node", "srv");
  s.put("setting", "settings", { ...s.settings(), factory: { repo: "acme/factory", path: "", node: "srv" } });
  ensureFactoryTables(s);
  items.insert(s, {
    id: "it_1",
    source: "bugs",
    externalId: "acme/api#1",
    key: "api-1",
    repo: "acme/api",
    title: "Crash",
    snapshot: {},
    phase: "pr",
    prUrl: "https://github.com/acme/api/pull/7",
    configCommit: "a".repeat(40),
  });
  recordSessionUsage(s, {
    session: "sess-1",
    provider: "claude",
    model: "opus",
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    at: s.now(),
  });

  scrubDevStore(s);

  expect(s.settings().factory).toBeUndefined();
  expect(items.list(s)).toEqual([]);
  expect(sessionUsage(s, ["sess-1"])).toEqual([]);
  expect(s.nodeId).toBe("dev");
  s.close();
});
