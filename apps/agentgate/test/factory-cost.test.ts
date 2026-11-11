import { afterAll, afterEach, expect, test } from "bun:test";
import { buildBoard } from "../src/factory/board.ts";
import { items, newId, runs } from "../src/factory/db.ts";
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

test("with 500 reported runs, a dispatch pass and a board each take under 25 ms", async () => {
  const n = await factoryNode(cleanup, { config: { limits: { threads: 3 } } });
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
    for (const kind of ["triage", "implement", "review", "scout"] as const) {
      runs.insert(n.s, {
        id: newId("run"),
        ...(kind !== "scout" && { item: item.id }),
        kind,
        attempt: 1,
        state: "reported",
        nudges: 0,
        threadId: `thread-${i}-${kind}`,
        configCommit: n.commit,
        endedAt: n.s.now(),
      });
    }
  }
  // An item held before its stage: dispatch looks at its queued run on every pass.
  expect((await n.command("add", n.repo, "Crash on save")).code).toBe(0);
  const [held] = items.list(n.s, { open: true });
  items.update(n.s, held!.id, {
    needsYou: { kind: "start", cause: "held", title: "Waiting for approval", question: "Start triage?", since: 0 },
  });

  await n.dispatch();
  const dispatch = await timed(() => n.dispatch());
  const board = await timed(() => buildBoard(n.f, { includeWebhookUrls: false }));
  expect(dispatch).toBeLessThan(BUDGET_MS);
  expect(board).toBeLessThan(BUDGET_MS);
  const built = await buildBoard(n.f, { includeWebhookUrls: false });
  expect(built.capacity).toMatchObject({ working: 0, waitingForYou: 1 });
  expect(built.items.filter((i) => i.phase === "shipped")).toHaveLength(125);
});

test("the page's board is reused between reads, and shows a factory change at once", async () => {
  const n = await factoryNode(cleanup);
  n.s.put("node", "a", { ...n.s.get("node", "a")!, healthDashboard: true });
  let builds = 0;
  n.f.boardParts.push(async () => (builds++, {}));
  const page = async () =>
    (await (await n.f.page!(new Request("http://127.0.0.1/factory"), "loopback")).json()) as { items: unknown[] };
  await page();
  await page();
  expect(builds).toBe(1);
  expect((await n.command("add", n.repo, "Crash on save")).code).toBe(0);
  expect((await page()).items).toHaveLength(1);
});
