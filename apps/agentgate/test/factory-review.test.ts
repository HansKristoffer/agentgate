import { afterAll, afterEach, expect, test } from "bun:test";
import { items, newId, runs, type FactoryItem } from "../src/factory/db.ts";
import { parseMarkers } from "../src/factory/markers.ts";
import { host } from "../src/logins.ts";
import { prFactory, type FakePr } from "./fixtures/factory-pr.ts";
import { removeTmp } from "./fixtures/git.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const MINUTE = 60_000;
const head = (c: string) => c.repeat(40);
const finding = { file: "src/save.ts", line: 12, severity: "important", text: "The lock is never released." } as const;

type PostedReview = {
  commit_id: string;
  body: string;
  comments: { path: string; line: number; side: string; body: string }[];
};

/** The review factory: the PR fixture plus the PR reviews the factory posts, and helpers for the review stage. */
async function reviewFactory(config: Record<string, unknown> = {}) {
  const n = await prFactory(cleanup, (repo) => ({
    repositories: { [repo]: { reviewers: ["octocat"] } },
    ...config,
  }));
  const reviews: PostedReview[] = [];
  const outage = { on: false };
  const gh = host.gh;
  host.gh = async (args, stdin) => {
    if (outage.on) return { ok: false, out: "HTTP 502" };
    if (args[0] === "api" && /\/pulls\/\d+\/reviews$/.test(args[1]!)) {
      reviews.push(JSON.parse(stdin!));
      return { ok: true, out: "{}" };
    }
    return gh(args, stdin);
  };
  cleanup.push(() => (host.gh = gh));
  const builtin = (await n.ctx.gateway.builtin!()).client;
  const reviewRuns = (item: FactoryItem) => runs.forItem(n.s, item.id).filter((r) => r.kind === "review");
  const launches = (item: FactoryItem) =>
    n.mcp.calls.filter(
      (c) => c.tool === "t3_thread_launch" && reviewRuns(item).some((r) => r.id === c.args.clientRequestId),
    );

  /** Issue `number` has a draft PR whose checks pass, and its first review run was dispatched. */
  async function reviewing(number: number) {
    const opened = await n.opened(number, { checks: "passing" });
    await n.pollPrs();
    await n.dispatch();
    return { ...opened, review: reviewRuns(opened.item)[0]! };
  }

  return {
    ...n,
    reviews,
    /** GitHub answers every gh call with a 502 while on. */
    outage,
    reviewRuns,
    launches,
    reviewing,
    /** The PR follower, which takes the review rounds. */
    pollReviews: n.pollPrs,
    /** The newest review run of the item, as dispatched. */
    latest: (item: FactoryItem) => reviewRuns(item).at(-1)!,
    reviewed: (pr: FakePr, findings: unknown[], commit = pr.headRefOid) => ({
      outcome: "done",
      summary: "Reviewed it.",
      result: { kind: "review", prUrl: pr.url, commit, findings, testsFailWithoutFix: true },
    }),
    async itemView(run: { id: string; threadId?: string }) {
      const result = await builtin.callTool({
        name: "factory_item",
        arguments: { run: run.id },
        _meta: { "dev.agentgate/t3Thread": run.threadId },
      });
      return (result.content as { text: string }[])[0]!.text;
    },
  };
}

test("once checks pass and every claim has evidence, a blind review starts in its own worktree with the item, spec and PR", async () => {
  const n = await reviewFactory();
  const { item, pr } = await n.opened(1, { checks: "passing" });
  runs.insert(n.s, {
    id: newId("run"),
    item: item.id,
    kind: "spec",
    attempt: 1,
    state: "reported",
    nudges: 0,
    configCommit: item.configCommit,
    report: {
      run: "spec",
      outcome: "done",
      summary: "Wrote the spec.",
      result: { kind: "spec", spec: "Saving twice keeps one file.", review: "Fine.", approved: true },
    },
  });

  await n.pollPrs();
  expect(items.get(n.s, item.id)!.phase).toBe("review");
  await n.dispatch();
  const review = n.latest(item);
  expect(review.state).toBe("running");
  const [launch] = n.launches(item);
  expect(launch!.args).toMatchObject({
    title: `Review ${n.key(1)} (round 1): Issue 1`,
    workspaceStrategy: {
      type: "worktree",
      baseRef: "main",
      branch: `factory/${n.key(1)}-review-1`,
      startFromOrigin: true,
    },
  });

  const brief = String(launch!.args.message);
  const view = await n.itemView(review);
  for (const text of [brief, view]) {
    expect(text).toContain(pr.url);
    expect(text).toContain("Issue 1");
    // The implement run's summary and its claims and evidence.
    for (const claim of ["Fixed the crash.", "Saving twice no longer crashes", "test/save.test.ts"])
      expect(text).not.toContain(claim);
  }
  expect(brief).toContain(`review its head \`${pr.headRefOid}\``);
  expect(brief).toContain("Revert the fix locally");
  expect(brief).toContain("testsFailWithoutFix");
  expect(brief).toContain("Never post anything on GitHub");
  expect(view).toContain("Saving twice keeps one file.");
});

test("a stale report is discarded, findings become one PR review that holds the item until a green push, and round 2 sees only the new range", async () => {
  const n = await reviewFactory();
  const { item, pr, run: implement, review } = await n.reviewing(1);
  const reviewedHead = pr.headRefOid;

  // The implementer pushed while the review ran.
  pr.headRefOid = head("a");
  expect(await n.report(review, n.reviewed(pr, [finding], reviewedHead))).toEqual({ accepted: true });
  expect(n.reviews).toEqual([]);
  expect(items.get(n.s, item.id)!.phase).toBe("review");

  await n.pollReviews();
  await n.dispatch();
  const again = n.latest(item);
  expect(again.id).not.toBe(review.id);
  expect(String(n.launches(item)[1]!.args.message)).toContain("round 1 of at most 3");

  const elsewhere = { file: "src/old.ts", severity: "pre-existing", text: "This was already broken." };
  expect(await n.report(again, n.reviewed(pr, [finding, elsewhere]))).toEqual({ accepted: true });
  expect(n.reviews).toHaveLength(1);
  const [posted] = n.reviews;
  expect(posted!.commit_id).toBe(head("a"));
  expect(parseMarkers(posted!.body)).toEqual([expect.objectContaining({ item: item.id, stage: "review" })]);
  expect(posted!.comments).toEqual([{ path: "src/save.ts", line: 12, side: "RIGHT", body: expect.any(String) }]);
  expect(posted!.body).toContain("This was already broken.");
  expect(n.sent(implement.threadId!).at(-1)).toContain("The lock is never released.");
  expect(items.get(n.s, item.id)!.phase).toBe("review");

  // Nothing new to review until the head moves and its checks pass.
  await n.pollReviews();
  pr.headRefOid = head("b");
  pr.checks = "pending";
  await n.pollReviews();
  expect(n.reviewRuns(item)).toHaveLength(2);

  pr.checks = "passing";
  await n.pollReviews();
  await n.dispatch();
  expect(n.reviewRuns(item)).toHaveLength(3);
  const round2 = String(n.launches(item)[2]!.args.message);
  expect(round2).toContain(`git diff ${head("a")}..${head("b")}`);
  expect(round2).toContain("The lock is never released.");
  expect(n.launches(item)[2]!.args.title).toBe(`Review ${n.key(1)} (round 2): Issue 1`);
});

test("a clean review moves the item to ready; findings in the last allowed round go to ready as open findings in the ready comment", async () => {
  const n = await reviewFactory({ limits: { threads: 20, reviewRounds: 2 } });
  const clean = await n.reviewing(1);
  expect(await n.report(clean.review, n.reviewed(clean.pr, []))).toEqual({ accepted: true });
  expect(items.get(n.s, clean.item.id)!.phase).toBe("ready");
  expect(clean.pr).toMatchObject({ isDraft: false, reviewers: ["octocat"] });
  expect(n.reviews).toEqual([]);
  expect(n.github.posted(1).at(-1)).toBe("The pull request is ready for review.");

  const { item, pr, review } = await n.reviewing(2);
  await n.report(review, n.reviewed(pr, [finding]));
  pr.headRefOid = head("c");
  await n.pollReviews();
  await n.dispatch();
  const last = { ...finding, text: "The retry loop never ends." };
  await n.report(n.latest(item), n.reviewed(pr, [last]));

  expect(n.reviews).toHaveLength(2);
  expect(items.get(n.s, item.id)!.phase).toBe("ready");
  expect(pr.isDraft).toBe(false);
  const comment = n.github.issues.get(2)!.comments.at(-1)!.body;
  expect(comment).toContain("The pull request is ready for review.");
  expect(comment).toContain("Review round 2 of 2 still found problems.");
  expect(comment).toContain("The retry loop never ends.");
  expect(comment).not.toContain("The lock is never released.");
});

test("findings the implement thread leaves unanswered for stalledAfter go to ready as open findings", async () => {
  const n = await reviewFactory();
  const { item, pr, run: implement, review } = await n.reviewing(1);
  await n.report(review, n.reviewed(pr, [finding]));

  await n.thread(implement.threadId!, "running");
  n.advance(20 * MINUTE);
  await n.pollReviews();
  expect(items.get(n.s, item.id)!.phase).toBe("review");

  await n.thread(implement.threadId!, "idle");
  await n.pollReviews();
  expect(items.get(n.s, item.id)!.phase).toBe("ready");
  const comment = n.github.issues.get(1)!.comments.at(-1)!.body;
  expect(comment).toContain("left round 1's findings unanswered");
  expect(comment).toContain("The lock is never released.");
});

test("reviewRounds 0 sends a green PR to ready without a review run", async () => {
  const n = await reviewFactory({ limits: { threads: 20, reviewRounds: 0 } });
  const { item, pr } = await n.reviewing(1);
  expect(items.get(n.s, item.id)!.phase).toBe("ready");
  expect(pr.isDraft).toBe(false);
  expect(n.reviewRuns(item)).toEqual([]);
});

test("a review report without testsFailWithoutFix is refused", async () => {
  const n = await reviewFactory();
  const { pr, review } = await n.reviewing(1);
  const { testsFailWithoutFix: _, ...withoutTests } = n.reviewed(pr, []).result;
  const refused = await n.report(review, { outcome: "done", summary: "Reviewed it.", result: withoutTests });
  expect(refused.error).toStartWith("result.testsFailWithoutFix:");
  expect(runs.get(n.s, review.id)!.state).toBe("running");
});

test("a review taken while GitHub is down is finished by the review loop, and its findings are posted once", async () => {
  const n = await reviewFactory();
  const { item, pr, review } = await n.reviewing(1);

  n.outage.on = true;
  expect(await n.report(review, n.reviewed(pr, [finding]))).toEqual({ accepted: true });
  await n.pollReviews();
  expect(n.reviews).toEqual([]);
  expect(items.get(n.s, item.id)!.phase).toBe("review");

  n.outage.on = false;
  await n.pollReviews();
  await n.pollReviews();
  expect(n.reviews).toHaveLength(1);
  expect(items.get(n.s, item.id)!.phase).toBe("review");
});

test("a review taken while the PR follower runs is posted once", async () => {
  const n = await reviewFactory();
  const { item, pr, review } = await n.reviewing(1);
  // The report and a pass of the follower arrive together; each is a step of the item, so one takes the review.
  await Promise.all([n.report(review, n.reviewed(pr, [finding])), n.pollReviews(), n.pollReviews()]);
  expect(n.reviews).toHaveLength(1);
  expect(items.get(n.s, item.id)!.phase).toBe("review");
});

test("a review GitHub refuses for a line outside the diff is posted again with every finding in its body", async () => {
  const n = await reviewFactory();
  const { pr, review } = await n.reviewing(1);
  const gh = host.gh;
  let refused = 0;
  host.gh = async (args, stdin) => {
    const inline = args[0] === "api" && /\/reviews$/.test(args[1]!) && JSON.parse(stdin!).comments.length;
    if (inline) {
      refused++;
      return {
        ok: false,
        out: JSON.stringify({ message: "Pull request review thread line must be part of the diff" }),
      };
    }
    return gh(args, stdin);
  };
  cleanup.push(() => (host.gh = gh));
  await n.report(review, n.reviewed(pr, [{ ...finding, line: 999 }]));
  expect(refused).toBe(1);
  expect(n.reviews).toHaveLength(1);
  expect(n.reviews[0]!.comments).toEqual([]);
  expect(n.reviews[0]!.body).toContain("src/save.ts:999: The lock is never released.");
});
