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
export function prOf(url: string) {
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
): Promise<Array<{ number: number; title: string; body: string; url: string; updatedAt?: string }>> {
  return ghJson(
    `list the open issues labelled "${label}" in ${repo}`,
    z.array(
      z.object({
        number: z.number().int(),
        title: z.string(),
        body: z.string(),
        url: z.string(),
        updatedAt: z.string().optional(),
      }),
    ),
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
      "number,title,body,url,updatedAt",
    ],
  );
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

/** An issue's state and every comment, oldest first, in one read. Issues and pull requests share numbers, so a number
 * can answer MERGED, which counts as closed. */
export async function issueStateAndComments(repo: string, number: number) {
  const view = await ghJson(
    `read ${repo}#${number}`,
    z.object({ state: z.enum(["OPEN", "CLOSED", "MERGED"]), comments: z.array(issueComment) }),
    ["issue", "view", String(number), "--repo", repo, "--json", "state,comments"],
  );
  return {
    open: view.state === "OPEN",
    comments: view.comments.map(({ author, ...rest }) => ({ ...rest, author: author?.login ?? "" })),
  };
}

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
  /** Point an existing branch at the new commit instead: one an earlier, failed attempt of the same command left. */
  replace = false,
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
  if (replace)
    await gh(
      `move the branch ${branch} in ${repo}`,
      ["api", `repos/${repo}/git/refs/heads/${branch}`, "--method", "PATCH", "--input", "-"],
      JSON.stringify({ sha: commit.sha, force: true }),
    );
  else
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

export async function createIssue(repo: string, title: string, body: string): Promise<PostResult> {
  return post(`open an issue on ${repo}`, `repos/${repo}/issues`, { title, body });
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
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  body: string;
  files: string[];
  comments: Array<{ body: string; authorAssociation: string; createdAt: string }>;
  reviews: Array<{ body: string; authorAssociation: string; submittedAt: string; state: string }>;
}

export type CheckState = "pending" | "passing" | "failing" | "none";

const FAILED = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"];
const check = z.union([
  z.object({
    __typename: z.literal("CheckRun"),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
  }),
  z.object({ __typename: z.literal("StatusContext"), context: z.string(), state: z.string() }),
]);
type Check = z.infer<typeof check>;
const CHECK_FIELDS = "__typename ... on CheckRun { name status conclusion } ... on StatusContext { context state }";
const checkName = (c: Check) => (c.__typename === "CheckRun" ? c.name : c.context);
const outcomeOf = (c: Check) =>
  c.__typename === "StatusContext" ? c.state : c.status === "COMPLETED" ? (c.conclusion ?? "") : "PENDING";

/** One summary of check runs and commit statuses: any failure wins, then anything not finished. */
function rollup(checks: Check[]): CheckState {
  if (!checks.length) return "none";
  const outcomes = checks.map(outcomeOf);
  if (outcomes.some((o) => FAILED.includes(o))) return "failing";
  if (outcomes.some((o) => o === "PENDING" || o === "EXPECTED" || o === "")) return "pending";
  return "passing";
}

/** The checks a branch requires, as GitHub shows them to anyone who can read the repository: `refUpdateRule` for a
 * protection rule, `rules` for the rulesets that apply to the branch. */
const REQUIRED_FIELDS = `refUpdateRule { requiredStatusCheckContexts }
      rules(first: 100) { nodes { parameters { ... on RequiredStatusChecksParameters { requiredStatusChecks { context } } } } }`;
const requiring = z.object({
  refUpdateRule: z.object({ requiredStatusCheckContexts: z.array(z.string().nullable()).nullable() }).nullable(),
  rules: z.object({
    nodes: z.array(
      z.object({
        parameters: z
          .object({ requiredStatusChecks: z.array(z.object({ context: z.string() })).optional() })
          .nullable(),
      }),
    ),
  }),
});

function requiredChecks(ref: z.infer<typeof requiring> | null): string[] {
  const names = [
    ...(ref?.refUpdateRule?.requiredStatusCheckContexts ?? []),
    ...(ref?.rules.nodes.flatMap((n) => n.parameters?.requiredStatusChecks?.map((c) => c.context) ?? []) ?? []),
  ];
  return [...new Set(names.filter((n): n is string => !!n))];
}

/** The checks that count: the ones the branch requires, or every check when it requires none. */
const counted = (contexts: Check[], required: string[]) =>
  required.length ? contexts.filter((c) => required.includes(checkName(c))) : contexts;

/**
 * A PR head's checks as the follower judges them: the ones that count, and a required one not reported yet is
 * pending, as GitHub has it. A preview deploy or an app build the branch does not require holds nothing back.
 * `failing` names every check that failed, for the thread.
 */
function judgeChecks(contexts: Check[], required: string[]): { checks: CheckState; failing: string[] } {
  const failing = [...new Set(contexts.filter((c) => FAILED.includes(outcomeOf(c))).map(checkName))].sort();
  const state = rollup(counted(contexts, required));
  const unreported = required.some((name) => !contexts.some((c) => checkName(c) === name));
  return { checks: state !== "failing" && unreported ? "pending" : state, failing };
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
  const { mergedAt, author, files, ...rest } = pr;
  return {
    ...rest,
    author: author.login,
    ...(mergedAt && { mergedAt }),
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
const feedbackShape = {
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
          nodes: z.array(z.object({ body: z.string(), createdAt: z.string(), authorAssociation: z.string(), author })),
        }),
      }),
    ),
  }),
};
const feedbackSchema = z.object({
  data: z.object({ repository: z.object({ pullRequest: z.object(feedbackShape) }) }),
});

function toFeedback({ reviews, reviewThreads }: z.infer<z.ZodObject<typeof feedbackShape>>): PrFeedback {
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
  return toFeedback(answer.data.repository.pullRequest);
}

/** A PR's state and head, mergeability, and plain comments. */
export type PrState = Omit<PrView, "body" | "files" | "reviews">;
/** The follower's read of a PR: its state, its head's checks as `judgeChecks` has them, and the reviews and
 * conversations of `prFeedback`. Only this read knows which checks the base branch requires. */
export type FollowedPr = PrState & { checks: CheckState; failing: string[]; feedback: PrFeedback };

const REVIEWS_AND_THREADS = `reviews(last: 100) { nodes { body state submittedAt authorAssociation author { __typename } } }
    reviewThreads(first: 100) {
      nodes {
        id isResolved isOutdated path line originalLine viewerCanResolve
        comments(first: 50) { nodes { body createdAt authorAssociation author { __typename } } }
      }
    }`;
const FOLLOWED = `fragment Followed on PullRequest {
    number url title state isDraft author { login } headRefName headRefOid baseRefName mergedAt mergeable
    baseRef { ${REQUIRED_FIELDS} }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { ${CHECK_FIELDS} } } } } } }
    comments(last: 100) { nodes { body authorAssociation createdAt } }
    ${REVIEWS_AND_THREADS}
  }`;
const followedSchema = z.object({
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  author: login.nullable(), // null for a deleted account
  headRefName: z.string(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  mergedAt: z.string().nullable(),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  baseRef: requiring.nullable(), // null once the base branch is deleted
  commits: z.object({
    nodes: z.array(
      z.object({
        commit: z.object({
          statusCheckRollup: z.object({ contexts: z.object({ nodes: z.array(check) }) }).nullable(),
        }),
      }),
    ),
  }),
  comments: z.object({ nodes: z.array(comment) }),
  ...feedbackShape,
});
/** PRs per query: GitHub limits a query's cost, and 20 PRs with their reviews stay well inside it. */
const FOLLOW_BATCH = 20;

/** The PR follower's read of every PR it follows in one repository: one GraphQL query per 20 PRs, instead of a
 * `gh pr view` and a review read per PR. GitHub fails a whole query for one PR it cannot show, so a failed batch is
 * read again one PR at a time, and each PR gets its own answer or error. */
export async function followedPrs(repo: string, numbers: number[]): Promise<Map<number, FollowedPr | Error>> {
  const found = new Map<number, FollowedPr | Error>();
  const read = async (batch: number[]) => {
    for (const pr of await followedBatch(repo, batch)) found.set(pr.number, pr);
  };
  for (let i = 0; i < numbers.length; i += FOLLOW_BATCH) {
    const batch = numbers.slice(i, i + FOLLOW_BATCH);
    try {
      await read(batch);
    } catch (e) {
      if (batch.length === 1) found.set(batch[0]!, e as Error);
      else for (const n of batch) await read([n]).catch((e: Error) => found.set(n, e));
    }
  }
  for (const n of numbers)
    if (!found.has(n)) found.set(n, new Error(`GitHub does not show ${repo}#${n} to this machine's gh login`));
  return found;
}

async function followedBatch(repo: string, batch: number[]): Promise<FollowedPr[]> {
  const [owner, name] = repo.split("/") as [string, string];
  const fields = batch.map((n) => `p${n}: pullRequest(number: ${n}) { ...Followed }`).join("\n    ");
  const query = `query ($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\n    ${fields}\n  }\n}\n${FOLLOWED}`;
  const answer = await ghJson(
    `read the pull requests the factory follows in ${repo}`,
    z.object({ data: z.object({ repository: z.record(z.string(), followedSchema.nullable()) }) }),
    ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`],
  );
  return Object.values(answer.data.repository).flatMap((pr) => {
    if (!pr) return [];
    const { commits, comments, reviews, reviewThreads, mergedAt, author, baseRef, ...rest } = pr;
    return [
      {
        ...rest,
        author: author?.login ?? "ghost",
        ...(mergedAt && { mergedAt }),
        ...judgeChecks(commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [], requiredChecks(baseRef)),
        comments: comments.nodes,
        feedback: toFeedback({ reviews, reviewThreads }),
      },
    ];
  });
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

const DEFAULT_BRANCH_CHECKS = `query ($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      ${REQUIRED_FIELDS}
      target { ... on Commit { statusCheckRollup { contexts(first: 100) { nodes { ${CHECK_FIELDS} } } } } }
    }
  }
}`;
const defaultBranchChecks = z.object({
  data: z.object({
    repository: z.object({
      defaultBranchRef: requiring
        .extend({
          target: z
            .object({ statusCheckRollup: z.object({ contexts: z.object({ nodes: z.array(check) }) }).nullish() })
            .nullable(),
        })
        .nullable(), // an empty repository has no branch
    }),
  }),
});

/**
 * The default branch's CI at its newest commit: the checks that count there. A required check that does not run on the
 * default branch, as PR-only CI does not, is left out rather than waited for.
 */
export async function defaultBranchCi(repo: string): Promise<CheckState> {
  const [owner, name] = repo.split("/") as [string, string];
  const answer = await ghJson(`read the checks on the default branch of ${repo}`, defaultBranchChecks, [
    "api",
    "graphql",
    "-f",
    `query=${DEFAULT_BRANCH_CHECKS}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
  ]);
  const ref = answer.data.repository.defaultBranchRef;
  if (!ref) return "none";
  return rollup(counted(ref.target?.statusCheckRollup?.contexts.nodes ?? [], requiredChecks(ref)));
}

const revertSchema = z.object({ number: z.number().int(), title: z.string(), body: z.string(), mergedAt: z.string() });
export type MergedRevert = z.infer<typeof revertSchema>;

/** The repository's merged PRs titled as reverts since `since`: one search covers every PR merged since then. */
export async function revertsSince(repo: string, since: number): Promise<MergedRevert[]> {
  return ghJson(`search ${repo} for reverts`, z.array(revertSchema), [
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "merged",
    "--search",
    `Revert in:title merged:>=${new Date(since).toISOString().slice(0, 10)}`,
    "--limit",
    "100",
    "--json",
    "number,title,body,mergedAt",
  ]);
}

/** A revert merged within 14 days of the PR whose title starts with "Revert" and names the PR's number or title.
 * GitHub's revert button writes `Revert "<title>"` with `Reverts owner/repo#<n>` in the body. */
export function isRevertOf(reverts: MergedRevert[], pr: { number: number; title: string; mergedAt: string }) {
  const from = Date.parse(pr.mergedAt);
  const names = new RegExp(`#${pr.number}(?!\\d)`);
  return reverts.some((r) => {
    const at = Date.parse(r.mergedAt);
    const inWindow = at >= from && at <= from + 14 * DAY;
    const isRevert = r.number !== pr.number && /^revert\b/i.test(r.title);
    if (!inWindow || !isRevert) return false;
    return names.test(r.title) || names.test(r.body) || r.title.includes(pr.title);
  });
}
