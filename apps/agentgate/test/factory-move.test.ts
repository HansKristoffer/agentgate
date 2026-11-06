import { afterAll, afterEach, expect, test } from "bun:test";
import type { MarkerPayload } from "@agentgate/protocol";
import { app } from "../src/daemon.ts";
import { buildBoard } from "../src/factory/board.ts";
import { items, runs } from "../src/factory/db.ts";
import { MARKER_PREFIX, parseMarkers } from "../src/factory/markers.ts";
import { loopTask, runCommand, type FactoryRuntime } from "../src/factory/runtime.ts";
import { host } from "../src/logins.ts";
import { NODE_PROTOCOL } from "../src/remote.ts";
import { removeTmp } from "./fixtures/git.ts";
import { startNodes } from "./fixtures/nodes.ts";
import { factoryNode, idle } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

interface Issue {
  number: number;
  title: string;
  comments: { body: string; author: { login: string }; authorAssociation: string; createdAt: string }[];
}

/** One repository's open issues labelled `factory`, answering the gh commands gh.ts sends, and counting them. */
function fakeGitHub(repo: string) {
  const issues = new Map<number, Issue>();
  const calls: string[][] = [];
  const realGh = host.gh;
  cleanup.push(() => (host.gh = realGh));
  const ok = (value: unknown) => ({ ok: true, out: JSON.stringify(value) });
  host.gh = async (args, stdin) => {
    calls.push(args);
    const url = (n: number) => `https://github.com/${repo}/issues/${n}`;
    if (args[0] === "issue" && args[1] === "list")
      return ok([...issues.values()].map((i) => ({ number: i.number, title: i.title, body: "", url: url(i.number) })));
    if (args[0] === "issue" && args[1] === "view") {
      const issue = issues.get(Number(args[2]))!;
      return ok(args.at(-1) === "state" ? { state: "OPEN" } : { comments: issue.comments });
    }
    // Every machine's gh acts as the maintainer's login (D42), so each one's markers count on the others.
    if (args[0] === "api" && args[1] === "user") return ok({ login: "maintainer" });
    const comment = args[1]?.match(/\/issues\/(\d+)\/comments$/);
    if (args[0] === "api" && comment) {
      const { body } = JSON.parse(stdin!);
      issues
        .get(Number(comment[1]))!
        .comments.push({ body, author: { login: "maintainer" }, authorAssociation: "OWNER", createdAt: "2026-11-05" });
      return ok({ id: 1 });
    }
    throw new Error(`the fake GitHub has no answer for gh ${args.join(" ")}`);
  };
  return {
    issues,
    calls,
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
              author: { login: "maintainer" },
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
  const builtin = (await a.ctx.gateway.builtin!()).client;
  const key = (number: number) => `${a.repo.split("/")[1]!.toLowerCase()}-${number}`;

  return {
    a,
    b: b!,
    bf,
    github,
    key,
    stopA: () => server.stop(true),
    /** a has not answered sync for a while, as when it sleeps or is gone. */
    aGoesQuiet: () => b!.s.db.run("update peers set last_seen = 0 where node = 'a'"),
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
      await idle(a.f);
      return JSON.parse((result.content as { text: string }[])[0]!.text);
    },
  };
}

const keys = (f: FactoryRuntime) => items.list(f.s).map((i) => i.key);

test("after a move, b leaves an issue a took before triaging it, because a marked it taken; a keeps its T3 sign-in and finishes it", async () => {
  const { a, bf, github, key, moveToB, report } = await twoMachines();
  github.open(1);
  await a.intake();
  await a.dispatch();
  await idle(a.f);
  // The issue says at once which machine took it.
  expect(parseMarkers(github.issues.get(1)!.comments[0]!.body)).toEqual([
    expect.objectContaining({ key: key(1), stage: null, node: "a", state: "open" }),
  ]);
  const [triage] = runs.list(a.s);
  await a.until(() => a.mirror.thread(triage!.threadId!)?.status === "running", "the triage thread to run");

  await moveToB();
  github.open(2);
  await loop(bf, "factory-intake");
  // b's intake took the new issue and left a's, which has no triage result yet.
  expect(keys(bf)).toEqual([key(2)]);
  const board = await buildBoard(bf, { includeWebhookUrls: false });
  expect(board.items.find((i) => i.key === key(1))).toMatchObject({ heldBy: "a" });
  expect(board.items.find((i) => i.key === key(1))!.needsYou).toBeUndefined();

  github.open(3);
  await a.intake();
  expect(keys(a.f)).toEqual([key(1)]);

  // a no longer runs the factory, but holds an item: its T3 sign-in stays, and its item goes on to its next stage.
  await loop(a.f, "t3-mcp");
  expect(a.mcp.revoked).toEqual([]);
  const spec = {
    outcome: "done",
    summary: "Unclear: it needs a spec.",
    result: { kind: "triage", route: "spec", reproduction: { notPossible: "a design question" } },
  };
  expect(await report(triage!.id, spec)).toEqual({ accepted: true });
  await a.dispatch();
  const specRun = runs.forItem(a.s, triage!.item!).find((r) => r.kind === "spec")!;
  expect(specRun).toMatchObject({ state: "running", error: undefined });
  expect(a.mcp.calls.filter((c) => c.tool === "t3_thread_launch").map((c) => c.args.clientRequestId)).toContain(
    specRun.id,
  );
  expect((await buildBoard(a.f, { includeWebhookUrls: false })).t3.mcp).toBe("signed-in");

  // Once its last item finishes, a signs out and T3 forgets the session.
  expect(await a.command("drop", key(1))).toEqual({ code: 0, output: [`Dropped ${key(1)}`] });
  await loop(a.f, "t3-mcp");
  expect(a.mcp.revoked).toHaveLength(1);
});

test("with a quiet, b shows a's marked issues as orphaned and adopts one at its marked stage", async () => {
  const { a, bf, github, key, moveToB, stopA, aGoesQuiet } = await twoMachines();
  expect((await a.command("add", a.repo, "Rename the export")).code).toBe(0);
  github.open(5, { stage: "implement" });
  github.open(6, { node: "c" });
  github.open(7, { state: "finished" });
  await moveToB();
  stopA();
  aGoesQuiet();

  await loop(bf, "factory-intake");
  const board = await buildBoard(bf, { includeWebhookUrls: false });
  expect(board.items.map((i) => [i.key, i.heldBy, i.phase, i.needsYou?.reason])).toEqual([
    [key(5), "a", "implement", "orphaned"],
    [key(6), "c", "implement", "orphaned"],
  ]);

  const output: string[] = [];
  expect(await runCommand(bf, "retry", [`${a.repo}#5`], { out: (line) => output.push(line) })).toBe(0);
  expect(output).toEqual([`Took over ${key(5)}; it starts at implement`]);
  const [item] = items.list(bf.s);
  expect(item).toMatchObject({ key: key(5), phase: "implement", externalId: `${a.repo}#5` });
  expect(runs.forItem(bf.s, item!.id).map((r) => [r.kind, r.state])).toEqual([["implement", "queued"]]);
  // A key names the issue too.
  expect(await runCommand(bf, "retry", [key(6)], { out: () => {} })).toBe(0);
  expect(keys(bf)).toEqual([key(5), key(6)]);
});

test("retry refuses an issue whose machine is online, since it finishes the issue itself", async () => {
  const { a, bf, github, key, moveToB } = await twoMachines();
  github.open(1);
  await a.intake();
  await idle(a.f);
  await moveToB();

  const output: string[] = [];
  await expect(runCommand(bf, "retry", [`${a.repo}#1`], { out: (line) => output.push(line) })).rejects.toThrow(
    `a still holds ${key(1)} and finishes it there`,
  );
  expect(keys(bf)).toEqual([]);
});

test("with a machine offline and labelled issues held, an hour of loops reads no issue comments and asks no machine for its items", async () => {
  const { bf, github, moveToB, stopA, aGoesQuiet } = await twoMachines();
  for (let i = 1; i <= 20; i++) github.open(i, { node: "a" });
  await moveToB();
  stopA();
  aGoesQuiet();
  await loop(bf, "factory-intake");
  const reads = () => github.calls.filter((c) => c[0] === "issue" && c[1] === "view" && c.at(-1) === "comments").length;
  const first = reads();
  expect(first).toBe(20);
  for (let minute = 0; minute < 60; minute++) {
    bf.s.now = (
      (at) => () =>
        at
    )(bf.s.now() + 60_000);
    for (const name of ["factory-dispatch", "factory-prs", "factory-tokens", "factory-stuck"]) await loop(bf, name);
  }
  // Intake reads each issue's markers when it polls, once per pass: the other loops never do.
  expect(reads()).toBe(first);
  expect(bf.loops.map((l) => l.name)).not.toContain("factory-move");
  expect(keys(bf)).toEqual([]);
});
