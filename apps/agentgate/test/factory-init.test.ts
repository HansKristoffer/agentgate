import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FACTORY_INIT_BRANCH } from "@agentgate/protocol";
import { app, makeCtx } from "../src/daemon.ts";
import { loadFolder } from "../src/factory/config.ts";
import { fetcher } from "../src/factory/folder.ts";
import { initTemplate } from "../src/factory/init.ts";
import { loopTask, runCommand, type FactoryRuntime } from "../src/factory/runtime.ts";
import { host } from "../src/logins.ts";
import { Store } from "../src/store.ts";
import { recorded } from "./fixtures/gh.ts";
import { removeTmp, tmp } from "./fixtures/git.ts";

const REPO = "acme/api";
const realGh = host.gh;
const realFetch = fetcher.fetch;
const cleanup: (() => unknown)[] = [];
beforeEach(() => {
  fetcher.root = tmp("agentgate-factory-init-");
});
afterEach(async () => {
  host.gh = realGh;
  fetcher.fetch = realFetch;
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
afterAll(removeTmp);

const ok = (value: unknown) => ({ ok: true, out: typeof value === "string" ? value : JSON.stringify(value) });

/** GitHub for one repository, answering the gh calls `factory init` and the folder loop make. What is not there, and
 * a repository without commits, are answered as GitHub was recorded answering them (fixtures/gh-recorded.json). */
function fakeGitHub() {
  const github = {
    files: new Set<string>(),
    branches: new Set<string>(["main"]),
    labels: new Set<string>(),
    prs: new Map<number, { head: string; state: "OPEN" | "CLOSED" | "MERGED"; draft: boolean; title: string }>(),
    empty: false,
    labelsFail: false,
    /** The tree and commit init wrote. */
    tree: [] as { path: string; content: string }[],
    commit: undefined as { message: string; tree: string; parents: string[] } | undefined,
    calls: [] as string[][],
    /** Calls that write to GitHub. */
    writes: () =>
      github.calls.filter((c) => c.includes("POST") || c.includes("PATCH") || (c[0] === "pr" && c[1] === "create")),
    /** Branches moved to a new commit, as init does with one an earlier, failed init left. */
    moved: [] as string[],
  };
  host.gh = async (args, stdin) => {
    github.calls.push(args);
    const [cmd, sub] = args;
    if (cmd === "repo" && sub === "view")
      return github.empty ? recorded("repoView.empty") : ok({ defaultBranchRef: { name: "main" } });
    if (cmd === "pr" && sub === "create") {
      const number = 7 + github.prs.size;
      const flag = (name: string) => args[args.indexOf(name) + 1]!;
      github.prs.set(number, {
        head: flag("--head"),
        state: "OPEN",
        draft: args.includes("--draft"),
        title: flag("--title"),
      });
      return ok(`https://github.com/${REPO}/pull/${number}\n`);
    }
    if (cmd === "pr" && sub === "list") {
      const head = args[args.indexOf("--head") + 1];
      const open = [...github.prs].filter(([, p]) => p.head === head && p.state === "OPEN");
      return ok(open.map(([n]) => ({ url: `https://github.com/${REPO}/pull/${n}` })));
    }
    if (cmd === "pr" && sub === "view") return ok({ state: github.prs.get(Number(args[2]))!.state });
    if (cmd !== "api") throw new Error(`the fake GitHub has no answer for gh ${args.join(" ")}`);
    const path = sub!.replace(`repos/${REPO}/`, "");
    const post = args.includes("POST");
    if (path.startsWith("contents/")) {
      if (github.empty) return recorded("fileExists.empty");
      return github.files.has(path.slice(9)) ? ok(path.slice(9)) : recorded("fileExists.missing");
    }
    if (path.startsWith("branches/")) {
      const branch = decodeURIComponent(path.slice(9));
      if (github.empty) return recorded("branchExists.empty");
      return github.branches.has(branch)
        ? ok({ name: branch, protected: branch === "main" })
        : recorded("branchExists.missing");
    }
    if (path === "git/ref/heads/main") return ok({ object: { sha: "base" } });
    if (path === "git/commits/base") return ok({ tree: { sha: "base-tree" } });
    if (path === "git/trees" && post) {
      github.tree = JSON.parse(stdin!).tree;
      return ok({ sha: "tree-1" });
    }
    if (path === "git/commits" && post) {
      github.commit = JSON.parse(stdin!);
      return ok({ sha: "commit-1" });
    }
    if (path === "git/refs" && post) {
      github.branches.add(JSON.parse(stdin!).ref.replace("refs/heads/", ""));
      return ok({ ref: "created" });
    }
    if (path.startsWith("git/refs/heads/") && args.includes("PATCH")) {
      github.moved.push(path.slice("git/refs/heads/".length));
      return ok({ ref: "moved" });
    }
    if (path.startsWith("labels/"))
      return github.labels.has(decodeURIComponent(path.slice(7))) ? ok("factory") : recorded("label.missing");
    if (path === "labels" && post) {
      if (github.labelsFail) return { ok: false, out: JSON.stringify({ message: "Must have admin rights" }) };
      github.labels.add(JSON.parse(stdin!).name);
      return ok({});
    }
    throw new Error(`the fake GitHub has no answer for gh ${args.join(" ")}`);
  };
  return github;
}

/** The folder git would fetch: the template on the init branch, the same files on main once merged. */
function fakeFetcher(github: ReturnType<typeof fakeGitHub>) {
  const fetched: (string | undefined)[] = [];
  fetcher.fetch = async ({ ref }) => {
    fetched.push(ref);
    if (ref && !github.branches.has(ref)) throw new Error(`git could not fetch ${ref} of ${REPO}`);
    const commit = (ref ? "a" : "b").repeat(40);
    const dir = join(fetcher.root, commit);
    for (const [path, content] of Object.entries(initTemplate(REPO))) {
      const file = join(dir, path.replace(/^factory\//, ""));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    return { commit, dir };
  };
  return fetched;
}

function node() {
  const s = new Store(":memory:");
  s.setLocal("node", "a");
  s.put("node", "a", { id: "a", protocol: 8 });
  s.now = () => 1_000;
  const ctx = makeCtx(s);
  cleanup.push(async () => {
    ctx.abort.abort();
    ctx.skills.close();
    ctx.imports.close();
    await ctx.gateway.close();
    s.close();
  });
  const f = ctx.factory;
  const command = async (...args: string[]) => {
    const output: string[] = [];
    const code = await runCommand(f, args[0]!, args.slice(1), { out: (line) => output.push(line) }).catch(
      (e: Error) => {
        output.push(e.message);
        return 1;
      },
    );
    return { code, output };
  };
  const api = (path: string, body: unknown) =>
    app(ctx).fetch(
      new Request(`http://127.0.0.1:7878/api/factory${path}`, {
        method: "POST",
        headers: { host: "127.0.0.1:7878", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { listener: "loopback" },
    );
  return { s, f, command, api };
}

const folderLoop = (f: FactoryRuntime) =>
  loopTask(
    f,
    f.loops.find((l) => l.name === "factory-folder")!,
  )();

test("init pushes the template to its branch in one commit, opens a draft PR, creates the label and turns the factory on there", async () => {
  const github = fakeGitHub();
  fakeFetcher(github);
  const { s, api } = node();

  const res = await api("/init", { repo: REPO });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    prUrl: `https://github.com/${REPO}/pull/7`,
    branch: FACTORY_INIT_BRANCH,
    warnings: [],
    factory: {
      store: "github",
      repo: REPO,
      path: "factory",
      ref: FACTORY_INIT_BRANCH,
      node: "a",
      online: true,
      lastSeenAt: 1_000,
    },
    config: { commit: "a".repeat(40), name: "api", loadedAt: 1_000, repositories: [REPO] },
  });
  expect(github.tree.map((t) => t.path)).toEqual(["factory/factory.yaml", "factory/rulings.md"]);
  expect(github.commit).toEqual({
    message: "chore(factory): start a software factory",
    tree: "tree-1",
    parents: ["base"],
  });
  expect(github.prs.get(7)).toMatchObject({ head: FACTORY_INIT_BRANCH, draft: true, state: "OPEN" });
  expect(github.labels.has("factory")).toBe(true);
  expect(s.settings().factory).toEqual({
    store: "github",
    repo: REPO,
    path: "factory",
    ref: FACTORY_INIT_BRANCH,
    node: "a",
    init: { pr: 7 },
  });
});

test("factory init --json prints what the route answers, and the template parses and loads as a folder", async () => {
  const github = fakeGitHub();
  fakeFetcher(github);
  const viaApi = await (await node().api("/init", { repo: REPO })).json();
  const again = fakeGitHub();
  fakeFetcher(again);
  const { code, output } = await node().command("init", REPO, "--json");
  expect(code).toBe(0);
  expect(JSON.parse(output[0]!)).toEqual(viaApi);

  const dir = tmp();
  for (const [path, content] of Object.entries(initTemplate("Acme/My_API.v2"))) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const folder = loadFolder(join(dir, "factory"), "c".repeat(40));
  expect(folder.config).toMatchObject({
    name: "my-api-v2",
    repositories: { "Acme/My_API.v2": {} },
    sources: [{ id: "issues", type: "github", repo: "Acme/My_API.v2", label: "factory" }],
  });
  // The rulings file asks about greenfield and owned packages in a comment, which never reaches a brief.
  expect(initTemplate(REPO)["factory/rulings.md"]).toContain("Packages you own");
  expect(folder.rulings).toBe("# Rulings");
});

test("init refuses before writing anything: a factory on, a folder there, an open init PR, an empty repository; a label it cannot create is a warning", async () => {
  const github = fakeGitHub();
  fakeFetcher(github);
  const a = node();
  const refused = async (why: string) => {
    expect(await a.command("init", REPO)).toEqual({ code: 1, output: [why] });
    expect(github.writes()).toEqual([]);
  };

  github.files.add("factory/factory.yaml");
  await refused(`${REPO} already has factory/factory.yaml; turn it on with agentgate factory use ${REPO}:factory`);
  github.files.clear();

  github.branches.add(FACTORY_INIT_BRANCH);
  github.prs.set(3, { head: FACTORY_INIT_BRANCH, state: "OPEN", draft: true, title: "x" });
  await refused(`An init PR for ${REPO} is open: https://github.com/${REPO}/pull/3. Merge or close it first`);
  github.prs.clear();

  github.empty = true;
  await refused(`${REPO} has no commits yet; push a first commit, then try again`);
  github.empty = false;

  // A branch an earlier init left without an open PR, as when opening the PR failed: init moves it to its commit.
  github.labelsFail = true;
  const done = await a.command("init", REPO);
  expect(done.code).toBe(0);
  expect(github.moved).toEqual([FACTORY_INIT_BRANCH]);
  expect(done.output).toContain(
    "Warning: Creating the factory label failed (gh could not create the label factory in acme/api: Must have admin rights); create it before labelling issues",
  );

  // The factory is on now: a second init refuses before it asks GitHub anything.
  const asked = github.calls.length;
  expect(await a.command("init", REPO)).toEqual({
    code: 1,
    output: [
      `The factory is on, ${REPO}:factory at ${FACTORY_INIT_BRANCH}; turn it off with agentgate factory off before init`,
    ],
  });
  expect(github.calls).toHaveLength(asked);
});

test("once the init PR merges, the factory follows the default branch even though the branch is gone; a closed PR keeps the branch", async () => {
  const github = fakeGitHub();
  const fetched = fakeFetcher(github);
  const { s, f, api } = node();
  await api("/init", { repo: REPO });

  await folderLoop(f);
  expect(s.settings().factory).toMatchObject({ ref: FACTORY_INIT_BRANCH, init: { pr: 7 } });

  // The branch is deleted, so its fetch fails and backs off; then the merge shows on GitHub.
  github.branches.delete(FACTORY_INIT_BRANCH);
  await folderLoop(f);
  expect(f.events.recent(5).map((e) => e.text)).toContainEqual(
    expect.stringContaining("Fetching the factory folder failed"),
  );
  github.prs.get(7)!.state = "MERGED";
  fetched.length = 0;
  await folderLoop(f);
  expect(s.settings().factory).toEqual({ store: "github", repo: REPO, path: "factory", node: "a" });
  expect(fetched).toEqual([undefined]);
  expect(f.events.recent(10).map((e) => e.text)).toContain(
    `The init PR #7 merged; the factory follows ${REPO}'s default branch`,
  );
  // Without `init`, GitHub is not asked about any PR again.
  const views = () => github.calls.filter((c) => c[0] === "pr" && c[1] === "view").length;
  const before = views();
  await folderLoop(f);
  expect(views()).toBe(before);
});

test("moving the factory keeps the init PR it waits on, so the machine it lands on still follows the merge", async () => {
  const github = fakeGitHub();
  fakeFetcher(github);
  const { s, f, api, command } = node();
  await api("/init", { repo: REPO });
  s.put("node", "b", { id: "b", protocol: 8 });

  expect((await command("move", "b")).code).toBe(0);
  expect(s.settings().factory).toEqual({
    store: "github",
    repo: REPO,
    path: "factory",
    ref: FACTORY_INIT_BRANCH,
    init: { pr: 7 },
    node: "b",
  });
  expect((await command("move", "nowhere")).output).toEqual([
    "No machine is named nowhere; agentgate status lists them",
  ]);

  expect((await api("/move", { node: "a" })).status).toBe(200);
  github.prs.get(7)!.state = "MERGED";
  await folderLoop(f);
  expect(s.settings().factory).toEqual({ store: "github", repo: REPO, path: "factory", node: "a" });
});

test("a closed init PR leaves the factory on its branch, says so, and stops asking", async () => {
  const github = fakeGitHub();
  fakeFetcher(github);
  const { s, f, api } = node();
  await api("/init", { repo: REPO });
  github.prs.get(7)!.state = "CLOSED";
  await folderLoop(f);
  expect(s.settings().factory).toEqual({
    store: "github",
    repo: REPO,
    path: "factory",
    ref: FACTORY_INIT_BRANCH,
    node: "a",
  });
  expect(f.events.recent(10).map((e) => e.text)).toContain(
    `The init PR #7 was closed without merging; the factory still runs ${FACTORY_INIT_BRANCH}`,
  );
});
