import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeCtx } from "../src/daemon.ts";
import { currentFolder, folderAt } from "../src/factory/config.ts";
import { items, newId, runs, type FactoryRun } from "../src/factory/db.ts";
import { fetcher, storedCommit, storedFiles } from "../src/factory/folder.ts";
import { initTemplate } from "../src/factory/init.ts";
import { loopTask, runCommand, type FactoryRuntime } from "../src/factory/runtime.ts";
import { host } from "../src/logins.ts";
import { Store } from "../src/store.ts";
import { peers, pullPeer } from "../src/sync.ts";
import { removeTmp, tmp } from "./fixtures/git.ts";
import { startNodes } from "./fixtures/nodes.ts";
import { factoryNode, idle } from "./fixtures/t3-mcp.ts";

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
const BODY =
  "## Targets\n\nstages/implement.md\n\n## Runs addressed\n\nrun_1\n\n## Evidence\n\n#12\n\n## Expected effect\n\nFewer reverts.";

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
  return { s, f: ctx.factory };
}

async function command(f: FactoryRuntime, name: string, args: string[], stdin?: string) {
  const output: string[] = [];
  const code = await runCommand(f, name, args, { out: (line) => output.push(line), stdin }).catch((e: Error) => {
    output.push(e.message);
    return 1;
  });
  return { code, output };
}

const folderLoop = (f: FactoryRuntime) =>
  loopTask(
    f,
    f.loops.find((l) => l.name === "factory-folder")!,
  )();

test("init --store agentgate turns the factory on with the template stored in agentgate and no PR; edits load at once, and one that breaks the folder is refused", async () => {
  const { s, f } = node();
  expect(await command(f, "init", [REPO, "--store", "agentgate"])).toEqual({
    code: 0,
    output: ["The factory runs on a with a folder agentgate stores; edit it with agentgate factory folder."],
  });
  expect(s.settings().factory).toEqual({ store: "agentgate", node: "a" });
  const template = Object.fromEntries(
    Object.entries(initTemplate(REPO)).map(([path, text]) => [path.replace(/^factory\//, ""), text]),
  );
  expect(storedFiles(s)).toEqual(template);
  const first = storedCommit(template);
  expect(currentFolder(f)).toMatchObject({ commit: first, config: { name: "api" } });
  expect((await command(f, "status", [])).output[0]).toBe("Factory: stored in agentgate on a (this machine), online");

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
  expect((await command(f, "init", [REPO, "--store", "agentgate"])).output[0]).toStartWith(
    "agentgate already stores a factory folder",
  );
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
  await command(f, "init", [REPO, "--store", "agentgate"]);
  const added = await command(
    f,
    "source",
    ["add"],
    `source: { id: desk, type: webhook, repo: ${REPO}, title: "{{body.subject}}" }\n`,
  );
  expect(added).toEqual({ code: 0, output: ["Added to the stored folder; the source starts within 2 minutes."] });
  const scout = `source: { id: perf, type: scout, repo: ${REPO}, schedule: { every: 6h } }\nprompt: Look at the logs.\n`;
  expect((await command(f, "source", ["add"], scout)).code).toBe(0);
  expect(currentFolder(f)?.config.sources.map((x) => x.id)).toEqual(["issues", "desk", "perf"]);
  expect(storedFiles(s)!["scouts/perf.md"]).toBe(
    `---\nrepo: ${REPO}\nschedule:\n  every: "6h"\n---\n\nLook at the logs.\n`,
  );
  expect((await command(f, "source", ["add"], scout)).output).toEqual(["The factory already has a scout perf"]);
});

test("a learn run on a stored folder proposes files, which apply refuses once a file moved on and discard leaves alone", async () => {
  const n = await factoryNode(cleanup, { config: { learning: { every: "7d" } } });
  const yaml = JSON.stringify({ version: 1, name: "acme", repositories: { [n.repo]: {} } });
  const put = (files: Record<string, string | null>) => n.api("/api/factory/folder", "PUT", { files });
  expect((await put({ "factory.yaml": yaml, "rulings.md": "# Rulings\n" })).status).toBe(200);
  expect((await n.command("use", "--store", "agentgate", "--node", "a")).code).toBe(0);

  const builtin = (await n.ctx.gateway.builtin!()).client;
  const report = async (run: FactoryRun, body: Record<string, unknown>) => {
    const result = await builtin.callTool({
      name: "factory_report",
      arguments: { run: run.id, ...body },
      _meta: { "dev.agentgate/t3Thread": runs.get(n.s, run.id)!.threadId },
    });
    await idle(n.f);
    const text = (result.content as { text: string }[])[0]!.text;
    return result.isError ? { error: text } : JSON.parse(text);
  };
  const learnRun = async () => {
    items.insert(n.s, {
      id: newId("it"),
      source: "manual",
      externalId: crypto.randomUUID(),
      key: `k-${crypto.randomUUID().slice(0, 6)}`,
      repo: n.repo,
      title: "Shipped",
      snapshot: {},
      phase: "shipped",
      configCommit: n.commit,
    });
    expect((await n.command("learn")).output[0]).toStartWith("Queued the learn run");
    await n.dispatch();
    return runs.list(n.s, { kinds: ["learn"] }).at(-1)!;
  };
  const proposed = (files: Record<string, string | null>, body = BODY) => ({
    outcome: "done",
    summary: "Tightened the implement brief.",
    result: { kind: "learn", lessons: ["Tests first."], proposal: { files, body } },
  });

  const run = await learnRun();
  const launch = n.mcp.calls.find((c) => c.tool === "t3_thread_launch" && c.args.clientRequestId === run.id)!;
  // In a worktree of the folder's repository, reading the folder from its directory.
  expect(n.t3.projects.find((p) => p.id === launch.args.projectId)!.title).toBe(n.repo.split("/")[1]!);
  const brief = String(launch.args.message);
  expect(brief).toContain(`Its files are in \`${join(fetcher.root, currentFolder(n.f)!.commit)}\``);
  expect(brief).toContain("Hand in your change as `result.proposal`");
  expect(brief).not.toContain("gh pr create");

  expect(
    await report(run, {
      outcome: "done",
      summary: "A PR.",
      result: { kind: "learn", lessons: [], prUrl: `https://github.com/${n.repo}/pull/3` },
    }),
  ).toEqual({ error: "AgentGate stores the factory's folder: hand in result.proposal, not a PR" });
  expect(await report(run, proposed({ "rulings.md": "# Mine\n" }))).toEqual({
    error: "The proposal changes rulings.md, which only the maintainer changes",
  });
  expect(await report(run, proposed({ "stages/implement.md": "x" }, "## Targets\n\nx"))).toEqual({
    error:
      "The proposal's body is missing sections: it has no Runs addressed section; it has no Evidence section; it has no Expected effect section",
  });
  expect(await report(run, proposed({ "stages/nope.md": "x" }))).toEqual({
    error:
      "With the proposal, the folder does not load: stages/nope.md: not a stage; the stages are triage, spec, implement, review",
  });
  expect(await report(run, proposed({ "stages/implement.md": "Write the failing test first.\n" }))).toEqual({
    accepted: true,
  });

  const board = async () => (await (await n.api("/api/factory")).json()) as { proposals: unknown[] };
  expect((await board()).proposals).toEqual([{ run: run.id, at: expect.any(Number), files: ["stages/implement.md"] }]);
  const shown = await n.command("proposal", run.id);
  expect(shown.output).toContain("--- stages/implement.md (added)");
  expect(shown.output).toContain("+Write the failing test first.");
  expect(await n.command("proposal", "apply", run.id)).toMatchObject({ code: 0 });
  expect(storedFiles(n.s)!["stages/implement.md"]).toBe("Write the failing test first.\n");
  expect(currentFolder(n.f)?.stages.implement?.brief).toBe("Write the failing test first.");
  expect((await board()).proposals).toEqual([]);
  expect((await n.command("proposal", "discard", run.id)).output).toEqual([
    `The proposal of ${run.id} was applied already`,
  ]);

  const second = await learnRun();
  expect(await report(second, proposed({ "stages/implement.md": "Read the issue twice.\n" }))).toEqual({
    accepted: true,
  });
  expect((await n.command("proposal", second.id)).output).toContain(
    "-Write the failing test first.\n+Read the issue twice.",
  );
  // The maintainer edited the file since: applying would overwrite that.
  expect((await put({ "stages/implement.md": "My own words.\n" })).status).toBe(200);
  expect((await n.command("proposal", "apply", second.id)).output).toEqual([
    `stages/implement.md changed since ${second.id} proposed this; read it with agentgate factory proposal ${second.id} and change the folder by hand`,
  ]);
  const discarded = await n.api(`/api/factory/proposals/${second.id}/discard`, "POST");
  expect(await discarded.json()).toMatchObject({ run: second.id, state: "discarded" });
  expect(storedFiles(n.s)!["stages/implement.md"]).toBe("My own words.\n");
  expect(existsSync(join(fetcher.root, storedCommit(storedFiles(n.s)!)))).toBe(true);
});
