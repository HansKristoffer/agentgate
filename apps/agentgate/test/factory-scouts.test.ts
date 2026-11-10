import { afterAll, afterEach, expect, test } from "bun:test";
import type { FactoryBoard } from "@agentgate/protocol";
import { boardText } from "../src/factory/board.ts";
import { threadScope, workingCount } from "../src/factory/controller.ts";
import { items, newId, runs, type FactoryRun } from "../src/factory/db.ts";
import { loopTask } from "../src/factory/runtime.ts";
import { SLOT_GRACE_MS, scheduleText, scoutDue } from "../src/factory/scouts.ts";
import { removeTmp } from "./fixtures/git.ts";
import { factoryNode } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const MINUTE = 60_000;
const HOUR = 3600_000;
const DAY = 86_400_000;
const utc = (iso: string) => Date.parse(iso);

test("scoutDue: an every scout runs at once, then each interval after the last run", () => {
  const schedule = { every: "6h" };
  const now = utc("2026-11-02T10:00:00Z");
  expect(scoutDue(schedule, undefined, now)).toEqual({ due: true, nextAt: now });
  expect(scoutDue(schedule, now - 5 * HOUR, now)).toEqual({ due: false, nextAt: now + HOUR });
  expect(scoutDue(schedule, now - 6 * HOUR, now).due).toBe(true);
});

test("scoutDue: an at slot runs within the hour after it, once, on its weekdays and in its timezone", () => {
  const weekdays9 = { at: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] as const, timezone: "UTC" };
  const days = [...weekdays9.days];
  const monday9 = utc("2026-11-02T09:00:00Z");
  expect(scoutDue({ ...weekdays9, days }, undefined, monday9 + 10 * MINUTE)).toEqual({
    due: true,
    nextAt: monday9,
    slot: monday9,
  });
  // Run once for that slot: a run queued after it waits for Tuesday's.
  expect(scoutDue({ ...weekdays9, days }, monday9 + MINUTE, monday9 + 20 * MINUTE)).toEqual({
    due: false,
    nextAt: monday9 + DAY,
  });
  // A slot more than the grace ago is skipped, and Friday's next slot is Monday's.
  const friday9 = utc("2026-11-06T09:00:00Z");
  expect(scoutDue({ ...weekdays9, days }, undefined, friday9 + SLOT_GRACE_MS + MINUTE)).toEqual({
    due: false,
    nextAt: utc("2026-11-09T09:00:00Z"),
  });

  // Copenhagen is UTC+1 in winter and UTC+2 in summer.
  const copenhagen = {
    at: "09:00",
    days: [...weekdays9.days, "sat" as const, "sun" as const],
    timezone: "Europe/Copenhagen",
  };
  expect(scoutDue(copenhagen, undefined, utc("2026-01-15T08:05:00Z")).nextAt).toBe(utc("2026-01-15T08:00:00Z"));
  expect(scoutDue(copenhagen, undefined, utc("2026-07-15T07:05:00Z")).nextAt).toBe(utc("2026-07-15T07:00:00Z"));

  // Monday 09:00 in Auckland (UTC+13 in January) is Sunday 20:00 in UTC.
  const auckland = { at: "09:00", days: ["mon" as const], timezone: "Pacific/Auckland" };
  expect(scoutDue(auckland, undefined, utc("2026-01-04T20:30:00Z"))).toMatchObject({
    due: true,
    slot: utc("2026-01-04T20:00:00Z"),
  });

  // A late slot is still due just after midnight.
  const late = { at: "23:30", days: [...copenhagen.days], timezone: "UTC" };
  expect(scoutDue(late, undefined, utc("2026-11-03T00:10:00Z"))).toMatchObject({
    due: true,
    slot: utc("2026-11-02T23:30:00Z"),
  });

  expect(scheduleText({ every: "6h" })).toBe("every 6h");
  expect(scheduleText(late)).toBe("23:30 every day (UTC)");
  expect(scheduleText({ ...weekdays9, days: ["fri", "mon"] })).toBe("09:00 Mon, Fri (UTC)");
});

/** The factory machine with one scout, `perf`, on the repository. */
async function scoutFactory(scout: Record<string, unknown> = {}) {
  const n = await factoryNode(cleanup, {
    // Room for a scout run next to the triage runs its findings start.
    config: { limits: { threads: 5 } },
    files: (repo) => ({
      "scouts/perf.md": `---\n${JSON.stringify({ repo, schedule: { every: "6h" }, mcp: ["railway"], ...scout })}\n---\n\nLook at the p95 latency of every endpoint over the last day.`,
    }),
  });
  const builtin = (await n.ctx.gateway.builtin!()).client;
  const tool = async (name: string, args: Record<string, unknown>, thread?: string) => {
    const result = await builtin.callTool({
      name,
      arguments: args,
      ...(thread && { _meta: { "dev.agentgate/t3Thread": thread } }),
    });
    const text = (result.content as { text: string }[])[0]!.text;
    return result.isError ? { error: text } : JSON.parse(text);
  };
  return {
    ...n,
    tool,
    board: async () => (await (await n.api("/api/factory")).json()) as FactoryBoard,
    scoutLoop: loopTask(
      n.f,
      n.f.loops.find((l) => l.name === "factory-scouts")!,
    ),
    scoutRuns: () => runs.list(n.s, { kinds: ["scout"] }),
    async started() {
      await n.dispatch();
      return runs.get(n.s, this.scoutRuns().at(-1)!.id)!;
    },
    report: (run: FactoryRun, body: Record<string, unknown>) =>
      tool("factory_report", { run: run.id, ...body }, runs.get(n.s, run.id)!.threadId),
    /** perf's item for a finding, finished `ago` ms before now. */
    finished(key: string, ago: number) {
      const now = n.s.now;
      n.s.now = () => now() - ago;
      items.insert(n.s, {
        id: newId("it"),
        source: "perf",
        externalId: crypto.randomUUID(),
        key: `perf-${key}`,
        repo: n.repo,
        title: key,
        snapshot: { title: key, body: "" },
        dedupe: key,
        phase: "closed",
        configCommit: n.commit,
      });
      n.s.now = now;
    },
  };
}

const found = (...keys: string[]) => ({
  outcome: "done",
  summary: `Found ${keys.length}.`,
  result: {
    kind: "scout",
    findings: keys.map((key) => ({ key, title: `Slow ${key}`, body: `p95 of ${key} is 2 s.` })),
  },
});

test("a scout runs on its schedule, not while intake is off or its run is going, and on scout, factory_scout and POST /scouts/:id/run", async () => {
  const n = await scoutFactory();
  await n.scoutLoop();
  const first = await n.started();
  expect(first).toMatchObject({ state: "running", checked: { kind: "scout", source: "perf" } });

  const launch = n.mcp.calls.find((c) => c.tool === "t3_thread_launch" && c.args.clientRequestId === first.id)!;
  expect(launch.args.workspaceStrategy).toMatchObject({ baseRef: "main", branch: `factory/scout-${first.id}` });
  const brief = String(launch.args.message);
  expect(brief).toContain("Look at the p95 latency of every endpoint over the last day.");
  expect(brief).toContain("you may use the MCP servers `railway`");
  expect(brief).toContain("This scout has no open tickets");
  // The thread sees its source's servers, as a stage thread sees its stage file's.
  expect(threadScope(n.f, first.threadId)).toEqual({ servers: ["railway"] });

  n.advance(7 * HOUR);
  await n.scoutLoop();
  expect(n.scoutRuns()).toHaveLength(1); // its run is still going
  expect(await n.command("scout", "perf")).toEqual({
    code: 0,
    output: [`Skipped: The perf scout's run ${first.id} has not finished yet`],
  });
  expect(await n.report(first, { outcome: "nothing-to-do", summary: "All fast." })).toEqual({ accepted: true });

  await n.command("pause");
  n.advance(7 * HOUR);
  await n.scoutLoop();
  expect(n.scoutRuns()).toHaveLength(1);
  await n.command("resume");
  await n.scoutLoop();
  expect(n.scoutRuns()).toHaveLength(2);
  expect(n.scoutRuns()[1]!.queuedAt).toBe(n.s.now());

  // Run now, from the terminal and from the app, whatever the schedule says.
  runs.update(n.s, n.scoutRuns()[1]!.id, { state: "cancelled" });
  expect((await n.command("scout", "perf")).output).toEqual([expect.stringMatching(/^Queued the scout run run_/)]);
  runs.update(n.s, n.scoutRuns()[2]!.id, { state: "cancelled" });
  expect(await (await n.op("scout", { id: "perf" })).json()).toEqual({ run: expect.stringMatching(/^run_/) });
  // While that run goes, another is skipped, and says why.
  expect(await (await n.op("scout", { id: "perf" })).json()).toEqual({
    skipped: expect.stringMatching(/^The perf scout's run run_\w+ has not finished yet$/),
  });
  const unknown = await n.op("scout", { id: "nope" });
  expect([unknown.status, await unknown.json()]).toEqual([400, { error: "The factory has no source nope" }]);
});

test("a disabled scout never runs on its schedule, but runs on request", async () => {
  const n = await scoutFactory({ enabled: false });
  await n.scoutLoop();
  expect(n.scoutRuns()).toEqual([]);
  expect((await n.command("scout", "perf")).output).toEqual([expect.stringMatching(/^Queued the scout run /)]);
  const board = await n.board();
  expect(board.sources.find((s) => s.id === "perf")?.scout).toEqual({
    schedule: "every 6h",
    enabled: false,
    lastRun: expect.objectContaining({ state: "queued", filed: 0 }),
  });
});

test("an at slot that waits on paused intake is noted once", async () => {
  const n = await scoutFactory({ schedule: { at: "09:00" } });
  const today9 = Math.floor(n.s.now() / DAY) * DAY + 9 * HOUR;
  n.advance(today9 + 5 * MINUTE + (n.s.now() > today9 ? DAY : 0) - n.s.now());
  await n.command("pause");
  await n.scoutLoop();
  await n.scoutLoop();
  expect(n.scoutRuns()).toEqual([]);
  const notes = (await n.board()).events.filter((e) => e.text.startsWith("The perf scout's run"));
  expect(notes.map((e) => e.text)).toEqual([
    "The perf scout's run (09:00 every day (UTC)) waits while intake is off; it is skipped if that lasts an hour",
  ]);
});

test("a scout reports done with findings or nothing-to-do, never a question", async () => {
  const n = await scoutFactory();
  await n.scoutLoop();
  const run = await n.started();
  expect(await n.report(run, { outcome: "done", summary: "Found some." })).toEqual({
    error:
      'The outcome done needs result: { kind: "scout", findings: [{ key, title, body }] } with at least one finding; report nothing-to-do when nothing needs a ticket',
  });
  expect(await n.report(run, found("orders", "orders"))).toEqual({
    error: "Each finding needs its own key; orders repeats",
  });
  expect(
    await n.report(run, { outcome: "blocked", summary: "No access.", blocked: { missing: "Railway access" } }),
  ).toEqual({
    error:
      "A scout run reports done with findings, or nothing-to-do; not blocked. There is no ticket to ask on: put a question for the maintainer in a finding's body",
  });
  expect(await n.report(run, { ...found("orders"), outcome: "nothing-to-do" })).toEqual({
    error: "Report the findings with the outcome done, or report nothing-to-do without them",
  });
});

test("each finding becomes an item in triage, except one whose key the scout has open or finished within its window", async () => {
  const n = await scoutFactory();
  n.finished("search", 2 * DAY); // within 14d: skipped
  n.finished("login", 15 * DAY); // before the window: filed again
  await n.scoutLoop();
  const run = await n.started();
  expect(String(n.t3.threads.get(run.threadId!)!.messages[0])).toContain("- `search`: search (perf-search, closed)");
  expect(await n.report(run, found("orders", "search", "login"))).toEqual({ accepted: true });

  const filed = items.list(n.s, { open: true }).filter((i) => i.source === "perf");
  expect(filed.map((i) => [i.title, i.phase, i.dedupe])).toEqual([
    ["Slow orders", "triage", "orders"],
    ["Slow login", "triage", "login"],
  ]);
  expect(runs.list(n.s, { kinds: ["triage"] }).map((r) => r.item)).toEqual(filed.map((i) => i.id));
  expect(runs.get(n.s, run.id)!.checked).toEqual({
    kind: "scout",
    source: "perf",
    filed: filed.map((i) => i.key),
    skipped: ["search"],
  });

  // The next run sees them, and a repeat of an open one is skipped.
  n.advance(6 * HOUR);
  await n.scoutLoop();
  const next = await n.started();
  expect(String(n.t3.threads.get(next.threadId!)!.messages[0])).toContain("- `orders`: Slow orders");
  expect(await n.report(next, found("orders"))).toEqual({ accepted: true });
  expect(items.list(n.s, { open: true }).filter((i) => i.source === "perf")).toHaveLength(2);

  const board = await n.board();
  expect(board.sources.find((s) => s.id === "perf")).toMatchObject({
    type: "scout",
    scout: {
      schedule: "every 6h",
      enabled: true,
      nextAt: n.s.now() + 6 * HOUR,
      lastRun: { id: next.id, state: "reported", filed: 0, skipped: 1 },
    },
  });
  expect(boardText(board, { now: n.s.now() })).toContain(
    `  perf (scout, ${n.repo}), every 6h, next in 6h, last run just now filed 0 (skipped 1)`,
  );
});

test("a holding scout's findings wait for approval, and stop at 20 waiting", async () => {
  const n = await scoutFactory({ intake: "hold" });
  await n.scoutLoop();
  const run = await n.started();
  const keys = Array.from({ length: 21 }, (_, i) => `slow-${i}`);
  expect(await n.report(run, found(...keys))).toEqual({ accepted: true });
  const held = items.list(n.s, { open: true }).filter((i) => i.source === "perf");
  expect(held).toHaveLength(20);
  expect(held.every((i) => i.phase === "held" && i.needsYou?.cause === "held")).toBe(true);
  expect(runs.get(n.s, run.id)!.checked).toMatchObject({ skipped: ["slow-20"] });
});

/** The factory machine with `threads` threads and a scout for each id, none of which is due by itself. */
async function scoutsOnThreads(threads: number, ...ids: string[]) {
  const n = await factoryNode(cleanup, {
    config: { limits: { threads } },
    files: (repo) =>
      Object.fromEntries(
        ids.map((id) => [
          `scouts/${id}.md`,
          `---\n${JSON.stringify({ repo, schedule: { every: "6h" }, enabled: false })}\n---\n\nLook for what is slow.`,
        ]),
      ),
  });
  const scoutRun = (id: string) => runs.list(n.s, { kinds: ["scout"], source: id }).at(-1)!;
  const triageRun = () => runs.list(n.s, { kinds: ["triage"] }).at(-1)!;
  /** Queues the scout's run a moment after whatever was queued before it. */
  const queue = async (id: string) => {
    expect((await n.command("scout", id)).code).toBe(0);
    n.advance(1000);
  };
  return { ...n, scoutRun, triageRun, queue };
}

test("a scout run takes a thread like a stage run, and a stage run queued after it starts first", async () => {
  const n = await scoutsOnThreads(1, "perf");
  await n.queue("perf");
  await n.command("add", n.repo, "Crash on save");
  await n.dispatch();
  // The scout was queued first, but an item's work goes first and takes the only thread.
  expect(n.triageRun().state).toBe("running");
  expect(n.scoutRun("perf").state).toBe("queued");
  expect(workingCount(n.f)).toBe(1);

  // Once the item waits for its maintainer, its thread no longer counts, and the scout takes it.
  n.mcp.setThread(n.triageRun().threadId!, { needsYou: true });
  await n.until(() => n.triageRun().state === "waiting", "the triage run to wait");
  await n.dispatch();
  expect(n.scoutRun("perf").state).toBe("running");
  expect(workingCount(n.f)).toBe(1);
});

test("with two threads and a scout at work, a second scout leaves the free thread to an item's triage", async () => {
  const n = await scoutsOnThreads(2, "perf", "deps");
  await n.queue("perf");
  await n.queue("deps");
  await n.dispatch();
  expect([n.scoutRun("perf").state, n.scoutRun("deps").state]).toEqual(["running", "queued"]);

  await n.command("add", n.repo, "Crash on save");
  await n.dispatch();
  expect(n.triageRun().state).toBe("running");
  expect(n.scoutRun("deps").state).toBe("queued");
  expect(workingCount(n.f)).toBe(2);
});
