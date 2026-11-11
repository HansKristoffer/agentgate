import { afterAll, afterEach, expect, test } from "bun:test";
import { dataOf, items, newId, runs, type FactoryItem } from "../src/factory/db.ts";
import { host } from "../src/logins.ts";
import { prFactory, type FakePr } from "./fixtures/factory-pr.ts";
import { idle } from "./fixtures/t3-mcp.ts";
import { removeTmp } from "./fixtures/git.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const MINUTE = 60_000;
const head = (c: string) => c.repeat(40);
const finding = { file: "src/save.ts", line: 12, severity: "important", text: "The lock is never released." } as const;

const SUMMARY = "<!-- agentgate-factory:summary -->";
/** How many of the gh calls are `gh pr view`. */
const prViews = (calls: { args: string[] }[]) =>
  calls.filter(({ args }) => args[0] === "pr" && args[1] === "view").length;
const risk = {
  door: "two-way",
  reach: "module",
  unrelated: ["src/util.ts: renamed a helper"],
  focus: ["the retry in src/save.ts, which runs on every save"],
} as const;

/** The review factory: the PR fixture plus any PR review posted (none should be), and helpers for the review stage. */
async function reviewFactory(config: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  const n = await prFactory(
    cleanup,
    (repo) => ({ repositories: { [repo]: { reviewers: ["octocat"] } }, ...config }),
    files,
  );
  const reviews: unknown[] = [];
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
    reviewed: (pr: FakePr, findings: unknown[], commit = pr.headRefOid, extra: Record<string, unknown> = {}) => ({
      outcome: "done",
      summary: "Reviewed it.",
      result: { kind: "review", prUrl: pr.url, commit, findings, testsFailWithoutFix: true, ...extra },
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
      branch: `factory/${n.key(1)}-review-1-${review.id.slice(-6).toLowerCase()}`,
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
  expect(brief).toContain("testsFailWithoutFix");
  expect(brief).toContain("Never post anything on GitHub");
  expect(view).toContain("Saving twice keeps one file.");
  // The implementer's claims reach the PR only at ready, so the reviewer cannot read them there either.
  expect(pr.body).not.toContain(SUMMARY);
});

test("a folder's own review brief still shows the result's shape, risk included", async () => {
  const n = await reviewFactory({}, { "stages/review.md": "Review it our way." });
  const { item } = await n.reviewing(1);
  const brief = String(n.launches(item)[0]!.args.message);
  expect(brief).toContain("Review it our way.");
  expect(brief).not.toContain("focused passes");
  expect(brief).toContain('risk?: { door: "one-way" | "two-way"');
});

test("a stale report is discarded, findings go to the implement thread and not to GitHub and hold the item until a green push, and round 2 sees only the new range", async () => {
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
  expect(n.reviews).toEqual([]);
  const sent = n.sent(implement.threadId!).at(-1)!;
  expect(sent).toStartWith(`The factory's reviewer found these in ${head("a").slice(0, 12)} (round 1 of 3):`);
  expect(sent).toContain("The lock is never released.");
  // Pre-existing findings are not the implementer's to fix.
  expect(sent).not.toContain("This was already broken.");
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

test("a clean review moves the item to ready; findings in the last allowed round go to ready as open findings in the ready comment and the PR's summary", async () => {
  const n = await reviewFactory({ limits: { threads: 20, reviewRounds: 2 } });
  const clean = await n.reviewing(1);
  // Its approved spec left a slice for later, which becomes an issue when the PR goes ready.
  const later = { title: "Export more than 10,000 rows", body: "Page the export instead of loading every row." };
  runs.insert(n.s, {
    id: newId("run"),
    item: clean.item.id,
    kind: "spec",
    attempt: 1,
    state: "reported",
    nudges: 0,
    configCommit: clean.item.configCommit,
    report: {
      run: "x",
      outcome: "done",
      summary: "Spec approved.",
      result: { kind: "spec", spec: "The first slice.", review: "Fine.", approved: true, later: [later] },
    },
  });
  const before = n.github.calls.length;
  expect(await n.report(clean.review, n.reviewed(clean.pr, []))).toEqual({ accepted: true });
  expect(items.get(n.s, clean.item.id)!.phase).toBe("ready");
  // Checking the reviewed commit reads the PR once, and going ready reuses that read for its author and body.
  expect(prViews(n.github.calls.slice(before))).toBe(1);
  expect(clean.pr).toMatchObject({ isDraft: false, reviewers: ["octocat"] });
  expect(n.reviews).toEqual([]);
  expect(n.github.posted(1).at(-1)).toBe("The pull request is ready for review.");
  expect(clean.pr.body).toContain(
    `**Review:** 1 round, the last at \`${clean.pr.headRefOid.slice(0, 12)}\` found nothing to fix.`,
  );
  // That round reported no risk, so the summary has no Risk line.
  expect(clean.pr.body).not.toContain("**Risk:**");
  await idle(n.f);
  expect(n.github.filed).toHaveLength(1);
  expect(n.github.filed[0]).toMatchObject({ title: later.title });
  expect(n.github.filed[0]!.body).toContain(`left this for later; ${clean.pr.url} does the first part`);

  const { item, pr, review } = await n.reviewing(2);
  await n.report(review, n.reviewed(pr, [finding]));
  pr.headRefOid = head("c");
  await n.pollReviews();
  await n.dispatch();
  const last = { ...finding, text: "The retry loop never ends." };
  const old = {
    file: "src/load.ts",
    line: 10,
    severity: "pre-existing",
    text: "The cache is never cleared.",
    title: "Cache never cleared",
  };
  await n.report(n.latest(item), n.reviewed(pr, [last, old], pr.headRefOid, { risk }));

  expect(n.reviews).toEqual([]);
  expect(items.get(n.s, item.id)!.phase).toBe("ready");
  expect(pr.isDraft).toBe(false);
  const comment = n.github.issues.get(2)!.comments.at(-1)!.body;
  expect(comment).toContain("The pull request is ready for review.");
  expect(comment).toContain("Review round 2 of 2 still found problems.");
  expect(comment).toContain("The retry loop never ends.");
  expect(comment).not.toContain("The lock is never released.");

  // The PR's body: the author's text, then the factory's summary of the last round.
  const body = pr.body;
  expect(body).toStartWith("Fixes #2");
  expect(body.indexOf(SUMMARY)).toBeGreaterThan(0);
  expect(body).toContain(`**Review:** 2 rounds, the last at \`${head("c").slice(0, 12)}\`. Still open:`);
  expect(body).toContain("- Important, `src/save.ts:12`: The retry loop never ends.");
  expect(body).toContain(
    "Also seen, not this PR's to fix, each filed as an issue:\n- Pre-existing, `src/load.ts:10`: The cache is never cleared.",
  );
  // The pre-existing finding became an issue without the source's label: labelling it is the maintainer's approval.
  await idle(n.f);
  expect(n.github.filed).toHaveLength(2);
  expect(n.github.filed[1]).toMatchObject({ title: "Cache never cleared" });
  expect(n.github.filed[1]!.body).toContain("`src/load.ts:10`");
  expect(n.github.filed[1]!.body).toContain(`The factory's review of ${pr.url} found this`);
  expect(n.github.filed[1]!.body).toContain("Add the label `factory` to have the factory work it.");
  expect(body).toContain(
    "**Risk:** two-way door, reaches the module. Look first at: the retry in src/save.ts, which runs on every save. Unrelated changes: src/util.ts: renamed a helper.",
  );
  expect(body).not.toContain("The lock is never released.");
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

/** The messages carrying round 1's finding to the implement thread. */
const findingsSent = (n: Awaited<ReturnType<typeof reviewFactory>>, threadId: string) =>
  n.sent(threadId).filter((m) => m.includes("The lock is never released."));

test("a review taken while GitHub is down is finished by the review loop, and its findings reach the implement thread once", async () => {
  const n = await reviewFactory();
  const { item, pr, run: implement, review } = await n.reviewing(1);

  n.outage.on = true;
  expect(await n.report(review, n.reviewed(pr, [finding]))).toEqual({ accepted: true });
  await n.pollReviews();
  expect(findingsSent(n, implement.threadId!)).toEqual([]);
  expect(items.get(n.s, item.id)!.phase).toBe("review");

  n.outage.on = false;
  const before = n.github.calls.length;
  await n.pollReviews();
  expect(findingsSent(n, implement.threadId!)).toHaveLength(1);
  // The follower's own read of the PR is the one the review is checked against.
  expect(prViews(n.github.calls.slice(before))).toBe(0);
  await n.pollReviews();
  expect(findingsSent(n, implement.threadId!)).toHaveLength(1);
  expect(n.reviews).toEqual([]);
  expect(items.get(n.s, item.id)!.phase).toBe("review");
});

test("findings T3 Code refused to send are sent again by the next pass, once", async () => {
  const n = await reviewFactory();
  const { pr, run: implement, review } = await n.reviewing(1);
  n.mcp.answer("t3_thread_send", () => {
    throw new Error("Thread is busy");
  });
  await n.report(review, n.reviewed(pr, [finding]));
  expect(findingsSent(n, implement.threadId!)).toHaveLength(1);

  n.mcp.answer("t3_thread_send", () => ({ ok: true }));
  await n.pollReviews();
  await n.pollReviews();
  expect(findingsSent(n, implement.threadId!)).toHaveLength(2);
});

test("findings whose send was cut off stay handled, so they are never sent twice", async () => {
  const n = await reviewFactory();
  const { pr, run: implement, review } = await n.reviewing(1);
  n.mcp.answer("t3_thread_send", () => new Promise(() => {}));
  const reported = n.report(review, n.reviewed(pr, [finding]));
  await n.until(() => findingsSent(n, implement.threadId!).length === 1, "the findings to be sent");
  // T3 Code goes away mid-call: nothing says whether the thread got them.
  n.t3.stop();
  await reported;
  expect(dataOf(runs.get(n.s, review.id), "review")).toMatchObject({ round: 1, final: false });
});

test("a review taken while the PR follower runs reaches the implement thread once", async () => {
  const n = await reviewFactory();
  const { item, pr, run: implement, review } = await n.reviewing(1);
  // The report and a pass of the follower arrive together; each is a step of the item, so one takes the review.
  await Promise.all([n.report(review, n.reviewed(pr, [finding])), n.pollReviews(), n.pollReviews()]);
  expect(findingsSent(n, implement.threadId!)).toHaveLength(1);
  expect(n.reviews).toEqual([]);
  expect(items.get(n.s, item.id)!.phase).toBe("review");
});
