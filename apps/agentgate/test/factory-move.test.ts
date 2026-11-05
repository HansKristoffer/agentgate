import { afterAll, afterEach, expect, test } from "bun:test";
import type { MarkerPayload } from "@agentgate/protocol";
import { app } from "../src/daemon.ts";
import { boardView, buildBoard } from "../src/factory/board.ts";
import { items, runs } from "../src/factory/db.ts";
import { MARKER_PREFIX } from "../src/factory/markers.ts";
import { loopTask, runCommand, type FactoryRuntime } from "../src/factory/runtime.ts";
import { host } from "../src/logins.ts";
import { NODE_PROTOCOL } from "../src/remote.ts";
import { removeTmp } from "./fixtures/git.ts";
import { startNodes } from "./fixtures/nodes.ts";
import { factoryNode } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

interface Issue {
  number: number;
  title: string;
  comments: { body: string; authorAssociation: string; createdAt: string }[];
}

/** One repository's open issues labelled `factory`, answering the gh commands gh.ts sends. */
function fakeGitHub(repo: string) {
  const issues = new Map<number, Issue>();
  const realGh = host.gh;
  cleanup.push(() => (host.gh = realGh));
  const ok = (value: unknown) => ({ ok: true, out: JSON.stringify(value) });
  host.gh = async (args, stdin) => {
    const url = (n: number) => `https://github.com/${repo}/issues/${n}`;
    if (args[0] === "issue" && args[1] === "list")
      return ok([...issues.values()].map((i) => ({ number: i.number, title: i.title, body: "", url: url(i.number) })));
    if (args[0] === "issue" && args[1] === "view") {
      const issue = issues.get(Number(args[2]))!;
      return ok(args.at(-1) === "state" ? { state: "OPEN" } : { comments: issue.comments });
    }
    const comment = args[1]?.match(/\/issues\/(\d+)\/comments$/);
    if (args[0] === "api" && comment) {
      const { body } = JSON.parse(stdin!);
      issues.get(Number(comment[1]))!.comments.push({ body, authorAssociation: "OWNER", createdAt: "2026-11-05" });
      return ok({ id: 1 });
    }
    throw new Error(`the fake GitHub has no answer for gh ${args.join(" ")}`);
  };
  return {
    open(number: number, marker?: Partial<MarkerPayload>) {
      const comments = marker
        ? [
            {
              body: `Taken.\n\n${MARKER_PREFIX}${JSON.stringify({
                item: `it_${number}`,
                key: `gh-${number}`,
                stage: "implement",
                outcome: null,
                route: null,
                commit: null,
                factory: "3f2c1a9",
                node: "a",
                state: "open",
                ...marker,
              })} -->`,
              authorAssociation: "OWNER",
              createdAt: "2026-11-02T10:00:00Z",
            },
          ]
        : [];
      issues.set(number, { number, title: `Issue ${number}`, comments });
    },
  };
}

const loop = (f: FactoryRuntime, name: string) =>
  loopTask(
    f,
    f.loops.find((l) => l.name === name)!,
  )();

/** The factory machine `a`, with a GitHub source, and a machine `b`, paired over Tailscale. */
async function twoMachines() {
  const a = await factoryNode(cleanup, {
    config: (repo) => ({ limits: { threads: 20 }, sources: [{ id: "bugs", type: "github", repo, label: "factory" }] }),
  });
  const github = fakeGitHub(a.repo);
  const handler = app(a.ctx);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => handler.fetch(req, { listener: "tailnet" }),
  });
  cleanup.push(() => server.stop(true));
  const [b] = await startNodes("b");
  cleanup.push(() => b!.stop());
  const token = crypto.randomUUID();
  a.s.db.run("insert into peers values (?, ?, ?, 0, ?)", ["b", b!.url, token, a.s.now()]);
  b!.s.db.run("insert into peers values (?, ?, ?, 0, ?)", ["a", `http://127.0.0.1:${server.port}`, token, b!.s.now()]);
  a.s.put("node", "b", { id: "b", protocol: NODE_PROTOCOL });
  b!.s.put("node", "a", { id: "a", protocol: NODE_PROTOCOL });
  const bf = b!.ctx.factory;
  // The daemon runs it at start; with b paired, a's intake waits for it too.
  await loop(a.f, "factory-move");
  const builtin = (await a.ctx.gateway.builtin!()).client;

  return {
    a,
    b: b!,
    bf,
    github,
    stopA: () => server.stop(true),
    /** `agentgate factory use … --node b` on a, then the setting reaching b as record sync carries it. */
    async moveToB() {
      expect((await a.command("use", "acme/factory", "--node", "b")).code).toBe(0);
      b!.s.put("setting", "settings", { ...b!.s.settings(), factory: a.f.pointer() });
      await loop(bf, "factory-folder");
    },
    /** `factory_report` from the run's own T3 thread on a, as the shim sends it. */
    async report(run: string, body: Record<string, unknown>) {
      const result = await builtin.callTool({
        name: "factory_report",
        arguments: { run, ...body },
        _meta: { "dev.agentgate/t3Thread": runs.get(a.s, run)!.threadId },
      });
      return JSON.parse((result.content as { text: string }[])[0]!.text);
    },
  };
}

const keys = (f: FactoryRuntime) => items.list(f.s).map((i) => i.key);

test("b asks a for its open items before its intake starts, and a stops intake but finishes its own", async () => {
  const { a, bf, github, moveToB, report } = await twoMachines();
  github.open(1);
  await a.intake();
  await a.dispatch();
  const [triage] = runs.list(a.s);
  await a.until(() => a.mirror.thread(triage!.threadId!)?.status === "running", "the triage thread to run");

  await moveToB();
  github.open(2);
  await loop(bf, "factory-intake");
  expect(keys(bf)).toEqual([]);
  expect((await buildBoard(bf, { includeWebhookUrls: false })).capacity.intake).toBe("off");

  await loop(bf, "factory-move");
  await loop(bf, "factory-intake");
  // gh-1 has no marker yet: only a's answer keeps b from taking it a second time.
  expect(keys(bf)).toEqual(["gh-2"]);

  github.open(3);
  await a.intake();
  expect(keys(a.f)).toEqual(["gh-1"]);

  // The board on either machine shows both machines' items while a holds one.
  const heldBy = (board: Awaited<ReturnType<typeof buildBoard>>) =>
    Object.fromEntries(board.items.map((i) => [i.key, i.heldBy]));
  expect(heldBy(await buildBoard(bf, { includeWebhookUrls: false }))).toEqual({ "gh-1": "a", "gh-2": "b" });
  expect(heldBy(await boardView(a.f, { includeWebhookUrls: false }))).toEqual({ "gh-1": "a", "gh-2": "b" });

  // a's own thread still reports to a, which closes its item.
  expect(await report(triage!.id, { outcome: "not-a-bug", summary: "Works as designed." })).toEqual({
    accepted: true,
  });
  expect(items.list(a.s)[0]!.phase).toBe("closed");
  await loop(bf, "factory-move");
  expect(heldBy(await buildBoard(bf, { includeWebhookUrls: false }))).toEqual({ "gh-2": "b" });
});

test("with a unreachable, b lists a's marked issues as orphaned and adopts one at its marked stage", async () => {
  const { a, bf, github, moveToB, stopA } = await twoMachines();
  expect((await a.command("add", a.repo, "Rename the export")).code).toBe(0);
  github.open(5, { stage: "implement" });
  github.open(6, { node: "c" });
  github.open(7, { state: "finished" });
  await moveToB();
  stopA();

  await loop(bf, "factory-move");
  const board = await buildBoard(bf, { includeWebhookUrls: false });
  expect(board.items.map((i) => [i.key, i.heldBy, i.phase, i.needsYou?.reason])).toEqual([
    ["gh-5", "a", "implement", "orphaned"],
  ]);

  const output: string[] = [];
  expect(await runCommand(bf, "retry", [`${a.repo}#5`], { out: (line) => output.push(line) })).toBe(0);
  expect(output).toEqual(["Took over gh-5; it starts at implement"]);
  const [item] = items.list(bf.s);
  expect(item).toMatchObject({ key: "gh-5", phase: "implement", externalId: `${a.repo}#5` });
  expect(runs.forItem(bf.s, item!.id).map((r) => [r.kind, r.state])).toEqual([["implement", "queued"]]);
  expect((await buildBoard(bf, { includeWebhookUrls: false })).items.map((i) => [i.key, i.heldBy])).toEqual([
    ["gh-5", "b"],
  ]);
});

test("retry refuses an issue whose machine still holds it", async () => {
  const { a, bf, github, moveToB } = await twoMachines();
  github.open(1);
  await a.intake();
  github.open(1, { item: items.list(a.s)[0]!.id, stage: "triage" });
  await moveToB();
  await loop(bf, "factory-move");

  const output: string[] = [];
  await expect(runCommand(bf, "retry", [`${a.repo}#1`], { out: (line) => output.push(line) })).rejects.toThrow(
    "a still holds gh-1 and finishes it there",
  );
  expect(keys(bf)).toEqual([]);
});
