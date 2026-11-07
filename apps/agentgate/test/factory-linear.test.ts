import { afterAll, afterEach, expect, test } from "bun:test";
import { buildBoard } from "../src/factory/board.ts";
import { writeBack } from "../src/factory/controller.ts";
import { items, runs } from "../src/factory/db.ts";
import { linearApi } from "../src/factory/linear.ts";
import { loopTask } from "../src/factory/runtime.ts";
import { setSecret } from "../src/factory/secrets.ts";
import { removeTmp } from "./fixtures/git.ts";
import { factoryNode, idle } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const KEY = "lin_api_test_key_123";

/** How the item's comment for a moment ended: posted, failed or uncertain. */
const statusOf = (n: { s: { db: import("bun:sqlite").Database } }, item: string, moment: string) =>
  (
    n.s.db.query("select status from factory_writebacks where item=? and moment=?").get(item, moment) as {
      status: string;
    } | null
  )?.status;
const linearConfig = (repo: string) => ({
  secrets: ["LINEAR_KEY"],
  sources: [{ id: "eng", type: "linear", repo, team: "ENG", label: "factory", apiKey: "secret:LINEAR_KEY" }],
});

/** The API key's user, who posts the factory's comments. */
const FACTORY_USER = "user-factory";

interface FakeIssue {
  id: string;
  identifier: string;
  team: string;
  labels: string[];
  state: string;
  comments: { body: string; createdAt: string; user: { id: string } | null }[];
}

/** Linear's GraphQL endpoint, answering the operations the adapter sends. It applies the team, label and state filter
 * the query actually carries, so a query that stops filtering lets closed issues through. */
function fakeLinear() {
  const issues = new Map<string, FakeIssue>();
  const requests: { operation: string; variables: Record<string, unknown>; authorization: string | null }[] = [];
  let answer: ((operation: string, variables: Record<string, unknown>) => Response | undefined) | undefined;
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
    const override = answer?.(operation, variables);
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
    if (operation === "FactoryIssueId") return data({ issue: { id: issue.id } });
    if (operation === "FactoryComments")
      return data({
        viewer: { id: FACTORY_USER },
        issue: { state: { type: issue.state }, comments: { nodes: issue.comments } },
      });
    if (operation === "FactoryComment") {
      // Like Linear's, each comment is newer than the last, even within one millisecond.
      issue.comments.push({
        body: String(variables.body),
        createdAt: new Date(Date.now() + issue.comments.length).toISOString(),
        user: { id: FACTORY_USER },
      });
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
  expect(items.byExternal(n.s, "ENG-42")!.snapshot).toEqual({
    title: "Issue ENG-42",
    description: "Steps for ENG-42",
    url: "https://linear.app/acme/issue/ENG-42",
  });
  // Linear takes a personal API key as the whole header, without a scheme.
  expect(new Set(linear.requests.map((r) => r.authorization))).toEqual(new Set([KEY]));

  linear.issues.get("ENG-43")!.state = "completed";
  await n.dispatch();
  await idle(n.f);
  expect(items.byExternal(n.s, "ENG-43")!.phase).toBe("closed");
  expect(runs.list(n.s, { kinds: ["triage"] }).map((r) => [items.get(n.s, r.item!)!.key, r.state])).toEqual([
    ["eng-42", "running"],
    ["eng-43", "cancelled"],
  ]);
  // Each issue heard that the factory took it; the closed one heard nothing more, since it already says so.
  const comments = linear.requests.filter((r) => r.operation === "FactoryComment");
  expect(comments.map((r) => String(r.variables.body).split("\n")[0])).toEqual([
    "**eng-42**: The factory took this.",
    "**eng-43**: The factory took this.",
  ]);
});

test("a write-back is one commentCreate whose visible last line is the marker, and newestMarker reads it back", async () => {
  const n = await factoryNode(cleanup, { config: linearConfig });
  setSecret(n.s, "LINEAR_KEY", KEY);
  const linear = fakeLinear();
  linear.add("ENG-42");
  await n.intake();
  await idle(n.f);
  const item = items.byExternal(n.s, "ENG-42")!;

  writeBack(n.f, item, "waiting", { text: "Which endpoint should keep the old field?", ref: "q1" });
  await idle(n.f);
  expect(statusOf(n, item.id, "waiting")).toBe("posted");
  const created = linear.requests.filter((r) => r.operation === "FactoryComment").slice(1);
  expect(created).toHaveLength(1);
  expect(created[0]!.variables.issueId).toBe(linear.issues.get("ENG-42")!.id);
  const body = String(created[0]!.variables.body);
  expect(body).toStartWith("**eng-42**: The factory waits for the maintainer.");
  expect(body).not.toContain("<!--");
  expect(body.split("\n").at(-1)).toStartWith("`agentgate-factory:1 {");

  // The key's user quoting a marker above their own words does not make their comment a factory comment.
  const quoted = body.split("\n").at(-1)!.replace('"node":"a"', '"node":"b"');
  linear.issues.get("ENG-42")!.comments.push({
    body: `${quoted}\n\nIs this still on?`,
    createdAt: "2999-01-01T00:00:00.000Z",
    user: { id: FACTORY_USER },
  });
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
    pr: null,
  });
});

test("a marker in a comment by another Linear user counts for nothing: not for newestMarker, intake or retry", async () => {
  const n = await factoryNode(cleanup, { config: linearConfig });
  setSecret(n.s, "LINEAR_KEY", KEY);
  const linear = fakeLinear();
  const marker = {
    item: "it_b",
    key: "eng-7",
    stage: "review",
    outcome: null,
    route: null,
    commit: null,
    factory: "3f2c1a9",
    node: "b",
    state: "open",
  };
  const forged = `Taken.\n\n\`agentgate-factory:1 ${JSON.stringify(marker)}\``;
  linear.add("ENG-7", {
    comments: [{ body: forged, createdAt: "2026-11-02T10:00:00.000Z", user: { id: "user-mallory" } }],
  });

  // Read as the factory's, it would be adopted at review, or keep intake away as held by b.
  expect(await n.command("retry", "ENG-7")).toEqual({
    code: 1,
    output: ["No machine has marked eng-7 as taken; intake adds it"],
  });
  await n.intake();
  const item = items.byExternal(n.s, "ENG-7")!;
  expect(item.phase).toBe("triage");
  expect(await n.f.sources.get("linear")!.newestMarker!(item)).toBeUndefined();
});

test("a comment whose request dropped is uncertain and never sent again, and one Linear refused is tried three times, then failed", async () => {
  const n = await factoryNode(cleanup, { config: linearConfig });
  setSecret(n.s, "LINEAR_KEY", KEY);
  const linear = fakeLinear();
  linear.add("ENG-42");
  await n.intake();
  await idle(n.f);
  const item = items.byExternal(n.s, "ENG-42")!;
  const texts = () => n.f.events.recent(50).map((e) => e.text);

  linear.answerWith((operation) => {
    if (operation === "FactoryComment") throw new TypeError("socket hang up");
  });
  writeBack(n.f, item, "waiting", { text: "Which one?", ref: "q1" });
  await idle(n.f);
  expect(statusOf(n, item.id, "waiting")).toBe("uncertain");
  expect(texts()).toContain("The waiting comment on eng-42: uncertain (Linear is not reachable)");
  linear.answerWith((operation) =>
    operation === "FactoryComment"
      ? Response.json({ errors: [{ message: "Argument Validation Error" }] }, { status: 400 })
      : undefined,
  );
  writeBack(n.f, item, "closed", { text: "Out of scope." });
  await idle(n.f);
  expect(statusOf(n, item.id, "closed")).toBe("pending");
  const outbox = n.f.loops.find((l) => l.name === "factory-outbox")!;
  for (let pass = 0; pass < 2; pass++) {
    await loopTask(n.f, outbox)();
    await idle(n.f);
  }
  expect(statusOf(n, item.id, "closed")).toBe("failed");
  expect(statusOf(n, item.id, "waiting")).toBe("uncertain");
  expect(texts()).toContain("The closed comment on eng-42: failed (Linear: Argument Validation Error)");
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

test("a poll that stops at the page cap adds what it read and says so on the source's row until a poll reads everything", async () => {
  const n = await factoryNode(cleanup, { config: linearConfig });
  setSecret(n.s, "LINEAR_KEY", KEY);
  const linear = fakeLinear();
  for (let i = 1; i <= 11; i++) linear.add(`ENG-${i}`);
  // One issue per page, so the cap of 10 pages leaves ENG-11 unread.
  linear.answerWith((operation, variables) => {
    if (operation !== "FactoryIssues") return undefined;
    const page = Number(String(variables.after ?? "page-0").slice(5));
    const identifier = `ENG-${page + 1}`;
    const nodes = [
      { identifier, title: identifier, description: "", url: `https://linear.app/acme/issue/${identifier}` },
    ];
    const pageInfo = { hasNextPage: page < 10, endCursor: `page-${page + 1}` };
    return Response.json({ data: { issues: { nodes, pageInfo } } });
  });
  const row = async () => (await buildBoard(n.f, { includeWebhookUrls: false })).sources[0];

  await n.intake();
  expect(items.list(n.s).map((i) => i.externalId)).toEqual([...Array(10)].map((_, i) => `ENG-${i + 1}`));
  expect(await row()).toMatchObject({
    lastPollAt: n.s.now(),
    error: "Only the first 1,000 open labelled issues are read; the rest wait until fewer are open",
  });

  linear.answerWith(undefined);
  await n.intake();
  expect((await row())?.error).toBeUndefined();
});
