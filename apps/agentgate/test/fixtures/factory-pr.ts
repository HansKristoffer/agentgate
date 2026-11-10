import type { FactoryReport } from "@agentgate/protocol";
import { items, runs, type FactoryItem, type FactoryRun } from "../../src/factory/db.ts";
import { loopTask } from "../../src/factory/runtime.ts";
import { host, type GhAnswer } from "../../src/logins.ts";
import { factoryNode, idle } from "./t3-mcp.ts";

type Answer = GhAnswer | undefined;
const ok = (value: unknown): Answer => ({ ok: true, out: JSON.stringify(value) });
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
const sha = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");

type Comment = { body: string; author?: { login: string }; authorAssociation: string; createdAt: string };
/** A review conversation, in GraphQL's field names; `bot` stands for an author whose __typename is Bot. */
export interface FakeConversation {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  viewerCanResolve: boolean;
  comments: { body: string; createdAt: string; authorAssociation: string; bot?: boolean }[];
}
export interface FakePr {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  author: string;
  headRefName: string;
  headRefOid: string;
  checks: "pending" | "passing" | "failing" | "none";
  /** Named check runs at the head, by conclusion (null while running), in place of `checks`. */
  checkRuns?: Record<string, string | null>;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  body: string;
  comments: Comment[];
  reviews: { body: string; authorAssociation: string; submittedAt: string; state: string; bot?: boolean }[];
  conversations: FakeConversation[];
  reviewers: string[];
}

const ROLLUP = {
  none: {},
  passing: { test: "SUCCESS" },
  failing: { test: "FAILURE" },
  pending: { test: null },
};
/** A commit's checks as GraphQL answers `contexts(first: 100)`: one page, and whether there are more. */
const checkRuns = (runs: Record<string, string | null>) => ({
  nodes: Object.entries(runs)
    .slice(0, 100)
    .map(([name, conclusion]) => ({
      __typename: "CheckRun",
      name,
      status: conclusion ? "COMPLETED" : "IN_PROGRESS",
      conclusion,
    })),
  pageInfo: { hasNextPage: Object.keys(runs).length > 100 },
});

/** GitHub for one repository with default branch `main`, answering the gh commands gh.ts sends in the shapes gh 2.102
 * prints: labelled issues and their comments, pull requests, and the default branch's checks. */
function fakeGitHub(repo: string, cleanup: (() => unknown)[]) {
  const issues = new Map<number, { title: string; state: "OPEN" | "CLOSED"; comments: Comment[] }>();
  const prs = new Map<string, FakePr>();
  const calls: { args: string[]; stdin?: string }[] = [];
  const github = {
    issues,
    prs,
    calls,
    /** The checks `main` requires to merge, and the check runs at its newest commit. */
    required: [] as string[],
    mainChecks: {} as Record<string, string | null>,
    /** How many of the next replies and resolves GitHub refuses. */
    refuse: { reply: 0, resolve: 0 },
    /** Issues the factory opened, kept apart from \`issues\`: they carry no label, so intake never lists them. */
    filed: [] as { repo: string; title: string; body: string }[],
    addIssue(number: number) {
      issues.set(number, { title: `Issue ${number}`, state: "OPEN", comments: [] });
    },
    /** The draft PR an implement thread opens from `branch`. */
    openPr(number: number, branch: string, patch: Partial<FakePr> = {}) {
      const url = `https://github.com/${repo}/pull/${number}`;
      const pr: FakePr = {
        number,
        url,
        state: "OPEN",
        isDraft: true,
        author: "maintainer",
        headRefName: branch,
        headRefOid: sha(),
        checks: "pending",
        mergeable: "MERGEABLE",
        body: "Fixes #1",
        comments: [],
        reviews: [],
        conversations: [],
        reviewers: [],
        ...patch,
      };
      prs.set(url, pr);
      return pr;
    },
    /** The factory's comments on an issue, by the headline after the item key. */
    posted: (number: number) =>
      issues.get(number)!.comments.map((c) => c.body.split("\n")[0]!.replace(/^\*\*.+?\*\*: /, "")),
  };
  const realGh = host.gh;
  host.gh = async (args, stdin) => {
    calls.push({ args, ...(stdin !== undefined && { stdin }) });
    const [command, sub] = args;
    if (command === "repo" && sub === "view") return ok({ defaultBranchRef: { name: "main" } });
    if (command === "issue" && sub === "list")
      return ok(
        [...issues]
          .filter(([, i]) => i.state === "OPEN")
          // gh lists no more than --limit.
          .slice(0, Number(flag(args, "--limit")))
          .map(([number, i]) => ({
            number,
            title: i.title,
            body: "",
            url: `https://github.com/${repo}/issues/${number}`,
          })),
      );
    if (command === "issue" && sub === "view") {
      const issue = issues.get(Number(args[2]))!;
      return ok({ state: issue.state, comments: issue.comments.map((c, i) => ({ id: `IC_${args[2]}_${i}`, ...c })) });
    }
    // The factory acts as the maintainer's own login (D42).
    if (command === "api" && sub === "user") return ok({ login: "maintainer" });
    const comment = sub?.match(/^repos\/.+\/issues\/(\d+)\/comments$/);
    if (command === "api" && comment) {
      const { body } = JSON.parse(stdin!);
      issues
        .get(Number(comment[1]))!
        .comments.push({ body, author: { login: "maintainer" }, authorAssociation: "OWNER", createdAt: "2026-11-05" });
      return ok({ id: 1 });
    }
    const filed = sub?.match(/^repos\/(.+)\/issues$/);
    if (command === "api" && filed) {
      const { title, body } = JSON.parse(stdin!);
      github.filed.push({ repo: filed[1]!, title, body });
      return ok({ number: 100 + github.filed.length });
    }
    if (command === "api" && sub === "graphql") return graphql(args);
    const pr = prs.get(args[2]!);
    if (command === "pr" && pr) {
      if (sub === "view" && flag(args, "--json") === "author") return ok({ author: { login: pr.author } });
      if (sub === "view")
        return ok({
          number: pr.number,
          url: pr.url,
          title: "Fix it",
          state: pr.state,
          isDraft: pr.isDraft,
          author: { login: pr.author },
          headRefName: pr.headRefName,
          headRefOid: pr.headRefOid,
          baseRefName: "main",
          mergedAt: pr.state === "MERGED" ? "2026-11-05T12:00:00Z" : null,
          mergeable: pr.mergeable,
          body: pr.body,
          comments: pr.comments,
        });
      if (sub === "ready") {
        pr.isDraft = false;
        return { ok: true, out: "" };
      }
      if (sub === "edit" && args.includes("--body-file")) {
        pr.body = stdin!;
        return { ok: true, out: "" };
      }
      if (sub === "edit" && args.includes("--add-reviewer")) {
        pr.reviewers.push(...flag(args, "--add-reviewer")!.split(","));
        return { ok: true, out: "" };
      }
    }
    throw new Error(`the fake GitHub has no answer for gh ${args.join(" ")}`);
  };
  cleanup.push(() => (host.gh = realGh));

  const author = (bot?: boolean) => ({ __typename: bot ? "Bot" : "User" });
  /** `main`'s rules as GraphQL has them: the required checks as a ruleset's, beside a rule without parameters. */
  const requiring = () => ({
    refUpdateRule: null,
    rules: {
      nodes: [
        { parameters: null },
        ...(github.required.length
          ? [{ parameters: { requiredStatusChecks: github.required.map((context) => ({ context })) } }]
          : []),
      ],
    },
  });
  /** `gh api graphql`: the reviews read, and the reply and resolve mutations. */
  function graphql(args: string[]): Answer {
    const vars = Object.fromEntries(
      args.flatMap((a, i) =>
        args[i - 1] === "-f" || args[i - 1] === "-F" ? [[a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]] : [],
      ),
    ) as Record<string, string>;
    const feedback = (pr: FakePr) => ({
      reviews: { nodes: pr.reviews.map(({ bot, ...r }) => ({ ...r, author: author(bot) })) },
      reviewThreads: {
        nodes: pr.conversations.map(({ comments, line, ...c }) => ({
          ...c,
          line,
          originalLine: line,
          comments: { nodes: comments.map(({ bot, ...m }) => ({ ...m, state: "SUBMITTED", author: author(bot) })) },
        })),
      },
    });
    // The follower's read: one aliased pullRequest per followed PR.
    if (vars.query!.includes("fragment Followed")) {
      const numbers = [...vars.query!.matchAll(/p(\d+): pullRequest\(number: \d+\)/g)].map((m) => Number(m[1]));
      const repository = Object.fromEntries(
        numbers.map((number) => {
          const pr = [...prs.values()].find((p) => p.number === number);
          return [
            `p${number}`,
            pr && {
              number: pr.number,
              url: pr.url,
              title: "Fix it",
              state: pr.state,
              isDraft: pr.isDraft,
              author: { login: pr.author },
              headRefName: pr.headRefName,
              headRefOid: pr.headRefOid,
              baseRefName: "main",
              mergedAt: pr.state === "MERGED" ? "2026-11-05T12:00:00Z" : null,
              mergeable: pr.mergeable,
              baseRef: requiring(),
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: { contexts: checkRuns(pr.checkRuns ?? ROLLUP[pr.checks]) },
                    },
                  },
                ],
              },
              comments: { nodes: pr.comments.map(({ author: _, ...c }) => c) },
              ...feedback(pr),
            },
          ];
        }),
      );
      return ok({ data: { repository } });
    }
    if (vars.query!.includes("defaultBranchRef")) {
      const target = { statusCheckRollup: { contexts: checkRuns(github.mainChecks) } };
      return ok({ data: { repository: { defaultBranchRef: { ...requiring(), target } } } });
    }
    if (vars.query!.includes("reviewThreads")) {
      const pr = [...prs.values()].find((p) => p.number === Number(vars.number))!;
      return ok({ data: { repository: { pullRequest: feedback(pr) } } });
    }
    const conversation = [...prs.values()].flatMap((p) => p.conversations).find((c) => c.id === vars.id)!;
    const refused = { ok: false, out: JSON.stringify({ errors: [{ message: "Something went wrong" }] }) };
    if (vars.query!.includes("addPullRequestReviewThreadReply")) {
      if (github.refuse.reply && github.refuse.reply--) return refused;
      conversation.comments.push({ body: vars.body!, createdAt: "2026-11-05T00:00:00Z", authorAssociation: "OWNER" });
      return ok({
        data: { addPullRequestReviewThreadReply: { comment: { id: `reply-${conversation.comments.length}` } } },
      });
    }
    if (vars.query!.includes("resolveReviewThread")) {
      if (github.refuse.resolve && github.refuse.resolve--) return refused;
      conversation.isResolved = true;
      return ok({ data: { resolveReviewThread: { thread: { isResolved: true } } } });
    }
    throw new Error(`the fake GitHub has no answer for this GraphQL query: ${vars.query}`);
  }
  return github;
}

export const triaged = {
  outcome: "done",
  summary: "Reproduced it.",
  result: { kind: "triage", route: "implement", reproduction: { command: "bun test", failsBefore: true } },
} as const;

/** The factory machine with one GitHub source on a fake GitHub, and helpers that walk an issue to its PR. */
export async function prFactory(
  cleanup: (() => unknown)[],
  config: (repo: string) => Record<string, unknown> = () => ({}),
  files: Record<string, string> = {},
) {
  const n = await factoryNode(cleanup, {
    config: (repo) => ({
      limits: { threads: 20 },
      sources: [{ id: "bugs", type: "github", repo, label: "factory" }],
      ...config(repo),
    }),
    files,
  });
  return withPr(n, fakeGitHub(n.repo, cleanup));
}

/** The node with its PR helpers; a restart keeps the fake GitHub and binds the helpers to the new daemon. */
async function withPr(n: Node, github: ReturnType<typeof fakeGitHub>): Promise<PrNode> {
  return { ...(await prHelpers(n, github)), restart: async () => withPr(await n.restart(), github) };
}
type PrNode = Awaited<ReturnType<typeof prHelpers>> & { restart(): Promise<PrNode> };

/** The PR helpers, bound to one daemon of the node. */
async function prHelpers({ restart: _restart, ...n }: Node, github: ReturnType<typeof fakeGitHub>) {
  const builtin = (await n.ctx.gateway.builtin!()).client;

  /** factory_report from the run's own T3 thread: `{ accepted: true }`, or the tool error's text. */
  const report = async (run: FactoryRun, body: Omit<FactoryReport, "run"> | Record<string, unknown>) => {
    const result = await builtin.callTool({
      name: "factory_report",
      arguments: { run: run.id, ...body },
      _meta: { "dev.agentgate/t3Thread": run.threadId },
    });
    const text = (result.content as { text: string }[])[0]!.text;
    await idle(n.f);
    return result.isError ? { error: text } : JSON.parse(text);
  };
  /** factory_pr_threads from the run's own T3 thread, or from `thread`: the answer, or the tool error's text. */
  const prThreads = async (run: FactoryRun, body: Record<string, unknown>, thread = run.threadId) => {
    const result = await builtin.callTool({
      name: "factory_pr_threads",
      arguments: { run: run.id, ...body },
      _meta: { "dev.agentgate/t3Thread": thread },
    });
    const text = (result.content as { text: string }[])[0]!.text;
    await idle(n.f);
    return result.isError ? { error: text } : JSON.parse(text);
  };
  const implementRuns = (item: FactoryItem) => runs.forItem(n.s, item.id).filter((r) => r.kind === "implement");

  /** Issue `number` entered, was triaged to implement, and its implement run was dispatched. */
  async function implementing(number: number) {
    github.addIssue(number);
    await n.intake();
    await n.dispatch();
    const item = items.byExternal(n.s, `${n.repo}#${number}`)!;
    await report(runs.forItem(n.s, item.id)[0]!, triaged);
    await n.dispatch();
    return { item, run: implementRuns(item)[0]! };
  }

  const done = (run: FactoryRun, pr: FakePr, result: Record<string, unknown> = {}) =>
    report(run, {
      outcome: "done",
      summary: "Fixed the crash.",
      result: {
        kind: "implement",
        prUrl: pr.url,
        commit: pr.headRefOid,
        // Written as sentences, the way agents do: the summary joins them without a doubled full stop.
        claims: [{ claim: "Saving twice no longer crashes.", evidence: "bun test test/save.test.ts passes" }],
        notChecked: ["Windows.", "Linux"],
        decisions: [
          { decision: "The save lock lives in memory, not on disk", confidence: "high" },
          { decision: "A second save waits for the first instead of failing", confidence: "low" },
        ],
        ...result,
      },
    });

  /** Issue `number` reached `pr` with an open draft PR. */
  async function opened(number: number, patch: Partial<FakePr> = {}) {
    const { item, run } = await implementing(number);
    const pr = github.openPr(100 + number, `factory/${item.key}`, { body: `Fixes #${number}`, ...patch });
    const answer = await done(run, pr);
    if (!answer.accepted) throw new Error(`the implement report was refused: ${answer.error}`);
    return { item: items.get(n.s, item.id)!, run: runs.get(n.s, run.id)!, pr };
  }

  const node = {
    ...n,
    github,
    /** The item key intake gives issue `number`: the repository's name and the number. */
    key: (number: number) => `${n.repo.split("/")[1]!.toLowerCase()}-${number}`,
    report,
    prThreads,
    done,
    implementing,
    opened,
    implementRuns,
    /** One pass of the PR follower, with what it left to post. */
    pollPrs: async () => {
      await loopTask(
        n.f,
        n.f.loops.find((l) => l.name === "factory-prs")!,
      )();
      await idle(n.f);
    },
    /** Messages the factory sent to a thread after launching it. */
    sent: (threadId: string) =>
      n.mcp.calls
        .filter((c) => c.tool === "t3_thread_send" && c.args.threadId === threadId)
        .map((c) => String(c.args.message)),
    /** Ends, starts or stops (`interrupted`) the thread's turn and waits until the mirror shows it. */
    async thread(threadId: string, status: "idle" | "running" | "interrupted") {
      n.mcp.setThread(threadId, { status });
      await n.until(() => n.mirror.thread(threadId)?.status === status, `the thread to be ${status}`);
    },
  };
  return node;
}
type Node = Awaited<ReturnType<typeof factoryNode>>;
