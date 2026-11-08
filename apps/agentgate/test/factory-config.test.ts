import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, makeCtx } from "../src/daemon.ts";
import { currentFolder, folderAt, loadFolder } from "../src/factory/config.ts";
import { items } from "../src/factory/db.ts";
import { fetcher, type FolderFetcher } from "../src/factory/folder.ts";
import { loopTask, runCommand, type FactoryRuntime } from "../src/factory/runtime.ts";
import { host } from "../src/logins.ts";
import { Store } from "../src/store.ts";
import { peers, pullPeer } from "../src/sync.ts";
import { removeTmp, repos, sh, tmp } from "./fixtures/git.ts";
import { startNodes } from "./fixtures/nodes.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "factory");
const realFetch = fetcher.fetch;
const cleanup: (() => Promise<void> | void)[] = [];
const realGh = host.gh;
beforeEach(() => {
  fetcher.root = tmp("agentgate-factory-home-");
  // No test reaches GitHub: `use` asks it whether the folder's branch is protected.
  host.gh = async () => undefined;
});
afterEach(async () => {
  host.gh = realGh;
  fetcher.fetch = realFetch;
  for (const fn of cleanup.splice(0)) await fn();
});
afterAll(removeTmp);

function node(name = "a") {
  const s = new Store(":memory:");
  s.setLocal("node", name);
  s.setLocal("adminToken", "admin-secret");
  s.put("node", name, { id: name, protocol: 8 });
  const ctx = makeCtx(s);
  cleanup.push(async () => {
    ctx.abort.abort();
    ctx.skills.close();
    ctx.imports.close();
    await ctx.gateway.close();
    s.close();
  });
  return { s, ctx, f: ctx.factory };
}

async function command(f: FactoryRuntime, name: string, ...args: string[]) {
  const output: string[] = [];
  const code = await runCommand(f, name, args, { out: (line) => output.push(line) });
  return { code, output };
}

const fetchLoop = (f: FactoryRuntime) =>
  loopTask(
    f,
    f.loops.find((l) => l.name === "factory-folder")!,
  );
const board = async (f: FactoryRuntime) => Object.assign({}, ...(await Promise.all(f.boardParts.map((p) => p()))));

/** A copy of the example folder with one file changed. */
function edited(file: string, edit: (text: string) => string) {
  const dir = tmp();
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(join(dir, file), edit(readFileSync(join(dir, file), "utf8")));
  return dir;
}

test("the example folder loads with every file type, defaults applied and source repos spelled as in repositories", () => {
  const folder = loadFolder(FIXTURE, "c0ffee");
  expect(folder.config.name).toBe("acme");
  expect(folder.config.limits).toMatchObject({ threads: 2, reviewRounds: 3, stalledAfter: "30m" });
  expect(folder.config.sources.map((s) => [s.id, s.repo])).toEqual([
    ["bugs", "acme/api"],
    ["linear", "acme/web"],
    ["desk", "acme/api"],
    ["perf", "acme/api"],
  ]);
  expect(folder.config.sources[3]).toMatchObject({
    schedule: { at: "09:00", days: ["mon", "thu"], timezone: "Europe/Copenhagen" },
    intake: "auto",
    dedupeWindow: "14d",
    enabled: true,
  });
  expect(folder.scouts.perf!.prompt).toStartWith("Look at the p95 latency");
  expect(folder.stages.triage).toEqual({
    file: { start: "auto", model: { provider: "claudeAgent", model: "claude-sonnet-5-5" } },
    brief: "Reproduce the report with a failing test before you route it.",
  });
  expect(folder.stages.implement?.file).toEqual({ start: "manual", skill: "debug" });
  expect(folder.config.stages).toEqual({
    implement: { note: "Run `bun test` in the package you changed before you open the PR." },
  });
  expect(folder.scorers.tests!.file.sample).toBe(50);
  expect(folder.rulings).toStartWith("# Rulings");
  expect(folder.skillsDir).toBe(join(FIXTURE, "skills"));
});

test.each([
  [
    "a source repo missing from repositories",
    edited("factory.yaml", (t) => t.replace("repo: acme/web\n    team", "repo: acme/mobile\n    team")),
    "factory.yaml: sources[1].repo: acme/mobile is not under repositories",
  ],
  [
    "a duplicate source id",
    edited("factory.yaml", (t) => t.replace("id: desk", "id: bugs")),
    "factory.yaml: sources[2].id: bugs is also the id of sources[0]",
  ],
  [
    "an unknown frontmatter key in a stage",
    edited("stages/implement.md", (t) => t.replace("start: manual", "start: manual\ncolor: red")),
    "stages/implement.md: color: unknown key",
  ],
  [
    "a scorer whose pass is above its best label",
    edited("scorers/tests.md", (t) => t.replace("score: 1\n", "score: 0.4\n").replace("score: 0.5\n", "score: 0.3\n")),
    "scorers/tests.md: pass: 0.5 is above the best label's score, 0.4, so nothing passes",
  ],
  [
    "a note for a stage that does not exist",
    edited("factory.yaml", (t) => t.replace("stages:\n  implement:", "stages:\n  deploy:")),
    "factory.yaml: stages.deploy: unknown key",
  ],
  [
    "a scout listed in factory.yaml",
    edited("factory.yaml", (t) =>
      t.replace("sources:\n", "sources:\n  - { id: deps, type: scout, repo: acme/api, schedule: { every: 6h } }\n"),
    ),
    "factory.yaml: sources[0].type: a scout is set in scouts/<id>.md, not here",
  ],
  [
    "a scout named like a source",
    edited("factory.yaml", (t) => t.replace("id: desk", "id: perf")),
    "scouts/perf.md: perf is also the id of sources[2]",
  ],
  [
    "a scout with an empty prompt",
    edited("scouts/perf.md", (t) => t.replace(/\n---\n[\s\S]*$/, "\n---\n")),
    "scouts/perf.md: the prompt is empty",
  ],
  [
    "a scout on a repository not under repositories",
    edited("scouts/perf.md", (t) => t.replace("repo: acme/api", "repo: acme/mobile")),
    "scouts/perf.md: repo: acme/mobile is not under repositories in factory.yaml",
  ],
  [
    "an unknown timezone",
    edited("scouts/perf.md", (t) => t.replace("timezone: Europe/Copenhagen", "timezone: Nope/Nowhere")),
    "scouts/perf.md: schedule.timezone: Nope/Nowhere is not a timezone",
  ],
  [
    "a scout more often than hourly",
    edited("scouts/perf.md", (t) =>
      t.replace(
        /schedule:\n(\s+)at: "09:00"\n\s+days: \[mon, thu\]\n\s+timezone: Europe\/Copenhagen/,
        "schedule:\n$1every: 30m",
      ),
    ),
    "scouts/perf.md: schedule.every: a scout runs at most once an hour",
  ],
])("the loader rejects %s, naming the file and field", (_, dir, message) => {
  expect(() => loadFolder(dir, "c0ffee")).toThrow(message);
});

test("use loads the folder from git; a broken commit keeps the last good one; folders open items use are kept", async () => {
  const { s, f } = node();
  const git = repos("work");
  const repo = git.url.replace(/^https:\/\/github\.com\/(.+)\.git$/, "$1");
  const push = (message: string) => {
    sh(git.work, "add", "-A");
    sh(git.work, "commit", "-m", message);
    sh(git.work, "push", "origin", "main");
    return sh(git.work, "rev-parse", "HEAD");
  };
  cpSync(FIXTURE, join(git.work, "factory"), { recursive: true });
  const good = push("factory");

  expect(await command(f, "use", `${repo}:factory`)).toEqual({
    code: 0,
    output: [`Factory folder ${repo}:factory, run by a.`, `Loaded acme at ${good.slice(0, 7)}.`],
  });
  expect(s.settings().factory).toEqual({ store: "github", repo, path: "factory", node: "a" });
  expect(readdirSync(join(fetcher.root, good)).sort()).toEqual([
    "factory.yaml",
    "rulings.md",
    "scorers",
    "scouts",
    "skills",
    "stages",
  ]);
  expect(currentFolder(f)?.config.name).toBe("acme");

  writeFileSync(join(git.work, "factory", "factory.yaml"), "version: [1\n");
  const broken = push("broken");
  await fetchLoop(f)();
  expect(currentFolder(f)?.commit).toBe(good);
  expect((await board(f)).config).toEqual({
    commit: good,
    name: "acme",
    loadedAt: expect.any(Number),
    error: expect.stringMatching(/^factory\.yaml: invalid YAML/),
    repositories: ["acme/api", "acme/web"],
  });
  expect(f.events.recent(1)[0]!.text).toStartWith(`${broken.slice(0, 7)} is broken, so kept ${good.slice(0, 7)}`);

  items.insert(s, {
    id: "it_1",
    source: "bugs",
    externalId: "1",
    key: "gh-1",
    repo: "acme/api",
    title: "Crash",
    snapshot: {},
    phase: "implement",
    configCommit: good,
  });
  cpSync(FIXTURE, join(git.work, "factory"), { recursive: true });
  // A comment is a note for whoever edits the file, such as the prompts factory init writes; briefs never get it.
  writeFileSync(
    join(git.work, "factory", "rulings.md"),
    "# Rulings\n\n<!-- Greenfield or live?\n-->\nNo new dependencies.\n",
  );
  const fixed = push("fixed");
  await fetchLoop(f)();
  expect(currentFolder(f)?.rulings).toBe("# Rulings\n\nNo new dependencies.");
  expect((await board(f)).config).toEqual({
    commit: fixed,
    name: "acme",
    loadedAt: expect.any(Number),
    repositories: ["acme/api", "acme/web"],
  });
  expect(readdirSync(fetcher.root).sort()).toEqual([fixed, good].sort());
  expect(folderAt(f, good)?.rulings).toStartWith("# Rulings\n\n- Public API");

  items.update(s, "it_1", { phase: "shipped" });
  await fetchLoop(f)();
  expect(readdirSync(fetcher.root)).toEqual([fixed]);
});

test("a commit that leaves the folder as it was keeps the loaded folder, its commit and its directory", async () => {
  const { f } = node();
  const git = repos("work");
  const repo = git.url.replace(/^https:\/\/github\.com\/(.+)\.git$/, "$1");
  const push = (message: string) => {
    sh(git.work, "add", "-A");
    sh(git.work, "commit", "-m", message);
    sh(git.work, "push", "origin", "main");
    return sh(git.work, "rev-parse", "HEAD");
  };
  cpSync(FIXTURE, join(git.work, "factory"), { recursive: true });
  const first = push("factory");
  expect((await command(f, "use", `${repo}:factory`)).code).toBe(0);
  const loaded = () => f.events.recent(50).filter((e) => e.text.startsWith("Loaded "));
  expect(loaded()).toHaveLength(1);

  writeFileSync(join(git.work, "README.md"), "the app changed\n");
  push("app change");
  await fetchLoop(f)();
  expect(currentFolder(f)?.commit).toBe(first);
  expect(readdirSync(fetcher.root)).toEqual([first]);
  expect(loaded()).toHaveLength(1);

  writeFileSync(join(git.work, "factory", "rulings.md"), "# Rulings\n\nNo new dependencies.\n");
  const changed = push("rulings");
  await fetchLoop(f)();
  expect(currentFolder(f)?.commit).toBe(changed);
  expect(loaded()).toHaveLength(2);
});

/** A fetcher that serves the example folder as one commit, and counts its calls. */
function fakeFetcher() {
  const commit = "c".repeat(40);
  const calls: Parameters<FolderFetcher>[0][] = [];
  fetcher.fetch = async (input) => {
    calls.push(input);
    if (input.since === commit) return null;
    const dir = join(fetcher.root, commit);
    if (!existsSync(dir)) cpSync(FIXTURE, dir, { recursive: true });
    return { commit, dir };
  };
  return { commit, calls };
}

test("use waits for every machine to understand the factory, and only the machine it names fetches", async () => {
  const [a, b] = await startNodes("a", "b");
  cleanup.push(() => Promise.all([a!.stop(), b!.stop()]).then(() => {}));
  const { calls } = fakeFetcher();

  b!.s.put("node", "b", { id: "b", protocol: 7 });
  await pullPeer(
    a!.s,
    peers(a!.s).find((p) => p.node === "b")!,
  );
  await expect(command(a!.ctx.factory, "use", "acme/factory", "--node", "b")).rejects.toThrow(
    "Update agentgate on b first",
  );
  b!.s.put("node", "b", { id: "b", protocol: 8 });
  await pullPeer(
    a!.s,
    peers(a!.s).find((p) => p.node === "b")!,
  );

  expect((await command(a!.ctx.factory, "use", "acme/factory", "--node", "b")).code).toBe(0);
  await pullPeer(
    b!.s,
    peers(b!.s).find((p) => p.node === "a")!,
  );
  expect(b!.s.settings().factory).toEqual({ store: "github", repo: "acme/factory", path: "", node: "b" });
  await fetchLoop(a!.ctx.factory)();
  expect(calls).toEqual([]);
  await fetchLoop(b!.ctx.factory)();
  expect(calls).toEqual([
    { repo: "acme/factory", path: "", ref: undefined, since: undefined, signal: expect.any(AbortSignal) },
  ]);

  const off: string[] = [];
  b!.ctx.factory.events.on("factory.off", (e) => void off.push(e.text));
  expect(await command(b!.ctx.factory, "off")).toEqual({ code: 0, output: ["The factory is off."] });
  expect(b!.s.settings().factory).toBeUndefined();
  expect(off).toEqual(["The factory was turned off"]);
  await fetchLoop(b!.ctx.factory)();
  expect(calls).toHaveLength(1);
});

test("POST /api/factory/reload on another machine reloads the factory machine's folder, and says when it cannot reach it", async () => {
  const [a, b] = await startNodes("a", "b");
  let bStopped = false;
  cleanup.push(() => Promise.all([a!.stop(), bStopped ? undefined : b!.stop()]).then(() => {}));
  const { calls } = fakeFetcher();
  expect((await command(a!.ctx.factory, "use", "acme/factory", "--node", "b")).code).toBe(0);
  await pullPeer(
    b!.s,
    peers(b!.s).find((p) => p.node === "a")!,
  );
  await fetchLoop(b!.ctx.factory)();
  const fetched = calls.length;
  const reload = () =>
    app(a!.ctx).fetch(
      new Request("http://127.0.0.1:7878/api/factory/reload", { method: "POST", headers: { host: "127.0.0.1:7878" } }),
      { listener: "loopback" },
    );

  const res = await reload();
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    factory: { store: "github", repo: "acme/factory", node: "b" },
    config: { name: "acme" },
  });
  expect(calls).toHaveLength(fetched + 1);

  await b!.stop();
  bStopped = true;
  const down = await reload();
  expect(down.status).toBe(400);
  expect(((await down.json()) as { error: string }).error).toContain("this machine cannot reach it");
});

test("use warns when GitHub does not protect the folder's branch, and says nothing when it does or cannot tell", async () => {
  const { f } = node();
  fakeFetcher();
  const asked: string[][] = [];
  let protectedBranch: boolean | undefined = false;
  host.gh = async (args) => {
    asked.push(args);
    if (args[0] === "repo" && args[1] === "view")
      return { ok: true, out: JSON.stringify({ defaultBranchRef: { name: "main" } }) };
    if (protectedBranch === undefined) return { ok: false, out: JSON.stringify({ message: "Not Found" }) };
    return { ok: true, out: JSON.stringify({ name: "main", protected: protectedBranch }) };
  };
  const warning =
    "Warning: main of acme/factory is not protected, so a factory thread that pushes there changes every later brief. Protect it on GitHub if your plan allows.";
  expect((await command(f, "use", "acme/factory")).output).toContain(warning);
  expect(asked.at(-1)).toEqual(["api", "repos/acme/factory/branches/main"]);
  expect((await command(f, "use", "acme/factory", "--ref", "release/v2")).output.at(-1)).toContain(
    "release/v2 of acme/factory is not protected",
  );
  expect(asked.at(-1)).toEqual(["api", "repos/acme/factory/branches/release%2Fv2"]);
  protectedBranch = true;
  expect((await command(f, "use", "acme/factory")).output.join("\n")).not.toContain("Warning");
  protectedBranch = undefined; // a tag, or no access
  expect((await command(f, "use", "acme/factory", "--ref", "v1.0")).output.join("\n")).not.toContain("Warning");
});

test("the use command and PUT /api/factory set the same pointer, and the board shows it with the folder", async () => {
  const { s, ctx, f } = node();
  const { commit } = fakeFetcher();
  s.now = () => 1_000;
  const put = (body: unknown) =>
    app(ctx).fetch(
      new Request("http://127.0.0.1:7878/api/factory", {
        method: "PUT",
        headers: { host: "127.0.0.1:7878", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { listener: "loopback" },
    );

  await command(f, "use", "acme/factory:/factory/", "--ref", "live");
  const byCommand = s.settings().factory;
  await command(f, "off");
  const res = await put({ repo: "acme/factory", path: "factory", ref: "live" });
  expect(s.settings().factory).toEqual(byCommand!);

  const status = {
    factory: {
      store: "github",
      repo: "acme/factory",
      path: "factory",
      ref: "live",
      node: "a",
      online: true,
      lastSeenAt: 1_000,
    },
    config: { commit, name: "acme", loadedAt: 1_000, repositories: ["acme/api", "acme/web"] },
  };
  expect(await res.json()).toEqual(status);
  expect(await board(f)).toMatchObject(status);

  const missing = await put({ repo: "acme/factory", node: "nowhere" });
  expect(missing.status).toBe(400);
  expect(await missing.json()).toEqual({ error: "No machine is named nowhere; agentgate status lists them" });
});
