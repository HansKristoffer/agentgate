import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeCtx } from "../src/daemon.ts";
import { currentFolder, loadFolder } from "../src/factory/config.ts";
import { items } from "../src/factory/db.ts";
import { fetcher, storedFiles } from "../src/factory/folder.ts";
import { initTemplate } from "../src/factory/init.ts";
import { addRepository } from "../src/factory/repos.ts";
import { host } from "../src/logins.ts";
import { Store } from "../src/store.ts";
import { recorded } from "./fixtures/gh.ts";
import { removeTmp, tmp } from "./fixtures/git.ts";
import { postOp, terminal } from "./fixtures/t3-mcp.ts";

const REPO = "acme/api";
const WEB = "acme/web";
const realGh = host.gh;
const realRoot = fetcher.root;
const cleanup: (() => unknown)[] = [];
beforeEach(() => {
  fetcher.root = tmp("agentgate-factory-init-");
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  host.gh = realGh;
  fetcher.root = realRoot;
});
afterAll(removeTmp);

const ok = (value: unknown) => ({ ok: true, out: typeof value === "string" ? value : JSON.stringify(value) });

/** GitHub for the factory's repositories: labels, and a factory folder at `factory/` of acme/api's main branch, with the
 * tree and PR a change to it writes. What is not there is answered as GitHub was recorded answering it
 * (fixtures/gh-recorded.json). */
function fakeGitHub(files: Record<string, string> = {}) {
  const github = {
    files,
    labels: new Set<string>(),
    labelsFail: false,
    tree: [] as { path: string; content?: string; sha?: null }[],
    prs: [] as { repo: string; head: string; base: string; title: string; body: string }[],
    calls: [] as string[][],
  };
  host.gh = async (args, stdin) => {
    github.calls.push(args);
    const [cmd, sub] = args;
    if (cmd === "repo" && sub === "view") return ok({ defaultBranchRef: { name: "main" } });
    if (cmd === "pr" && sub === "create") {
      const flag = (name: string) => args[args.indexOf(name) + 1]!;
      github.prs.push({
        repo: flag("--repo"),
        head: flag("--head"),
        base: flag("--base"),
        title: flag("--title"),
        body: stdin!,
      });
      return ok(`https://github.com/${flag("--repo")}/pull/${8 + github.prs.length}\n`);
    }
    const path = args.find((a) => a.startsWith("repos/"))!;
    const [, owner, name, ...rest] = path.split("/");
    const repo = `${owner}/${name}`;
    const route = rest.join("/").split("?")[0]!;
    if (route.startsWith("labels/"))
      return github.labels.has(`${repo}#${decodeURIComponent(route.slice(7))}`)
        ? ok("factory")
        : recorded("label.missing");
    if (route === "labels") {
      if (github.labelsFail) return { ok: false, out: JSON.stringify({ message: "Must have admin rights" }) };
      github.labels.add(`${repo}#${JSON.parse(stdin!).name}`);
      return ok({});
    }
    if (route.startsWith("contents/")) {
      const content = github.files[route.slice(9)];
      return content === undefined ? recorded("readFile.missing") : ok(content);
    }
    if (route.startsWith("branches/")) return recorded("branchExists.missing");
    if (route === "git/ref/heads/main") return ok({ object: { sha: "base" } });
    if (route === "git/commits/base") return ok({ tree: { sha: "base-tree" } });
    if (route === "git/trees") {
      github.tree = JSON.parse(stdin!).tree;
      return ok({ sha: "tree-1" });
    }
    if (route === "git/commits") return ok({ sha: "commit-1" });
    if (route === "git/refs") return ok({ ref: "created" });
    throw new Error(`the fake GitHub has no answer for gh ${args.join(" ")}`);
  };
  return github;
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
  const command = (...words: string[]) => terminal(f, words);
  /** An operation as the app sends it. */
  const api = async (name: string, input: unknown) => {
    const res = await postOp(ctx, name, input);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { s, f, command, api };
}

/** The folder `files` would make, loaded the way the factory loads it. */
function load(files: Record<string, string>) {
  const dir = tmp();
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return loadFolder(dir, "c".repeat(40));
}

test("init writes the template to the stored folder, creates the label and turns the factory on, with no branch or PR on GitHub", async () => {
  const github = fakeGitHub();
  const { s, f, api } = node();

  const res = await api("init", { repo: REPO });
  expect(res).toEqual({
    status: 200,
    body: {
      warnings: [],
      factory: { store: "agentgate", label: "stored in agentgate", node: "a", online: true, lastSeenAt: 1_000 },
      config: expect.objectContaining({ name: "api", repositories: [REPO] }),
    },
  });
  expect(storedFiles(s)).toEqual(initTemplate(REPO));
  expect(s.settings().factory).toEqual({ store: "agentgate", node: "a" });
  expect(currentFolder(f)?.config.sources).toEqual([
    expect.objectContaining({ id: "issues", type: "github", repo: REPO, label: "factory" }),
  ]);
  expect(github.labels).toEqual(new Set([`${REPO}#factory`]));
  // Only the label was read and created: nothing was pushed and no PR was opened.
  expect(github.calls.every((c) => c[1]!.startsWith(`repos/${REPO}/labels`))).toBe(true);
});

test("factory init --json prints what the route answers, --label names the label, and the template parses and loads as a folder", async () => {
  fakeGitHub();
  const viaApi = (await node().api("init", { repo: REPO, label: "agent" })).body;
  const github = fakeGitHub();
  const { code, output } = await node().command("init", REPO, "--label", "agent", "--json");
  expect(code).toBe(0);
  expect(JSON.parse(output[0]!)).toEqual(viaApi);
  expect(github.labels).toEqual(new Set([`${REPO}#agent`]));

  const folder = load(initTemplate("Acme/My_API.v2"));
  expect(folder.config).toMatchObject({
    name: "my-api-v2",
    repositories: { "Acme/My_API.v2": {} },
    sources: [{ id: "issues", type: "github", repo: "Acme/My_API.v2", label: "factory" }],
  });
  // The rulings file asks about greenfield and owned packages in a comment, which never reaches a brief.
  expect(initTemplate(REPO)["rulings.md"]).toContain("Packages you own");
  expect(folder.rulings).toBe("# Rulings");
});

test("init refuses while a factory is on, naming repo add, and while agentgate stores a folder; a label it cannot create is a warning", async () => {
  const github = fakeGitHub();
  github.labelsFail = true;
  const { s, command } = node();
  const done = await command("init", REPO);
  expect(done).toEqual({
    code: 0,
    output: [
      "The factory runs on a with a folder agentgate stores; edit it with agentgate factory folder.",
      "Warning: Creating the factory label failed (gh could not create the label factory in acme/api: Must have admin rights); create it before labelling issues",
    ],
  });

  const asked = github.calls.length;
  expect(await command("init", WEB)).toEqual({
    code: 1,
    output: [`The factory is on, stored in agentgate; add ${WEB} to it with agentgate factory repo add ${WEB}`],
  });
  await command("off");
  expect((await command("init", WEB)).output[0]).toStartWith("agentgate already stores a factory folder");
  expect(github.calls).toHaveLength(asked);
  expect(storedFiles(s)).toEqual(initTemplate(REPO));
});

test("repo add on the stored folder applies at once: the folder loads with the repository and its source, and a second add changes nothing", async () => {
  const github = fakeGitHub();
  const { s, f, command, api } = node();
  await command("init", REPO);

  expect(await command("repo", "add", WEB)).toEqual({
    code: 0,
    output: [`The factory works in ${WEB} now, on issues labelled factory.`],
  });
  expect(currentFolder(f)?.config).toMatchObject({
    repositories: { [REPO]: {}, [WEB]: {} },
    sources: [
      { id: "issues", repo: REPO, label: "factory" },
      { id: "web-issues", type: "github", repo: WEB, label: "factory" },
    ],
  });
  expect(github.labels.has(`${WEB}#factory`)).toBe(true);

  const before = storedFiles(s);
  expect(await api("repo add", { repo: "ACME/Web" })).toEqual({ status: 200, body: { unchanged: true, warnings: [] } });
  expect((await command("repo", "add", WEB)).output).toEqual([`${WEB} is in the factory already; nothing changed.`]);
  expect(storedFiles(s)).toEqual(before);
});

test("repo add on a folder in git opens a PR whose factory.yaml has the repository and its source", async () => {
  const yaml = initTemplate(REPO)["factory.yaml"]!.replace("sources:", "# where items come from\nsources:");
  const github = fakeGitHub({ "factory/factory.yaml": yaml });
  const { s, api } = node();
  s.put("setting", "settings", {
    ...s.settings(),
    factory: { store: "github", repo: REPO, path: "factory", node: "a" },
  });

  expect(await api("repo add", { repo: WEB, label: "agent" })).toEqual({
    status: 200,
    body: { pr: `https://github.com/${REPO}/pull/9`, warnings: [] },
  });
  expect(github.prs).toEqual([
    expect.objectContaining({
      repo: REPO,
      head: "agentgate/factory-add-acme-web",
      base: "main",
      title: `chore(factory): add ${WEB}`,
    }),
  ]);
  expect(github.tree.map((t) => t.path)).toEqual(["factory/factory.yaml"]);
  const edited = github.tree[0]!.content!;
  expect(edited).toContain("# where items come from");
  expect(load({ "factory.yaml": edited }).config).toMatchObject({
    repositories: { [REPO]: {}, [WEB]: {} },
    sources: [{ id: "issues" }, { id: "web-issues", type: "github", repo: WEB, label: "agent" }],
  });
  expect(github.labels.has(`${WEB}#agent`)).toBe(true);
});

test("repo remove refuses while the repository has open items, and otherwise takes it and its sources and scouts out", async () => {
  fakeGitHub();
  const { s, f, command } = node();
  await command("init", REPO);
  await command("repo", "add", WEB);
  const scout = `source: { id: perf, type: scout, repo: ${WEB}, schedule: { every: 6h } }\nprompt: Look at the logs.\n`;
  expect((await terminal(f, ["source", "add"], scout)).code).toBe(0);
  const item = (id: string) =>
    items.insert(s, {
      id,
      source: "web-issues",
      externalId: `${WEB}#${id}`,
      key: `web-${id}`,
      repo: WEB,
      title: "Crash",
      snapshot: {},
      phase: "implement",
      configCommit: currentFolder(f)!.commit,
    });
  item("1");
  item("2");

  expect(await command("repo", "remove", WEB)).toEqual({
    code: 1,
    output: [`${WEB} has 2 open items; let them finish or drop them before removing it`],
  });
  items.update(s, "1", { phase: "shipped" });
  items.update(s, "2", { phase: "closed" });
  expect(await command("repo", "remove", WEB)).toEqual({ code: 0, output: [`The factory no longer works in ${WEB}.`] });
  expect(currentFolder(f)?.config).toMatchObject({ repositories: { [REPO]: {} }, sources: [{ id: "issues" }] });
  expect(storedFiles(s)!["scouts/perf.md"]).toBeUndefined();
  expect(storedFiles(s)!["factory.yaml"]).toBe(initTemplate(REPO)["factory.yaml"]);

  expect((await command("repo", "remove", WEB)).output).toEqual([`${WEB} is not in the factory; nothing changed.`]);
  expect((await command("repo", "remove", REPO)).output).toEqual([
    `${REPO} is the factory's only repository; turn the factory off instead`,
  ]);
});

test("adding a repository keeps the person's layout and comments, and one it cannot edit is refused with what to do by hand", () => {
  const yaml = [
    "version: 1",
    "name: acme",
    "repositories: # the repositories",
    "  acme/api:",
    "    reviewers: [alice]",
    "",
    "# items",
    "sources:",
    "- id: issues",
    "  type: github",
    "  repo: acme/api",
    "  label: factory",
    "limits:",
    "  threads: 2",
    "",
  ].join("\n");
  const next = addRepository(yaml, WEB, "factory");
  expect(next).toBe(
    yaml
      .replace("    reviewers: [alice]\n", "    reviewers: [alice]\n  acme/web: {}\n")
      .replace(
        "  label: factory\n",
        "  label: factory\n- id: web-issues\n  type: github\n  repo: acme/web\n  label: factory\n",
      ),
  );
  expect(() =>
    addRepository(yaml.replace(/repositories:[\s\S]*?\n\n/, "repositories: { acme/api: {} }\n"), WEB, "factory"),
  ).toThrow(
    "factory.yaml could not be edited (its repositories are not a block mapping); add acme/web: {} under repositories by hand",
  );
});
