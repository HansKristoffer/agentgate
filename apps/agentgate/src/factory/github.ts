import { currentFolder } from "./config.ts";
import type { FactoryItem } from "./db.ts";
import {
  ISSUE_LIMIT,
  issueComments,
  issueStateAndComments,
  openLabelledIssues,
  postIssueComment,
  viewerLogin,
} from "./gh.ts";
import { parseMarkers } from "./markers.ts";
import type { FactoryRuntime, SourceAdapter } from "./runtime.ts";

/**
 * The GitHub source: open issues with the source's label become items, keyed `<repository name>-<n>` with the external
 * id `owner/repo#<n>`. The controller polls, dedupes, backs off and re-checks the issue before every stage; this file
 * only talks to GitHub through gh.ts.
 */

const CAPPED = `Only the newest ${ISSUE_LIMIT} open labelled issues are read; the rest wait until fewer are open`;

/** Sources whose last poll found more than ISSUE_LIMIT issues, which their board row says. */
const cappedSources = new WeakMap<FactoryRuntime, Set<string>>();
function cappedOf(f: FactoryRuntime) {
  let set = cappedSources.get(f);
  if (!set) cappedSources.set(f, (set = new Set()));
  return set;
}

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

/** The newest marker in the factory's own comments: anyone who can comment could otherwise forge one. */
const newestOf = (comments: { body: string; author: string }[], viewer: string) =>
  comments
    .filter((c) => c.author.toLowerCase() === viewer.toLowerCase())
    .flatMap((c) => parseMarkers(c.body))
    .at(-1);

export const githubSource = (f: FactoryRuntime): SourceAdapter => ({
  type: "github",
  async poll(source) {
    // Cleared first, so a failed poll shows its own error instead.
    cappedOf(f).delete(source.id);
    if (source.type !== "github") return [];
    const { issues, more } = await openLabelledIssues(source.repo, source.label);
    if (more) cappedOf(f).add(source.id);
    return issues.map((issue) => ({
      externalId: `${source.repo}#${issue.number}`,
      key: issueKey(f, source.repo, issue.number),
      title: issue.title,
      url: issue.url,
      snapshot: { title: issue.title, body: issue.body, url: issue.url },
      ...(issue.updatedAt && { updatedAt: issue.updatedAt }),
    }));
  },
  async check(item) {
    const { repo, number } = issueOf(item);
    return { open: (await issueStateAndComments(repo, number)).open };
  },
  async post(item, body) {
    const { repo, number } = issueOf(item);
    return postIssueComment(repo, number, body);
  },
  /** Only the factory's own comments count: anyone who can comment could otherwise forge a marker. */
  async newestMarker(item) {
    const { repo, number } = issueOf(item);
    const [comments, viewer] = await Promise.all([issueComments(repo, number), viewerLogin()]);
    return newestOf(comments, viewer);
  },
});

export function setup(f: FactoryRuntime): void {
  // Merged into the controller's row for the source, which comes earlier.
  f.boardParts.push(async () => ({
    sources: (currentFolder(f)?.config.sources ?? []).flatMap((source) =>
      cappedOf(f).has(source.id) ? [{ id: source.id, type: source.type, repo: source.repo, error: CAPPED }] : [],
    ),
  }));
  f.sources.set("github", githubSource(f));
}
