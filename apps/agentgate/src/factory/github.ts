import { currentFolder } from "./config.ts";
import type { FactoryItem } from "./db.ts";
import type { FactoryCheck } from "@agentgate/protocol";
import {
  canPush,
  COLLABORATORS,
  ghAccount,
  ISSUE_LIMIT,
  issueComments,
  issueStateAndComments,
  labelExists,
  openLabelledIssues,
  postIssueComment,
  viewerLogin,
} from "./gh.ts";
import { ownMarkers, parseMarkers } from "./markers.ts";
import { shortError, type FactoryRuntime, type SourceAdapter } from "./runtime.ts";

/**
 * The GitHub source: open issues with the source's label become items, keyed `<repository name>-<n>` with the external
 * id `owner/repo#<n>`. Intake polls, dedupes and backs off, and the controller re-checks the issue before every stage; this file
 * only talks to GitHub through gh.ts.
 */

const CAPPED = `Only the newest ${ISSUE_LIMIT} open labelled issues are read; the rest wait until fewer are open`;

/** `<repository name>-<number>`, such as `api-42`, or `<owner>-<name>-<number>` when another of the folder's
 * repositories has the same name. Lowercase, with anything a branch name should not hold made a dash. */
function issueKey(f: FactoryRuntime, repo: string, number: number) {
  const [owner, name] = repo.toLowerCase().split("/") as [string, string];
  const repos = Object.keys(currentFolder(f)?.config.repositories ?? {}).map((r) => r.toLowerCase());
  const clash = repos.some((r) => r !== repo.toLowerCase() && r.split("/")[1] === name);
  return `${clash ? `${owner}-` : ""}${name}-${number}`.replace(/[^a-z0-9-]+/g, "-");
}

/** The issue an external id names. The id, not the item's repo, is what intake recorded. */
function issueOf(item: Pick<FactoryItem, "externalId">) {
  const m = item.externalId.match(/^(.+)#(\d+)$/);
  if (!m) throw new Error(`${item.externalId} is not a GitHub issue (owner/repo#number)`);
  return { repo: m[1]!, number: Number(m[2]) };
}

export const githubSource = (f: FactoryRuntime): SourceAdapter => ({
  type: "github",
  async poll(source) {
    if (source.type !== "github") return { items: [] };
    const { issues, more } = await openLabelledIssues(source.repo, source.label);
    return {
      items: issues.map((issue) => ({
        externalId: `${source.repo}#${issue.number}`,
        key: issueKey(f, source.repo, issue.number),
        title: issue.title,
        url: issue.url,
        snapshot: { title: issue.title, body: issue.body, url: issue.url },
        ...(issue.updatedAt && { updatedAt: issue.updatedAt }),
      })),
      ...(more && { capped: CAPPED }),
    };
  },
  async check(item) {
    const { repo, number } = issueOf(item);
    const [{ open, comments }, viewer] = await Promise.all([issueStateAndComments(repo, number), viewerLogin()]);
    const own = comments.map((c) => ({ body: c.body, own: c.author.toLowerCase() === viewer.toLowerCase() }));
    return { open, markers: ownMarkers(own) };
  },
  async post(item, body) {
    const { repo, number } = issueOf(item);
    return postIssueComment(repo, number, body);
  },
  /** The trust rule for PR comments (D40): the repository's own people. A comment without a marker is a person's, even
   * from the factory's own login, which is the maintainer's (D42). */
  async replies(item, after) {
    const { repo, number } = issueOf(item);
    const [comments, viewer] = await Promise.all([issueComments(repo, number), viewerLogin()]);
    const own = (c: { author: string }) => c.author.toLowerCase() === viewer.toLowerCase();
    const factory = comments.findLastIndex((c) => own(c) && parseMarkers(c.body).length);
    if (factory < 0) return [];
    return comments
      .slice(
        Math.max(
          factory,
          comments.findIndex((c) => c.id === after),
        ) + 1,
      )
      .filter((c) => !parseMarkers(c.body).length && (own(c) || COLLABORATORS.includes(c.authorAssociation)))
      .map(({ id, body }) => ({ id, body }));
  },
});

/**
 * The preflight's GitHub checks, through this machine's `gh`: signed in with the `repo` scope, push access to each of
 * the folder's repositories, and each GitHub source's label. One call for the login, then one per repository and
 * label at once; nothing past the login is asked while `gh` cannot ask at all.
 */
async function githubChecks(f: FactoryRuntime): Promise<FactoryCheck[]> {
  const account = await ghAccount();
  const signedIn = { id: "gh", title: "gh is signed in with the repo scope" };
  if ("error" in account)
    return [
      {
        ...signedIn,
        state: "fail",
        detail: account.error,
        fix: account.signedOut ? "install gh and run gh auth login" : "gh auth status",
      },
    ];
  // A fine-grained token has no scopes to read: its push access below says what it may do.
  const scoped = !account.scopes || account.scopes.includes("repo");
  const checks: FactoryCheck[] = [
    {
      ...signedIn,
      state: scoped ? "ok" : "fail",
      detail: scoped
        ? `as ${account.login}`
        : `${account.login}'s token lacks the repo scope (it has ${account.scopes?.join(", ") || "none"})`,
      ...(!scoped && { fix: "gh auth refresh --scopes repo" }),
    },
  ];
  const config = currentFolder(f)?.config;
  const asked = async (check: Omit<FactoryCheck, "state">, ask: () => Promise<boolean>, fix: string) => {
    try {
      return (await ask()) ? { ...check, state: "ok" as const } : { ...check, state: "fail" as const, fix };
    } catch (e) {
      return { ...check, state: "unknown" as const, detail: shortError(e) };
    }
  };
  const pushes = Object.keys(config?.repositories ?? {}).map((repo) =>
    asked(
      { id: `push:${repo}`, title: `gh can push to ${repo}` },
      () => canPush(repo),
      `give ${account.login} write access to ${repo}`,
    ),
  );
  const labels = (config?.sources ?? []).flatMap((source) =>
    source.type === "github"
      ? [
          asked(
            { id: `label:${source.id}`, title: `${source.repo} has the label ${source.label} (source ${source.id})` },
            () => labelExists(source.repo, source.label),
            `gh label create ${source.label} --repo ${source.repo}`,
          ),
        ]
      : [],
  );
  return [...checks, ...(await Promise.all([...pushes, ...labels]))];
}

export function setup(f: FactoryRuntime): void {
  f.checks.push({ name: "GitHub", slow: true, run: () => githubChecks(f) });
  f.sources.set("github", githubSource(f));
}
