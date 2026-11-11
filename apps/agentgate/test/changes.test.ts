import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Changes } from "../src/changes.ts";
import { Store } from "../src/store.ts";
import { removeTmp, tmp } from "./fixtures/git.ts";

afterAll(removeTmp);

const project = { id: "acme/web" };

test("a daemon write wakes a waiter within a microtask and moves the status topic", async () => {
  const s = new Store(":memory:");
  s.setLocal("node", "n");
  const changes = new Changes(s);
  const before = changes.snapshot();
  const waiting = changes.wait(before.token, 60_000, new AbortController().signal).then(() => "woke");
  s.put("project", project.id, project);
  // Every microtask runs before a zero-delay timer: only a wake without timers wins this race.
  const timer = new Promise((resolve) => setTimeout(() => resolve("timer"), 0));
  expect(await Promise.race([waiting, timer])).toBe("woke");
  expect(changes.snapshot().versions.status).toBeGreaterThan(before.versions.status);
  changes.close();
  s.close();
});

test("a write from another connection to the same file, as the CLI makes, wakes a waiter and reports its kind", async () => {
  const file = join(tmp(), "agentgate.db");
  const daemon = new Store(file);
  daemon.setLocal("node", "daemon");
  const changes = new Changes(daemon, { externalMs: 5 });
  const kinds = new Promise<Set<string>>((resolve) => changes.onRecords(resolve));
  const waiting = changes.wait(changes.snapshot().token, 60_000, new AbortController().signal);
  const cli = new Store(file);
  cli.setLocal("node", "cli");
  cli.put("project", project.id, project);
  await waiting;
  expect(await kinds).toEqual(new Set(["project"]));
  cli.close();
  changes.close();
  daemon.close();
});

test("a node renamed from the CLI while the daemon runs writes under the new name", async () => {
  const file = join(tmp(), "agentgate.db");
  const daemon = new Store(file);
  daemon.setLocal("node", "old");
  expect(daemon.nodeId).toBe("old");
  const changes = new Changes(daemon, { externalMs: 5 });
  const waiting = changes.wait(changes.snapshot().token, 60_000, new AbortController().signal);
  const cli = new Store(file);
  cli.setLocal("node", "new");
  await waiting;
  daemon.put("project", project.id, project);
  expect(daemon.record("project", project.id)?.node).toBe("new");
  cli.close();
  changes.close();
  daemon.close();
});
