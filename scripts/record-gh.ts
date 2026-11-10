// Records what `gh` really answers to the reads apps/agentgate/src/factory/gh.ts makes, for the replays in
// apps/agentgate/test/fixtures/gh.ts. It calls gh.ts itself, so each entry has exactly the arguments gh.ts passes, and
// it refuses any call that is not a read. It uses this machine's own `gh` login against HansKristoffer/factory-scratch
// and a repository that does not exist. Logins and commit authors are cut to what the tests need, and the file is not
// written if anything looks like a credential.
// An entry is written only when it is new or gh.ts now asks with other arguments, so the fixture's diff stays small;
// `--refresh` records every entry again. Entries this script cannot make (another environment, another repository or
// a cut by hand) stay as recorded, and it lists them.
// Usage: bun scripts/record-gh.ts [--refresh]
import { join } from "node:path";
import * as gh from "../apps/agentgate/src/factory/gh.ts";
import { ghAnswer, host } from "../apps/agentgate/src/logins.ts";

type Recording = { args: string[]; exit: number; stdout: string; stderr: string };

const FIXTURE = join(import.meta.dir, "../apps/agentgate/test/fixtures/gh-recorded.json");
const SCRATCH = "HansKristoffer/factory-scratch";
const GONE = "HansKristoffer/no-such-repo-agentgate";
const pr = (n: number) => `https://github.com/${SCRATCH}/pull/${n}`;

/** Entries made another way, kept as they are. */
const KEPT: Array<[RegExp, string]> = [
  [/^(offline|noDns|loggedOut|badToken)\./, "needs gh run offline, logged out or with a bad token"],
  [/\.empty$/, "reads aldevvv/zerolabs, a repository without commits"],
  [/^followed\.manyChecks$/, "reads pytorch/pytorch#203997 and was cut by hand"],
  [/^reverts$/, "reads cli/cli"],
];

function assertRead(args: string[]) {
  const [cmd, sub] = args;
  const refuse = () => {
    throw new Error(`refusing a call that is not a known read: gh ${args.slice(0, 3).join(" ")}`);
  };
  if (cmd === "api") {
    if (args.some((a) => ["--method", "-X", "--input"].includes(a))) refuse();
    if (sub !== "graphql") return;
    const query = args.find((a) => a.startsWith("query="));
    if (!query || !/^query=\s*query\b/.test(query) || /\bmutation\b/.test(query)) refuse();
    return;
  }
  if (!["repo view", "issue list", "issue view", "pr view", "pr list"].includes(`${cmd} ${sub}`)) refuse();
}

const made: Array<[string, Recording]> = [];
let names: string[] = [];

host.gh = async (args, stdin) => {
  assertRead(args);
  if (stdin !== undefined) throw new Error("a read takes no stdin");
  const name = names.shift();
  if (!name) throw new Error(`gh ${args.slice(0, 3).join(" ")} was not expected here`);
  const child = Bun.spawn(["gh", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    timeout: 60_000,
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  made.push([name, { args, exit, stdout, stderr }]);
  return ghAnswer({ exit, stdout, stderr });
};

/** Runs one gh.ts read; `calls` names each `gh` call it makes, in order. */
async function record(calls: string | string[], read: () => Promise<unknown>) {
  names = [calls].flat();
  const first = names[0];
  const outcome = await read().then(
    () => "ok",
    (e: Error) => `threw: ${e.message}`,
  );
  if (names.length) throw new Error(`${first} made fewer gh calls than named: ${names.join(", ")} never ran`);
  console.log(`${first}: ${outcome}`);
}

await record("repoView", () => gh.defaultBranch(SCRATCH));
await record("repoView.noRepo", () => gh.defaultBranch(GONE));
await record(["visibility", "protection"], () => gh.protectionAvailable(SCRATCH, "main"));
await record("branch", () => gh.branchProtected(SCRATCH, "main"));
await record("branchExists", () => gh.branchExists(SCRATCH, "main"));
await record("branchExists.missing", () => gh.branchExists(SCRATCH, "no-such-branch"));
await record("branchExists.noRepo", () => gh.branchExists(GONE, "main"));
await record("readFile", () => gh.readFile(SCRATCH, "README.md", "main"));
await record("readFile.missing", () => gh.readFile(SCRATCH, "factory/no-such-file.yaml", "main"));
await record("label", () => gh.labelExists(SCRATCH, "factory"));
await record("label.missing", () => gh.labelExists(SCRATCH, "no-such-label"));
await record("user", () => gh.viewerLogin());
await record("user.scopes", () => gh.ghAccount());
await record("push", () => gh.canPush(SCRATCH));
await record("issueList", () => gh.openLabelledIssues(SCRATCH, "factory"));
await record("issueList.noRepo", () => gh.openLabelledIssues(GONE, "factory"));
await record("issueView", () => gh.issueStateAndComments(SCRATCH, 4));
await record("issueView.comments", () => gh.issueComments(SCRATCH, 5));
await record("issueView.missing", () => gh.issueStateAndComments(SCRATCH, 999));
await record("prList", () => gh.openPrFor(SCRATCH, "agentgate/factory-init"));
await record("prState", () => gh.prState(SCRATCH, 3));
await record("prState.missing", () => gh.prState(SCRATCH, 999));
await record("prView", () => gh.prView(pr(6)));
await record("feedback", () => gh.prFeedback(pr(6)));
await record("followed", () => gh.followedPrs(SCRATCH, [1, 3, 6, 7, 8]));
// GitHub fails the whole query for one missing PR, so gh.ts reads each again on its own.
await record(["followed.missing", "followed.missing.6", "followed.missing.999"], () =>
  gh.followedPrs(SCRATCH, [6, 999]),
);
await record("followed.noRepo", () => gh.followedPrs(GONE, [1]));
await record("mainChecks", () => gh.defaultBranchCi(SCRATCH));
await record("mainChecks.noRepo", () => gh.defaultBranchCi(GONE));
// prAddReviewers reads the author before it writes; the write itself is never run, so the read is made on its own.
names = ["prView.author"];
await host.gh(["pr", "view", pr(6), "--json", "author"]);
console.log("prView.author: ok");

const compact = (v: unknown) => `${JSON.stringify(v)}\n`;
/** Cuts an answer to what the tests read, where the rest names a person or changes on every push. */
function cut(name: string, r: Recording): Recording {
  if (r.exit !== 0) return r;
  if (name === "branch") {
    const body = JSON.parse(r.stdout);
    return { ...r, stdout: compact({ ...body, commit: { sha: body.commit.sha } }) };
  }
  if (name === "user") return { ...r, stdout: compact({ login: JSON.parse(r.stdout).login }) };
  if (name === "user.scopes") {
    // The status line and the headers that say what the token may do; the rest are request ids and rate limits.
    const split = r.stdout.search(/\r?\n\r?\n/);
    const head = r.stdout
      .slice(0, split)
      .split(/\r?\n/)
      .filter((l, i) => i === 0 || /^(content-type|x-oauth-scopes|x-accepted-oauth-scopes):/i.test(l));
    return { ...r, stdout: `${head.join("\n")}\n\n${compact({ login: JSON.parse(r.stdout.slice(split)).login })}` };
  }
  return r;
}

const CREDENTIAL =
  /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_\w{20,}|\bbearer\s+\S|^(authorization|set-cookie|cookie):|x-access-token/im;

const fixture = (await Bun.file(FIXTURE).json()) as Record<string, Recording | string>;
const refresh = process.argv.includes("--refresh");
const changes: string[] = [];
for (const [name, raw] of made) {
  const r = cut(name, raw);
  if (CREDENTIAL.test(JSON.stringify(r))) throw new Error(`${name} looks like it holds a credential; nothing written`);
  const old = fixture[name];
  const why = !old ? "new" : !Bun.deepEquals((old as Recording).args, r.args) ? "arguments changed" : "";
  if (!why && !refresh) continue;
  fixture[name] = r;
  changes.push(`${name} (${why || "recorded again"})`);
}

const recordedHere = new Set(made.map(([n]) => n));
const kept = Object.keys(fixture).filter((n) => n !== "_source" && !recordedHere.has(n));
console.log(`\nwritten: ${changes.join(", ") || "nothing"}`);
for (const n of kept) console.log(`kept as recorded: ${n}: ${KEPT.find(([re]) => re.test(n))?.[1] ?? "not made here"}`);
if (changes.length) {
  await Bun.write(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  // The repository's formatter lays the fixture out, so a write leaves only the changed entries in its diff.
  const fmt = Bun.spawn([process.execPath, "fmt", "--no-script", FIXTURE], { stdout: "ignore", timeout: 60_000 });
  if ((await fmt.exited) !== 0) throw new Error("bun fmt could not format the fixture");
}
