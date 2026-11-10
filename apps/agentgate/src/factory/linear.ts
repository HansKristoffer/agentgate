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
const cappedOf = (f: FactoryRuntime) => f.memory("capped linear sources", () => new Set<string>());

type LinearSource = Extract<FactorySource, { type: "linear" }>;

class LinearError extends Error {
  override name = "LinearError";
  /**
   * What became of the call. `refused`: Linear answered no, so it applied nothing. `unreachable`: the request
   * certainly never reached Linear. `unknown`: no answer said either way, so a mutation may have been applied.
   */
  constructor(
    message: string,
    readonly outcome: "refused" | "unreachable" | "unknown" = "refused",
  ) {
    super(message);
  }
}

/** `fetch`'s error codes for a connection that never opened: nothing was sent. A timeout or a reset is not among
 * them, because the request may have arrived first. */
const NO_CONNECTION = ["ECONNREFUSED", "ENOTFOUND"];

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
  } catch (e) {
    // The error itself could name the request, so only its code is read.
    const code = e instanceof Error && "code" in e ? e.code : undefined;
    if (!status && typeof code === "string" && NO_CONNECTION.includes(code))
      throw new LinearError("Linear is not reachable", "unreachable");
    // The request may have reached Linear.
    throw new LinearError(
      status ? `Linear's answer did not arrive (HTTP ${status})` : "Linear did not answer",
      "unknown",
    );
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
  if (message) throw new LinearError(`Linear: ${scrub(message, apiKey)}`, status >= 500 ? "unknown" : "refused");

  const data = schema.safeParse(body?.data);
  if (ok && data.success) return data.data;

  const problem = ok ? "Linear answered in an unexpected shape" : `Linear answered HTTP ${status}`;
  throw new LinearError(problem, ok || status >= 500 ? "unknown" : "refused");
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
  throw new LinearError(
    `The Linear API key ${name} is not set; set it with agentgate factory secret set ${name}`,
    "unreachable",
  );
}

const issuesSchema = z.object({
  issues: z.object({
    nodes: z.array(
      z.object({
        identifier: z.string().min(1),
        title: z.string(),
        description: z.string().nullish(),
        url: z.string(),
        updatedAt: z.string().optional(),
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
    nodes { identifier title description url updatedAt }
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
        ...(issue.updatedAt && { updatedAt: issue.updatedAt }),
      });
    more = issues.pageInfo.hasNextPage && !!issues.pageInfo.endCursor;
    if (!more) break;
    after = issues.pageInfo.endCursor!;
  }
  if (more) cappedOf(f).add(source.id);
  return found;
}

// `issue(id:)` takes the identifier (ENG-42) as well as the UUID; `commentCreate` is documented with the UUID.
const idSchema = z.object({ issue: z.object({ id: z.string().min(1) }) });
const ID = `query FactoryIssueId($id: String!) { issue(id: $id) { id } }`;
const createdSchema = z.object({ commentCreate: z.object({ success: z.boolean() }) });
const CREATE = `mutation FactoryComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success }
}`;
// The viewer is the API key's user, who posts the factory's comments; a comment from an integration has no user.
const commentsSchema = z.object({
  viewer: z.object({ id: z.string().min(1) }),
  issue: z.object({
    state: z.object({ type: z.string() }),
    comments: z.object({
      nodes: z.array(
        z.object({ body: z.string(), createdAt: z.string(), user: z.object({ id: z.string() }).nullish() }),
      ),
    }),
  }),
});
const COMMENTS = `query FactoryComments($id: String!) {
  viewer { id }
  issue(id: $id) { state { type } comments(last: 100) { nodes { body createdAt user { id } } } }
}`;

/** The newest marker in the API key user's own comments: anyone who can comment could otherwise forge one. */
function newestOf({ viewer, issue }: z.infer<typeof commentsSchema>) {
  const newest = issue.comments.nodes
    .filter((c) => c.user?.id === viewer.id)
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const comment of newest) {
    const marker = markerOf(comment.body);
    if (marker) return marker;
  }
  return undefined;
}

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
  // Until the mutation is sent, nothing can have been written.
  let mutating = false;
  try {
    const apiKey = apiKeyOf(f, sourceFor(f, item.source, item.configCommit));
    const issueId = (await graphql(f, apiKey, idSchema, ID, { id: item.externalId })).issue.id;
    mutating = true;
    const { commentCreate } = await graphql(f, apiKey, createdSchema, CREATE, { issueId, body: visibleMarker(body) });
    return commentCreate.success
      ? { status: "posted" }
      : { status: "failed", error: "Linear did not create the comment" };
  } catch (e) {
    if (!(e instanceof LinearError)) throw e;
    if (e.outcome === "refused") return { status: "failed", error: e.message };
    // Anything else is safe to send again, unless the mutation may have arrived.
    return { status: e.outcome === "unknown" && mutating ? "uncertain" : "unreachable", error: e.message };
  }
}

export function setup(f: FactoryRuntime): void {
  // Merged into intake's row for the source, which comes earlier.
  f.boardParts.push(async () => ({
    sources: (currentFolder(f)?.config.sources ?? []).flatMap((source) =>
      cappedOf(f).has(source.id) ? [{ id: source.id, type: source.type, repo: source.repo, error: CAPPED }] : [],
    ),
  }));
  f.sources.set("linear", {
    type: "linear",
    poll: (source) => poll(f, source),
    async check(item) {
      const apiKey = apiKeyOf(f, sourceFor(f, item.source, item.configCommit));
      const answer = await graphql(f, apiKey, commentsSchema, COMMENTS, { id: item.externalId });
      return { open: !CLOSED.includes(answer.issue.state.type), marker: newestOf(answer) };
    },
    post: (item, body) => post(f, item, body),
  });
}
