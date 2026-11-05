import { z } from "zod";
import { host } from "../logins.ts";
import type { PostResult } from "./runtime.ts";

/**
 * Every GitHub call the factory makes, through this machine's `gh` login (`host.gh`). Output is parsed with zod, and
 * errors name the repository and what was asked, never the command line or its environment: `gh` keeps its own
 * stderr, and a GitHub API error contributes only its `message`.
 */

const DAY = 86_400_000;

/** GitHub's own explanation, when `gh api` printed an error response. */
function apiMessage(out: string) {
  try {
    const message = z.object({ message: z.string() }).safeParse(JSON.parse(out));
    if (message.success) return message.data.message.slice(0, 200);
  } catch {
    // Not a GitHub API error response.
  }
  return undefined;
}

async function gh(what: string, args: string[], stdin?: string) {
  const r = await host.gh(args, stdin);
  if (!r) throw new Error(`gh is not installed, so the factory cannot ${what}`);
  if (!r.ok) {
    const message = apiMessage(r.out);
    throw new Error(`gh could not ${what}: ${message ?? "check gh auth status on this machine"}`);
  }
  return r.out;
}

async function ghJson<T extends z.ZodType>(what: string, schema: T, args: string[], stdin?: string) {
  const out = await gh(what, args, stdin);
  let json: unknown;
  try {
    json = JSON.parse(out);
  } catch {
    throw new Error(`gh answered with something other than JSON when asked to ${what}`);
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  const where = issue.path.join(".") || "the answer";
  throw new Error(`gh answered in an unexpected shape when asked to ${what} (${where}: ${issue.message})`);
}

/** `owner/repo` and the number of a pull request URL. */
function prOf(url: string) {
  const m = url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/);
  if (!m) throw new Error(`${url} is not a GitHub pull request URL`);
  return { repo: m[1]!, number: Number(m[2]) };
}

const login = z.object({ login: z.string() });
const comment = z.object({ body: z.string(), authorAssociation: z.string(), createdAt: z.string() });

export async function defaultBranch(repo: string): Promise<string> {
  const view = await ghJson(
    `read the default branch of ${repo}`,
    z.object({ defaultBranchRef: z.object({ name: z.string().min(1) }) }),
    ["repo", "view", repo, "--json", "defaultBranchRef"],
  );
  return view.defaultBranchRef.name;
}

export async function openLabelledIssues(
  repo: string,
  label: string,
): Promise<Array<{ number: number; title: string; body: string; url: string }>> {
  return ghJson(
    `list the open issues labelled "${label}" in ${repo}`,
    z.array(z.object({ number: z.number().int(), title: z.string(), body: z.string(), url: z.string() })),
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--label",
      label,
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,title,body,url",
    ],
  );
}

export async function issueState(repo: string, number: number): Promise<"OPEN" | "CLOSED"> {
  // Issues and pull requests share numbers, so a number can answer MERGED.
  const view = await ghJson(
    `read the state of ${repo}#${number}`,
    z.object({ state: z.enum(["OPEN", "CLOSED", "MERGED"]) }),
    ["issue", "view", String(number), "--repo", repo, "--json", "state"],
  );
  return view.state === "OPEN" ? "OPEN" : "CLOSED";
}

/** Every comment, oldest first: `gh` pages through them when `comments` is asked for. Zod drops the other fields. */
export async function issueComments(
  repo: string,
  number: number,
): Promise<Array<{ body: string; authorAssociation: string; createdAt: string }>> {
  const view = await ghJson(`read the comments on ${repo}#${number}`, z.object({ comments: z.array(comment) }), [
    "issue",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "comments",
  ]);
  return view.comments;
}

/** A POST whose outcome decides between failed (GitHub refused it, or it never left) and uncertain (it may exist). */
async function post(what: string, path: string, payload: unknown): Promise<PostResult> {
  const r = await host.gh(["api", path, "--method", "POST", "--input", "-"], JSON.stringify(payload));
  if (!r) return { status: "failed", error: `gh is not installed, so the factory cannot ${what}` };
  if (r.ok) return { status: "posted" };
  const message = apiMessage(r.out);
  return message
    ? { status: "failed", error: `GitHub refused to ${what}: ${message}` }
    : { status: "uncertain", error: `gh could not ${what}, and GitHub gave no answer` };
}

export async function postIssueComment(repo: string, number: number, body: string): Promise<PostResult> {
  return post(`comment on ${repo}#${number}`, `repos/${repo}/issues/${number}/comments`, { body });
}

export interface PrView {
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  author: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  mergedAt?: string;
  checks: "pending" | "passing" | "failing" | "none";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  body: string;
  files: string[];
  comments: Array<{ body: string; authorAssociation: string; createdAt: string }>;
  reviews: Array<{ body: string; authorAssociation: string; submittedAt: string; state: string }>;
}

const FAILED = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"];
const check = z.union([
  z.object({ __typename: z.literal("CheckRun"), status: z.string(), conclusion: z.string().nullable() }),
  z.object({ __typename: z.literal("StatusContext"), state: z.string() }),
]);

/** One summary of a PR's check runs and commit statuses: any failure wins, then anything not finished. */
function rollup(checks: z.infer<typeof check>[]): PrView["checks"] {
  if (!checks.length) return "none";
  const outcomes = checks.map((c) => {
    if (c.__typename === "StatusContext") return c.state;
    return c.status === "COMPLETED" ? (c.conclusion ?? "") : "PENDING";
  });
  if (outcomes.some((o) => FAILED.includes(o))) return "failing";
  if (outcomes.some((o) => o === "PENDING" || o === "EXPECTED" || o === "")) return "pending";
  return "passing";
}

const prViewSchema = z.object({
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  author: login,
  headRefName: z.string(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  mergedAt: z.string().nullable(),
  statusCheckRollup: z.array(check),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  body: z.string(),
  files: z.array(z.object({ path: z.string() })),
  comments: z.array(comment),
  reviews: z.array(
    z.object({ body: z.string(), authorAssociation: z.string(), submittedAt: z.string(), state: z.string() }),
  ),
});
const PR_FIELDS = Object.keys(prViewSchema.shape).join(",");

export async function prView(url: string): Promise<PrView> {
  const { repo, number } = prOf(url);
  const pr = await ghJson(`read pull request ${repo}#${number}`, prViewSchema, [
    "pr",
    "view",
    url,
    "--json",
    PR_FIELDS,
  ]);
  const { statusCheckRollup, mergedAt, author, files, ...rest } = pr;
  return {
    ...rest,
    author: author.login,
    ...(mergedAt && { mergedAt }),
    checks: rollup(statusCheckRollup),
    files: files.map((file) => file.path),
  };
}

export async function prReady(url: string): Promise<void> {
  const { repo, number } = prOf(url);
  await gh(`mark ${repo}#${number} ready for review`, ["pr", "ready", url]);
}

/** GitHub refuses a review request to the PR's own author, and in v1 that author is often the maintainer (D42). */
export async function prAddReviewers(url: string, reviewers: string[]): Promise<void> {
  const { repo, number } = prOf(url);
  const { author } = await ghJson(`read the author of ${repo}#${number}`, z.object({ author: login }), [
    "pr",
    "view",
    url,
    "--json",
    "author",
  ]);
  const others = reviewers.filter((r) => r.toLowerCase() !== author.login.toLowerCase());
  if (!others.length) return;
  await gh(`request reviews on ${repo}#${number}`, ["pr", "edit", url, "--add-reviewer", others.join(",")]);
}

export async function prSetBody(url: string, body: string): Promise<void> {
  const { repo, number } = prOf(url);
  await gh(`edit the body of ${repo}#${number}`, ["pr", "edit", url, "--body-file", "-"], body);
}

/** One review per round, as comments only. A finding without a line has no place in the diff, so it joins the body. */
export async function postPrReview(
  url: string,
  input: { commit: string; body: string; comments: Array<{ path: string; line?: number; body: string }> },
): Promise<PostResult> {
  const { repo, number } = prOf(url);
  const inline = input.comments.filter((c) => c.line !== undefined);
  const fileLevel = input.comments.filter((c) => c.line === undefined).map((c) => `**${c.path}**: ${c.body}`);
  return post(`review ${repo}#${number}`, `repos/${repo}/pulls/${number}/reviews`, {
    commit_id: input.commit,
    event: "COMMENT",
    body: [input.body, ...fileLevel].join("\n\n"),
    comments: inline.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })),
  });
}

/** The workflow runs of the newest commit pushed to the default branch. Scheduled and manual runs do not count. */
export async function defaultBranchCi(repo: string): Promise<"passing" | "failing" | "pending" | "none"> {
  const branch = await defaultBranch(repo);
  const list = await ghJson(
    `list the CI runs on ${branch} in ${repo}`,
    z.array(z.object({ headSha: z.string(), status: z.string(), conclusion: z.string() })),
    [
      "run",
      "list",
      "--repo",
      repo,
      "--branch",
      branch,
      "--event",
      "push",
      "--limit",
      "30",
      "--json",
      "headSha,status,conclusion",
    ],
  );
  const newest = list[0]?.headSha;
  if (!newest) return "none";
  const latest = list.filter((r) => r.headSha === newest);
  if (latest.some((r) => ["failure", "timed_out", "startup_failure"].includes(r.conclusion))) return "failing";
  if (latest.some((r) => r.status !== "completed")) return "pending";
  return "passing";
}

/** A merged PR within 14 days whose title starts with "Revert" and names the PR's number or title. GitHub's revert
 * button writes `Revert "<title>"` with `Reverts owner/repo#<n>` in the body. */
export async function mergedRevertOf(
  repo: string,
  pr: { number: number; title: string; mergedAt: string },
): Promise<boolean> {
  const from = Date.parse(pr.mergedAt);
  const since = new Date(from).toISOString().slice(0, 10);
  const list = await ghJson(
    `search ${repo} for reverts of #${pr.number}`,
    z.array(z.object({ number: z.number().int(), title: z.string(), body: z.string(), mergedAt: z.string() })),
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "merged",
      "--search",
      `Revert in:title merged:>=${since}`,
      "--limit",
      "50",
      "--json",
      "number,title,body,mergedAt",
    ],
  );
  const names = new RegExp(`#${pr.number}(?!\\d)`);
  return list.some((r) => {
    const at = Date.parse(r.mergedAt);
    const inWindow = at >= from && at <= from + 14 * DAY;
    const isRevert = r.number !== pr.number && /^revert\b/i.test(r.title);
    if (!inWindow || !isRevert) return false;
    return names.test(r.title) || names.test(r.body) || r.title.includes(pr.title);
  });
}

/** The open pull request whose branch is `branch`, if there is one. */
export async function openPrForHead(
  repo: string,
  branch: string,
): Promise<{ number: number; url: string } | undefined> {
  const list = await ghJson(
    `list the open pull requests from ${branch} in ${repo}`,
    z.array(z.object({ number: z.number().int(), url: z.string() })),
    ["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--limit", "1", "--json", "number,url"],
  );
  return list[0];
}

const CLOSED_BY_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: 50, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number url mergedAt baseRefOid headRefName author { __typename login }
        closingIssuesReferences(first: 10) { nodes { number title body } }
      }
    }
  }
}`;
const closedBySchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequests: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        nodes: z.array(
          z.object({
            number: z.number().int(),
            url: z.string(),
            mergedAt: z.string(),
            baseRefOid: z.string(),
            headRefName: z.string(),
            author: z.object({ __typename: z.string(), login: z.string() }).nullable(),
            closingIssuesReferences: z.object({
              nodes: z.array(z.object({ number: z.number().int(), title: z.string(), body: z.string() })),
            }),
          }),
        ),
      }),
    }),
  }),
});
const CLOSED_BY_PAGES = 20;

/** GraphQL names a bot `dependabot` where REST and `gh` say `dependabot[bot]`, and a deleted account has no author;
 * GitHub shows that account as `ghost`. */
const authorLogin = (author: { __typename: string; login: string } | null) =>
  !author ? "ghost" : author.__typename === "Bot" ? `${author.login}[bot]` : author.login;

/** Issues closed by a merged PR, most recently updated PRs first, at most `limit`. Reads at most 1,000 merged PRs. */
export async function closedByMergedPr(
  repo: string,
  limit: number,
): Promise<
  Array<{
    issue: number;
    title: string;
    body: string;
    pr: number;
    prUrl: string;
    baseSha: string;
    headRefName: string;
    author: string;
    mergedAt: string;
  }>
> {
  const [owner, name] = repo.split("/");
  const found: Awaited<ReturnType<typeof closedByMergedPr>> = [];
  let after: string | null = null;
  for (let page = 0; page < CLOSED_BY_PAGES && found.length < limit; page++) {
    const answer: z.infer<typeof closedBySchema> = await ghJson(
      `list the issues closed by merged PRs in ${repo}`,
      closedBySchema,
      [
        "api",
        "graphql",
        "-f",
        `query=${CLOSED_BY_QUERY}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        ...(after ? ["-f", `after=${after}`] : []),
      ],
    );
    const { nodes, pageInfo } = answer.data.repository.pullRequests;
    for (const pr of nodes)
      for (const issue of pr.closingIssuesReferences.nodes)
        found.push({
          issue: issue.number,
          title: issue.title,
          body: issue.body,
          pr: pr.number,
          prUrl: pr.url,
          baseSha: pr.baseRefOid,
          headRefName: pr.headRefName,
          author: authorLogin(pr.author),
          mergedAt: pr.mergedAt,
        });
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
    after = pageInfo.endCursor;
  }
  return found.slice(0, limit);
}
