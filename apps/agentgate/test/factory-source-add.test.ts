import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, makeCtx } from "../src/daemon.ts";
import { loadFolder } from "../src/factory/config.ts";
import { initTemplate } from "../src/factory/init.ts";
import { runCommand } from "../src/factory/runtime.ts";
import { factorySourceAddInputSchema } from "@agentgate/protocol";
import { insertSource, scoutFile, sourceYaml, withoutDefaults } from "../src/factory/source-add.ts";
import { host } from "../src/logins.ts";
import { Store } from "../src/store.ts";
import { recorded } from "./fixtures/gh.ts";
import { removeTmp, tmp } from "./fixtures/git.ts";

const REPO = "acme/api";
const realGh = host.gh;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  host.gh = realGh;
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
afterAll(removeTmp);

const TEMPLATE = initTemplate(REPO)["factory/factory.yaml"]!;
const scout = {
  id: "perf",
  type: "scout",
  repo: REPO,
  schedule: { at: "09:00", days: ["mon", "thu"], timezone: "Europe/Copenhagen" },
  mcp: ["railway"],
};
const webhook = {
  id: "desk",
  type: "webhook",
  repo: REPO,
  title: "{{body.ticket.subject}}",
  signature: { header: "X-Desk-Signature", encoding: "hex", prefix: "sha256=", secret: "secret:DESK_SIGNING" },
};

/** The folder `files` would make, loaded the way the factory loads it. */
function load(files: Record<string, string>) {
  const dir = tmp();
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return loadFolder(dir, "c".repeat(40));
}

test("a source is written as YAML that reads back the same, with times, templates and secret refs quoted", () => {
  expect(sourceYaml(scout)).toBe(
    [
      "  - id: perf",
      "    type: scout",
      "    repo: acme/api",
      "    schedule:",
      '      at: "09:00"',
      "      days: [mon, thu]",
      "      timezone: Europe/Copenhagen",
      "    mcp: [railway]",
    ].join("\n"),
  );
  expect(sourceYaml(webhook)).toContain('    title: "{{body.ticket.subject}}"');
  expect(sourceYaml(webhook)).toContain('      secret: "secret:DESK_SIGNING"');
  expect(sourceYaml({ id: "x", enabled: false, value: "yes" })).toContain('    value: "yes"');
});

test.each([
  [
    "sources followed by another key, with comments",
    TEMPLATE.replace("\n", "\n# the folder's settings\n") + "# limits\nlimits:\n  threads: 2\n",
  ],
  ["sources last", TEMPLATE],
  ["sources: []", TEMPLATE.replace(/sources:[\s\S]*$/, "sources: []\n")],
  ["no sources key", TEMPLATE.replace(/sources:[\s\S]*$/, "")],
  ["sources with nothing under them", TEMPLATE.replace(/sources:[\s\S]*$/, "sources:\nlimits:\n  threads: 2\n")],
])("a webhook source is added to a factory.yaml with %s, which keeps its comments and loads", (_, yaml) => {
  const next = insertSource(yaml, webhook);
  expect(next).toStartWith(yaml.split("\n")[0]!); // the schema comment stays first
  for (const comment of yaml.split("\n").filter((l) => l.startsWith("#"))) expect(next).toContain(comment);
  const folder = load({ "factory.yaml": next });
  expect(folder.config.sources.at(-1)).toMatchObject({ id: "desk", type: "webhook", repo: REPO, intake: "hold" });
  expect(next).not.toContain("intake"); // only what was set
});

test("a source keeps only what differs from its defaults, nested values included", () => {
  const parse = (value: unknown) => factorySourceAddInputSchema.shape.source.parse(value);
  const all = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  expect(
    withoutDefaults(
      { ...scout, schedule: { at: "09:00", days: all, timezone: "UTC" }, intake: "auto", enabled: true },
      parse,
    ),
  ).toEqual({ id: "perf", type: "scout", repo: REPO, schedule: { at: "09:00" }, mcp: ["railway"] });
  expect(
    withoutDefaults(
      { ...webhook, body: "{{body}}", intake: "hold", signature: { ...webhook.signature, prefix: "" } },
      parse,
    ),
  ).toEqual({ ...webhook, signature: { header: "X-Desk-Signature", encoding: "hex", secret: "secret:DESK_SIGNING" } });
});

test("a scout is one file: its settings as frontmatter, only those set, and its prompt", () => {
  const file = scoutFile(scout, "Look at latency.\n\n");
  expect(file).toBe(
    [
      "---",
      "repo: acme/api",
      "schedule:",
      '  at: "09:00"',
      "  days: [mon, thu]",
      "  timezone: Europe/Copenhagen",
      "mcp: [railway]",
      "---",
      "",
      "Look at latency.",
      "",
    ].join("\n"),
  );
  const folder = load({ "factory.yaml": TEMPLATE, "scouts/perf.md": file });
  expect(folder.config.sources.at(-1)).toMatchObject({ id: "perf", type: "scout", repo: REPO, intake: "auto" });
  expect(folder.scouts.perf!.prompt).toBe("Look at latency.");
});

test("a signed webhook's secret is the one its source names, with nothing to declare", () => {
  const next = insertSource(TEMPLATE, webhook);
  expect(next.match(/DESK_SIGNING/g)).toHaveLength(1);
  expect(load({ "factory.yaml": next }).secrets).toEqual(["DESK_SIGNING"]);
});

test("a factory.yaml it cannot edit is refused with the snippet to add by hand", () => {
  const flow = TEMPLATE.replace(
    /sources:[\s\S]*$/,
    "sources: [{ id: issues, type: github, repo: acme/api, label: factory }]\n",
  );
  expect(() => insertSource(flow, scout)).toThrow(
    "factory.yaml could not be edited (its sources are not a block list); add this to it by hand:\n\nsources:\n  - id: perf",
  );
});

const ok = (value: unknown) => ({ ok: true, out: typeof value === "string" ? value : JSON.stringify(value) });

/** GitHub for the factory's repository: files by branch, branches, and the tree, commit and PR a source add writes.
 * A file or branch that is not there is answered as GitHub was recorded answering it (fixtures/gh-recorded.json). */
function fakeGitHub(files: Record<string, string> = { "factory/factory.yaml": TEMPLATE }) {
  const github = {
    branches: new Map<string, Record<string, string>>([["main", files]]),
    tags: new Set<string>(),
    tree: [] as { path: string; content: string }[],
    base: "",
    prs: [] as { head: string; base: string; draft: boolean; title: string; body: string }[],
    writes: 0,
  };
  host.gh = async (args, stdin) => {
    const [cmd, sub] = args;
    if (cmd === "repo" && sub === "view") return ok({ defaultBranchRef: { name: "main" } });
    if (cmd === "pr" && sub === "create") {
      github.writes++;
      const flag = (name: string) => args[args.indexOf(name) + 1]!;
      github.prs.push({
        head: flag("--head"),
        base: flag("--base"),
        draft: args.includes("--draft"),
        title: flag("--title"),
        body: stdin!,
      });
      return ok(`https://github.com/${REPO}/pull/${8 + github.prs.length}\n`);
    }
    if (cmd === "pr" && sub === "list")
      return ok(github.prs.map((_, i) => ({ url: `https://github.com/${REPO}/pull/${9 + i}` })));
    const path = args.find((a) => a.startsWith(`repos/${REPO}/`))!.replace(`repos/${REPO}/`, "");
    const [route, query] = path.split("?");
    const ref = new URLSearchParams(query).get("ref") ?? "main";
    if (route!.startsWith("contents/")) {
      const content = github.branches.get(ref)?.[route!.slice(9)];
      if (content === undefined) return recorded(args.includes("--jq") ? "fileExists.missing" : "readFile.missing");
      return ok(args.includes("--jq") ? route!.slice(9) : content);
    }
    if (route!.startsWith("branches/")) {
      const branch = decodeURIComponent(route!.slice(9));
      return github.branches.has(branch) ? ok({ name: branch }) : recorded("branchExists.missing");
    }
    const head = route!.match(/^git\/ref\/heads\/(.+)$/);
    if (head) {
      github.base = head[1]!;
      return ok({ object: { sha: "base" } });
    }
    if (route === "git/commits/base") return ok({ tree: { sha: "base-tree" } });
    if (route === "git/trees") {
      github.writes++;
      github.tree = JSON.parse(stdin!).tree;
      return ok({ sha: "tree-1" });
    }
    if (route === "git/commits") return ok({ sha: "commit-1" });
    if (route === "git/refs") {
      github.branches.set(JSON.parse(stdin!).ref.replace("refs/heads/", ""), {});
      return ok({ ref: "created" });
    }
    throw new Error(`the fake GitHub has no answer for gh ${args.join(" ")}`);
  };
  return github;
}

/** A machine whose factory runs the folder `factory` of acme/api, at `ref` when given. */
function node(ref?: string) {
  const s = new Store(":memory:");
  s.setLocal("node", "a");
  s.put("node", "a", { id: "a", protocol: 8 });
  s.put("setting", "settings", {
    ...s.settings(),
    factory: { store: "github", repo: REPO, path: "factory", node: "a", ...(ref && { ref }) },
  });
  const ctx = makeCtx(s);
  cleanup.push(async () => {
    ctx.abort.abort();
    ctx.skills.close();
    ctx.imports.close();
    await ctx.gateway.close();
    s.close();
  });
  const command = async (stdin: string, ...args: string[]) => {
    const output: string[] = [];
    const code = await runCommand(ctx.factory, "source", args, { stdin, out: (line) => output.push(line) }).catch(
      (e: Error) => {
        output.push(e.message);
        return 1;
      },
    );
    return { code, output };
  };
  const api = async (body: unknown) => {
    const res = await app(ctx).fetch(
      new Request("http://127.0.0.1:7878/api/factory/sources", {
        method: "POST",
        headers: { host: "127.0.0.1:7878", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { listener: "loopback" },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { command, api };
}

test("POST /sources pushes the scout's file under the folder, and opens a PR to the factory's branch", async () => {
  const github = fakeGitHub();
  const res = await node().api({ source: scout, prompt: "Look at latency.\n\n" });
  expect(res).toEqual({
    status: 200,
    body: { prUrl: `https://github.com/${REPO}/pull/9`, branch: "agentgate/factory-source-perf", warnings: [] },
  });
  expect(github.base).toBe("main");
  expect(github.tree.map((t) => t.path)).toEqual(["factory/scouts/perf.md"]);
  const folder = load({ "factory.yaml": TEMPLATE, "scouts/perf.md": github.tree[0]!.content });
  expect(folder.config.sources.map((s) => s.id)).toEqual(["issues", "perf"]);
  expect(github.prs).toEqual([
    expect.objectContaining({
      head: "agentgate/factory-source-perf",
      base: "main",
      draft: false,
      title: "chore(factory): add the scout perf",
    }),
  ]);
  expect(github.prs[0]!.body).toContain(
    "It starts once this PR merges. `agentgate factory scout perf` runs it at once.",
  );
});

test("source add reads YAML on stdin; a signed webhook says to set its secret", async () => {
  const github = fakeGitHub();
  const yaml = [
    "source:",
    "  id: desk",
    "  type: webhook",
    `  repo: ${REPO}`,
    '  title: "{{body.ticket.subject}}"',
    "  signature:",
    "    header: X-Desk-Signature",
    "    encoding: hex",
    '    prefix: "sha256="',
    "    secret: secret:DESK_SIGNING",
  ].join("\n");
  const { code, output } = await node().command(yaml, "add");
  expect({ code, output }).toEqual({
    code: 0,
    output: [
      `Opened https://github.com/${REPO}/pull/9; the source starts once it merges.`,
      "Warning: Set the signing secret with agentgate factory secret set DESK_SIGNING before deliveries arrive",
    ],
  });
  const yamlFile = github.tree.find((t) => t.path === "factory/factory.yaml")!.content;
  expect(load({ "factory.yaml": yamlFile }).secrets).toEqual(["DESK_SIGNING"]);
  expect(github.prs[0]!.body).toContain("agentgate factory secret set DESK_SIGNING");
});

test("a factory that follows a tag gets its PR on the default branch, with a warning", async () => {
  const github = fakeGitHub();
  const res = await node("v1").api({ source: scout, prompt: "Look at latency." });
  expect(res.body.warnings).toEqual([
    "The factory follows v1, which is not a branch, so the PR goes to the default branch; perf starts once v1 includes it",
  ]);
  expect(github.prs[0]!.base).toBe("main");
});

test("source add refuses before writing: a taken id, a repository the factory lacks, an existing prompt or branch, a scout without a prompt", async () => {
  const github = fakeGitHub();
  const { api, command } = node();
  const taken = await api({ source: { ...scout, id: "issues" }, prompt: "x" });
  expect(taken).toEqual({ status: 400, body: { error: "The factory already has a source issues" } });
  expect((await api({ source: { ...scout, repo: "acme/web" }, prompt: "x" })).body.error).toBe(
    "acme/web is not under repositories in factory.yaml; add it there first",
  );
  expect((await api({ source: scout })).body.error).toBe("The scout perf needs a prompt");
  expect(
    await command(`source:\n  id: perf\n  type: scout\n  repo: ${REPO}\n  schedule: { every: 6h }\n`, "add"),
  ).toEqual({
    code: 1,
    output: ["The scout perf needs a prompt"],
  });

  github.branches.get("main")!["factory/scouts/perf.md"] = "Old prompt.";
  expect((await api({ source: scout, prompt: "x" })).body.error).toBe("The factory already has a scout perf");
  delete github.branches.get("main")!["factory/scouts/perf.md"];

  github.branches.set("agentgate/factory-source-perf", {});
  github.prs.push({ head: "agentgate/factory-source-perf", base: "main", draft: false, title: "", body: "" });
  expect((await api({ source: scout, prompt: "x" })).body.error).toBe(
    `A PR that adds perf is open: https://github.com/${REPO}/pull/9`,
  );
  expect(github.writes).toBe(0);
});
