import { z } from "zod";
import { host } from "../logins.ts";
import type { PostResult } from "./runtime.ts";

/**
 * Every GitHub call the factory makes, through this machine's `gh` login (`host.gh`). Output is parsed with zod, and
 * errors name the repository and what was asked, never the command line or its environment: `gh` keeps its own
 * stderr, and a GitHub API error contributes only its `message`.
 */

const DAY = 86_400_000;

/** GitHub's own explanation, when `gh api` printed an error response: REST's `message`, or GraphQL's first error. */
function apiMessage(out: string) {
  try {
    const json = JSON.parse(out);
    const message = z
      .union([
        z.object({ message: z.string() }),
        z.object({ errors: z.tuple([z.object({ message: z.string() })]).rest(z.unknown()) }),
      ])
      .safeParse(json);
    if (message.success)
      return ("message" in message.data ? message.data.message : message.data.errors[0].message).slice(0, 200);
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

/** The author associations of a repository's own people: only their PR text reaches a factory thread or counts as a
 * person's comment (D40). Bots and outside contributors have others. */
export const COLLABORATORS = ["OWNER", "MEMBER", "COLLABORATOR"];

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

/** Whether GitHub protects the branch from direct pushes, by a protection rule or a ruleset. */
export async function branchProtected(repo: string, branch: string): Promise<boolean> {
  const view = await ghJson(`read whether ${branch} of ${repo} is protected`, z.object({ protected: z.boolean() }), [
    "api",
    `repos/${repo}/branches/${encodeURIComponent(branch)}`,
  ]);
  return view.protected;
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

let viewer: Promise<string> | undefined;

/** The login this machine's `gh` acts as, which is the factory's own account (D42). Read once per process; a failed
 * read is not kept, so the next call asks again. */
export async function viewerLogin(): Promise<string> {
  viewer ??= ghJson("read this machine's gh login", login, ["api", "user"]).then(
    (user) => user.login,
    (e) => {
      viewer = undefined;
      throw e;
    },
  );
  return viewer;
}

// A deleted account's comments come without an author.
const issueComment = comment.extend({ author: login.nullish() });

/** Every comment, oldest first: `gh` pages through them when `comments` is asked for. Zod drops the other fields. */
export async function issueComments(
  repo: string,
  number: number,
): Promise<Array<{ body: string; author: string; authorAssociation: string; createdAt: string }>> {
  const view = await ghJson(`read the comments on ${repo}#${number}`, z.object({ comments: z.array(issueComment) }), [
    "issue",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "comments",
  ]);
  return view.comments.map(({ author, ...rest }) => ({ ...rest, author: author?.login ?? "" }));
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

// ---- starting a factory folder in a repository (factory init)

/** Whether GitHub answered a read with "Not Found". */
const notFound = (r: { ok: boolean; out: string } | undefined) => !!r && !r.ok && apiMessage(r.out) === "Not Found";

const contents = (repo: string, path: string, ref?: string) =>
  `repos/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;

/** Whether a file exists on `ref`, or the default branch. */
export async function fileExists(repo: string, path: string, ref?: string): Promise<boolean> {
  const r = await host.gh(["api", contents(repo, path, ref), "--jq", ".path"]);
  if (notFound(r)) return false;
  await gh(`read ${path} in ${repo}`, ["api", contents(repo, path, ref), "--jq", ".path"]);
  return true;
}

/** A text file's content on `ref`, or undefined when there is none. */
export async function readFile(repo: string, path: string, ref: string): Promise<string | undefined> {
  const args = ["api", "-H", "Accept: application/vnd.github.raw+json", contents(repo, path, ref)];
  const r = await host.gh(args);
  if (notFound(r)) return undefined;
  return gh(`read ${path} at ${ref} in ${repo}`, args);
}

/** Whether a branch exists. */
export async function branchExists(repo: string, branch: string): Promise<boolean> {
  const r = await host.gh(["api", `repos/${repo}/branches/${encodeURIComponent(branch)}`, "--jq", ".name"]);
  if (notFound(r)) return false;
  await gh(`read the branch ${branch} of ${repo}`, ["api", `repos/${repo}/branches/${encodeURIComponent(branch)}`]);
  return true;
}

const sha = z.object({ sha: z.string().min(1) });

/** One commit on a new branch from the head of `base` (default: the default branch), adding or replacing `files` (path
 * to text). Throws when the branch exists or the repository has no commits. */
export async function pushNewBranch(
  repo: string,
  branch: string,
  message: string,
  files: Record<string, string>,
  base?: string,
) {
  base ??= await defaultBranch(repo);
  const head = await ghJson(
    `read the head of ${base} in ${repo} (an empty repository has none)`,
    z.object({ object: sha }),
    ["api", `repos/${repo}/git/ref/heads/${base}`],
  ).then((r) => r.object.sha);
  const parent = await ghJson(`read commit ${head} of ${repo}`, z.object({ tree: sha }), [
    "api",
    `repos/${repo}/git/commits/${head}`,
  ]);
  const post = (what: string, path: string, payload: unknown) =>
    ghJson(what, sha, ["api", path, "--method", "POST", "--input", "-"], JSON.stringify(payload));
  const tree = await post(`write the files to ${repo}`, `repos/${repo}/git/trees`, {
    base_tree: parent.tree.sha,
    tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
  });
  const commit = await post(`commit the files to ${repo}`, `repos/${repo}/git/commits`, {
    message,
    tree: tree.sha,
    parents: [head],
  });
  await gh(
    `create the branch ${branch} in ${repo}`,
    ["api", `repos/${repo}/git/refs`, "--method", "POST", "--input", "-"],
    JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
  );
}

/** Opens a PR from `head` to `base`, or the default branch. */
export async function openPr(
  repo: string,
  head: string,
  title: string,
  body: string,
  opts: { base?: string; draft?: boolean } = {},
) {
  const base = opts.base ?? (await defaultBranch(repo));
  const out = await gh(
    `open a pull request from ${head} in ${repo}`,
    [
      "pr",
      "create",
      "--repo",
      repo,
      "--head",
      head,
      "--base",
      base,
      ...(opts.draft ? ["--draft"] : []),
      "--title",
      title,
      "--body-file",
      "-",
    ],
    body,
  );
  const url = out.trim().split("\n").at(-1)!.trim();
  const { number } = prOf(url);
  return { url, number };
}

/** The open PR whose head is `branch`, if there is one. */
export async function openPrFor(repo: string, branch: string): Promise<string | undefined> {
  const list = await ghJson(`list pull requests from ${branch} in ${repo}`, z.array(z.object({ url: z.string() })), [
    "pr",
    "list",
    "--repo",
    repo,
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "url",
  ]);
  return list[0]?.url;
}

/** Creates a label unless the repository has it. */
export async function ensureLabel(repo: string, name: string, color: string, description: string) {
  const r = await host.gh(["api", `repos/${repo}/labels/${encodeURIComponent(name)}`, "--jq", ".name"]);
  if (r?.ok) return;
  if (!notFound(r))
    await gh(`read the label ${name} in ${repo}`, ["api", `repos/${repo}/labels/${encodeURIComponent(name)}`]);
  await gh(
    `create the label ${name} in ${repo}`,
    ["api", `repos/${repo}/labels`, "--method", "POST", "--input", "-"],
    JSON.stringify({ name, color, description }),
  );
}

/** A PR's state. */
export async function prState(repo: string, number: number): Promise<"OPEN" | "CLOSED" | "MERGED"> {
  const view = await ghJson(
    `read the state of ${repo}#${number}`,
    z.object({ state: z.enum(["OPEN", "CLOSED", "MERGED"]) }),
    ["pr", "view", String(number), "--repo", repo, "--json", "state"],
  );
  return view.state;
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

/** A comment in a review or a review conversation; `bot` when a GitHub App wrote it, whatever its association. */
export interface FeedbackComment {
  body: string;
  at: string;
  association: string;
  bot: boolean;
}
export interface ReviewConversation {
  id: string;
  resolved: boolean;
  outdated: boolean;
  path: string;
  line: number | null;
  canResolve: boolean;
  comments: FeedbackComment[];
}
export interface PrFeedback {
  reviews: Array<FeedbackComment & { state: string }>;
  conversations: ReviewConversation[];
}

// `gh pr view` cannot tell a bot from a person (both are plain logins), and has no review conversations.
const FEEDBACK = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(last: 100) { nodes { body state submittedAt authorAssociation author { __typename } } }
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line originalLine viewerCanResolve
          comments(first: 50) { nodes { body createdAt authorAssociation author { __typename } } }
        }
      }
    }
  }
}`;
const author = z.object({ __typename: z.string() }).nullable(); // null for a deleted account
const feedbackSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviews: z.object({
          nodes: z.array(
            z.object({
              body: z.string(),
              state: z.string(),
              submittedAt: z.string().nullable(), // null while pending
              authorAssociation: z.string(),
              author,
            }),
          ),
        }),
        reviewThreads: z.object({
          nodes: z.array(
            z.object({
              id: z.string(),
              isResolved: z.boolean(),
              isOutdated: z.boolean(),
              path: z.string(),
              line: z.number().nullable(),
              originalLine: z.number().nullable(),
              viewerCanResolve: z.boolean(),
              comments: z.object({
                nodes: z.array(
                  z.object({ body: z.string(), createdAt: z.string(), authorAssociation: z.string(), author }),
                ),
              }),
            }),
          ),
        }),
      }),
    }),
  }),
});

/** A PR's reviews and review conversations, with which comments bots wrote. The last 100 reviews, the first 100
 * conversations and the first 50 comments of each. */
export async function prFeedback(url: string): Promise<PrFeedback> {
  const { repo, number } = prOf(url);
  const [owner, name] = repo.split("/") as [string, string];
  const answer = await ghJson(`read the reviews of ${repo}#${number}`, feedbackSchema, [
    "api",
    "graphql",
    "-f",
    `query=${FEEDBACK}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${number}`,
  ]);
  const { reviews, reviewThreads } = answer.data.repository.pullRequest;
  const comment = (c: { body: string; authorAssociation: string; author: { __typename: string } | null }) => ({
    body: c.body,
    association: c.authorAssociation,
    bot: c.author?.__typename === "Bot",
  });
  return {
    reviews: reviews.nodes.flatMap((r) =>
      r.submittedAt ? [{ ...comment(r), at: r.submittedAt, state: r.state }] : [],
    ),
    conversations: reviewThreads.nodes.map((t) => ({
      id: t.id,
      resolved: t.isResolved,
      outdated: t.isOutdated,
      path: t.path,
      line: t.line ?? t.originalLine,
      canResolve: t.viewerCanResolve,
      comments: t.comments.nodes.map((c) => ({ ...comment(c), at: c.createdAt })),
    })),
  };
}

const REPLY = `mutation ($id: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } }
}`;
const RESOLVE = `mutation ($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }`;

/** A reply in a review conversation. Like an issue comment: failed when GitHub refused it (nothing was written),
 * uncertain when no answer said either way. GraphQL can exit 0 with `errors` and a null payload, which is a refusal. */
export async function replyToConversation(id: string, body: string): Promise<PostResult> {
  const what = "reply in a review conversation";
  const r = await host.gh(["api", "graphql", "-f", `query=${REPLY}`, "-f", `id=${id}`, "-f", `body=${body}`]);
  if (!r) return { status: "failed", error: `gh is not installed, so the factory cannot ${what}` };
  const message = apiMessage(r.out);
  if (r.ok && !message) return { status: "posted" };
  return message
    ? { status: "failed", error: `GitHub refused to ${what}: ${message}` }
    : { status: "uncertain", error: `gh could not ${what}, and GitHub gave no answer` };
}

export async function resolveConversation(id: string): Promise<void> {
  await ghJson(
    "resolve a review conversation",
    z.object({
      data: z.object({ resolveReviewThread: z.object({ thread: z.object({ isResolved: z.literal(true) }) }) }),
    }),
    ["api", "graphql", "-f", `query=${RESOLVE}`, "-f", `id=${id}`],
  );
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
