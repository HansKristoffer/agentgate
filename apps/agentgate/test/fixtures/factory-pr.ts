import type { FactoryReport } from "@agentgate/protocol";
import { items, runs, type FactoryItem, type FactoryRun } from "../../src/factory/db.ts";
import { loopTask } from "../../src/factory/runtime.ts";
import { host } from "../../src/logins.ts";
import { factoryNode } from "./t3-mcp.ts";

type Answer = { ok: boolean; out: string } | undefined;
const ok = (value: unknown): Answer => ({ ok: true, out: JSON.stringify(value) });
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
const sha = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");

type Comment = { body: string; author?: { login: string }; authorAssociation: string; createdAt: string };
export interface FakePr {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  author: string;
  headRefName: string;
  headRefOid: string;
  checks: "pending" | "passing" | "failing" | "none";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  body: string;
  comments: Comment[];
  reviews: { body: string; authorAssociation: string; submittedAt: string; state: string }[];
  reviewers: string[];
}

const ROLLUP = {
  none: [],
  passing: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
  failing: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }],
  pending: [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null }],
};

/** GitHub for one repository with default branch `main`, answering the gh commands gh.ts sends in the shapes gh 2.102
 * prints: labelled issues and their comments, pull requests, and the default branch's push runs. */
function fakeGitHub(repo: string, cleanup: (() => unknown)[]) {
  const issues = new Map<number, { title: string; state: "OPEN" | "CLOSED"; comments: Comment[] }>();
  const prs = new Map<string, FakePr>();
  const calls: { args: string[]; stdin?: string }[] = [];
  const github = {
    issues,
    prs,
    calls,
    /** The conclusion of the newest push run on `main`. */
    ci: "success" as "success" | "failure",
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
    if (command === "run" && sub === "list")
      return ok([{ headSha: "abc1234", status: "completed", conclusion: github.ci }]);
    if (command === "issue" && sub === "list")
      return ok(
        [...issues]
          .filter(([, i]) => i.state === "OPEN")
          .map(([number, i]) => ({
            number,
            title: i.title,
            body: "",
            url: `https://github.com/${repo}/issues/${number}`,
          })),
      );
    if (command === "issue" && sub === "view") {
      const issue = issues.get(Number(args[2]))!;
      return ok(flag(args, "--json") === "state" ? { state: issue.state } : { comments: issue.comments });
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
          statusCheckRollup: ROLLUP[pr.checks],
          mergeable: pr.mergeable,
          body: pr.body,
          files: [{ path: "src/a.ts" }],
          comments: pr.comments,
          reviews: pr.reviews,
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
) {
  const n = await factoryNode(cleanup, {
    config: (repo) => ({
      limits: { threads: 20 },
      sources: [{ id: "bugs", type: "github", repo, label: "factory" }],
      ...config(repo),
    }),
  });
  const github = fakeGitHub(n.repo, cleanup);
  const builtin = (await n.ctx.gateway.builtin!()).client;

  /** factory_report from the run's own T3 thread: `{ accepted: true }`, or the tool error's text. */
  const report = async (run: FactoryRun, body: Omit<FactoryReport, "run"> | Record<string, unknown>) => {
    const result = await builtin.callTool({
      name: "factory_report",
      arguments: { run: run.id, ...body },
      _meta: { "dev.agentgate/t3Thread": run.threadId },
    });
    const text = (result.content as { text: string }[])[0]!.text;
    return result.isError ? { error: text } : JSON.parse(text);
  };
  const implementRuns = (item: FactoryItem) => runs.forItem(n.s, item.id).filter((r) => r.kind === "implement");

  /** Issue `number` entered, was triaged to implement, and its implement run was dispatched. */
  async function implementing(number: number) {
    github.addIssue(number);
    await n.intake();
    await n.dispatch();
    const item = items.byExternal(n.s, "bugs", `${n.repo}#${number}`)!;
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
        claims: [{ claim: "Saving twice no longer crashes", evidence: "bun test test/save.test.ts passes" }],
        notChecked: ["Windows"],
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

  return {
    ...n,
    github,
    report,
    done,
    implementing,
    opened,
    implementRuns,
    pollPrs: loopTask(
      n.f,
      n.f.loops.find((l) => l.name === "factory-prs")!,
    ),
    /** Messages the factory sent to a thread after launching it. */
    sent: (threadId: string) =>
      n.mcp.calls
        .filter((c) => c.tool === "t3_thread_send" && c.args.threadId === threadId)
        .map((c) => String(c.args.message)),
    /** Ends or starts the thread's turn and waits until the mirror shows it. */
    async thread(threadId: string, status: "idle" | "running") {
      n.mcp.setThread(threadId, { status });
      await n.until(() => n.mirror.thread(threadId)?.status === status, `the thread to be ${status}`);
    },
  };
}
