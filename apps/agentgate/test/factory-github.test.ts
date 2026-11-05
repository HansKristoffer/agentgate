import { afterAll, afterEach, expect, test } from "bun:test";
import type { FactoryReport, MarkerPayload } from "@agentgate/protocol";
import { buildBoard } from "../src/factory/board.ts";
import { writeBack } from "../src/factory/controller.ts";
import { items, runs, type FactoryRun } from "../src/factory/db.ts";
import * as gh from "../src/factory/gh.ts";
import { MARKER_PREFIX, parseMarkers } from "../src/factory/markers.ts";
import { host } from "../src/logins.ts";
import { removeTmp } from "./fixtures/git.ts";
import { factoryNode } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const realGh = host.gh;
type Answer = { ok: boolean; out: string } | undefined;
/** Stubs `host.gh` until the test ends, recording every call. */
function stubGh(answer: (args: string[], stdin?: string) => Answer) {
  const calls: { args: string[]; stdin?: string }[] = [];
  host.gh = async (args, stdin) => {
    calls.push({ args, ...(stdin !== undefined && { stdin }) });
    return answer(args, stdin);
  };
  cleanup.push(() => (host.gh = realGh));
  return calls;
}
const ok = (value: unknown): Answer => ({ ok: true, out: JSON.stringify(value) });
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

/** The login this machine's gh acts as: the factory's own account, which is also the maintainer's (D42). */
const FACTORY_LOGIN = "maintainer";

interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "OPEN" | "CLOSED";
  comments: { body: string; author: { login: string }; authorAssociation: string; createdAt: string }[];
}

/** GitHub for one repository, answering the gh commands gh.ts sends as the real gh does. */
function fakeGitHub(repo: string) {
  const issues = new Map<number, Issue>();
  const github: {
    issues: typeof issues;
    /** A failure for gh commands that match, as gh shows one: a non-zero exit and GitHub's answer, if any, on stdout. */
    fail?: (args: string[]) => Answer;
    add(number: number, patch?: Partial<Issue>): void;
    calls: ReturnType<typeof stubGh>;
  } = {
    issues,
    add(number, patch = {}) {
      issues.set(number, {
        number,
        title: `Issue ${number}`,
        body: `Steps for ${number}`,
        labels: ["factory"],
        state: "OPEN",
        comments: [],
        ...patch,
      });
    },
    calls: stubGh((args, stdin): Answer => {
      const failed = github.fail?.(args);
      if (failed) return failed;
      const url = (i: Issue) => `https://github.com/${repo}/issues/${i.number}`;
      if (args[0] === "issue" && args[1] === "list")
        return ok(
          [...issues.values()]
            // gh lists open issues unless --state says otherwise.
            .filter((i) => (args.includes("--state") && flag(args, "--state") !== "open") || i.state === "OPEN")
            .filter((i) => i.labels.includes(flag(args, "--label")!))
            .map((i) => ({ body: i.body, number: i.number, title: i.title, url: url(i) })),
        );
      if (args[0] === "issue" && args[1] === "view") {
        const i = issues.get(Number(args[2]))!;
        return ok(flag(args, "--json") === "state" ? { state: i.state } : { comments: i.comments });
      }
      if (args[0] === "api" && args[1] === "user") return ok({ login: FACTORY_LOGIN });
      const comment = args[1]?.match(/^repos\/.+\/issues\/(\d+)\/comments$/);
      if (args[0] === "api" && comment) {
        const { body } = JSON.parse(stdin!);
        issues
          .get(Number(comment[1]))!
          .comments.push({
            body,
            author: { login: FACTORY_LOGIN },
            authorAssociation: "OWNER",
            createdAt: "2026-11-05",
          });
        return ok({ id: 1, html_url: `https://github.com/${repo}/issues/${comment[1]}#issuecomment-1` });
      }
      throw new Error(`the fake GitHub has no answer for gh ${args.join(" ")}`);
    }),
  };
  return github;
}

const source = (repo: string, id = "bugs", label = "factory") => ({ id, type: "github", repo, label });

async function githubFactory(sources = (repo: string) => [source(repo)]) {
  const n = await factoryNode(cleanup, { config: (repo) => ({ limits: { threads: 20 }, sources: sources(repo) }) });
  const github = fakeGitHub(n.repo);
  const builtin = (await n.ctx.gateway.builtin!()).client;
  /** factory_report from the run's own T3 thread, as the shim forwards it. */
  const report = async (run: FactoryRun, body: Omit<FactoryReport, "run">) => {
    const result = await builtin.callTool({
      name: "factory_report",
      arguments: { run: run.id, ...body },
      _meta: { "dev.agentgate/t3Thread": run.threadId },
    });
    return JSON.parse((result.content as { text: string }[])[0]!.text);
  };
  const posts = () => github.calls.filter((c) => c.args[0] === "api");
  return { ...n, github, report, posts };
}

const triaged = {
  outcome: "done",
  summary: "Reproduced it.",
  result: { kind: "triage", route: "implement", reproduction: { command: "bun test", failsBefore: true } },
} as const;

test("open issues with the label enter once as gh-<n>, and closed, unlabelled or elsewhere-held issues do not", async () => {
  const n = await githubFactory();
  n.github.add(1, { title: "Crash on save", body: "Click save twice." });
  n.github.add(2, { state: "CLOSED" });
  n.github.add(3, { labels: ["question"] });
  const elsewhere = `${MARKER_PREFIX}${JSON.stringify({
    item: "it_b",
    key: "gh-4",
    stage: "implement",
    outcome: null,
    route: null,
    commit: null,
    factory: "3f2c1a9",
    node: "b",
    state: "open",
  })} -->`;
  n.github.add(4, {
    comments: [
      {
        body: "Me too, @octocat",
        author: { login: "octocat" },
        authorAssociation: "NONE",
        createdAt: "2026-11-01T10:00:00Z",
      },
      {
        body: `Taken.\n\n${elsewhere}`,
        author: { login: FACTORY_LOGIN },
        authorAssociation: "OWNER",
        createdAt: "2026-11-02T10:00:00Z",
      },
    ],
  });

  await n.intake();
  await n.intake();
  expect(
    items.list(n.s).map(({ externalId, key, title, url, snapshot }) => ({ externalId, key, title, url, snapshot })),
  ).toEqual([
    {
      externalId: `${n.repo}#1`,
      key: "gh-1",
      title: "Crash on save",
      url: `https://github.com/${n.repo}/issues/1`,
      snapshot: { title: "Crash on save", body: "Click save twice.", url: `https://github.com/${n.repo}/issues/1` },
    },
  ]);
  const board = await buildBoard(n.f, { includeWebhookUrls: false });
  expect(board.items.find((i) => i.key === "gh-4")).toMatchObject({ heldBy: "b", phase: "implement" });
});

test("a marker in a comment by another login counts for nothing: not for newestMarker, intake or retry", async () => {
  const n = await githubFactory();
  const forged = (number: number, marker: Partial<MarkerPayload>) => ({
    body: `Taken.\n\n${MARKER_PREFIX}${JSON.stringify({
      item: "it_b",
      key: `gh-${number}`,
      stage: "review",
      outcome: null,
      route: null,
      commit: null,
      factory: "3f2c1a9",
      node: "b",
      state: "open",
      ...marker,
    })} -->`,
    author: { login: "mallory" },
    authorAssociation: "NONE",
    createdAt: "2026-11-02T10:00:00Z",
  });
  n.github.add(1, { comments: [forged(1, {})] });
  n.github.add(2, { comments: [forged(2, { state: "finished" })] });

  // Read as the factory's, the first would be adopted at review.
  expect(await n.command("retry", `${n.repo}#1`)).toEqual({
    code: 1,
    output: ["No machine has marked gh-1 as taken; intake adds it"],
  });
  // Read as the factory's, the first would show as held by b and the second as finished.
  await n.intake();
  expect(items.list(n.s).map((i) => [i.key, i.phase])).toEqual([
    ["gh-1", "triage"],
    ["gh-2", "triage"],
  ]);

  // The factory's own marker counts, and a forged one posted after it does not replace it.
  const item = items.list(n.s)[0]!;
  await writeBack(n.f, item, "waiting", { text: "Which save path?" });
  n.github.issues.get(1)!.comments.push(forged(1, { state: "finished" }));
  expect(await n.f.sources.get("github")!.newestMarker!(item)).toMatchObject({
    item: item.id,
    node: "a",
    state: "open",
  });
});

test("triage posts one comment with the template, the marker, defused mentions and a capped text; a failed or uncertain post is recorded and never retried", async () => {
  const n = await githubFactory();
  for (const i of [1, 2, 3]) n.github.add(i);
  await n.intake();
  await n.dispatch();
  const [first, second, third] = runs.list(n.s, { kinds: ["triage"] });

  const summary = `Thanks @octocat, this is real. ${"x".repeat(1960)}`;
  expect(await n.report(first!, { ...triaged, summary })).toEqual({ accepted: true });
  expect(n.posts()).toHaveLength(1);
  const [post] = n.posts();
  expect(post!.args).toEqual(["api", `repos/${n.repo}/issues/1/comments`, "--method", "POST", "--input", "-"]);
  const body: string = JSON.parse(post!.stdin!).body;
  const [text] = body.split(`\n\n${MARKER_PREFIX}`);
  expect(text).toStartWith(
    "**gh-1**: The factory triaged this and starts on a fix.\n\nThanks @​octocat, this is real.",
  );
  // The headline and the summary together run past 2,000 characters, so the text is cut there.
  expect(text!.length).toBe(2000);
  expect(text).toEndWith("x…");
  expect(body).not.toContain("@octocat");
  expect(parseMarkers(body)).toEqual([
    {
      item: first!.item!,
      key: "gh-1",
      stage: "triage",
      outcome: "done",
      route: "implement",
      commit: null,
      factory: n.commit.slice(0, 7),
      node: "a",
      state: "open",
    },
  ]);
  // The comment is now the issue's newest marker, so another machine would leave the issue to this one.
  expect(await n.f.sources.get("github")!.newestMarker!(items.get(n.s, first!.item!)!)).toMatchObject({
    node: "a",
    state: "open",
  });

  // GitHub refused the second; the third got no answer at all, so it may exist.
  n.github.fail = (args) =>
    args[1]?.endsWith("/2/comments")
      ? { ok: false, out: JSON.stringify({ message: "Validation Failed", status: "422" }) }
      : args[1]?.endsWith("/3/comments")
        ? { ok: false, out: "" }
        : undefined;
  await n.report(second!, triaged);
  await n.report(third!, triaged);
  const writebacks = n.s.db.query("select status from factory_writebacks order by status").all();
  expect(writebacks).toEqual([{ status: "failed" }, { status: "posted" }, { status: "uncertain" }]);
  const texts = n.f.events.recent(50).map((e) => e.text);
  expect(texts).toContain(
    `The triaged comment on gh-2: failed (GitHub refused to comment on ${n.repo}#2: Validation Failed)`,
  );
  expect(texts).toContain(
    `The triaged comment on gh-3: uncertain (gh could not comment on ${n.repo}#3, and GitHub gave no answer)`,
  );

  n.github.fail = undefined;
  for (const run of [first!, second!, third!])
    expect(await writeBack(n.f, items.get(n.s, run.item!)!, "triaged")).toBe("skipped");
  expect(n.posts()).toHaveLength(3);
});

test("the issue is re-checked before every stage, and one closed on GitHub closes its item without a comment", async () => {
  const n = await githubFactory();
  n.github.add(1);
  n.github.add(2);
  const implementLaunches: string[] = [];
  n.f.runKinds.set("implement", {
    kind: "implement",
    launch: async (_run, item) => {
      implementLaunches.push(item!.key);
      return {
        repo: item!.repo,
        title: "Implement",
        brief: "Fix it.",
        baseRef: "main",
        branch: `factory/${item!.key}`,
        startFromOrigin: true,
      };
    },
    validate: async () => undefined,
    accept: async () => {},
  });
  const stateChecks = () => n.github.calls.filter((c) => c.args[1] === "view" && flag(c.args, "--json") === "state");

  await n.intake();
  n.github.issues.get(2)!.state = "CLOSED";
  await n.dispatch();
  expect(stateChecks().map((c) => c.args[2])).toEqual(["1", "2"]);
  const [one, two] = items.list(n.s);
  expect(two!.phase).toBe("closed");
  expect(runs.list(n.s, { kinds: ["triage"] }).map((r) => [r.item, r.state])).toEqual([
    [one!.id, "running"],
    [two!.id, "cancelled"],
  ]);

  await n.report(runs.forItem(n.s, one!.id)[0]!, triaged);
  expect(items.get(n.s, one!.id)!.phase).toBe("implement");
  n.github.issues.get(1)!.state = "CLOSED";
  await n.dispatch();
  expect(stateChecks().map((c) => c.args[2])).toEqual(["1", "2", "1"]);
  expect(items.get(n.s, one!.id)!.phase).toBe("closed");
  expect(implementLaunches).toEqual(["gh-1"]);
  expect(runs.list(n.s, { kinds: ["implement"] }).map((r) => r.state)).toEqual(["cancelled"]);
  // Only the triaged comment: the issue already says it is closed.
  expect(n.posts()).toHaveLength(1);
});

test("a failing gh shows on its source's row and backs off, while the other source keeps polling", async () => {
  const n = await githubFactory((repo) => [source(repo), source(repo, "broken", "urgent")]);
  n.github.add(1);
  n.github.fail = (args) =>
    args[1] === "list" && flag(args, "--label") === "urgent" ? { ok: false, out: "" } : undefined;
  const polled = () => n.github.calls.filter((c) => c.args[1] === "list").map((c) => flag(c.args, "--label"));

  await n.intake();
  n.advance(60_000);
  await n.intake();
  expect(polled()).toEqual(["factory", "urgent", "factory"]);
  const rows = (await buildBoard(n.f, { includeWebhookUrls: false })).sources;
  expect(rows.find((r) => r.id === "broken")).toEqual({
    id: "broken",
    type: "github",
    repo: n.repo,
    error: `gh could not list the open issues labelled "urgent" in ${n.repo}: check gh auth status on this machine`,
  });
  expect(rows.find((r) => r.id === "bugs")).toMatchObject({ lastPollAt: n.s.now() });

  n.github.fail = undefined;
  n.advance(2 * 60_000);
  await n.intake();
  expect(polled().at(-1)).toBe("urgent");
  expect((await buildBoard(n.f, { includeWebhookUrls: false })).sources.find((r) => r.id === "broken")!.error).toBe(
    undefined,
  );
});

// ---- gh.ts against recorded gh output (gh 2.102, trimmed)

const REPO = "acme/app";
const PR = `https://github.com/${REPO}/pull/42`;

const recorded = {
  repoView: { defaultBranchRef: { name: "trunk" } },
  issueList: [
    { body: "\n### Describe the bug\n", number: 7, title: "Crash on save", url: `https://github.com/${REPO}/issues/7` },
  ],
  issueComments: {
    comments: [
      {
        id: "IC_kwDODKw3uc8AAAABLBWqZg",
        author: { login: "babakks" },
        authorAssociation: "MEMBER",
        body: "Thanks for reporting this, @S-zhi!",
        createdAt: "2026-07-21T13:23:07Z",
        includesCreatedEdit: false,
        isMinimized: false,
        minimizedReason: "",
        reactionGroups: [],
        url: `https://github.com/${REPO}/issues/7#issuecomment-5034584678`,
        viewerDidAuthor: false,
      },
    ],
  },
  prView: {
    author: { id: "MDQ6VXNlcjQ3Mzk0MjAw", is_bot: false, login: "BagToad", name: "Kynan Ware" },
    baseRefName: "trunk",
    body: "Fixes #7",
    comments: [],
    files: [{ path: "pkg/cmd/api/api.go", additions: 4, deletions: 2, changeType: "MODIFIED" }],
    headRefName: "bagtoad/gh-help-environment-fix",
    headRefOid: "f44bd1dcc58a718327a4d1df89ea3d1145c827b2",
    isDraft: false,
    mergeable: "UNKNOWN",
    mergedAt: "2026-11-03T17:40:14Z",
    number: 42,
    reviews: [
      {
        id: "PRR_kwDODKw3uc8AAAABVyGoqg",
        author: { login: "babakks" },
        authorAssociation: "MEMBER",
        body: "",
        submittedAt: "2026-11-03T17:32:31Z",
        includesCreatedEdit: false,
        reactionGroups: [],
        state: "APPROVED",
        commit: { oid: "f44bd1dcc58a718327a4d1df89ea3d1145c827b2" },
      },
    ],
    state: "MERGED",
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        completedAt: "2026-11-03T17:32:33Z",
        conclusion: "SUCCESS",
        detailsUrl: "https://github.com/cli/cli/actions/runs/41684918597/job/126088020830",
        name: "lint",
        startedAt: "2026-11-03T17:30:40Z",
        status: "COMPLETED",
        workflowName: "Lint",
      },
    ],
    title: "Clarify which hosts use GH_ENTERPRISE_TOKEN",
    url: PR,
  },
  runList: [
    { conclusion: "success", headSha: "eeb44bc", status: "completed", workflowName: "Lint" },
    { conclusion: "success", headSha: "eeb44bc", status: "completed", workflowName: "Unit and Integration Tests" },
    { conclusion: "failure", headSha: "0ld5ha", status: "completed", workflowName: "Lint" },
  ],
  revertList: [
    {
      body: "## Description\r\n\r\nReverts acme/app#42\r\n",
      mergedAt: "2026-11-10T14:11:21Z",
      number: 50,
      title: 'Revert "Use internal Apple codesign action"',
    },
  ],
  closedBy: (after: string | null) => ({
    data: {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: !after, endCursor: after ? null : "Y3Vyc29yOnYy" },
          nodes: [
            {
              number: after ? 40 : 41,
              url: `https://github.com/${REPO}/pull/${after ? 40 : 41}`,
              mergedAt: "2026-11-03T17:40:14Z",
              baseRefOid: "c4513d446bf98cfcbe72ed83f17cd3220174d88f",
              headRefName: after ? "dependabot/bun/hono-4.10.4" : "bagtoad/gh-help-environment-fix",
              author: after ? { __typename: "Bot", login: "dependabot" } : { __typename: "User", login: "BagToad" },
              closingIssuesReferences: { nodes: [{ number: after ? 5 : 6, title: "Bug", body: "Steps" }] },
            },
            {
              number: 39,
              url: `https://github.com/${REPO}/pull/39`,
              mergedAt: "2026-11-02T00:25:42Z",
              baseRefOid: "9c399f1520a45f1bffb968d7d6565ea4112937fa",
              headRefName: "patch-1",
              author: null,
              closingIssuesReferences: { nodes: [] },
            },
          ],
        },
      },
    },
  }),
};

/** Answers by gh subcommand, as recorded; `api` answers by path. */
function recordedGh(overrides: Record<string, unknown> = {}) {
  const answers: Record<string, (args: string[]) => unknown> = {
    "repo view": () => recorded.repoView,
    "issue list": () => recorded.issueList,
    "issue view": (args) => (flag(args, "--json") === "state" ? { state: "OPEN" } : recorded.issueComments),
    "pr view": (args) => (flag(args, "--json") === "author" ? { author: recorded.prView.author } : recorded.prView),
    "run list": () => recorded.runList,
    "pr list": () => recorded.revertList,
    "api graphql": (args) => recorded.closedBy(args.find((a) => a.startsWith("after="))?.slice(6) ?? null),
  };
  return stubGh((args) => {
    const key = `${args[0]} ${args[1]}`;
    if (key in overrides) return { ok: true, out: JSON.stringify(overrides[key]) };
    const answer = answers[key];
    return answer ? ok(answer(args)) : { ok: true, out: "" };
  });
}

test("each gh.ts read parses a recorded gh answer", async () => {
  recordedGh();
  expect(await gh.defaultBranch(REPO)).toBe("trunk");
  expect(await gh.openLabelledIssues(REPO, "factory")).toEqual(recorded.issueList);
  expect(await gh.issueState(REPO, 7)).toBe("OPEN");
  expect(await gh.issueComments(REPO, 7)).toEqual([
    {
      body: "Thanks for reporting this, @S-zhi!",
      author: "babakks",
      authorAssociation: "MEMBER",
      createdAt: "2026-07-21T13:23:07Z",
    },
  ]);
  expect(await gh.prView(PR)).toEqual({
    number: 42,
    url: PR,
    title: "Clarify which hosts use GH_ENTERPRISE_TOKEN",
    state: "MERGED",
    isDraft: false,
    author: "BagToad",
    headRefName: "bagtoad/gh-help-environment-fix",
    headRefOid: "f44bd1dcc58a718327a4d1df89ea3d1145c827b2",
    baseRefName: "trunk",
    mergedAt: "2026-11-03T17:40:14Z",
    checks: "passing",
    mergeable: "UNKNOWN",
    body: "Fixes #7",
    files: ["pkg/cmd/api/api.go"],
    comments: [],
    reviews: [{ body: "", authorAssociation: "MEMBER", submittedAt: "2026-11-03T17:32:31Z", state: "APPROVED" }],
  });
  expect(await gh.defaultBranchCi(REPO)).toBe("passing");
  expect(await gh.mergedRevertOf(REPO, { number: 42, title: "Speed up save", mergedAt: "2026-11-03T17:40:14Z" })).toBe(
    true,
  );
  expect(await gh.closedByMergedPr(REPO, 10)).toEqual([
    {
      issue: 6,
      title: "Bug",
      body: "Steps",
      pr: 41,
      prUrl: `https://github.com/${REPO}/pull/41`,
      baseSha: "c4513d446bf98cfcbe72ed83f17cd3220174d88f",
      headRefName: "bagtoad/gh-help-environment-fix",
      author: "BagToad",
      mergedAt: "2026-11-03T17:40:14Z",
    },
    {
      issue: 5,
      title: "Bug",
      body: "Steps",
      pr: 40,
      prUrl: `https://github.com/${REPO}/pull/40`,
      baseSha: "c4513d446bf98cfcbe72ed83f17cd3220174d88f",
      headRefName: "dependabot/bun/hono-4.10.4",
      // GraphQL names bots without the suffix gh and REST use.
      author: "dependabot[bot]",
      mergedAt: "2026-11-03T17:40:14Z",
    },
  ]);

  const calls = recordedGh({ "pr list": [{ number: 43, url: `https://github.com/${REPO}/pull/43` }] });
  expect(await gh.openPrForHead(REPO, "factory/learn-run_1")).toEqual({
    number: 43,
    url: `https://github.com/${REPO}/pull/43`,
  });
  expect([flag(calls[0]!.args, "--head"), flag(calls[0]!.args, "--state")]).toEqual(["factory/learn-run_1", "open"]);
  recordedGh({ "pr list": [] });
  expect(await gh.openPrForHead(REPO, "factory/learn-run_1")).toBeUndefined();
});

test("each gh.ts read rejects a malformed answer with an error naming the repository", async () => {
  const reads: [string, () => Promise<unknown>][] = [
    ["repo view", () => gh.defaultBranch(REPO)],
    ["issue list", () => gh.openLabelledIssues(REPO, "factory")],
    ["issue view", () => gh.issueState(REPO, 7)],
    ["issue view", () => gh.issueComments(REPO, 7)],
    ["pr view", () => gh.prView(PR)],
    ["pr view", () => gh.prAddReviewers(PR, ["octocat"])],
    ["run list", () => gh.defaultBranchCi(REPO)],
    ["pr list", () => gh.mergedRevertOf(REPO, { number: 42, title: "x", mergedAt: "2026-11-03T17:40:14Z" })],
    ["pr list", () => gh.openPrForHead(REPO, "factory/learn-run_1")],
    ["api graphql", () => gh.closedByMergedPr(REPO, 10)],
  ];
  for (const [command, read] of reads) {
    recordedGh({ [command]: { surprise: [{ number: "seven" }] } });
    await expect(read()).rejects.toThrow(REPO);
    // Not JSON at all, as when gh prints a table.
    stubGh(() => ({ ok: true, out: "7\tCrash on save\tOPEN" }));
    await expect(read()).rejects.toThrow(REPO);
  }
  stubGh(() => undefined);
  await expect(gh.defaultBranch(REPO)).rejects.toThrow(
    `gh is not installed, so the factory cannot read the default branch of ${REPO}`,
  );
  await expect(gh.prView("https://example.com/pull/1")).rejects.toThrow("is not a GitHub pull request URL");
});

test("PR checks sum up to failing over pending over passing, and a merged PR with a revert in 14 days is reverted", async () => {
  const run = (status: string, conclusion: string | null) => ({ __typename: "CheckRun", status, conclusion });
  const checks = async (rollup: unknown[]) => {
    recordedGh({ "pr view": { ...recorded.prView, statusCheckRollup: rollup } });
    return (await gh.prView(PR)).checks;
  };
  expect(await checks([])).toBe("none");
  expect(await checks([run("COMPLETED", "SUCCESS"), run("COMPLETED", "SKIPPED")])).toBe("passing");
  expect(await checks([run("COMPLETED", "SUCCESS"), run("IN_PROGRESS", null)])).toBe("pending");
  expect(await checks([run("IN_PROGRESS", null), { __typename: "StatusContext", state: "ERROR" }])).toBe("failing");
  expect(await checks([{ __typename: "StatusContext", state: "PENDING" }])).toBe("pending");

  const ci = async (list: unknown[]) => {
    const calls = recordedGh({ "run list": list });
    const result = await gh.defaultBranchCi(REPO);
    const runList = calls.find((c) => c.args[0] === "run")!.args;
    expect([flag(runList, "--branch"), flag(runList, "--event")]).toEqual(["trunk", "push"]);
    return result;
  };
  expect(await ci([])).toBe("none");
  expect(await ci([{ headSha: "new", status: "in_progress", conclusion: "" }, ...recorded.runList])).toBe("pending");
  expect(await ci([{ headSha: "new", status: "completed", conclusion: "failure" }, ...recorded.runList])).toBe(
    "failing",
  );

  const reverted = async (revert: Partial<(typeof recorded.revertList)[number]>) => {
    recordedGh({ "pr list": [{ ...recorded.revertList[0], ...revert }] });
    return gh.mergedRevertOf(REPO, { number: 42, title: "Speed up save", mergedAt: "2026-11-03T17:40:14Z" });
  };
  expect(await reverted({ body: "", title: 'Revert "Speed up save"' })).toBe(true);
  expect(await reverted({ body: "Reverts acme/app#421" })).toBe(false);
  expect(await reverted({ title: "Undo the codesign action" })).toBe(false);
  expect(await reverted({ mergedAt: "2026-11-18T17:40:14Z" })).toBe(false);
});

test("gh.ts writes: refused or unsent posts fail, line-less review findings join the body, and review requests skip the PR's author", async () => {
  stubGh(() => undefined);
  expect(await gh.postIssueComment(REPO, 7, "Hello")).toEqual({
    status: "failed",
    error: `gh is not installed, so the factory cannot comment on ${REPO}#7`,
  });

  let calls = stubGh(() => ({ ok: false, out: JSON.stringify({ message: "Unprocessable Entity", status: "422" }) }));
  const review = await gh.postPrReview(PR, {
    commit: "f44bd1d",
    body: "Two findings.",
    comments: [
      { path: "src/a.ts", line: 12, body: "Off by one." },
      { path: "README.md", body: "Describe the flag." },
    ],
  });
  expect(review).toEqual({ status: "failed", error: `GitHub refused to review ${REPO}#42: Unprocessable Entity` });
  expect(calls[0]!.args[1]).toBe(`repos/${REPO}/pulls/42/reviews`);
  expect(JSON.parse(calls[0]!.stdin!)).toEqual({
    commit_id: "f44bd1d",
    event: "COMMENT",
    body: "Two findings.\n\n**README.md**: Describe the flag.",
    comments: [{ path: "src/a.ts", line: 12, side: "RIGHT", body: "Off by one." }],
  });

  calls = recordedGh();
  await gh.prAddReviewers(PR, ["bagtoad", "octocat"]);
  expect(calls.at(-1)!.args).toEqual(["pr", "edit", PR, "--add-reviewer", "octocat"]);
  calls = recordedGh();
  await gh.prAddReviewers(PR, ["BagToad"]);
  expect(calls.map((c) => c.args[1])).toEqual(["view"]);

  calls = recordedGh();
  await gh.prSetBody(PR, "Fixes #7");
  await gh.prReady(PR);
  expect(calls).toEqual([
    { args: ["pr", "edit", PR, "--body-file", "-"], stdin: "Fixes #7" },
    { args: ["pr", "ready", PR] },
  ]);
  stubGh(() => ({ ok: false, out: "" }));
  await expect(gh.prReady(PR)).rejects.toThrow(`gh could not mark ${REPO}#42 ready for review`);
});
