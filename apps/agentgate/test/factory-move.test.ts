import { afterAll, afterEach, expect, test } from "bun:test";
import type { FactoryBoard, MarkerPayload } from "@agentgate/protocol";
import { app } from "../src/daemon.ts";
import { boardView } from "../src/factory/board.ts";
import { items, runs } from "../src/factory/db.ts";
import { MARKER_PREFIX, parseMarkers } from "../src/factory/markers.ts";
import { loopTask, type FactoryRuntime } from "../src/factory/runtime.ts";
import { host } from "../src/logins.ts";
import { NODE_PROTOCOL } from "../src/remote.ts";
import type { Store } from "../src/store.ts";
import { removeTmp } from "./fixtures/git.ts";
import { startNodes } from "./fixtures/nodes.ts";
import { factoryNode, idle, terminal } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

interface Issue {
  number: number;
  title: string;
  updatedAt: string;
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
      return ok(
        [...issues.values()].map((i) => ({
          number: i.number,
          title: i.title,
          body: "",
          url: url(i.number),
          updatedAt: i.updatedAt,
        })),
      );
    if (args[0] === "issue" && args[1] === "view") {
      const issue = issues.get(Number(args[2]))!;
      return ok({ state: "OPEN", comments: issue.comments });
    }
    // Every machine's gh acts as the maintainer's login (D42), so each one's markers count on the others.
    if (args[0] === "api" && args[1] === "user") return ok({ login: "maintainer" });
    const comment = args[1]?.match(/\/issues\/(\d+)\/comments$/);
    if (args[0] === "api" && comment) {
      const { body } = JSON.parse(stdin!);
      const issue = issues.get(Number(comment[1]))!;
      issue.comments.push({
        body,
        author: { login: "maintainer" },
        authorAssociation: "OWNER",
        createdAt: "2026-11-05",
      });
      issue.updatedAt = new Date().toISOString() + issue.comments.length;
      return ok({ id: 1 });
    }
    throw new Error(`the fake GitHub has no answer for gh ${args.join(" ")}`);
  };
  return {
    issues,
    calls,
    /** An open labelled issue; with `marker`, one a factory machine commented on before. */
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
                node: "c",
                state: "open",
                ...marker,
              })} -->`,
              author: { login: "maintainer" },
              authorAssociation: "OWNER",
              createdAt: "2026-11-02T10:00:00Z",
            },
          ]
        : [];
      issues.set(number, { number, title: `Issue ${number}`, comments, updatedAt: "2026-11-02T10:00:00Z" });
    },
    /** The factory comments on an issue, as the newest marker of each tells them. */
    markers: (number: number) => issues.get(number)!.comments.map((c) => parseMarkers(c.body).at(-1)!),
  };
}

const loop = (f: FactoryRuntime, name: string) =>
  loopTask(
    f,
    f.loops.find((l) => l.name === name)!,
  )();

const toSpec = {
  outcome: "done",
  summary: "Unclear: it needs a spec.",
  result: { kind: "triage", route: "spec", reproduction: { notPossible: "a design question" } },
};

/** The factory machine `a`, with a GitHub source, and a machine `b`, paired over Tailscale; both know the factory
 * runs on a. */
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
  /** The pointer reaching the other machine, as record sync carries it. */
  const carry = (from: Store, to: Store) =>
    to.put("setting", "settings", { ...to.settings(), factory: from.settings().factory });
  carry(a.s, b!.s);

  return {
    a,
    b: b!,
    bf,
    github,
    key,
    stopA: () => server.stop(true),
    toB: () => carry(a.s, b!.s),
    toA: () => carry(b!.s, a.s),
    /** `agentgate factory <words>` typed on b. */
    onB: (...words: string[]) => terminal(bf, words),
    /** Issue `number` taken in on a, with its triage thread started. */
    async triaging(number: number) {
      github.open(number);
      await a.intake();
      await a.dispatch();
      await idle(a.f);
      return runs.forItem(a.s, items.byKey(a.s, key(number))!.id)[0]!;
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
const launches = (a: { mcp: { calls: { tool: string }[] } }) =>
  a.mcp.calls.filter((c) => c.tool === "t3_thread_launch").length;

test("with no open item, a move asked on any machine switches the factory at once, and use keeps the machine it runs on", async () => {
  const { a, bf, onB, toB } = await twoMachines();

  // b forwards the move to a, which alone knows what it has open.
  expect(await onB("move", "b")).toEqual({
    code: 0,
    output: ["Factory folder acme/factory, run by b.", `Loaded acme at ${a.commit.slice(0, 7)}.`],
  });
  expect(a.f.pointer()).toEqual({ store: "github", repo: "acme/factory", path: "", node: "b" });
  toB();
  expect(bf.isFactoryNode()).toBe(true);

  // Pointing the factory at a folder again from a does not bring it back to a.
  expect((await a.command("use", "acme/factory")).output[0]).toBe("Factory folder acme/factory, run by b.");
  expect((await a.command("move", "nowhere")).output).toEqual([
    "No machine is named nowhere; agentgate status lists them",
  ]);
});

test("a move with open items waits: intake stops, the items go on, and when the last one finishes the factory machine moves the pointer itself", async () => {
  const { a, bf, github, key, onB, toB, triaging, report } = await twoMachines();
  const triage = await triaging(1);

  const asked = await onB("move", "b");
  expect(asked.code).toBe(0);
  expect(asked.output[1]).toBe(
    "Moving to b once 1 item finishes; nothing new is taken in until then. agentgate factory move b --now does not wait, and leaves the open items frozen on a; agentgate factory move a cancels.",
  );
  expect(a.f.pointer()).toMatchObject({ node: "a", moveTo: "b" });
  // Pointing the factory at its folder again changes neither its machine nor the move it waits for.
  expect((await a.command("use", "acme/factory")).code).toBe(0);
  expect(a.f.pointer()).toMatchObject({ node: "a", moveTo: "b" });
  toB();
  // Every machine's board says so, with the factory machine's count.
  const board = await boardView(bf, { includeWebhookUrls: false });
  expect(board.factory).toMatchObject({ node: "a", moving: { to: "b", open: 1 } });
  expect(board.capacity.intake).toBe("off");
  expect((await a.command("status")).output).toContain(
    "Moving to b once 1 item finishes; nothing new is taken in until then",
  );

  // Nothing new comes in, and what is open goes on to its next stage on a.
  github.open(2);
  await a.intake();
  expect(keys(a.f)).toEqual([key(1)]);
  expect(await report(triage.id, toSpec)).toEqual({ accepted: true });
  await a.dispatch();
  expect(runs.forItem(a.s, triage.item!).find((r) => r.kind === "spec")).toMatchObject({ state: "running" });
  await loop(a.f, "factory-move");
  expect(a.f.pointer()).toMatchObject({ node: "a", moveTo: "b" });

  expect((await a.command("drop", key(1))).code).toBe(0);
  await idle(a.f);
  await loop(a.f, "factory-move");
  expect(a.f.pointer()).toEqual({ store: "github", repo: "acme/factory", path: "", node: "b" });
  expect(a.f.events.recent(5).map((e) => e.text)).toContain("The last open item finished, so the factory moved to b");

  // b takes what waited, and leaves the issue a finished.
  toB();
  for (const name of ["factory-folder", "factory-intake"]) await loop(bf, name);
  expect(keys(bf)).toEqual([key(2)]);
});

test("the factory stays until its machine has posted an item's last comment, which keeps the next machine from taking a dropped issue in again", async () => {
  const { a, github, key, triaging } = await twoMachines();
  await triaging(1);
  expect((await a.command("move", "b")).code).toBe(0);

  // gh is logged out as the item is dropped, so its closed comment cannot be sent.
  const gh = host.gh;
  host.gh = async () => ({ ok: false, out: "", exit: 4 });
  expect((await a.command("drop", key(1))).code).toBe(0);
  await idle(a.f);
  await loop(a.f, "factory-move");
  expect(a.f.pointer()).toMatchObject({ node: "a", moveTo: "b" });
  expect((await a.command("status")).output).toContain(
    "Moving to b once its last comments are posted; nothing new is taken in until then",
  );

  host.gh = gh;
  await loop(a.f, "factory-outbox");
  await idle(a.f);
  expect(github.markers(1).at(-1)).toMatchObject({ node: "a", state: "finished" });
  await loop(a.f, "factory-move");
  expect(a.f.pointer()).toMatchObject({ node: "b" });
});

test("moving to the machine that already runs the factory cancels a move that waits, and intake goes on", async () => {
  const { a, github, key, triaging } = await twoMachines();
  await triaging(1);
  expect((await a.command("move", "b")).code).toBe(0);
  expect(a.f.pointer()).toMatchObject({ node: "a", moveTo: "b" });

  expect(await a.command("move", "a")).toEqual({
    code: 0,
    output: ["Factory folder acme/factory, run by a.", `Loaded acme at ${a.commit.slice(0, 7)}.`],
  });
  expect(a.f.pointer()).toEqual({ store: "github", repo: "acme/factory", path: "", node: "a" });
  await loop(a.f, "factory-move");
  expect(a.f.isFactoryNode()).toBe(true);
  github.open(2);
  await a.intake();
  expect(keys(a.f)).toEqual([key(1), key(2)]);
});

test("move --now freezes the old machine's items: it starts no thread, follows no PR and signs out of T3 Code, its status says so, and drop closes one there without a comment", async () => {
  const { a, github, key, onB, toA, triaging, report } = await twoMachines();
  const first = await triaging(1);
  const second = await triaging(2);
  // One item with a stage queued, and one whose PR the follower would read.
  expect(await report(first.id, toSpec)).toEqual({ accepted: true });
  items.update(a.s, second.item!, { phase: "pr", prUrl: `https://github.com/${a.repo}/pull/9` });

  expect((await onB("move", "b", "--now")).output[0]).toBe("Factory folder acme/factory, run by b.");
  toA();
  expect(a.f.isFactoryNode()).toBe(false);
  const before = { launches: launches(a), calls: github.calls.length, comments: github.markers(1).length };
  for (const { name } of a.f.loops) await loop(a.f, name);
  await idle(a.f);
  expect(launches(a)).toBe(before.launches);
  expect(github.calls).toHaveLength(before.calls);
  expect(runs.forItem(a.s, first.item!).find((r) => r.kind === "spec")).toMatchObject({ state: "queued" });
  expect(a.mcp.revoked).toHaveLength(1);

  // a shows b's board, and its own items apart from it.
  const { output } = await a.command("status");
  expect(output.slice(0, 4)).toEqual([
    "Factory: acme/factory on b, online",
    "Frozen on a: 2 items. The factory now runs on b, so nothing works on them. agentgate factory move a resumes them; agentgate factory drop <id>, run on a, closes one.",
    `  spec      ${key(1)} Issue 1 (${first.item})`,
    `  pr        ${key(2)} Issue 2 (${second.item}) https://github.com/${a.repo}/pull/9`,
  ]);
  const board = (await (await a.api("/api/factory")).json()) as FactoryBoard;
  expect(board.items).toEqual([]);
  expect(board.frozen?.map((i) => [i.key, i.actions.map((x) => x.name)])).toEqual([
    [key(1), ["drop"]],
    [key(2), ["drop"]],
  ]);

  // A key names the factory machine's item, which may be a new one of the same issue; an id names the frozen one,
  // which only a can close.
  expect(await a.command("drop", key(1))).toEqual({ code: 1, output: [`b has no factory item ${key(1)}`] });
  expect(await a.command("retry", first.item!)).toEqual({
    code: 1,
    output: [
      `${key(1)} is frozen on a while the factory runs on b; move the factory back to go on with it, or drop it`,
    ],
  });
  expect((await a.command("show", first.item!)).output[0]).toBe(`${key(1)} Issue 1 (${a.repo}, spec)`);
  expect(await a.command("drop", first.item!)).toEqual({
    code: 0,
    output: [`Dropped ${key(1)}, which was frozen on a`],
  });
  await idle(a.f);
  expect(items.byKey(a.s, key(1))!.phase).toBe("closed");
  expect(runs.forItem(a.s, first.item!).every((r) => r.endedAt)).toBe(true);
  expect(github.markers(1)).toHaveLength(before.comments);
  expect((await a.command("status")).output[1]).toStartWith("Frozen on a: 1 item. The factory now runs on b");
});

test("moving the factory back resumes what was frozen", async () => {
  const { a, onB, toA, triaging, report } = await twoMachines();
  const triage = await triaging(1);
  expect(await report(triage.id, toSpec)).toEqual({ accepted: true });
  expect((await onB("move", "b", "--now")).code).toBe(0);
  toA();
  for (const { name } of a.f.loops) await loop(a.f, name);
  const spec = () => runs.forItem(a.s, triage.item!).find((r) => r.kind === "spec")!;
  expect(spec().state).toBe("queued");

  expect((await a.command("move", "a", "--now")).code).toBe(0);
  for (const name of ["t3-mcp", "t3-mirror"]) await loop(a.f, name);
  await a.until(() => a.mirror.status().stream === "live", "the shell stream");
  await a.dispatch();
  expect(spec().state).toBe("running");
  expect((await a.command("status")).output.some((line) => line.startsWith("Frozen"))).toBe(false);
});

test("after move --now, the new machine takes in again an issue the old one left open, from triage, and never one the factory finished", async () => {
  const { a, bf, github, key, onB, triaging } = await twoMachines();
  await triaging(1);
  github.open(2, { node: "c", stage: "review" });
  github.open(3, { state: "finished" });
  expect((await onB("move", "b", "--now")).code).toBe(0);

  const reads = () => github.calls.filter((c) => c[0] === "issue" && c[1] === "view" && c.at(-1) === "comments").length;
  const first = reads();
  for (let pass = 0; pass < 3; pass++) await loop(bf, "factory-intake");
  await idle(bf);
  expect(items.list(bf.s).map((i) => [i.key, i.phase])).toEqual([
    [key(1), "triage"],
    [key(2), "triage"],
  ]);
  // The issue hears that b took it, after a's comment.
  expect(github.markers(1).map((m) => [m.node, m.state])).toEqual([
    ["a", "open"],
    ["b", "open"],
  ]);
  expect(items.byKey(bf.s, key(1))!.id).not.toBe(items.byKey(a.s, key(1))!.id);

  // Each issue's marker was read once, and the finished one is read again only when its issue changed.
  expect(reads() - first).toBe(3);
  github.issues.get(3)!.updatedAt = "2026-11-06T10:00:00Z";
  await loop(bf, "factory-intake");
  expect(reads() - first).toBe(4);
  expect(keys(bf)).toEqual([key(1), key(2)]);
});

test("a move that waits cannot be asked while the factory machine is out of reach, and the answer names --now", async () => {
  const { a, onB, stopA } = await twoMachines();
  stopA();
  expect(await onB("move", "b")).toEqual({
    code: 1,
    output: [
      "The factory runs on a, and this machine cannot reach it; agentgate factory move b --now moves it without waiting for that machine",
    ],
  });
  expect((await onB("move", "b", "--now")).code).toBe(0);
  // a has not heard of it: it stays the factory machine in its own eyes until sync reaches it.
  expect(a.f.isFactoryNode()).toBe(true);
});
