import { afterAll, afterEach, expect, test } from "bun:test";
import { buildBoard } from "../src/factory/board.ts";
import { writeBack } from "../src/factory/controller.ts";
import { items, runs } from "../src/factory/db.ts";
import { linearApi } from "../src/factory/linear.ts";
import { setSecret } from "../src/factory/secrets.ts";
import { removeTmp } from "./fixtures/git.ts";
import { factoryNode } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const KEY = "lin_api_test_key_123";
const linearConfig = (repo: string) => ({
  secrets: ["LINEAR_KEY"],
  sources: [{ id: "eng", type: "linear", repo, team: "ENG", label: "factory", apiKey: "secret:LINEAR_KEY" }],
});

interface FakeIssue {
  id: string;
  identifier: string;
  team: string;
  labels: string[];
  state: string;
  comments: { body: string; createdAt: string }[];
}

/** Linear's GraphQL endpoint, answering the operations the adapter sends. It applies the team, label and state filter
 * the query actually carries, so a query that stops filtering lets closed issues through. */
function fakeLinear() {
  const issues = new Map<string, FakeIssue>();
  const requests: { operation: string; variables: Record<string, unknown>; authorization: string | null }[] = [];
  let answer: ((operation: string) => Response | undefined) | undefined;
  const add = (identifier: string, patch: Partial<FakeIssue> = {}) =>
    issues.set(identifier, {
      id: crypto.randomUUID(),
      identifier,
      team: identifier.split("-")[0]!,
      labels: ["Factory"],
      state: "unstarted",
      comments: [],
      ...patch,
    });
  const find = (id: unknown) => [...issues.values()].find((i) => i.identifier === id || i.id === id);
  const real = linearApi.fetch;
  cleanup.push(() => (linearApi.fetch = real));
  linearApi.fetch = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    const operation = /^(?:query|mutation) (\w+)/.exec(query)![1]!;
    requests.push({ operation, variables, authorization: new Headers(init.headers).get("authorization") });
    const override = answer?.(operation);
    if (override) return override;
    const data = (value: unknown) => Response.json({ data: value });
    if (operation === "FactoryIssues") {
      const excluded = JSON.parse(/state: \{ type: \{ nin: (\[[^\]]*\]) \} \}/.exec(query)?.[1] ?? "[]") as string[];
      const nodes = [...issues.values()]
        .filter((i) => i.team.toLowerCase() === String(variables.team).toLowerCase())
        .filter((i) => i.labels.some((l) => l.toLowerCase() === String(variables.label).toLowerCase()))
        .filter((i) => !excluded.includes(i.state))
        .map((i) => ({
          identifier: i.identifier,
          title: `Issue ${i.identifier}`,
          description: `Steps for ${i.identifier}`,
          url: `https://linear.app/acme/issue/${i.identifier}`,
        }));
      return data({ issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } });
    }
    const issue = find(variables.id ?? variables.issueId);
    if (!issue) return Response.json({ errors: [{ message: "Entity not found: Issue" }] });
    if (operation === "FactoryIssueState") return data({ issue: { state: { type: issue.state } } });
    if (operation === "FactoryIssueId") return data({ issue: { id: issue.id } });
    if (operation === "FactoryComments") return data({ issue: { comments: { nodes: issue.comments } } });
    if (operation === "FactoryComment") {
      issue.comments.push({ body: String(variables.body), createdAt: new Date().toISOString() });
      return data({ commentCreate: { success: true } });
    }
    throw new Error(`unexpected operation ${operation}`);
  }) as typeof fetch;
  return { issues, requests, add, answerWith: (fn: typeof answer) => (answer = fn) };
}

test("open, labelled issues in the team become items once, and an issue closed in Linear closes its item before its stage", async () => {
  const n = await factoryNode(cleanup, { config: linearConfig });
  setSecret(n.s, "LINEAR_KEY", KEY);
  const linear = fakeLinear();
  linear.add("ENG-42");
  linear.add("ENG-43");
  linear.add("ENG-44", { state: "completed" });
  linear.add("ENG-45", { state: "canceled" });
  linear.add("ENG-46", { labels: ["bug"] });
  linear.add("OPS-1");

  await n.intake();
  await n.intake();
  expect(items.list(n.s).map((i) => [i.source, i.externalId, i.key, i.title])).toEqual([
    ["eng", "ENG-42", "eng-42", "Issue ENG-42"],
    ["eng", "ENG-43", "eng-43", "Issue ENG-43"],
  ]);
  expect(items.byExternal(n.s, "eng", "ENG-42")!.snapshot).toEqual({
    title: "Issue ENG-42",
    description: "Steps for ENG-42",
    url: "https://linear.app/acme/issue/ENG-42",
  });
  // Linear takes a personal API key as the whole header, without a scheme.
  expect(new Set(linear.requests.map((r) => r.authorization))).toEqual(new Set([KEY]));

  linear.issues.get("ENG-43")!.state = "completed";
  await n.dispatch();
  expect(items.byExternal(n.s, "eng", "ENG-43")!.phase).toBe("closed");
  expect(runs.list(n.s, { kinds: ["triage"] }).map((r) => [items.get(n.s, r.item!)!.key, r.state])).toEqual([
    ["eng-42", "running"],
    ["eng-43", "cancelled"],
  ]);
  // The issue already says it is closed.
  expect(linear.requests.filter((r) => r.operation === "FactoryComment")).toEqual([]);
});

test("a write-back is one commentCreate whose visible last line is the marker, and newestMarker reads it back", async () => {
  const n = await factoryNode(cleanup, { config: linearConfig });
  setSecret(n.s, "LINEAR_KEY", KEY);
  const linear = fakeLinear();
  linear.add("ENG-42");
  await n.intake();
  const item = items.byExternal(n.s, "eng", "ENG-42")!;

  expect(await writeBack(n.f, item, "waiting", { text: "Which endpoint should keep the old field?" })).toEqual({
    status: "posted",
  });
  const created = linear.requests.filter((r) => r.operation === "FactoryComment");
  expect(created).toHaveLength(1);
  expect(created[0]!.variables.issueId).toBe(linear.issues.get("ENG-42")!.id);
  const body = String(created[0]!.variables.body);
  expect(body).toStartWith("**eng-42**: The factory waits for the maintainer.");
  expect(body).not.toContain("<!--");
  expect(body.split("\n").at(-1)).toStartWith("`agentgate-factory:1 {");

  // A person quoting a marker above their own words does not make their comment the factory's.
  const quoted = body.split("\n").at(-1)!.replace('"node":"a"', '"node":"b"');
  linear.issues
    .get("ENG-42")!
    .comments.push({ body: `${quoted}\n\nIs this still on?`, createdAt: "2999-01-01T00:00:00.000Z" });
  const marker = await n.f.sources.get("linear")!.newestMarker!(item);
  expect(marker).toEqual({
    item: item.id,
    key: "eng-42",
    stage: "triage",
    outcome: null,
    route: null,
    commit: null,
    factory: item.configCommit.slice(0, 7),
    node: "a",
    state: "open",
  });
});

test("a comment whose request dropped is uncertain, and one Linear refused is failed", async () => {
  const n = await factoryNode(cleanup, { config: linearConfig });
  setSecret(n.s, "LINEAR_KEY", KEY);
  const linear = fakeLinear();
  linear.add("ENG-42");
  await n.intake();
  const item = items.byExternal(n.s, "eng", "ENG-42")!;

  linear.answerWith((operation) => {
    if (operation === "FactoryComment") throw new TypeError("socket hang up");
  });
  expect(await writeBack(n.f, item, "waiting", { text: "Which one?" })).toEqual({
    status: "uncertain",
    error: "Linear is not reachable",
  });
  linear.answerWith((operation) =>
    operation === "FactoryComment"
      ? Response.json({ errors: [{ message: "Argument Validation Error" }] }, { status: 400 })
      : undefined,
  );
  expect(await writeBack(n.f, item, "closed", { text: "Out of scope." })).toEqual({
    status: "failed",
    error: "Linear: Argument Validation Error",
  });
});

test("a missing API key shows on the source's row without a request, and Linear's errors never carry the key", async () => {
  const n = await factoryNode(cleanup, { config: linearConfig });
  const linear = fakeLinear();
  linear.add("ENG-42");
  const row = async () => (await buildBoard(n.f, { includeWebhookUrls: false })).sources[0];

  await n.intake();
  expect(await row()).toEqual({
    id: "eng",
    type: "linear",
    repo: n.repo,
    error: "The Linear API key LINEAR_KEY is not set; set it with agentgate factory secret set LINEAR_KEY",
  });
  expect(linear.requests).toEqual([]);
  expect(items.list(n.s)).toEqual([]);

  setSecret(n.s, "LINEAR_KEY", KEY);
  linear.answerWith(() => Response.json({ errors: [{ message: `Invalid key ${KEY}` }] }, { status: 401 }));
  n.advance(60 * 60_000);
  await n.intake();
  expect((await row())?.error).toBe("Linear: Invalid key [redacted]");
});
