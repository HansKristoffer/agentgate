import { afterAll, afterEach, expect, test } from "bun:test";
import { buildBoard } from "../src/factory/board.ts";
import { items, newId, runs, transcripts } from "../src/factory/db.ts";
import { removeTmp } from "./fixtures/git.ts";
import { factoryNode } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** The daemon serves every model request on the same event loop as the factory's loops and its board: a factory step
 * that holds it for long makes requests wait (docs/internals/factory.md). */
const BUDGET_MS = 25;

const timed = async (fn: () => unknown) => {
  const started = performance.now();
  await fn();
  return performance.now() - started;
};

test("with 500 reported runs and their 256 KiB transcripts, a dispatch pass and a board each take under 25 ms", async () => {
  const n = await factoryNode(cleanup, { config: { limits: { threads: 3 } } });
  const transcript = "x".repeat(256 * 1024);
  for (let i = 0; i < 125; i++) {
    const item = items.insert(n.s, {
      id: newId("it"),
      source: "manual",
      externalId: crypto.randomUUID(),
      key: `m-${i}`,
      repo: n.repo,
      title: `Item ${i}`,
      snapshot: { title: `Item ${i}` },
      phase: "shipped",
      configCommit: n.commit,
    });
    for (const kind of ["triage", "implement", "review", "judge"] as const) {
      const run = runs.insert(n.s, {
        id: newId("run"),
        ...(kind !== "judge" && { item: item.id }),
        kind,
        attempt: 1,
        state: "reported",
        nudges: 0,
        threadId: `thread-${i}-${kind}`,
        configCommit: n.commit,
        endedAt: n.s.now(),
      });
      transcripts.put(n.s, run.id, transcript);
    }
  }
  // An item held before its stage: dispatch looks at its queued run on every pass.
  expect((await n.command("add", n.repo, "Crash on save")).code).toBe(0);
  const [held] = items.list(n.s, { open: true });
  items.update(n.s, held!.id, { needsYou: { reason: "held" } });

  await n.dispatch();
  const dispatch = await timed(() => n.dispatch());
  const board = await timed(() => buildBoard(n.f, { includeWebhookUrls: false }));
  expect(dispatch).toBeLessThan(BUDGET_MS);
  expect(board).toBeLessThan(BUDGET_MS);
  const built = await buildBoard(n.f, { includeWebhookUrls: false });
  expect(built.capacity).toMatchObject({ working: 0, waitingForYou: 1 });
  expect(built.items.filter((i) => i.phase === "shipped")).toHaveLength(125);
});

test("the page's board is built at most every 5 seconds, and the page asks every 10", async () => {
  const n = await factoryNode(cleanup);
  n.s.put("node", "a", { ...n.s.get("node", "a")!, healthDashboard: true });
  const page = async () => (await n.f.page!(new Request("http://127.0.0.1/factory"), "loopback")).json();
  const first = await page();
  expect((await n.command("add", n.repo, "Crash on save")).code).toBe(0);
  expect(await page()).toEqual(first);
  n.advance(5000);
  expect(((await page()) as { items: unknown[] }).items).toHaveLength(1);
  const { FACTORY_PAGE } = await import("../src/factory/page.ts");
  expect(FACTORY_PAGE).toContain("setInterval(refresh, 10000)");
});
