import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, afterEach, expect, test } from "bun:test";
import { items, newId, runs, scores, type FactoryRun } from "../src/factory/db.ts";
import { fetcher } from "../src/factory/folder.ts";
import { loopTask } from "../src/factory/runtime.ts";
import { host } from "../src/logins.ts";
import { updateSkill, updateSkills, writeSkillMd } from "../src/skills.ts";
import { removeTmp, repos } from "./fixtures/git.ts";
import { factoryNode } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const MINUTE = 60_000;
const DAY = 86_400_000;
const GOOD_BODY =
  "## Targets\n\nstages/implement.md\n\n## Runs addressed\n\nrun_1\n\n## Evidence\n\n#12\n\n## Expected effect\n\nFewer reverts.";
const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nDo it well.\n`;

/** The factory machine whose folder lives in a repository of its own, with GitHub answering for that repository's
 * pull requests and recording the comments the factory posts on them. */
async function learnFactory(files: Record<string, string> = {}) {
  const n = await factoryNode(cleanup, { config: { learning: { every: "7d" } }, files });
  const factoryRepo = repos()
    .url.replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
  const used = await n.command("use", factoryRepo, "--node", "a");
  if (used.code) throw new Error(used.output.join("\n"));

  const prs = new Map<string, { files: string[]; body: string }>();
  const comments: { pr: number; body: string }[] = [];
  const realGh = host.gh;
  host.gh = async (args, stdin) => {
    const comment = args[1]?.match(/^repos\/.+\/issues\/(\d+)\/comments$/);
    if (args[0] === "api" && comment) {
      comments.push({ pr: Number(comment[1]), body: JSON.parse(stdin!).body });
      return { ok: true, out: "{}" };
    }
    const pr = args[0] === "pr" && args[1] === "view" ? prs.get(args[2]!) : undefined;
    if (!pr) throw new Error(`the fake GitHub has no answer for gh ${args.join(" ")}`);
    return {
      ok: true,
      out: JSON.stringify({
        number: Number(args[2]!.split("/").at(-1)),
        url: args[2],
        title: "Learn from the week",
        state: "OPEN",
        isDraft: false,
        author: { login: "maintainer" },
        headRefName: "factory/learn",
        headRefOid: "a".repeat(40),
        baseRefName: "main",
        mergedAt: null,
        statusCheckRollup: [],
        mergeable: "MERGEABLE",
        body: pr.body,
        files: pr.files.map((path) => ({ path })),
        comments: [],
        reviews: [],
      }),
    };
  };
  cleanup.push(() => (host.gh = realGh));

  const builtin = (await n.ctx.gateway.builtin!()).client;
  const tool = async (name: string, args: Record<string, unknown> = {}, thread?: string) => {
    const result = await builtin.callTool({
      name,
      arguments: args,
      ...(thread && { _meta: { "dev.agentgate/t3Thread": thread } }),
    });
    const text = (result.content as { text: string }[])[0]!.text;
    return { text, value: result.isError ? { error: text } : JSON.parse(text) };
  };
  const learnLoop = loopTask(
    n.f,
    n.f.loops.find((l) => l.name === "factory-learn")!,
  );
  return {
    ...n,
    factoryRepo,
    prs,
    comments,
    tool: async (name: string, args: Record<string, unknown> = {}) => (await tool(name, args)).value,
    /** The raw text a history page comes back as. */
    historyText: async (args: Record<string, unknown>) => (await tool("factory_history", args)).text,
    learnLoop,
    learnRuns: () => runs.list(n.s, { kinds: ["learn"] }),
    /** factory_report from the run's own thread. */
    report: async (run: FactoryRun, body: Record<string, unknown>) =>
      (await tool("factory_report", { run: run.id, ...body }, runs.get(n.s, run.id)!.threadId)).value,
    /** A learn run, dispatched to its thread. */
    async started() {
      await n.dispatch();
      return runs.get(n.s, this.learnRuns().at(-1)!.id)!;
    },
    /** An item that shipped now. */
    finish(key: string, title = `Item ${key}`) {
      return items.insert(n.s, {
        id: newId("it"),
        source: "manual",
        externalId: crypto.randomUUID(),
        key,
        repo: n.repo,
        title,
        snapshot: {},
        phase: "shipped",
        configCommit: n.commit,
        tokens: 0,
      });
    },
  };
}

const nothingToDo = { outcome: "nothing-to-do", summary: "Nothing to change." };

test("a learn run starts every learning.every, on learn, factory_learn and POST /learn, in a worktree of the factory repo, and not when nothing finished since the last one", async () => {
  const n = await learnFactory();
  expect((await n.command("learn")).output).toEqual([
    "Skipped: No item has finished yet, so there is nothing to learn from",
  ]);

  n.finish("gh-1");
  await n.learnLoop();
  expect(n.learnRuns()).toEqual([]); // the week counts from the first item that finished
  n.advance(7 * DAY);
  await n.learnLoop();
  const weekly = await n.started();
  expect(weekly.state).toBe("running");
  const launch = n.mcp.calls.find((c) => c.tool === "t3_thread_launch" && c.args.clientRequestId === weekly.id)!;
  const project = n.t3.projects.find((p) => p.id === launch.args.projectId)!;
  expect(project.title).toBe(n.factoryRepo.split("/")[1]!);
  expect(launch.args.workspaceStrategy).toEqual({
    type: "worktree",
    baseRef: "main",
    branch: `factory/learn-${weekly.id}`,
    startFromOrigin: true,
  });
  const brief = String(launch.args.message);
  expect(brief).toContain("`factory_history`");
  expect(brief).toContain(`gh pr list --repo <repo> --state merged`);
  expect(brief).toContain("gh issue list --repo <repo> --state closed");
  expect(brief).toContain(`The factory works in \`${n.repo}\``);
  for (const section of ["## Targets", "## Runs addressed", "## Evidence", "## Expected effect"])
    expect(brief).toContain(section);
  expect(brief).toContain("never change `rulings.md`");
  expect(brief).toContain("- Keep public field names."); // the rulings, cited
  expect(await n.report(weekly, nothingToDo)).toEqual({ accepted: true });

  // Nothing finished since: neither the next week nor a request starts one.
  n.advance(7 * DAY);
  await n.learnLoop();
  const since = new Date(weekly.queuedAt).toISOString().slice(0, 10);
  expect((await n.command("learn")).output).toEqual([`Skipped: No item finished since the last learn run on ${since}`]);
  expect(await n.tool("factory_learn")).toEqual({ skipped: `No item finished since the last learn run on ${since}` });
  expect(n.learnRuns()).toHaveLength(1);

  n.finish("gh-2");
  const asked = await n.tool("factory_learn");
  expect(asked).toEqual({ run: expect.stringMatching(/^run_/) });
  expect((await n.command("learn")).output).toEqual([`Skipped: The learn run ${asked.run} has not finished yet`]);
  const second = await n.started();
  expect(String(n.t3.threads.get(second.threadId!)!.messages[0])).toContain(`{ since: ${weekly.queuedAt} }`);
  expect(await n.report(second, nothingToDo)).toEqual({ accepted: true });

  n.advance(MINUTE);
  n.finish("gh-3");
  const posted = await n.api("/api/factory/learn", "POST");
  expect(await posted.json()).toEqual({ run: expect.stringMatching(/^run_/) });
  expect(n.learnRuns().map((r) => r.state)).toEqual(["reported", "reported", "queued"]);
});

test("a learn run reports nothing-to-do or a PR on the factory repo; a PR that changes rulings.md or lacks a section gets one comment and the run is flawed", async () => {
  const n = await learnFactory();
  n.finish("gh-1");
  await n.tool("factory_learn");
  const run = await n.started();
  const pr = (number: number) => `https://github.com/${n.factoryRepo}/pull/${number}`;
  const learned = (prUrl: string) => ({
    outcome: "done",
    summary: "Tightened the implement brief.",
    result: { kind: "learn", prUrl, lessons: ["Bug fixes need a failing test first."] },
  });

  expect(await n.report(run, { outcome: "done", summary: "Done." })).toEqual({
    error: 'The outcome done needs result: { kind: "learn", prUrl, lessons }; report nothing-to-do without a PR',
  });
  expect(await n.report(run, learned(`https://github.com/${n.repo}/pull/3`))).toEqual({
    error: `The learning PR belongs on ${n.factoryRepo}, not https://github.com/${n.repo}/pull/3`,
  });
  expect(await n.report(run, { outcome: "not-a-bug", summary: "No." })).toEqual({
    error: "A learn run reports done or nothing-to-do, not not-a-bug",
  });

  n.prs.set(pr(7), { files: ["stages/implement.md"], body: GOOD_BODY });
  expect(await n.report(run, learned(pr(7)))).toEqual({ accepted: true });
  expect(runs.get(n.s, run.id)!).toMatchObject({ state: "reported", checked: { pr: pr(7), problems: [] } });
  expect(runs.get(n.s, run.id)!.verdict).toBeUndefined();
  expect(n.comments).toEqual([]);

  n.finish("gh-2");
  await n.tool("factory_learn");
  const flawed = await n.started();
  n.prs.set(pr(8), {
    files: ["stages/implement.md", "rulings.md"],
    body: GOOD_BODY.replace("## Evidence", "## Proof"),
  });
  expect(await n.report(flawed, learned(pr(8)))).toEqual({ accepted: true });
  expect(runs.get(n.s, flawed.id)!).toMatchObject({
    verdict: "flawed",
    checked: {
      pr: pr(8),
      problems: ["it changes rulings.md, which only the maintainer changes", "it has no Evidence section"],
    },
  });
  expect(n.comments).toHaveLength(1);
  expect(n.comments[0]!.pr).toBe(8);
  expect(n.comments[0]!.body).toContain("- It changes rulings.md, which only the maintainer changes.");
  expect(n.comments[0]!.body).toContain("- It has no Evidence section.");
});

test("the folder's skills are installed and linked into the factory's repositories, and removed when they leave the folder or the factory turns off", async () => {
  const n = await learnFactory({
    "skills/review-tips/SKILL.md": skill("review-tips", "How we review"),
    "skills/style/SKILL.md": skill("style", "House style"),
  });
  const source = `factory:${n.factoryRepo.toLowerCase()}`;
  const factorySkills = () =>
    n.s
      .list("skill")
      .filter((k) => k.source?.startsWith("factory:"))
      .map((k) => [k.id, k.source]);
  const linked = () => n.s.get("project", n.repo)?.skills.toSorted() ?? [];
  // Installed when `use` loaded the folder, under the factory repo it came from.
  expect(factorySkills()).toEqual([
    ["review-tips", source],
    ["style", source],
  ]);
  expect(linked()).toEqual(["review-tips", "style"]);
  // Only the folder updates them: the hourly skill update never asks the skills CLI for a `factory:` source.
  const asked: string[] = [];
  expect(await updateSkills(n.s, async (from) => (asked.push(from), []))).toEqual([]);
  expect(asked).toEqual([]);
  await expect(updateSkill(n.s, "style", async (from) => (asked.push(from), []))).rejects.toThrow(
    `style follows the factory folder ${n.factoryRepo.toLowerCase()}; it updates when the folder loads`,
  );
  expect(asked).toEqual([]);

  // The next commit drops `style` and adds `notes`, a name a person already wrote a skill under.
  writeSkillMd(n.s, "notes", skill("notes", "Mine"));
  const commit = "b".repeat(40);
  const dir = join(fetcher.root, commit);
  const next = {
    "factory.yaml": JSON.stringify({ version: 1, name: "acme", repositories: { [n.repo]: {} } }),
    "skills/review-tips/SKILL.md": skill("review-tips", "How we review, rewritten"),
    "skills/notes/SKILL.md": skill("notes", "The factory's notes"),
  };
  for (const [file, text] of Object.entries(next)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  fetcher.fetch = async () => ({ commit, dir });
  expect((await n.command("reload")).code).toBe(0);
  expect(factorySkills()).toEqual([["review-tips", source]]);
  expect(n.s.get("skill", "review-tips")!.description).toBe("How we review, rewritten");
  expect(n.s.get("skill", "style")).toBeUndefined();
  expect(n.s.get("skill", "notes")!.description).toBe("Mine");
  expect(linked()).toEqual(["review-tips"]);
  expect(n.f.events.recent(5).map((e) => e.text)).toContain(
    "The factory's skills are review-tips; skipped notes: a skill with this name already exists",
  );

  expect((await n.command("off")).code).toBe(0);
  expect(factorySkills()).toEqual([]);
  expect(linked()).toEqual([]);
  expect(n.s.get("skill", "notes")).toBeDefined();
});

test("factory_history returns finished items with their runs, outcomes, scores and threads, in pages of at most 20,000 characters with a cursor", async () => {
  const n = await learnFactory();
  const long = "x".repeat(5000);
  const ids: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const item = n.finish(`gh-${i}`, `Item ${i} ${long}`);
    ids.push(item.id);
    for (const kind of ["triage", "implement"] as const) {
      const run = runs.insert(n.s, {
        id: newId("run"),
        item: item.id,
        kind,
        attempt: 1,
        state: "reported",
        nudges: 0,
        configCommit: n.commit,
        threadId: `thread-${i}-${kind}`,
        verdict: "flawed",
        report: { run: "x", outcome: "done", summary: long.slice(0, 2000) },
        endedAt: n.s.now(),
      });
      ids.push(run.id);
      if (kind === "implement")
        scores.put(n.s, {
          run: run.id,
          scorer: "tests-first",
          label: "missing",
          score: 0,
          passed: false,
          reasoning: long,
          judgeRun: "run_judge",
          at: n.s.now(),
        });
    }
  }
  // Another repository's item, and one still open, are left out of a page for this repository.
  items.insert(n.s, {
    ...items.get(n.s, ids[0]!)!,
    id: newId("it"),
    externalId: "other",
    key: "other-1",
    repo: "acme/other",
  });
  items.insert(n.s, {
    ...items.get(n.s, ids[0]!)!,
    id: newId("it"),
    externalId: "open",
    key: "open-1",
    phase: "implement",
  });

  const seen: { type: string; id: string }[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const text = await n.historyText({ repo: n.repo.toUpperCase(), ...(cursor && { cursor }) });
    expect(text.length).toBeLessThanOrEqual(20_000);
    const page = JSON.parse(text);
    seen.push(...page.entries);
    cursor = page.next;
    pages++;
  } while (cursor);
  expect(pages).toBeGreaterThan(1);
  expect(seen.map((e) => e.id)).toEqual(ids);

  const implement = seen.find((e) => e.id === ids[2]) as Record<string, unknown>;
  expect(implement).toMatchObject({
    type: "run",
    kind: "implement",
    verdict: "flawed",
    threadId: "thread-1-implement",
    outcome: "done",
    scores: [{ scorer: "tests-first", label: "missing", passed: false }],
  });
  expect(seen[0]).toMatchObject({ type: "item", key: "gh-1", outcome: { humanTouches: 0, tokens: 0 } });

  n.advance(MINUTE);
  n.finish("gh-13");
  const later = JSON.parse(await n.historyText({ since: n.s.now() }));
  expect(later.entries.map((e: { key?: string }) => e.key)).toEqual(["gh-13"]);
  expect(await n.tool("factory_history", { cursor: "-1" })).toEqual({
    error: "cursor is the next value of an earlier page",
  });
});
