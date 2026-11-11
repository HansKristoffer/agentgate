import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeCtx } from "../src/daemon.ts";
import { currentFolder, folderAt } from "../src/factory/config.ts";
import { items } from "../src/factory/db.ts";
import { fetcher, storedCommit, storedFiles } from "../src/factory/folder.ts";
import { initTemplate } from "../src/factory/init.ts";
import { loopTask, type FactoryRuntime } from "../src/factory/runtime.ts";
import { host } from "../src/logins.ts";
import { Store } from "../src/store.ts";
import { peers, pullPeer } from "../src/sync.ts";
import { removeTmp, tmp } from "./fixtures/git.ts";
import { startNodes } from "./fixtures/nodes.ts";
import { postOp, terminal } from "./fixtures/t3-mcp.ts";

const REPO = "acme/api";
const realGh = host.gh;
const realRoot = fetcher.root;
const cleanup: (() => unknown)[] = [];
beforeEach(() => {
  fetcher.root = tmp("agentgate-factory-home-");
  // The label exists already; nothing else may reach GitHub.
  host.gh = async (args) => {
    if (args[0] === "api" && args[1] === `repos/${REPO}/labels/factory`) return { ok: true, out: "factory" };
    throw new Error(`the fake GitHub has no answer for gh ${args.join(" ")}`);
  };
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  host.gh = realGh;
  fetcher.root = realRoot;
});
afterAll(removeTmp);

const YAML = (name: string) => `version: 1\nname: ${name}\nrepositories:\n  ${REPO}: {}\n`;

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

const command = (f: FactoryRuntime, name: string, args: string[], stdin?: string) =>
  terminal(f, [name, ...args], stdin);

const folderLoop = (f: FactoryRuntime) =>
  loopTask(
    f,
    f.loops.find((l) => l.name === "factory-folder")!,
  )();

test("init turns the factory on with the template stored in agentgate; edits load at once, and one that breaks the folder is refused", async () => {
  const { s, f } = node();
  expect(await command(f, "init", [REPO])).toEqual({
    code: 0,
    output: ["The factory runs on a with a folder agentgate stores; edit it with agentgate factory folder."],
  });
  expect(s.settings().factory).toEqual({ store: "agentgate", node: "a" });
  const template = initTemplate(REPO);
  expect(storedFiles(s)).toEqual(template);
  const first = storedCommit(template);
  expect(currentFolder(f)).toMatchObject({ commit: first, config: { name: "api" } });
  expect((await command(f, "status", [])).output).toContain("Factory: stored in agentgate on a (this machine), online");

  items.insert(s, {
    id: "it_1",
    source: "issues",
    externalId: "1",
    key: "api-1",
    repo: REPO,
    title: "Crash",
    snapshot: {},
    phase: "implement",
    configCommit: first,
  });
  expect(await command(f, "folder", ["put", "stages/implement.md"], "Run the tests first.\n")).toEqual({
    code: 0,
    output: [expect.stringMatching(/^Saved stages\/implement\.md; the stored folder is at [0-9a-f]{7}\.$/)],
  });
  const second = currentFolder(f)!;
  expect(second.stages.implement?.brief).toBe("Run the tests first.");
  // The item keeps the folder it started with.
  expect(folderAt(f, first)?.stages.implement).toBeUndefined();
  expect((await command(f, "folder", ["cat", "stages/implement.md"])).output).toEqual(["Run the tests first."]);
  expect((await command(f, "folder", ["ls"])).output).toEqual([
    `The stored folder is at ${second.commit.slice(0, 7)}:`,
    `  factory.yaml  ${Buffer.byteLength(template["factory.yaml"]!)} bytes`,
    `  rulings.md  ${Buffer.byteLength(template["rulings.md"]!)} bytes`,
    "  stages/implement.md  21 bytes",
  ]);

  const broken = await command(f, "folder", ["put", "factory.yaml"], "version: [1\n");
  expect(broken.code).toBe(1);
  expect(broken.output[0]).toStartWith("factory.yaml: invalid YAML");
  expect((await command(f, "folder", ["rm", "factory.yaml"])).output).toEqual([
    "factory.yaml: the folder has no factory.yaml",
  ]);
  expect((await command(f, "folder", ["put", "../escape.md"], "x")).output).toEqual([
    "../escape.md: not a path inside the folder",
  ]);
  expect(currentFolder(f)?.commit).toBe(second.commit);

  // The folder outlives off, so use turns it on again; delete is refused until the factory leaves it.
  expect((await command(f, "folder", ["delete"])).output).toEqual([
    "The factory runs on the stored folder; turn it off with agentgate factory off first",
  ]);
  await command(f, "off", []);
  expect((await command(f, "init", [REPO])).output[0]).toStartWith("agentgate already stores a factory folder");
  expect((await command(f, "use", ["--store", "agentgate"])).code).toBe(0);
  expect(currentFolder(f)?.commit).toBe(second.commit);
  await command(f, "off", []);
  expect(await command(f, "folder", ["delete"])).toEqual({ code: 0, output: ["The stored folder is deleted."] });
  expect(storedFiles(s)).toBeUndefined();
  expect((await command(f, "use", ["--store", "agentgate"])).output[0]).toStartWith(
    "agentgate stores no factory folder",
  );
});

test("the stored folder syncs to the machine that runs the factory, which loads each change", async () => {
  const [a, b] = await startNodes("a", "b");
  cleanup.push(() => Promise.all([a!.stop(), b!.stop()]));
  const pull = (to: typeof a, from: string) =>
    pullPeer(
      to!.s,
      peers(to!.s).find((p) => p.node === from)!,
    );

  b!.s.put("node", "b", { id: "b", protocol: 7 });
  await pull(a, "b");
  expect((await command(a!.ctx.factory, "folder", ["put", "factory.yaml"], YAML("acme"))).output[0]).toStartWith(
    "Update agentgate on b first",
  );
  b!.s.put("node", "b", { id: "b", protocol: 8 });
  await pull(a, "b");

  expect((await command(a!.ctx.factory, "folder", ["put", "factory.yaml"], YAML("acme"))).code).toBe(0);
  expect((await command(a!.ctx.factory, "use", ["--store", "agentgate", "--node", "b"])).code).toBe(0);
  expect(currentFolder(a!.ctx.factory)).toBeUndefined(); // only the factory machine loads it
  await pull(b, "a");
  await folderLoop(b!.ctx.factory);
  expect(currentFolder(b!.ctx.factory)?.config.name).toBe("acme");

  expect((await command(a!.ctx.factory, "folder", ["put", "factory.yaml"], YAML("renamed"))).code).toBe(0);
  await pull(b, "a");
  await folderLoop(b!.ctx.factory);
  expect(currentFolder(b!.ctx.factory)).toMatchObject({
    commit: storedCommit({ "factory.yaml": YAML("renamed") }),
    config: { name: "renamed" },
  });
});

test("source add on a stored folder changes it at once, with no PR", async () => {
  const { s, f } = node();
  await command(f, "init", [REPO]);
  const added = await command(
    f,
    "source",
    ["add"],
    `source: { id: desk, type: webhook, repo: ${REPO}, title: "{{body.subject}}" }\n`,
  );
  expect(added).toEqual({ code: 0, output: ["Added to the factory folder; the source starts within 2 minutes."] });
  const scout = `source: { id: perf, type: scout, repo: ${REPO}, schedule: { every: 6h } }\nprompt: Look at the logs.\n`;
  expect((await command(f, "source", ["add"], scout)).code).toBe(0);
  expect(currentFolder(f)?.config.sources.map((x) => x.id)).toEqual(["issues", "desk", "perf"]);
  expect(storedFiles(s)!["scouts/perf.md"]).toBe(
    `---\nrepo: ${REPO}\nschedule:\n  every: "6h"\n---\n\nLook at the logs.\n`,
  );
  expect((await command(f, "source", ["add"], scout)).output).toEqual(["The factory already has a scout perf"]);
});

test("folder export then import round-trips every file; a relative directory is the CLI's, and a broken folder is refused", async () => {
  const { s, f } = node();
  await command(f, "init", [REPO]);
  await command(f, "folder", ["put", "stages/implement.md"], "Run the tests first.\n");
  await command(f, "folder", ["put", "skills/lint/SKILL.md"], "---\nname: lint\ndescription: Lints.\n---\nLint.\n");
  const files = storedFiles(s)!;

  // The CLI ran in `cwd`; the daemon's own working directory is somewhere else.
  const cwd = tmp();
  expect(await terminal(f, ["folder", "export", "out"], undefined, cwd)).toEqual({
    code: 0,
    output: [`Wrote the stored folder's 4 files to ${join(cwd, "out")}.`],
  });
  const out = join(cwd, "out");
  expect(
    readdirSync(out, { recursive: true })
      .filter((p) => String(p).endsWith(".md") || String(p).endsWith(".yaml"))
      .sort(),
  ).toEqual(["factory.yaml", "rulings.md", "skills/lint/SKILL.md", "stages/implement.md"]);
  expect((await terminal(f, ["folder", "export", "out"], undefined, cwd)).output).toEqual([
    `${out} is not empty; --force writes the files into it anyway`,
  ]);
  expect((await terminal(f, ["folder", "export", "out", "--force"], undefined, cwd)).code).toBe(0);
  expect((await command(f, "folder", ["export", "out"])).output).toEqual(["Give the directory as an absolute path"]);
  // Imported as it was written, the folder is the same files at the same commit.
  const commit = currentFolder(f)!.commit;
  expect((await terminal(f, ["folder", "import", "out"], undefined, cwd)).code).toBe(0);
  expect(storedFiles(s)).toEqual(files);
  expect(currentFolder(f)?.commit).toBe(commit);

  // A changed directory replaces the folder as a whole: a file gone from it goes, and git's own files are left out.
  writeFileSync(join(out, "stages/implement.md"), "Run the linter first.\n");
  writeFileSync(join(out, "rulings.md"), "# Rulings\n\n- Greenfield.\n");
  mkdirSync(join(out, ".git"));
  writeFileSync(join(out, ".git/HEAD"), "ref: refs/heads/main\n");
  rmSync(join(out, "skills"), { recursive: true });
  const imported = await terminal(f, ["folder", "import", "out"], undefined, cwd);
  expect(imported).toEqual({
    code: 0,
    output: [expect.stringMatching(/^Imported 3 files; the stored folder is at [0-9a-f]{7}\.$/)],
  });
  expect(storedFiles(s)).toEqual({
    "factory.yaml": files["factory.yaml"]!,
    "rulings.md": "# Rulings\n\n- Greenfield.\n",
    "stages/implement.md": "Run the linter first.\n",
  });
  // The factory runs on the stored folder, so the import loads at once.
  expect(currentFolder(f)?.rulings).toBe("# Rulings\n\n- Greenfield.");

  const before = storedFiles(s);
  writeFileSync(join(out, "factory.yaml"), "version: [1\n");
  const broken = await command(f, "folder", ["import", out]);
  expect(broken.code).toBe(1);
  expect(broken.output[0]).toStartWith("factory.yaml: invalid YAML");
  expect(storedFiles(s)).toEqual(before);
  expect(readFileSync(join(out, "rulings.md"), "utf8")).toBe("# Rulings\n\n- Greenfield.\n");
});

test("folder import prepares the stored folder while the factory is off or runs on a folder in git", async () => {
  const { s, f } = node();
  const dir = tmp();
  writeFileSync(join(dir, "factory.yaml"), YAML("acme"));
  expect((await command(f, "folder", ["import", dir])).code).toBe(0);
  expect(storedFiles(s)).toEqual({ "factory.yaml": YAML("acme") });

  s.put("setting", "settings", { ...s.settings(), factory: { store: "github", repo: REPO, path: "", node: "b" } });
  writeFileSync(join(dir, "factory.yaml"), YAML("renamed"));
  expect((await command(f, "folder", ["import", dir])).code).toBe(0);
  expect(storedFiles(s)).toEqual({ "factory.yaml": YAML("renamed") });
  expect(s.settings().factory).toMatchObject({ store: "github" });
});

test("folder export and import are refused over remote management", async () => {
  const { s, ctx } = node();
  const dir = tmp();
  writeFileSync(join(dir, "factory.yaml"), YAML("acme"));
  for (const name of ["folder import", "folder export"]) {
    const res = await postOp(ctx, name, { dir }, "tailnet", { authorization: "Bearer admin-secret" });
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 403,
      body: { error: "This operation requires a local connection" },
    });
  }
  expect(storedFiles(s)).toBeUndefined();
  // A typed call names an absolute directory: there is no CLI whose directory a relative one could be in.
  const relative = await postOp(ctx, "folder import", { dir: "out" });
  expect(relative.status).toBe(400);
});

test("an editor's save over a folder another machine changed since it opened is refused", async () => {
  const { s, ctx } = node();
  const put = (files: Record<string, string>, base?: string) => postOp(ctx, "folder put", { files, base });
  await put({ "factory.yaml": YAML("acme") });
  const opened = storedCommit(storedFiles(s)!);
  await put({ "rulings.md": "- Greenfield.\n" });
  expect((await put({ "factory.yaml": YAML("renamed") }, opened)).status).toBe(409);
  expect(storedFiles(s)).toEqual({ "factory.yaml": YAML("acme"), "rulings.md": "- Greenfield.\n" });
  expect((await put({ "factory.yaml": YAML("renamed") }, storedCommit(storedFiles(s)!))).status).toBe(200);
});
