import { expect, test } from "bun:test";
import {
  factoryConfigSchema,
  factoryJsonSchema,
  factoryReportSchema,
  scorerFileSchema,
  stageFileSchema,
} from "@agentgate/protocol";
import schemaFile from "../../../packages/protocol/factory.schema.json";

const example = `
version: 1
name: acme
description: Works Acme's bugs
repositories:
  acme/api: { reviewers: [alice], watchPullRequests: true }
  acme/web: {}
secrets: [LINEAR_KEY, GH_HOOK, SENTRY_HOOK]
limits:
  threads: 5
  waitForQuota: false
  waitingForYou: 10
  itemTokens: 2000000
  reviewRounds: 2
  nudges: 1
  stalledAfter: 30m
sources:
  - { id: bugs, type: github, repo: acme/api, label: factory, webhook: { secret: "secret:GH_HOOK" } }
  - { id: eng, type: linear, repo: acme/web, team: ENG, label: factory, apiKey: "secret:LINEAR_KEY", intake: hold }
  - id: sentry
    type: webhook
    repo: acme/api
    signature: { header: sentry-hook-signature, encoding: hex, secret: "secret:SENTRY_HOOK" }
    title: "{{body.data.issue.title}}"
    dedupe: "{{body.data.issue.id}}"
learning: { every: 14d }
scoring: { sample: 50 }
`;

test("a factory.yaml using every key parses, and what it leaves out gets the documented defaults", () => {
  const config = factoryConfigSchema.parse(Bun.YAML.parse(example));
  expect(config.repositories).toEqual({
    "acme/api": { reviewers: ["alice"], watchPullRequests: true },
    "acme/web": { reviewers: [], watchPullRequests: false },
  });
  expect(config.limits.stalledAfter).toBe("30m");
  expect(config.learning.every).toBe("14d");
  expect(config.sources.map((source) => source.intake)).toEqual(["auto", "hold", "hold"]);
  expect(config.sources[2]).toMatchObject({
    body: "{{body}}",
    dedupeWindow: "1h",
    signature: { prefix: "" },
  });

  const minimal = factoryConfigSchema.parse({ version: 1, name: "acme", repositories: { "acme/api": {} } });
  expect(minimal).toEqual({
    version: 1,
    name: "acme",
    repositories: { "acme/api": { reviewers: [], watchPullRequests: false } },
    secrets: [],
    limits: {
      threads: 3,
      waitForQuota: true,
      waitingForYou: 5,
      itemTokens: 30_000_000,
      reviewRounds: 3,
      nudges: 3,
      stalledAfter: "15m",
    },
    sources: [],
    learning: { every: "7d" },
    scoring: { sample: 25 },
  });
});

test("an unknown key is refused at every level of the folder's files and the report", () => {
  const config = Bun.YAML.parse(example) as { sources: Record<string, object>[] };
  const [github, , webhook] = config.sources as [Record<string, object>, unknown, Record<string, object>];
  const scorer = {
    description: "d",
    stages: ["review"],
    labels: [
      { value: "a", description: "", score: 0 },
      { value: "b", description: "", score: 1 },
    ],
    pass: 1,
  };
  const cases: [string, { safeParse(v: unknown): { success: boolean } }, unknown][] = [
    ["factory.yaml", factoryConfigSchema, { ...config, extra: 1 }],
    ["a repository", factoryConfigSchema, { ...config, repositories: { "acme/api": { reviewer: ["a"] } } }],
    ["limits", factoryConfigSchema, { ...config, limits: { thread: 2 } }],
    ["a source", factoryConfigSchema, { ...config, sources: [{ ...github, labels: ["x"] }] }],
    [
      "a webhook signature",
      factoryConfigSchema,
      { ...config, sources: [{ ...webhook, signature: { ...webhook.signature, algo: "sha1" } }] },
    ],
    ["learning", factoryConfigSchema, { ...config, learning: { evry: "1d" } }],
    ["scoring", factoryConfigSchema, { ...config, scoring: { sampel: 1 } }],
    ["a stage file", stageFileSchema, { start: "auto", modle: "x" }],
    ["a stage model", stageFileSchema, { model: { provider: "codex", model: "gpt-5", effort: "high" } }],
    ["a scorer file", scorerFileSchema, { ...scorer, weight: 2 }],
    [
      "a scorer label",
      scorerFileSchema,
      { ...scorer, labels: [{ ...scorer.labels[0], color: "red" }, scorer.labels[1]] },
    ],
    ["a report", factoryReportSchema, { run: "run_1", outcome: "done", summary: "ok", extra: true }],
    [
      "a stage result",
      factoryReportSchema,
      { run: "run_1", outcome: "done", summary: "ok", result: { kind: "learn", lessons: [], extra: 1 } },
    ],
  ];
  // Without the unknown key each value parses, so a refusal is about that key.
  expect(
    stageFileSchema.safeParse({ start: "auto", model: { provider: "codex", model: "gpt-5" }, mcp: ["docs"] }).success,
  ).toBe(true);
  expect(scorerFileSchema.safeParse(scorer).success).toBe(true);
  for (const [where, schema, value] of cases) expect([where, schema.safeParse(value).success]).toEqual([where, false]);
});

test("a review result may carry its risk, and a door outside the two is refused there", () => {
  const review = {
    kind: "review",
    prUrl: "https://github.com/acme/api/pull/7",
    commit: "abc1234",
    findings: [],
    testsFailWithoutFix: true,
  };
  const risk = { door: "one-way", reach: "data", unrelated: [], focus: ["the migration"] };
  const report = (result: unknown) =>
    factoryReportSchema.safeParse({ run: "r", outcome: "done", summary: "ok", result });
  expect(report(review).success).toBe(true);
  expect(report({ ...review, risk }).success).toBe(true);
  const refused = report({ ...review, risk: { ...risk, door: "revolving" } });
  expect(refused.success).toBe(false);
  expect(refused.error!.issues[0]!.path).toEqual(["result", "risk", "door"]);
});

test("the committed factory.schema.json matches the schema it is generated from", () => {
  expect(schemaFile).toEqual(JSON.parse(JSON.stringify(factoryJsonSchema())));
});
