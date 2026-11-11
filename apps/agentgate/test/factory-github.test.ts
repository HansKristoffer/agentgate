import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import type { FactoryReport, MarkerPayload } from "@agentgate/protocol";
import { buildBoard } from "../src/factory/board.ts";
import { moveItem } from "../src/factory/controller.ts";
import { writeBack } from "../src/factory/outbox.ts";
import { items, runs, type FactoryRun } from "../src/factory/db.ts";
import * as gh from "../src/factory/gh.ts";
import { MARKER_PREFIX, parseMarkers } from "../src/factory/markers.ts";
import { loopTask } from "../src/factory/runtime.ts";
import { ghAnswer, host, type GhAnswer } from "../src/logins.ts";
import { recorded, recordedJson, replayGh } from "./fixtures/gh.ts";
import { removeTmp } from "./fixtures/git.ts";
import { factoryNode, idle } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const realGh = host.gh;
type Answer = GhAnswer | undefined;
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

/** `gh` stopped at its deadline, as `host.gh` hands that on: no answer says whether the request arrived. */
const noAnswer = ghAnswer({ exit: 143, stdout: "", stderr: "" });

/** GitHub for one repository, answering the gh commands gh.ts sends as the real gh does. */
function fakeGitHub(repo: string) {
  const issues = new Map<number, Issue>();
  const github: {
    issues: typeof issues;
    /** A failure for gh commands that match: an answer recorded from the real gh. */
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
            // gh lists no more than --limit, 30 unless it is given.
            .slice(0, Number(flag(args, "--limit")))
            .map((i) => ({ body: i.body, number: i.number, title: i.title, url: url(i) })),
        );
      if (args[0] === "issue" && args[1] === "view") {
        const i = issues.get(Number(args[2]))!;
        const fields = flag(args, "--json")!.split(",");
        return ok({
          ...(fields.includes("state") && { state: i.state }),
          comments: i.comments.map((c, j) => ({ id: `IC_${i.number}_${j}`, ...c })),
        });
      }
      if (args[0] === "api" && args[1] === "user") return ok({ login: FACTORY_LOGIN });
      if (args[0] === "repo" && args[1] === "view") return ok({ defaultBranchRef: { name: "main" } });
      const comment = args[1]?.match(/^repos\/.+\/issues\/(\d+)\/comments$/);
      if (args[0] === "api" && comment) {
        const { body } = JSON.parse(stdin!);
        issues.get(Number(comment[1]))!.comments.push({
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

async function githubFactory(
  sources = (repo: string) => [source(repo)],
  repositories = (repo: string): Record<string, unknown> => ({ [repo]: {} }),
) {
  const n = await factoryNode(cleanup, {
    config: (repo) => ({ limits: { threads: 20 }, sources: sources(repo), repositories: repositories(repo) }),
  });
  const github = fakeGitHub(n.repo);
  const builtin = (await n.ctx.gateway.builtin!()).client;
  /** factory_report from the run's own T3 thread, as the shim forwards it. */
  const report = async (run: FactoryRun, body: Omit<FactoryReport, "run">) => {
    const result = await builtin.callTool({
      name: "factory_report",
      arguments: { run: run.id, ...body },
      _meta: { "dev.agentgate/t3Thread": run.threadId },
    });
    const answer = JSON.parse((result.content as { text: string }[])[0]!.text);
    await idle(n.f);
    return answer;
  };
  const posts = () => github.calls.filter((c) => c.args[0] === "api" && c.args[1] !== "user");
  /** Intake gives issue `number` the key `<repository name>-<number>`. */
  const key = (number: number) => `${n.repo.split("/")[1]!.toLowerCase()}-${number}`;
  return { ...n, github, report, posts, key };
}

const triaged = {
  outcome: "done",
  summary: "Reproduced it.",
  result: { kind: "triage", route: "implement", reproduction: { command: "bun test", failsBefore: true } },
} as const;

test("open issues with the label enter once as <repository>-<n> and hear that the factory took them, and closed, unlabelled or finished issues do not", async () => {
  const n = await githubFactory();
  n.github.add(1, { title: "Crash on save", body: "Click save twice." });
  n.github.add(2, { state: "CLOSED" });
  n.github.add(3, { labels: ["question"] });
  const finished = `${MARKER_PREFIX}${JSON.stringify({
    item: "it_b",
    key: "gh-4",
    stage: "implement",
    outcome: null,
    route: null,
    commit: null,
    factory: "3f2c1a9",
    node: "b",
    state: "finished",
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
        body: `Closed.\n\n${finished}`,
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
      key: n.key(1),
      title: "Crash on save",
      url: `https://github.com/${n.repo}/issues/1`,
      snapshot: { title: "Crash on save", body: "Click save twice.", url: `https://github.com/${n.repo}/issues/1` },
    },
  ]);
  await idle(n.f);
  expect(n.posts().map((c) => c.args[1])).toEqual([`repos/${n.repo}/issues/1/comments`]);
  expect(parseMarkers(n.github.issues.get(1)!.comments[0]!.body)).toEqual([
    expect.objectContaining({ key: n.key(1), stage: null, node: "a", state: "open" }),
  ]);
});

test("two sources on one repository take an issue with both labels in once, and keys stay unique", async () => {
  const n = await githubFactory((repo) => [source(repo), source(repo, "urgent", "urgent")]);
  n.github.add(1, { labels: ["factory", "urgent"] });
  await n.intake();
  expect(items.list(n.s).map((i) => [i.key, i.source])).toEqual([[n.key(1), "bugs"]]);
});

test("an issue of a repository whose name another repository shares is keyed <owner>-<name>-<n>, and a number naming two items is refused with both keys", async () => {
  const twin = (repo: string) => `elsewhere/${repo.split("/")[1]}`;
  const n = await githubFactory(undefined, (repo) => ({ [repo]: {}, [twin(repo)]: {} }));
  n.github.add(42);
  await n.intake();
  const [owner, name] = n.repo.toLowerCase().split("/");
  const key = `${owner}-${name}-42`;
  expect(items.list(n.s).map((i) => i.key)).toEqual([key]);
  await n.dispatch();
  const [triage] = runs.list(n.s);
  expect(n.t3.threads.get(triage!.threadId!)!.branch).toBe(
    `factory/${key}-triage-1-${triage!.id.slice(-6).toLowerCase()}`,
  );

  // The same number in the twin repository: `42` names both items, and every way in says so.
  const other = items.insert(n.s, {
    ...items.list(n.s)[0]!,
    id: "it_twin",
    externalId: `${twin(n.repo)}#42`,
    key: `elsewhere-${name}-42`,
    repo: twin(n.repo),
  });
  const refused = `42 names 2 items, ${key} and ${other.key}; name one by its key`;
  expect(await n.command("approve", "42")).toEqual({ code: 1, output: [refused] });
  const api = await n.op("approve", { item: "42" });
  expect(api.status).toBe(400);
  expect(await api.text()).toContain(refused);
  expect((await n.command("drop", `${n.repo}#42`)).code).toBe(0);
  expect(items.get(n.s, other.id)!.phase).not.toBe("closed");
});

test("a marker in a comment by another login counts for nothing: not for check or intake", async () => {
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

  // Read as the factory's, the second would count as finished, and intake would leave it out.
  await n.intake();
  expect(items.list(n.s).map((i) => [i.key, i.phase])).toEqual([
    [n.key(1), "triage"],
    [n.key(2), "triage"],
  ]);

  // The factory's own marker counts, and a forged one posted after it does not replace it.
  const item = items.list(n.s)[0]!;
  writeBack(n.f, item, "waiting", { text: "Which save path?", ref: "q1" });
  await idle(n.f);
  n.github.issues.get(1)!.comments.push(forged(1, { state: "finished" }));
  expect((await n.f.sources.get("github")!.check!(item)).markers.at(-1)).toMatchObject({
    item: item.id,
    node: "a",
    state: "open",
  });
});

/** How the item's comment for a moment stands in the outbox, as `factory show` tells it. */
async function writeStatus(n: Awaited<ReturnType<typeof githubFactory>>, key: string, moment: string) {
  const { output } = await n.command("show", key, "--json");
  const writes: { moment: string; status: string }[] = JSON.parse(output.at(-1)!).writebacks;
  return writes.find((w) => w.moment === moment)?.status;
}
const outboxPass = async (n: Awaited<ReturnType<typeof githubFactory>>) => {
  await loopTask(
    n.f,
    n.f.loops.find((l) => l.name === "factory-outbox")!,
  )();
  await idle(n.f);
};

test("triage posts one comment with the template, the marker, defused mentions and a capped text; a refused post is tried three times and an uncertain one is not sent blind", async () => {
  const n = await githubFactory();
  for (const i of [1, 2, 3]) n.github.add(i);
  await n.intake();
  await n.dispatch();
  await idle(n.f);
  const [first, second, third] = runs.list(n.s, { kinds: ["triage"] });
  // Each issue heard that the factory took it.
  const taken = n.posts().length;
  expect(taken).toBe(3);

  const summary = `Thanks @octocat, this is real. ${"x".repeat(1960)}`;
  expect(await n.report(first!, { ...triaged, summary })).toEqual({ accepted: true });
  expect(n.posts()).toHaveLength(taken + 1);
  const post = n.posts().at(-1);
  expect(post!.args).toEqual([
    "api",
    `repos/${n.repo}/issues/1/comments`,
    "--method",
    "POST",
    "--input",
    "-",
    "--include",
  ]);
  const body: string = JSON.parse(post!.stdin!).body;
  const [text] = body.split(`\n\n${MARKER_PREFIX}`);
  expect(text).toStartWith(
    `**${n.key(1)}**: The factory triaged this and starts on a fix.\n\nThanks @​octocat, this is real.`,
  );
  // The headline and the summary together run past 2,000 characters, so the text is cut there.
  expect(text!.length).toBe(2000);
  expect(text).toEndWith("x…");
  expect(body).not.toContain("@octocat");
  expect(parseMarkers(body)).toEqual([
    {
      item: first!.item!,
      key: n.key(1),
      stage: "triage",
      outcome: "done",
      route: "implement",
      commit: null,
      factory: n.commit.slice(0, 7),
      node: "a",
      state: "open",
      pr: null,
      moment: "triaged",
      ref: "",
    },
  ]);
  // The comment is now the issue's newest marker, read back from the factory's own login.
  expect((await n.f.sources.get("github")!.check!(items.get(n.s, first!.item!)!)).markers.at(-1)).toMatchObject({
    node: "a",
    state: "open",
  });

  // GitHub refused the second with a 4xx; the third got no answer at all, so it may exist.
  n.github.fail = (args) =>
    args[1]?.endsWith("/2/comments")
      ? recorded("badToken.branchExists")
      : args[1]?.endsWith("/3/comments")
        ? noAnswer
        : undefined;
  await n.report(second!, triaged);
  await n.report(third!, triaged);
  const statuses = () => Promise.all([1, 2, 3].map((i) => writeStatus(n, n.key(i), "triaged")));
  // A refusal wrote nothing, so the outbox tries it again, up to three attempts; the uncertain one is not sent.
  expect(await statuses()).toEqual(["posted", "pending", "uncertain"]);
  for (let pass = 0; pass < 2; pass++) await outboxPass(n);
  expect(await statuses()).toEqual(["posted", "failed", "uncertain"]);
  const texts = n.f.events.recent(50).map((e) => e.text);
  expect(texts).toContain(
    `The triaged comment on ${n.key(2)}: failed (GitHub refused to comment on ${n.repo}#2: Bad credentials); it is tried again`,
  );
  expect(texts).toContain(
    `The triaged comment on ${n.key(2)}: failed (GitHub refused to comment on ${n.repo}#2: Bad credentials)`,
  );
  expect(texts).toContain(
    `The triaged comment on ${n.key(3)}: uncertain (gh could not comment on ${n.repo}#3, though GitHub may have taken it: gh gave no reason (exit 143))`,
  );

  // Calling for the same moment again sends nothing: one post, three attempts at the refused one, one uncertain.
  n.github.fail = undefined;
  for (const run of [first!, second!, third!]) writeBack(n.f, items.get(n.s, run.item!)!, "triaged");
  await idle(n.f);
  expect(n.posts()).toHaveLength(taken + 5);
});

test("an uncertain comment that landed is marked posted once the issue's comments are read back, and one that did not is sent once more", async () => {
  const n = await githubFactory();
  n.github.add(1);
  n.github.add(2);
  await n.intake();
  await idle(n.f);
  const [landed, lost] = items.list(n.s);
  const statuses = () => Promise.all([1, 2].map((i) => writeStatus(n, n.key(i), "triaged")));
  const triagedOn = (number: number) =>
    n.github.issues.get(number)!.comments.filter((c) => parseMarkers(c.body).at(-1)?.stage === "triage");

  // gh hears nothing back for either; GitHub took the first and never got the second.
  n.github.fail = (args) => (args[1]?.endsWith("/comments") ? noAnswer : undefined);
  writeBack(n.f, landed!, "triaged");
  writeBack(n.f, lost!, "triaged");
  await idle(n.f);
  const sent = n.posts().find((c) => c.args[1]?.endsWith("/1/comments") && c.stdin?.includes("triaged this"))!;
  n.github.issues.get(1)!.comments.push({
    body: JSON.parse(sent.stdin!).body,
    author: { login: FACTORY_LOGIN },
    authorAssociation: "OWNER",
    createdAt: "2026-11-05",
  });
  n.github.fail = undefined;
  expect(await statuses()).toEqual(["uncertain", "uncertain"]);

  // A send still in flight at GitHub may show late, so the comments are read back a pass later.
  await outboxPass(n);
  expect(await statuses()).toEqual(["uncertain", "uncertain"]);
  n.advance(2 * 60_000);
  await outboxPass(n);
  expect(await statuses()).toEqual(["posted", "posted"]);
  n.advance(2 * 60_000);
  await outboxPass(n);
  expect([triagedOn(1).length, triagedOn(2).length]).toEqual([1, 1]);
});

test("a comment claimed while gh is offline or logged out is sent once gh reaches GitHub again, and one still unsent a day after its claim is failed", async () => {
  const n = await githubFactory();
  n.github.add(1);
  n.github.add(2);
  n.github.fail = (args) =>
    args[1]?.endsWith("/1/comments")
      ? recorded("offline.branchExists")
      : args[1]?.endsWith("/2/comments")
        ? recorded("loggedOut.branchExists")
        : undefined;
  await n.intake();
  await idle(n.f);
  const statuses = () => Promise.all([1, 2].map((i) => writeStatus(n, n.key(i), "taken")));
  expect(await statuses()).toEqual(["unreachable", "unreachable"]);

  // Nothing was written, so the loop sends both again on every pass, however many that takes.
  for (let pass = 0; pass < 5; pass++) {
    n.advance(2 * 60_000);
    await outboxPass(n);
  }
  expect(await statuses()).toEqual(["unreachable", "unreachable"]);
  expect(n.posts()).toHaveLength(12);
  // The item's history says so once, not on every pass.
  const said = () => n.f.events.recent(50).map((e) => e.text);
  expect(said().filter((text) => text.startsWith(`The taken comment on ${n.key(2)}`))).toEqual([
    `The taken comment on ${n.key(2)}: unreachable (gh could not comment on ${n.repo}#2: gh is not logged in on this machine (gh auth login)); it is tried again`,
  ]);

  // The network is back, and the first comment goes through.
  n.github.fail = (args) => (args[1]?.endsWith("/2/comments") ? recorded("loggedOut.branchExists") : undefined);
  await outboxPass(n);
  expect(await statuses()).toEqual(["posted", "unreachable"]);
  expect(parseMarkers(n.github.issues.get(1)!.comments[0]!.body)).toEqual([
    expect.objectContaining({ key: n.key(1), state: "open" }),
  ]);

  // A day after its claim the second is given up, and logging in later does not post it.
  n.advance(86_400_000);
  await outboxPass(n);
  expect(await statuses()).toEqual(["posted", "failed"]);
  expect(said()).toContain(
    `The taken comment on ${n.key(2)}: unreachable (gh could not comment on ${n.repo}#2: gh is not logged in on this machine (gh auth login)); a day after it was claimed, it is given up`,
  );
  n.github.fail = undefined;
  await outboxPass(n);
  expect(n.github.issues.get(2)!.comments).toEqual([]);
});

/** A `gh api --include` call GitHub answered with an error status, as gh prints it: headers and body on stdout. */
const ghError = (status: string, headers: string[], message: string) =>
  ghAnswer({
    exit: 1,
    stdout: `HTTP/2.0 ${status}\r\n${headers.join("\r\n")}\r\n\r\n${JSON.stringify({ message })}`,
    stderr: `gh: ${message} (HTTP ${status.slice(0, 3)})\n`,
  });
/** GitHub's secondary rate limit, which posting several comments in a row meets. */
const SECONDARY = "You have exceeded a secondary rate limit.";
const secondaryLimit = ghError("403 Forbidden", ["Retry-After: 60"], SECONDARY);

/** gh.ts holds GitHub calls back by the system clock: each test that meets a rate limit runs at a moment of its own,
 * long before the real time the clock returns to, so its limit has lifted for the tests after it. */
function pinClock(at: string) {
  let clock = Date.parse(at);
  setSystemTime(clock);
  cleanup.push(() => setSystemTime());
  return (ms: number) => setSystemTime((clock += ms));
}

test("a comment GitHub's rate limit turns away is sent once the limit lifts, without counting as a refusal, and no gh call runs until then", async () => {
  const n = await githubFactory();
  n.github.add(1);
  await n.intake();
  await idle(n.f);
  const item = items.list(n.s)[0]!;
  const advance = pinClock("2026-01-01T00:00:00Z");
  const writeRow = () => n.s.db.query("select status, refusals from factory_writebacks where moment='triaged'").get();

  n.github.fail = (args) => (args[1]?.endsWith("/1/comments") ? secondaryLimit : undefined);
  writeBack(n.f, item, "triaged");
  await idle(n.f);
  const calls = n.github.calls.length;
  // Three attempts in a row: the first met the limit, and the two passes after it are held back without asking.
  for (let pass = 0; pass < 2; pass++) await outboxPass(n);
  expect(n.github.calls).toHaveLength(calls);
  expect(writeRow()).toEqual({ status: "pending", refusals: 0 });
  await expect(gh.issueComments(n.repo, 1)).rejects.toThrow(
    "GitHub's rate limit holds calls until 2026-01-01T00:01:00.000Z",
  );
  expect(n.f.events.recent(50).map((e) => e.text)).toContain(
    `The triaged comment on ${n.key(1)}: limited (gh could not comment on ${n.repo}#1 yet: ${SECONDARY}); it is tried again`,
  );

  advance(60_000);
  n.github.fail = undefined;
  await outboxPass(n);
  expect(writeRow()).toEqual({ status: "posted", refusals: 0 });
  expect(n.github.issues.get(1)!.comments.map((c) => c.body.split("\n")[0])).toEqual([
    `**${n.key(1)}**: The factory took this.`,
    `**${n.key(1)}**: The factory triaged this and starts on a fix.`,
  ]);
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
      };
    },
    validate: async () => undefined,
    accept: async () => {},
  });
  // Intake reads each new issue with its comments, for its marker; dispatch reads its state alone.
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
  // The issue is read before the launch is built, so a closed one costs no launch work.
  expect(implementLaunches).toEqual([]);
  expect(runs.list(n.s, { kinds: ["implement"] }).map((r) => r.state)).toEqual(["cancelled"]);
  // The taken comments and the triaged one: the issue already says it is closed.
  await idle(n.f);
  expect(n.posts()).toHaveLength(3);
});

test("a failing gh shows on its source's row and backs off, while the other source keeps polling", async () => {
  const n = await githubFactory((repo) => [source(repo), source(repo, "broken", "urgent")]);
  n.github.add(1);
  n.github.fail = (args) =>
    args[1] === "list" && flag(args, "--label") === "urgent" ? recorded("loggedOut.issueList") : undefined;
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
    error: `gh could not list the open issues labelled "urgent" in ${n.repo}: gh is not logged in on this machine (gh auth login)`,
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

test("a source with more open labelled issues than one poll reads says so on its board row", async () => {
  const n = await githubFactory();
  for (let number = 1; number <= gh.ISSUE_LIMIT + 1; number++) n.github.add(number);
  const row = async () => (await buildBoard(n.f, { includeWebhookUrls: false })).sources.find((r) => r.id === "bugs")!;

  await n.intake();
  expect((await row()).error).toBe(
    "Only the newest 200 open labelled issues are read; the rest wait until fewer are open",
  );

  // Exactly as many as a poll reads is not more.
  n.github.issues.get(1)!.state = "CLOSED";
  n.advance(60_000);
  await n.intake();
  expect((await row()).error).toBe(undefined);
});

// ---- gh.ts against what gh really answered (fixtures/gh-recorded.json)

const SCRATCH = "HansKristoffer/factory-scratch";
const EMPTY = "aldevvv/zerolabs";
const GONE = "HansKristoffer/no-such-repo-agentgate";
const PR = `https://github.com/${SCRATCH}/pull/6`;
/** A cli/cli PR and the revert recorded for it. */
const REVERTED = { number: 14437, title: "Use internal Apple codesign action", mergedAt: "2026-09-15T13:00:00Z" };

test("each gh.ts read parses what gh really answered", async () => {
  replayGh(
    cleanup,
    "repoView",
    "branch",
    "branchExists",
    "readFile",
    "label",
    "issueList",
    "issueView",
    "issueView.comments",
    "prList",
    "prState",
    "prView",
    "feedback",
    "followed",
    "mainChecks",
    "reverts",
  );
  expect(await gh.defaultBranch(SCRATCH)).toBe("main");
  expect(await gh.branchProtected(SCRATCH, "main")).toBe(false);
  expect(await gh.branchExists(SCRATCH, "main")).toBe(true);
  expect(await gh.readFile(SCRATCH, "README.md", "main")).toStartWith("# factory-scratch\n");
  // A label the repository has is left as it is: creating one would be a call nothing was recorded for.
  await gh.ensureLabel(SCRATCH, "factory", "5319e7", "Issues the AgentGate software factory works");

  const listed = await gh.openLabelledIssues(SCRATCH, "factory");
  expect(listed.more).toBe(false);
  expect(listed.issues).toEqual([
    {
      number: 4,
      title: "Slugs should handle non-English titles",
      body: expect.stringContaining("Crème brûlée"),
      url: `https://github.com/${SCRATCH}/issues/4`,
      updatedAt: "2026-11-10T08:45:18Z",
    },
  ]);
  const issue = await gh.issueStateAndComments(SCRATCH, 4);
  expect(issue.open).toBe(true);
  expect(issue.comments[0]).toMatchObject({ author: "HansKristoffer", authorAssociation: "OWNER" });
  expect(parseMarkers(issue.comments[0]!.body)).toEqual([
    expect.objectContaining({ key: "factory-scratch-4", stage: null, state: "open" }),
  ]);
  expect(await gh.issueComments(SCRATCH, 5)).toEqual([]);

  expect(await gh.openPrFor(SCRATCH, "agentgate/factory-init")).toBe(`https://github.com/${SCRATCH}/pull/1`);
  expect(await gh.prState(SCRATCH, 3)).toBe("MERGED");
  expect(await gh.prView(PR)).toEqual({
    number: 6,
    url: PR,
    title: "feat: add truncate(text, max) helper (m-566044)",
    state: "OPEN",
    isDraft: false,
    author: "HansKristoffer",
    headRefName: "factory/m-566044",
    headRefOid: "02239b4d97f2f8a9e489e903fe904726c700d0d5",
    baseRefName: "main",
    mergeable: "MERGEABLE",
    body: expect.stringContaining("<!-- agentgate-factory:summary -->"),
    comments: [],
  });
  const feedback = await gh.prFeedback(PR);
  expect(feedback.reviews.map((r) => [r.state, r.association, r.bot])).toEqual([
    ["COMMENTED", "OWNER", false],
    ["COMMENTED", "OWNER", false],
  ]);
  expect(feedback.conversations).toEqual([
    {
      id: "PRRT_kwDOVpGbC861ncLB",
      resolved: true,
      outdated: false,
      path: "src/truncate.ts",
      line: 1,
      canResolve: false,
      comments: [
        expect.objectContaining({ association: "OWNER", bot: false, at: "2026-11-10T08:39:55Z" }),
        expect.objectContaining({ body: expect.stringContaining("Fixed in 02239b4d97f2."), bot: false }),
      ],
    },
  ]);

  const followed = await gh.followedPrs(SCRATCH, [1, 3, 6, 7, 8]);
  expect([...followed].map(([number, pr]) => (pr instanceof Error ? pr : [number, pr.state, pr.isDraft]))).toEqual([
    [1, "OPEN", true],
    [3, "MERGED", false],
    [6, "OPEN", false],
    [7, "OPEN", false],
    [8, "OPEN", true],
  ]);
  expect(followed.get(3)).toMatchObject({ mergedAt: "2026-11-10T08:39:57Z", checks: "passing", failing: [] });
  // The follower's read carries the same feedback as the read of one PR.
  expect(followed.get(6)).toMatchObject({ author: "HansKristoffer", checks: "passing", comments: [], feedback });
  expect(await gh.defaultBranchCi(SCRATCH)).toBe("passing");

  const reverts = await gh.revertsSince("cli/cli", Date.parse("2026-09-01T00:00:00Z"));
  expect(gh.isRevertOf(reverts, REVERTED)).toBe(true);
});

test("a missing branch, file or repository is told from a failure by GitHub's 404, however it words it, and a repository without commits says so", async () => {
  replayGh(
    cleanup,
    "branchExists.missing",
    "readFile.missing",
    "branchExists.noRepo",
    "repoView.noRepo",
    "issueList.noRepo",
    "issueView.missing",
    "prState.missing",
    "mainChecks.noRepo",
    "repoView.empty",
    "branchExists.empty",
    "mainChecks.empty",
  );
  // The branches API words its 404 "Branch not found", contents "Not Found".
  expect(await gh.branchExists(SCRATCH, "no-such-branch")).toBe(false);
  expect(await gh.readFile(SCRATCH, "factory/no-such-file.yaml", "main")).toBe(undefined);

  // A repository GitHub does not show has no branch and no file either; the reads that need it pass on gh's reason.
  expect(await gh.branchExists(GONE, "main")).toBe(false);
  const noRepo = `Could not resolve to a Repository with the name '${GONE}'.`;
  await expect(gh.defaultBranch(GONE)).rejects.toThrow(
    `gh could not read the default branch of ${GONE}: GraphQL: ${noRepo} (repository)`,
  );
  await expect(gh.openLabelledIssues(GONE, "factory")).rejects.toThrow(
    `gh could not list the open issues labelled "factory" in ${GONE}: GraphQL: ${noRepo} (repository)`,
  );
  await expect(gh.defaultBranchCi(GONE)).rejects.toThrow(
    `gh could not read the checks on the default branch of ${GONE}: ${noRepo}`,
  );
  await expect(gh.issueStateAndComments(SCRATCH, 999)).rejects.toThrow(
    `gh could not read ${SCRATCH}#999: GraphQL: Could not resolve to an issue or pull request with the number of 999. (repository.issue)`,
  );
  await expect(gh.prState(SCRATCH, 999)).rejects.toThrow(
    `gh could not read the state of ${SCRATCH}#999: GraphQL: Could not resolve to a PullRequest with the number of 999. (repository.pullRequest)`,
  );

  // A repository without commits: no file, no branch, no checks, and no default branch to start from.
  expect(await gh.branchExists(EMPTY, "agentgate/factory-init")).toBe(false);
  expect(await gh.defaultBranchCi(EMPTY)).toBe("none");
  await expect(gh.defaultBranch(EMPTY)).rejects.toThrow(
    `${EMPTY} has no commits yet; push a first commit, then try again`,
  );
});

test("a gh that is offline, logged out or holds a dead token is never read as a missing branch, and each read says why it failed", async () => {
  const scenarios = [
    ["offline", "proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused"],
    ["noDns", "error connecting to proxy.invalid"],
    ["loggedOut", "gh is not logged in on this machine (gh auth login)"],
  ] as const;
  for (const [scenario, why] of scenarios) {
    replayGh(cleanup, `${scenario}.branchExists`, `${scenario}.repoView`);
    const branch = await gh.branchExists(SCRATCH, "main").catch((e: Error) => e.message);
    expect(branch).toStartWith(`gh could not read the branch main of ${SCRATCH}: `);
    expect(branch).toEndWith(why);
    const view = await gh.defaultBranch(SCRATCH).catch((e: Error) => e.message);
    expect(view).toStartWith(`gh could not read the default branch of ${SCRATCH}: `);
    expect(view).toEndWith(why);
  }
  replayGh(cleanup, "offline.issueList", "offline.prView", "offline.followed");
  const offline =
    'Post "https://api.github.com/graphql": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused';
  await expect(gh.openLabelledIssues(SCRATCH, "factory")).rejects.toThrow(
    `gh could not list the open issues labelled "factory" in ${SCRATCH}: ${offline}`,
  );
  await expect(gh.prView(PR)).rejects.toThrow(`gh could not read pull request ${SCRATCH}#6: ${offline}`);
  expect((await gh.followedPrs(SCRATCH, [6])).get(6)).toEqual(
    new Error(`gh could not read the pull requests the factory follows in ${SCRATCH}: ${offline}`),
  );

  // GitHub answered a token it does not know with a 401: its own message, from `gh api` and from `gh repo view`.
  replayGh(cleanup, "badToken.branchExists", "badToken.repoView");
  await expect(gh.branchExists(SCRATCH, "main")).rejects.toThrow(
    `gh could not read the branch main of ${SCRATCH}: Bad credentials`,
  );
  await expect(gh.defaultBranch(SCRATCH)).rejects.toThrow(
    `gh could not read the default branch of ${SCRATCH}: HTTP 401: Bad credentials (https://api.github.com/graphql)`,
  );

  // GitHub fails a whole query for one PR it cannot show, so each PR is then read on its own.
  replayGh(cleanup, "followed.missing", "followed.missing.6", "followed.missing.999");
  const found = await gh.followedPrs(SCRATCH, [6, 999]);
  expect(found.get(6)).toMatchObject({ number: 6, checks: "passing" });
  expect(found.get(999)).toEqual(
    new Error(
      `gh could not read the pull requests the factory follows in ${SCRATCH}: Could not resolve to a PullRequest with the number of 999.`,
    ),
  );
});

test("each gh.ts read rejects a malformed answer with an error naming the repository", async () => {
  const reads: (() => Promise<unknown>)[] = [
    () => gh.defaultBranch(SCRATCH),
    () => gh.openLabelledIssues(SCRATCH, "factory"),
    () => gh.issueStateAndComments(SCRATCH, 4),
    () => gh.issueComments(SCRATCH, 4),
    () => gh.issueState(SCRATCH, 4),
    () => gh.prView(PR),
    () => gh.defaultBranchCi(SCRATCH),
    () => gh.revertsSince(SCRATCH, Date.parse("2026-11-03T17:40:14Z")),
  ];
  for (const read of reads) {
    stubGh(() => ok({ surprise: [{ number: "seven" }] }));
    await expect(read()).rejects.toThrow(SCRATCH);
    // Not JSON at all, as when gh prints a table.
    stubGh(() => ({ ok: true, out: "7\tCrash on save\tOPEN" }));
    await expect(read()).rejects.toThrow(SCRATCH);
  }
  stubGh(() => undefined);
  await expect(gh.defaultBranch(SCRATCH)).rejects.toThrow(
    `gh could not read the default branch of ${SCRATCH}: gh is not installed`,
  );
  await expect(gh.prView("https://example.com/pull/1")).rejects.toThrow("is not a GitHub pull request URL");
});

const checkRun = (name: string, status: string, conclusion: string | null) => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
});
const commitStatus = (context: string, state: string) => ({ __typename: "StatusContext", context, state });
/** One page of a commit's checks, as GraphQL answers `contexts(first: 100)`. */
const page = (nodes: unknown[], hasNextPage = false) => ({ contexts: { nodes, pageInfo: { hasNextPage } } });
/** A branch's rules as GitHub's GraphQL answers them: a pull request rule ({}), the required checks, a rule without
 * parameters (null). */
const requiring = (...contexts: string[]) => ({
  refUpdateRule: null,
  rules: {
    nodes: [
      { parameters: {} },
      { parameters: { requiredStatusChecks: contexts.map((context) => ({ context })) } },
      { parameters: null },
    ],
  },
});

test("a PR's checks sum up to failing over pending over passing; when its base branch requires checks only those count, and one not reported yet is pending", async () => {
  // The follower's recorded read of factory-scratch#6, with other checks at its head and another base branch.
  const read = async (contexts: unknown[], baseRef: unknown = requiring()) => {
    const pr = recordedJson("followed").data.repository.p6;
    pr.baseRef = baseRef;
    pr.commits.nodes[0].commit.statusCheckRollup = page(contexts);
    stubGh(() => ok({ data: { repository: { p6: pr } } }));
    const followed = (await gh.followedPrs(SCRATCH, [6])).get(6)!;
    if (followed instanceof Error) throw followed;
    return [followed.checks, followed.failing];
  };
  // Without required checks, every check counts.
  expect(await read([])).toEqual(["none", []]);
  expect(await read([checkRun("lint", "COMPLETED", "SUCCESS"), checkRun("e2e", "COMPLETED", "SKIPPED")])).toEqual([
    "passing",
    [],
  ]);
  expect(await read([checkRun("lint", "COMPLETED", "SUCCESS"), checkRun("e2e", "IN_PROGRESS", null)])).toEqual([
    "pending",
    [],
  ]);
  expect(await read([checkRun("e2e", "IN_PROGRESS", null), commitStatus("ci/deploy", "ERROR")])).toEqual([
    "failing",
    ["ci/deploy"],
  ]);
  expect(await read([commitStatus("ci/deploy", "PENDING")])).toEqual(["pending", []]);

  // A failing preview the branch does not require holds nothing back, though it is named.
  const preview = checkRun("Preview", "COMPLETED", "FAILURE");
  const gate = requiring("All checks");
  expect(await read([checkRun("All checks", "COMPLETED", "SUCCESS"), preview], gate)).toEqual(["passing", ["Preview"]]);
  // A required check not reported yet is pending: there are checks, so no wait for them to register makes it green.
  expect(await read([checkRun("Lint", "COMPLETED", "SUCCESS"), preview], gate)).toEqual(["pending", ["Preview"]]);
  expect(await read([], gate)).toEqual(["pending", []]);
  // A failing required check fails the PR, and every failed check is named for the thread.
  const failed = [
    checkRun("All checks", "COMPLETED", "FAILURE"),
    checkRun("Unit tests", "COMPLETED", "FAILURE"),
    preview,
  ];
  expect(await read(failed, gate)).toEqual(["failing", ["All checks", "Preview", "Unit tests"]]);
  // A protection rule requires checks the same way, and a base branch GitHub no longer has requires none.
  const rule = { refUpdateRule: { requiredStatusCheckContexts: ["ci/build"] }, rules: { nodes: [] } };
  expect(await read([commitStatus("ci/build", "SUCCESS"), preview], rule)).toEqual(["passing", ["Preview"]]);
  expect(await read([commitStatus("ci/build", "SUCCESS"), preview], null)).toEqual(["failing", ["Preview"]]);
});

test("a commit with more checks than one read returns never passes on those: it stays pending, and a failure among them still fails it", async () => {
  // pytorch/pytorch#203997 as recorded: the 100 checks GitHub returned all passed or were skipped, and it has more.
  replayGh(cleanup, "followed.manyChecks");
  const recordedPage =
    recordedJson("followed.manyChecks").data.repository.p203997.commits.nodes[0].commit.statusCheckRollup.contexts;
  expect(recordedPage.nodes).toHaveLength(100);
  expect(recordedPage.pageInfo).toEqual({ hasNextPage: true });
  expect((await gh.followedPrs("pytorch/pytorch", [203997])).get(203997)).toMatchObject({
    checks: "pending",
    failing: [],
  });

  // One of the checks that were read failed: that needs no second page.
  const body = recordedJson("followed.manyChecks");
  const [first] = body.data.repository.p203997.commits.nodes[0].commit.statusCheckRollup.contexts.nodes;
  first.conclusion = "FAILURE";
  stubGh(() => ok(body));
  expect((await gh.followedPrs("pytorch/pytorch", [203997])).get(203997)).toMatchObject({
    checks: "failing",
    failing: [first.name],
  });

  // The default branch's checks are read the same way.
  const main = recordedJson("mainChecks");
  main.data.repository.defaultBranchRef.target.statusCheckRollup.contexts.pageInfo.hasNextPage = true;
  stubGh(() => ok(main));
  expect(await gh.defaultBranchCi(SCRATCH)).toBe("pending");
});

test("a review a person started and has not submitted is left out, with its comments", async () => {
  // A pending review cannot be recorded without starting one: GraphQL answers its `submittedAt` as null and marks its
  // comments PENDING. Both are added here to what was recorded for factory-scratch#6.
  const feedback = recordedJson("feedback");
  const { reviews, reviewThreads } = feedback.data.repository.pullRequest;
  reviews.nodes.push({ ...reviews.nodes[0], body: "Rename this before merging", submittedAt: null, state: "PENDING" });
  const [thread] = reviewThreads.nodes;
  const draft = { ...thread.comments.nodes[0], body: "Not sent yet", state: "PENDING" };
  thread.comments.nodes.push(draft);
  reviewThreads.nodes.push({ ...thread, id: "PRRT_draft", comments: { nodes: [draft] } });
  stubGh(() => ok(feedback));
  const read = await gh.prFeedback(PR);
  expect(read.reviews.map((r) => r.state)).toEqual(["COMMENTED", "COMMENTED"]);
  // The conversation keeps its two submitted comments, and the one that holds only a draft is not shown.
  expect(read.conversations.map((c) => [c.id, c.comments.map((m) => m.body.slice(0, 12))])).toEqual([
    ["PRRT_kwDOVpGbC861ncLB", ["Please count", "**m-566044**"]],
  ]);
});

test("the default branch's CI is the checks at its newest commit that count there, every one or the required ones that run there; and a merged PR with a revert in 14 days is reverted", async () => {
  const ci = async (defaultBranchRef: unknown) => {
    stubGh(() => ok({ data: { repository: { defaultBranchRef } } }));
    return gh.defaultBranchCi(SCRATCH);
  };
  const head = (rules: unknown, ...nodes: unknown[]) => ({
    ...(rules as object),
    target: { statusCheckRollup: page(nodes) },
  });
  const release = checkRun("Release", "COMPLETED", "FAILURE");
  // Without required checks, every check at the head counts.
  expect(await ci(head(requiring()))).toBe("none");
  expect(await ci(head(requiring(), checkRun("lint", "COMPLETED", "SUCCESS"), release))).toBe("failing");
  expect(await ci(head(requiring(), checkRun("lint", "IN_PROGRESS", null)))).toBe("pending");
  expect(await ci(null)).toBe("none");
  // With required checks, a failing release or deploy is not failing CI, and a required check that runs only on pull
  // requests leaves nothing to wait for.
  const rules = requiring("All checks", "build");
  expect(await ci(head(rules, release))).toBe("none");
  expect(await ci(head(rules, checkRun("build", "COMPLETED", "FAILURE")))).toBe("failing");
  expect(await ci(head(rules, checkRun("build", "COMPLETED", "SUCCESS"), release))).toBe("passing");

  const [revert]: gh.MergedRevert[] = recordedJson("reverts");
  const reverted = (patch: Partial<gh.MergedRevert>) => gh.isRevertOf([{ ...revert!, ...patch }], REVERTED);
  expect(reverted({})).toBe(true);
  expect(reverted({ body: "" })).toBe(true);
  expect(reverted({ body: "Reverts cli/cli#144370", title: "Revert the codesign action" })).toBe(false);
  expect(reverted({ body: "", title: "Undo the codesign action" })).toBe(false);
  expect(reverted({ mergedAt: "2026-09-30T14:11:21Z" })).toBe(false);
});

test("gh.ts writes: a post GitHub refused failed, one that never left this machine is unreachable, and only one nothing answered is uncertain", async () => {
  const comment = (answer: Answer) => {
    stubGh(() => answer);
    return gh.postIssueComment(SCRATCH, 4, "Hello");
  };
  const could = `gh could not comment on ${SCRATCH}#4`;
  // Certainly not sent: no gh, no login, no connection.
  expect(await comment(undefined)).toEqual({ status: "unreachable", error: `${could}: gh is not installed` });
  expect(await comment(recorded("loggedOut.branchExists"))).toEqual({
    status: "unreachable",
    error: `${could}: gh is not logged in on this machine (gh auth login)`,
  });
  expect(await comment(recorded("offline.branchExists"))).toEqual({
    status: "unreachable",
    error: `${could}: Get "https://api.github.com/repos/${SCRATCH}/branches/main": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused`,
  });
  expect(await comment(recorded("noDns.branchExists"))).toEqual({
    status: "unreachable",
    error: `${could}: error connecting to proxy.invalid`,
  });
  // GitHub said no with a 4xx, a 404 included.
  expect(await comment(recorded("badToken.branchExists"))).toEqual({
    status: "failed",
    error: `GitHub refused to comment on ${SCRATCH}#4: Bad credentials`,
  });
  expect(await comment(recorded("label.missing"))).toEqual({
    status: "failed",
    error: `GitHub refused to comment on ${SCRATCH}#4: Not Found`,
  });
  // A 5xx, written here as `gh api` prints an error since none could be recorded, and a gh stopped at its deadline.
  const outage = ghAnswer({ exit: 1, stdout: '{"message":"Server Error"}', stderr: "gh: Server Error (HTTP 502)\n" });
  expect(await comment(outage)).toEqual({
    status: "uncertain",
    error: `${could}, though GitHub may have taken it: Server Error`,
  });
  expect(await comment(noAnswer)).toEqual({
    status: "uncertain",
    error: `${could}, though GitHub may have taken it: gh gave no reason (exit 143)`,
  });

  // A reply is a GraphQL mutation: an answer with `errors` is a refusal, as recorded for a query.
  const reply = (answer: Answer) => {
    stubGh(() => answer);
    return gh.replyToConversation("PRRT_kwDOVpGbC861ncLB", "Fixed.");
  };
  expect(await reply(recorded("followed.noRepo"))).toEqual({
    status: "failed",
    error: `GitHub refused to reply in a review conversation: Could not resolve to a Repository with the name '${GONE}'.`,
  });
  expect((await reply(recorded("offline.followed"))).status).toBe("unreachable");
  expect((await reply(noAnswer)).status).toBe("uncertain");
});

test("a write is rate limited by a 429, a GraphQL RATE_LIMITED error or a 403 whose headers say so, and held back until the limit's own time; a 403 or 422 without them is a refusal", async () => {
  const advance = pinClock("2026-02-01T00:00:00Z");
  const comment = (answer: Answer) => {
    stubGh(() => answer);
    return gh.postIssueComment(SCRATCH, 4, "Hello");
  };
  const refused = (message: string) => ({
    status: "failed" as const,
    error: `GitHub refused to comment on ${SCRATCH}#4: ${message}`,
  });
  expect(await comment(ghError("403 Forbidden", ["X-Ratelimit-Remaining: 4999"], "Resource not accessible"))).toEqual(
    refused("Resource not accessible"),
  );
  expect(await comment(ghError("422 Unprocessable Entity", [], "Validation Failed"))).toEqual(
    refused("Validation Failed"),
  );

  // A spent primary limit lifts at its reset, in epoch seconds; until then nothing reaches gh.
  const reset = Date.parse("2026-02-01T00:05:00Z") / 1000;
  const spent = ghError(
    "403 Forbidden",
    ["X-Ratelimit-Remaining: 0", `X-Ratelimit-Reset: ${reset}`],
    "API rate limit exceeded",
  );
  expect(await comment(spent)).toEqual({
    status: "limited",
    error: `gh could not comment on ${SCRATCH}#4 yet: API rate limit exceeded`,
  });
  advance(4 * 60_000);
  const calls = stubGh(() => ok({ id: 1 }));
  expect(await gh.postIssueComment(SCRATCH, 4, "Hello")).toEqual({
    status: "limited",
    error: `gh could not comment on ${SCRATCH}#4 yet: GitHub's rate limit holds calls until 2026-02-01T00:05:00.000Z`,
  });
  expect(calls).toEqual([]);
  advance(60_000);
  expect((await gh.postIssueComment(SCRATCH, 4, "Hello")).status).toBe("posted");

  // Neither a 429 nor GraphQL's limit says when it lifts: a minute later it has.
  expect((await comment(ghError("429 Too Many Requests", [], "Too many requests"))).status).toBe("limited");
  advance(60_000);
  stubGh(() => ({
    ok: false,
    exit: 1,
    out: JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }),
  }));
  expect((await gh.replyToConversation("PRRT_kwDOVpGbC861ncLB", "Fixed.")).status).toBe("limited");
  advance(60_000);
  expect((await comment(ok({ id: 1 }))).status).toBe("posted");
});

test("an issue's state is one read that asks for no comments, and a merged pull request's number reads as closed", async () => {
  for (const [state, expected] of [
    ["OPEN", "OPEN"],
    ["CLOSED", "CLOSED"],
    ["MERGED", "CLOSED"],
  ] as const) {
    const calls = stubGh(() => ok({ state }));
    expect(await gh.issueState(SCRATCH, 4)).toBe(expected);
    expect(calls).toEqual([{ args: ["issue", "view", "4", "--repo", SCRATCH, "--json", "state"] }]);
  }
});

test("review requests skip the PR's author without reading the PR, and a failed gh pr command passes on gh's reason without a token or a URL's credentials", async () => {
  const done = (): Answer => ({ ok: true, out: "" });
  let calls = stubGh(done);
  await gh.prAddReviewers(PR, "HansKristoffer", ["hanskristoffer", "octocat"]);
  expect(calls).toEqual([{ args: ["pr", "edit", PR, "--add-reviewer", "octocat"] }]);
  calls = stubGh(done);
  await gh.prAddReviewers(PR, "HansKristoffer", ["HansKristoffer"]);
  expect(calls).toEqual([]);

  calls = stubGh(done);
  await gh.prSetBody(PR, "Fixes #4");
  await gh.prReady(PR);
  expect(calls).toEqual([
    { args: ["pr", "edit", PR, "--body-file", "-"], stdin: "Fixes #4" },
    { args: ["pr", "ready", PR] },
  ]);

  stubGh(() =>
    ghAnswer({
      exit: 1,
      stdout: "",
      stderr:
        'Post "https://octocat:hunter2@proxy.example/graphql": refused for ghp_0123456789abcdefghijABCDEFGHIJ012345\nUsage: gh pr ready\n',
    }),
  );
  await expect(gh.prReady(PR)).rejects.toThrow(
    new Error(
      `gh could not mark ${SCRATCH}#6 ready for review: Post "https://proxy.example/graphql": refused for [redacted]`,
    ),
  );
});

/** A comment on an issue as GitHub lists it. */
const comment = (body: string, login = FACTORY_LOGIN, authorAssociation = "OWNER") => ({
  body,
  author: { login },
  authorAssociation,
  createdAt: "2026-11-06T10:00:00Z",
});

test("a comment on the issue answers its question: free text goes to the thread once, and an outsider's comment or one with a marker is not an answer", async () => {
  const n = await githubFactory();
  n.github.add(1);
  await n.intake();
  await n.dispatch();
  await idle(n.f);
  const [run] = runs.list(n.s, { kinds: ["triage"] });
  await n.report(run!, {
    outcome: "needs-decision",
    summary: "Two ways.",
    decision: { question: "Keep v1 alive?", recommendation: "Yes" },
  });
  const issue = n.github.issues.get(1)!;
  expect(issue.comments.at(-1)!.body).toContain("Keep v1 alive?");
  const sent = () => n.mcp.calls.filter((c) => c.tool === "t3_thread_send").map((c) => String(c.args.message));
  const before = sent().length;

  // Someone outside the repository, and a comment carrying a marker, answer nothing.
  const waiting = issue.comments.at(-1)!.body;
  issue.comments.push(comment("/approve", "mallory", "NONE"));
  issue.comments.push(comment(`/approve\n\n${waiting.slice(waiting.indexOf(MARKER_PREFIX))}`, "teammate", "MEMBER"));
  await n.intake();
  await idle(n.f);
  expect(items.get(n.s, run!.item!)!.needsYou).toMatchObject({ cause: "decision" });

  // The maintainer's own login, which the factory also comments as, answers in its own words.
  issue.comments.push(comment("Keep it for a week, then drop it."));
  await n.intake();
  await idle(n.f);
  expect(items.get(n.s, run!.item!)!.needsYou).toBeUndefined();
  expect(sent()).toHaveLength(before + 1);
  expect(sent().at(-1)).toStartWith("The maintainer answered: Keep it for a week, then drop it.");

  // Asked again, the comment already used is not a second answer.
  await n.report(run!, {
    outcome: "needs-decision",
    summary: "?",
    decision: { question: "And v0?", recommendation: "No" },
  });
  await n.intake();
  await idle(n.f);
  expect(items.get(n.s, run!.item!)!.needsYou).toMatchObject({ question: "And v0?" });
  expect(sent()).toHaveLength(before + 1);

  // /reject takes its reason along.
  issue.comments.push(comment("/reject v0 still has users", "teammate", "MEMBER"));
  await n.intake();
  await idle(n.f);
  expect(items.get(n.s, run!.item!)!.needsYou).toBeUndefined();
  expect(sent().at(-1)).toStartWith("The maintainer rejected your recommendation: v0 still has users.");
});

test("/approve on a held issue starts it, and free text there is not an approval", async () => {
  const n = await githubFactory((repo) => [{ ...source(repo), intake: "hold" }]);
  n.github.add(1);
  await n.intake();
  await idle(n.f);
  const [item] = items.list(n.s);
  expect(item).toMatchObject({ phase: "held", needsYou: { kind: "start" } });
  const issue = n.github.issues.get(1)!;
  issue.comments.push(comment("Looks real to me."));
  await n.intake();
  await idle(n.f);
  expect(items.get(n.s, item!.id)!.phase).toBe("held");
  issue.comments.push(comment("/approve"));
  await n.intake();
  await idle(n.f);
  expect(items.get(n.s, item!.id)!.phase).toBe("triage");
  expect(n.f.events.recent(20).map((e) => e.text)).toContain(
    `Approved ${item!.key}; triage is queued, from a comment on its issue`,
  );

  // The comment it used is remembered while the item is open, and forgotten once it closes.
  const seen = `factory:answer-seen:${item!.id}`;
  expect(n.s.local(seen)).toBeDefined();
  moveItem(n.f, item!.id, "closed", true);
  expect(n.s.local(seen)).toBeUndefined();
});
