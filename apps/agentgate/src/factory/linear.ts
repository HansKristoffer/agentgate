import { markerPayloadSchema, type FactorySource } from "@agentgate/protocol";
import { z } from "zod";
import { currentFolder, folderAt } from "./config.ts";
import type { FactoryItem } from "./db.ts";
import { MARKER_PREFIX, parseMarkers } from "./markers.ts";
import type { FactoryRuntime, IncomingItem, PostResult } from "./runtime.ts";
import { resolveSecretRef } from "./secrets.ts";

/**
 * The Linear source: open issues in a team that carry the source's label become items, and the factory comments back
 * on them. Linear keeps comments as rich text and drops HTML comments, so the marker travels as a visible last line,
 * `agentgate-factory:1 {...}` in a code span, and is read back from there.
 */

/** The test seam: tests answer GraphQL here instead of Linear. */
export const linearApi: { fetch: typeof fetch } = { fetch };

const ENDPOINT = "https://api.linear.app/graphql";
const TIMEOUT = 30_000;
const MAX_PAGES = 10; // 1,000 open labelled issues is far past what a factory takes on
const CLOSED = ["completed", "canceled"];
const VISIBLE = "agentgate-factory:1 ";

const CAPPED = "Only the first 1,000 open labelled issues are read; the rest wait until fewer are open";

/** Sources whose last poll stopped at MAX_PAGES with issues left, which their board row says. */
const cappedSources = new WeakMap<FactoryRuntime, Set<string>>();
function cappedOf(f: FactoryRuntime) {
  let set = cappedSources.get(f);
  if (!set) cappedSources.set(f, (set = new Set()));
  return set;
}

type LinearSource = Extract<FactorySource, { type: "linear" }>;

class LinearError extends Error {
  override name = "LinearError";
  /** True when Linear may have applied a mutation although the call did not say so. */
  constructor(
    message: string,
    readonly maybeApplied = false,
  ) {
    super(message);
  }
}

const graphqlResponse = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string().optional() })).optional(),
});

/** Linear's own text, cut short, with the key taken out in case a message ever echoes it. */
const scrub = (text: string, apiKey: string) => {
  const clean = text.replaceAll(apiKey, "[redacted]");
  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
};

async function graphql<T>(
  f: FactoryRuntime,
  apiKey: string,
  schema: z.ZodType<T>,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const signal = AbortSignal.any([f.ctx.abort.signal, AbortSignal.timeout(TIMEOUT)]);
  let status = 0;
  let text: string;
  try {
    const res = await linearApi.fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: apiKey },
      body: JSON.stringify({ query, variables }),
      signal,
    });
    status = res.status;
    text = await res.text();
  } catch {
    // The request may have reached Linear; the error itself could name the request, so it is not repeated.
    const problem = status ? `Linear's answer did not arrive (HTTP ${status})` : "Linear is not reachable";
    throw new LinearError(problem, true);
  }
  let body: z.infer<typeof graphqlResponse> | undefined;
  try {
    body = graphqlResponse.parse(JSON.parse(text));
  } catch {
    // Not GraphQL: reported by status below.
  }
  // A GraphQL error or a 4xx means Linear did not apply the call; a 5xx or a 2xx we cannot read might have.
  const ok = status >= 200 && status < 300;
  const message = body?.errors?.find((e) => e.message)?.message;
  if (message) throw new LinearError(`Linear: ${scrub(message, apiKey)}`, status >= 500);

  const data = schema.safeParse(body?.data);
  if (ok && data.success) return data.data;

  const problem = ok ? "Linear answered in an unexpected shape" : `Linear answered HTTP ${status}`;
  throw new LinearError(problem, ok || status >= 500);
}

/** The item's source as its folder commit declared it, or as the current folder does. */
function sourceFor(f: FactoryRuntime, id: string, commit?: string) {
  const folder = (commit && folderAt(f, commit)) || currentFolder(f);
  const source = folder?.config.sources.find((x) => x.id === id);
  if (source?.type !== "linear") throw new LinearError(`The factory has no Linear source ${id}`);
  return source;
}

function apiKeyOf(f: FactoryRuntime, source: LinearSource) {
  const key = resolveSecretRef(f.s, source.apiKey);
  if (key) return key;
  const name = source.apiKey.replace(/^secret:/, "");
  throw new LinearError(`The Linear API key ${name} is not set; set it with agentgate factory secret set ${name}`);
}

const issuesSchema = z.object({
  issues: z.object({
    nodes: z.array(
      z.object({
        identifier: z.string().min(1),
        title: z.string(),
        description: z.string().nullish(),
        url: z.string(),
      }),
    ),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
  }),
});
const ISSUES = `query FactoryIssues($team: String!, $label: String!, $after: String) {
  issues(first: 100, after: $after, filter: {
    team: { key: { eqIgnoreCase: $team } }
    labels: { name: { eqIgnoreCase: $label } }
    state: { type: { nin: ${JSON.stringify(CLOSED)} } }
  }) {
    nodes { identifier title description url }
    pageInfo { hasNextPage endCursor }
  }
}`;

async function poll(f: FactoryRuntime, source: FactorySource) {
  // Cleared first, so a failed poll shows its own error instead.
  cappedOf(f).delete(source.id);
  if (source.type !== "linear") throw new LinearError(`The source ${source.id} is not a Linear source`);
  const apiKey = apiKeyOf(f, source);
  const found: IncomingItem[] = [];
  let after: string | undefined;
  let more = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { issues } = await graphql(f, apiKey, issuesSchema, ISSUES, {
      team: source.team,
      label: source.label,
      after,
    });
    for (const issue of issues.nodes)
      found.push({
        externalId: issue.identifier,
        key: issue.identifier.toLowerCase(),
        title: issue.title,
        url: issue.url,
        snapshot: { title: issue.title, description: issue.description ?? "", url: issue.url },
      });
    more = issues.pageInfo.hasNextPage && !!issues.pageInfo.endCursor;
    if (!more) break;
    after = issues.pageInfo.endCursor!;
  }
  if (more) cappedOf(f).add(source.id);
  return found;
}

// `issue(id:)` takes the identifier (ENG-42) as well as the UUID; `commentCreate` is documented with the UUID.
const stateSchema = z.object({ issue: z.object({ state: z.object({ type: z.string() }) }) });
const STATE = `query FactoryIssueState($id: String!) { issue(id: $id) { state { type } } }`;
const idSchema = z.object({ issue: z.object({ id: z.string().min(1) }) });
const ID = `query FactoryIssueId($id: String!) { issue(id: $id) { id } }`;
const createdSchema = z.object({ commentCreate: z.object({ success: z.boolean() }) });
const CREATE = `mutation FactoryComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success }
}`;
const commentsSchema = z.object({
  issue: z.object({ comments: z.object({ nodes: z.array(z.object({ body: z.string(), createdAt: z.string() })) }) }),
});
const COMMENTS = `query FactoryComments($id: String!) { issue(id: $id) { comments(first: 100) { nodes { body createdAt } } } }`;

/** markers.ts's hidden marker becomes a visible last line. A backtick in a value would end the code span early. */
function visibleMarker(body: string) {
  const marker = parseMarkers(body).at(-1);
  if (!marker) return body;
  const at = body.lastIndexOf(MARKER_PREFIX);
  const json = JSON.stringify(marker).replaceAll("`", "\\u0060");
  return `${body.slice(0, at).trimEnd()}\n\n\`${VISIBLE}${json}\``;
}

/** The marker on a comment's last line. Only the last line counts: the factory always ends its comments with it, and
 * an agent's summary sits above it. */
function markerOf(body: string) {
  const last = body.trimEnd().split("\n").at(-1)?.trim() ?? "";
  const match = /^`agentgate-factory:1 (\{.*\})`$/.exec(last);
  if (!match) return undefined;
  try {
    const parsed = markerPayloadSchema.safeParse(JSON.parse(match[1]!));
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Not JSON: a person's text that looks like a marker.
    return undefined;
  }
}

async function post(f: FactoryRuntime, item: FactoryItem, body: string): Promise<PostResult> {
  try {
    const apiKey = apiKeyOf(f, sourceFor(f, item.source, item.configCommit));
    const issueId = (await graphql(f, apiKey, idSchema, ID, { id: item.externalId })).issue.id;
    const { commentCreate } = await graphql(f, apiKey, createdSchema, CREATE, { issueId, body: visibleMarker(body) });
    return commentCreate.success
      ? { status: "posted" }
      : { status: "failed", error: "Linear did not create the comment" };
  } catch (e) {
    if (!(e instanceof LinearError)) throw e;
    return { status: e.maybeApplied ? "uncertain" : "failed", error: e.message };
  }
}

export function setup(f: FactoryRuntime): void {
  // Merged into the controller's row for the source, which comes earlier.
  f.boardParts.push(async () => ({
    sources: (currentFolder(f)?.config.sources ?? []).flatMap((source) =>
      cappedOf(f).has(source.id) ? [{ id: source.id, type: source.type, repo: source.repo, error: CAPPED }] : [],
    ),
  }));
  f.sources.set("linear", {
    type: "linear",
    poll: (source) => poll(f, source),
    async isOpen(item) {
      const apiKey = apiKeyOf(f, sourceFor(f, item.source, item.configCommit));
      const { issue } = await graphql(f, apiKey, stateSchema, STATE, { id: item.externalId });
      return !CLOSED.includes(issue.state.type);
    },
    post: (item, body) => post(f, item, body),
    async newestMarker(item) {
      const apiKey = apiKeyOf(f, sourceFor(f, item.source));
      const { issue } = await graphql(f, apiKey, commentsSchema, COMMENTS, { id: item.externalId });
      const newest = issue.comments.nodes.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
      for (const comment of newest) {
        const marker = markerOf(comment.body);
        if (marker) return marker;
      }
      return undefined;
    },
  });
}
