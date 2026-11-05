import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, afterEach, expect, test } from "bun:test";
import { buildBoard } from "../src/factory/board.ts";
import { runs, scores, type FactoryRun } from "../src/factory/db.ts";
import { fetcher } from "../src/factory/folder.ts";
import { host } from "../src/logins.ts";
import { removeTmp, sh, tmp } from "./fixtures/git.ts";
import { factoryNode } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const BRANCH = "factory/learn-run_1";
const stage = (body: string) => `---\n{}\n---\n\n${body}`;

/**
 * The factory machine, its folder on `acme/factory` with a learning branch `BRANCH` whose implement guidance and rulings
 * differ. GitHub answers for the factory's repository's merged PRs and records comments; `prs` maps a branch to its
 * open PR. Every T3 thread gets a real clone of the repository as its worktree, and each message records the clone's
 * push URL when it arrived.
 */
async function benchFactory() {
  const n = await factoryNode(cleanup, {
    config: { limits: { threads: 20 } },
    files: { "stages/implement.md": stage("Current guidance.") },
  });
  const base = sh(n.origin.root, "--git-dir", n.origin.origin, "rev-parse", "main");

  // Candidate folders, one per branch, fetched by ref.
  const candidates = new Map<string, string>();
  const candidate = (ref: string, guidance: string) => {
    const commit = Bun.SHA1.hash(ref, "hex");
    const files = {
      "factory.yaml": JSON.stringify({ version: 1, name: "acme", repositories: { [n.repo]: {} } }),
      "stages/implement.md": stage(guidance),
      "rulings.md": `# Rulings\n\n- ${guidance} rulings.`,
    };
    for (const [file, text] of Object.entries(files)) {
      const path = join(fetcher.root, commit, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    candidates.set(ref, commit);
    return commit;
  };
  const loaded = fetcher.fetch;
  fetcher.fetch = async (input) => {
    const commit = input.ref && candidates.get(input.ref);
    return commit ? { commit, dir: join(fetcher.root, commit) } : loaded(input);
  };

  // Merged PRs, newest first: #30 closes two issues, #31 is the factory's own, #32 a bot's.
  const merged = [
    { number: 30, issues: [10, 11], branch: "fix-save", author: "alice", mergedAt: "2026-10-05T00:00:00Z" },
    { number: 31, issues: [12], branch: "factory/it-12", author: "alice", mergedAt: "2026-10-04T00:00:00Z" },
    { number: 32, issues: [13], branch: "deps", author: "dependabot[bot]", mergedAt: "2026-10-03T00:00:00Z" },
    { number: 33, issues: [14], branch: "fix-load", author: "bob", mergedAt: "2026-10-02T00:00:00Z" },
    { number: 34, issues: [15], branch: "fix-copy", author: "bob", mergedAt: "2026-10-01T00:00:00Z" },
  ];
  const prUrl = (number: number) => `https://github.com/${n.repo}/pull/${number}`;
  const prs = new Map<string, number>();
  const comments: { path: string; body: string }[] = [];
  const realGh = host.gh;
  host.gh = async (args, stdin) => {
    const json = (value: unknown) => ({ ok: true, out: JSON.stringify(value) });
    if (args[0] === "api" && args[1] === "graphql")
      return json({
        data: {
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: merged.map((pr) => ({
                number: pr.number,
                url: prUrl(pr.number),
                mergedAt: pr.mergedAt,
                baseRefOid: base,
                closingIssuesReferences: {
                  nodes: pr.issues.map((issue) => ({
                    number: issue,
                    title: `Issue ${issue}`,
                    body: `Body of ${issue}`,
                  })),
                },
              })),
            },
          },
        },
      });
    if (args[0] === "api" && /^repos\/.+\/issues\/\d+\/comments$/.test(args[1]!)) {
      comments.push({ path: args[1]!, body: JSON.parse(stdin!).body });
      return json({});
    }
    if (args[0] === "pr" && args[1] === "list") {
      const number = prs.get(args[args.indexOf("--head") + 1]!);
      return json(number ? [{ number, url: `https://github.com/acme/factory/pull/${number}` }] : []);
    }
    const pr = args[0] === "pr" && args[1] === "view" && merged.find((p) => prUrl(p.number) === args[2]);
    if (!pr) throw new Error(`the fake GitHub has no answer for gh ${args.join(" ")}`);
    return json({
      number: pr.number,
      url: prUrl(pr.number),
      title: `Fix ${pr.issues[0]}`,
      state: "MERGED",
      isDraft: false,
      author: { login: pr.author },
      headRefName: pr.branch,
      headRefOid: "b".repeat(40),
      baseRefName: "main",
      mergedAt: pr.mergedAt,
      statusCheckRollup: [],
      mergeable: "UNKNOWN",
      body: "",
      files: [],
      comments: [],
      reviews: [],
    });
  };
  cleanup.push(() => {
    host.gh = realGh;
    fetcher.fetch = loaded;
  });

  const messages: { thread: string; pushUrl: string; text: string }[] = [];
  n.mcp.answer("t3_thread_launch", (args) => {
    const id = `mcp:launch:${String(args.clientRequestId)}`;
    if (!n.t3.threads.has(id)) {
      const worktreePath = join(tmp(), "worktree");
      sh(dirname(worktreePath), "clone", "--quiet", n.origin.url, worktreePath);
      n.t3.addThread({ id, projectId: String(args.projectId), sessionId: crypto.randomUUID(), worktreePath });
      n.mcp.setThread(id, { status: "idle" });
    }
    return { threadId: id, link: `https://t3.test/threads/${id}` };
  });
  n.mcp.answer("t3_thread_read", (args) => ({
    thread: { worktreePath: n.t3.threads.get(String(args.threadId))?.worktreePath },
  }));
  n.mcp.answer("t3_thread_send", (args) => {
    const t = n.t3.threads.get(String(args.threadId))!;
    const pushUrl = sh(t.worktreePath!, "remote", "get-url", "--push", "origin");
    messages.push({ thread: t.id, pushUrl, text: String(args.message) });
    n.mcp.setThread(t.id, { status: "running" });
    return { ok: true };
  });

  const builtin = (await n.ctx.gateway.builtin!()).client;
  const call = async (name: string, run: FactoryRun, args: Record<string, unknown>) => {
    const thread = runs.get(n.s, run.id)!.threadId;
    const result = await builtin.callTool({ name, arguments: args, _meta: { "dev.agentgate/t3Thread": thread } });
    const text = (result.content as { text: string }[])[0]!.text;
    return result.isError ? { error: text } : JSON.parse(text);
  };
  const report = (run: FactoryRun, body: Record<string, unknown>) =>
    call("factory_report", run, { run: run.id, ...body });
  const replayed = (patch = "diff --git a/x b/x") => ({
    outcome: "done",
    summary: "Fixed it.",
    result: { kind: "replay", patch, testsPassed: true },
  });
  const graded = (label: string) => ({
    outcome: "done",
    summary: "Graded it.",
    result: { kind: "judge", scorer: "bench", label, reasoning: `It is ${label}.` },
  });
  const replays = () => runs.list(n.s, { kinds: ["replay"] });
  const judgeOf = (replay: FactoryRun) =>
    runs.list(n.s, { kinds: ["judge"] }).find((j) => (j.checked as { run: string }).run === replay.id)!;

  /** Reports the replay, then grades it with `label` in its judge thread. */
  async function finish(replay: FactoryRun, label: string) {
    expect(await report(replay, replayed())).toEqual({ accepted: true });
    await n.dispatch();
    expect(await report(judgeOf(replay), graded(label))).toEqual({ accepted: true });
  }
  return {
    ...n,
    base,
    candidate,
    prs,
    comments,
    messages,
    call,
    report,
    replayed,
    graded,
    replays,
    judgeOf,
    finish,
    benchLoop: n.f.loops.find((l) => l.name === "factory-bench")!.run,
  };
}

test("bench --ref replays issues closed by a person's merged PR at its base commit, with the folder at the ref and pushing disabled before the brief", async () => {
  const n = await benchFactory();
  const commit = n.candidate(BRANCH, "Candidate guidance.");

  const out = await n.command("bench", "--ref", BRANCH, "--items", "2");
  expect(out.code).toBe(0);
  expect(out.output.at(-1)).toContain("not the branch of an open PR");
  // One issue per PR, and neither the factory's own PR nor the bot's.
  expect(n.replays().map((r) => [r.configCommit, r.checked])).toEqual([
    [commit, expect.objectContaining({ repo: n.repo, issue: 10, pr: 30, baseSha: n.base, body: "Body of 10" })],
    [commit, expect.objectContaining({ repo: n.repo, issue: 14, pr: 33, baseSha: n.base })],
  ]);

  await n.dispatch();
  for (const replay of n.replays()) {
    const run = runs.get(n.s, replay.id)!;
    expect(run.state).toBe("running");
    const launch = n.mcp.calls.find((c) => c.tool === "t3_thread_launch" && c.args.clientRequestId === run.id)!;
    expect(launch.args.message).toBeUndefined();
    expect(launch.args.workspaceStrategy).toEqual({
      type: "worktree",
      baseRef: n.base,
      branch: `factory-bench/${run.id}`,
      startFromOrigin: false,
    });
    const brief = n.messages.find((m) => m.thread === run.threadId)!;
    expect(brief.pushUrl).toBe("no-push");
    expect(brief.text).toContain("Candidate guidance.");
    expect(brief.text).toContain("Candidate guidance. rulings.");
    expect(brief.text).not.toContain("Current guidance.");
    expect(brief.text).toContain(`run: "${run.id}"`);
  }
  expect(n.messages.find((m) => m.thread === runs.get(n.s, n.replays()[0]!.id)!.threadId)!.text).toContain(
    "```untrusted\nTitle: Issue 10\n\nBody of 10\n```",
  );

  // A replay must hand in its patch; once it does, nothing reaches GitHub or links a PR.
  const [first] = n.replays();
  expect((await n.report(first!, { outcome: "blocked", summary: "No.", blocked: { missing: "x" } })).error).toContain(
    'A replay reports done with result: { kind: "replay", patch, testsPassed }',
  );
  expect(await n.report(first!, n.replayed())).toEqual({ accepted: true });
  expect(n.mcp.calls.filter((c) => /pull_request/.test(c.tool))).toEqual([]);
  expect(n.comments).toEqual([]);
});

test("the built-in judge reads the replay through factory_run, compares it with the merged PR, and its score counts for the replay's factory commit", async () => {
  const n = await benchFactory();
  const commit = n.candidate(BRANCH, "Candidate guidance.");
  await n.command("bench", "--ref", BRANCH, "--items", "1");
  await n.dispatch();
  const replay = n.replays()[0]!;
  expect(await n.report(replay, n.replayed("diff --git a/save.ts b/save.ts"))).toEqual({ accepted: true });

  const judge = n.judgeOf(replay);
  expect(judge).toMatchObject({ state: "queued", configCommit: commit, checked: { run: replay.id, scorer: "bench" } });
  await n.dispatch();
  const launch = n.mcp.calls.find((c) => c.tool === "t3_thread_launch" && c.args.clientRequestId === judge.id)!;
  expect(launch.args.workspaceStrategy).toMatchObject({ baseRef: n.base, startFromOrigin: false });
  const brief = n.messages.find((m) => m.thread === runs.get(n.s, judge.id)!.threadId)!;
  expect(brief.pushUrl).toBe("no-push");
  expect(brief.text).toContain(`gh pr diff https://github.com/${n.repo}/pull/30`);
  expect(brief.text).toContain("`same-fix` (score 1)");

  const view = await n.call("factory_run", judge, { run: replay.id });
  expect(view).toMatchObject({
    kind: "replay",
    report: { result: { kind: "replay", patch: "diff --git a/save.ts b/save.ts", testsPassed: true } },
    checked: { issue: 10, prUrl: `https://github.com/${n.repo}/pull/30` },
  });

  expect((await n.report(judge, n.graded("great"))).error).toContain(
    "great is not one of bench's labels: same-fix, other-fix, partial, wrong",
  );
  expect(await n.report(judge, n.graded("other-fix"))).toEqual({ accepted: true });
  expect(scores.forRun(n.s, replay.id)).toEqual([
    expect.objectContaining({ scorer: "bench", label: "other-fix", score: 0.75, passed: true, judgeRun: judge.id }),
  ]);
  const board = await buildBoard(n.f, { includeWebhookUrls: false });
  expect(board.metrics.scorers).toEqual([
    { name: "bench", passRate: 1, runs: 1, byConfig: [{ commit, passRate: 1, runs: 1 }] },
  ]);
});

test("a branch with an open factory PR is compared with the current folder on the same issues, in one comment when every replay is judged", async () => {
  const n = await benchFactory();
  const commit = n.candidate(BRANCH, "Candidate guidance.");
  n.prs.set(BRANCH, 7);

  const out = await n.command("bench", "--ref", BRANCH, "--items", "2");
  expect(out.output.at(-1)).toContain("goes on https://github.com/acme/factory/pull/7");
  const side = (c: string) => n.replays().filter((r) => r.configCommit === c);
  expect(side(commit).map((r) => (r.checked as { issue: number }).issue)).toEqual([10, 14]);
  expect(side(n.commit).map((r) => (r.checked as { issue: number }).issue)).toEqual([10, 14]);
  await n.dispatch();

  const [c10, c14] = side(commit);
  const [b10, b14] = side(n.commit);
  await n.finish(c10!, "same-fix");
  await n.finish(c14!, "same-fix");
  await n.finish(b10!, "wrong");
  await n.benchLoop();
  expect(n.comments).toEqual([]);

  await n.finish(b14!, "other-fix");
  await n.benchLoop();
  await n.benchLoop();
  expect(n.comments).toHaveLength(1);
  const { path, body } = n.comments[0]!;
  expect(path).toBe("repos/acme/factory/issues/7/comments");
  const head = `This PR (\`${commit.slice(0, 7)}\`)`;
  const current = `Current (\`${n.commit.slice(0, 7)}\`)`;
  expect(body).toContain(`| Issue | Merged fix | ${head} | ${current} |`);
  expect(body).toContain(`| ${n.repo}#10 | ${n.repo}#30 | same-fix (1) | wrong (0) |`);
  expect(body).toContain(`| ${n.repo}#14 | ${n.repo}#33 | same-fix (1) | other-fix (0.75) |`);
  expect(body).toContain(`${head}: 2 of 2 passed, mean score 1.00`);
  expect(body).toContain(`${current}: 1 of 2 passed, mean score 0.38`);

  // Another learning PR, benched through the control API, reuses the current folder's judged replays.
  const second = n.candidate("factory/learn-run_2", "Other guidance.");
  n.prs.set("factory/learn-run_2", 8);
  const res = await n.api("/api/factory/bench", "POST", { ref: "factory/learn-run_2", items: 2 });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    candidate: second,
    baseline: n.commit,
    pr: "https://github.com/acme/factory/pull/8",
    replays: [
      { issue: 10, commit: second, reused: false },
      { issue: 10, commit: n.commit, run: b10!.id, reused: true },
      { issue: 14, commit: second, reused: false },
      { issue: 14, commit: n.commit, run: b14!.id, reused: true },
    ],
  });
  expect(side(n.commit)).toHaveLength(2);
});
