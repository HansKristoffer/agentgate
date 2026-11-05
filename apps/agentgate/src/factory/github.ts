import type { FactoryItem } from "./db.ts";
import { issueComments, issueState, openLabelledIssues, postIssueComment, viewerLogin } from "./gh.ts";
import { parseMarkers } from "./markers.ts";
import type { FactoryRuntime, SourceAdapter } from "./runtime.ts";

/**
 * The GitHub source: open issues with the source's label become items, keyed `gh-<n>` with the external id
 * `owner/repo#<n>`. The controller polls, dedupes, backs off and re-checks the issue before every stage; this file only
 * talks to GitHub through gh.ts.
 */

/** The issue an external id names. The id, not the item's repo, is what intake recorded. */
function issueOf(item: Pick<FactoryItem, "externalId">) {
  const m = item.externalId.match(/^(.+)#(\d+)$/);
  if (!m) throw new Error(`${item.externalId} is not a GitHub issue (owner/repo#number)`);
  return { repo: m[1]!, number: Number(m[2]) };
}

export const githubSource: SourceAdapter = {
  type: "github",
  async poll(source) {
    if (source.type !== "github") return [];
    const issues = await openLabelledIssues(source.repo, source.label);
    return issues.map((issue) => ({
      externalId: `${source.repo}#${issue.number}`,
      key: `gh-${issue.number}`,
      title: issue.title,
      url: issue.url,
      snapshot: { title: issue.title, body: issue.body, url: issue.url },
    }));
  },
  async isOpen(item) {
    const { repo, number } = issueOf(item);
    return (await issueState(repo, number)) === "OPEN";
  },
  async post(item, body) {
    const { repo, number } = issueOf(item);
    return postIssueComment(repo, number, body);
  },
  /** Only the factory's own comments count: anyone who can comment could otherwise forge a marker. */
  async newestMarker(item) {
    const { repo, number } = issueOf(item);
    const [comments, viewer] = await Promise.all([issueComments(repo, number), viewerLogin()]);
    return comments
      .filter((c) => c.author.toLowerCase() === viewer.toLowerCase())
      .flatMap((c) => parseMarkers(c.body))
      .at(-1);
  },
};

export function setup(f: FactoryRuntime): void {
  f.sources.set("github", githubSource);
}
