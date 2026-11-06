import { z } from "zod";

/**
 * The software factory: the folder format that defines one (`factory.yaml`, `stages/`, `scorers/`), the records and
 * reports the daemon keeps about its items and runs, and the board the CLI, app and page show.
 */

/**
 * The `_meta` key the MCP shim sets from its session's T3CODE_THREAD_ID on every call it forwards, naming the T3 Code
 * thread that made it. Any local process can set it, so it routes reports but proves nothing.
 */
export const T3_THREAD_META_KEY = "dev.agentgate/t3Thread";

const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/); // source and scorer ids
/** owner/repo; the daemon canonicalizes the case like canonicalProject. */
export const factoryRepoSchema = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/);
const repo = factoryRepoSchema;
export const secretNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const secretRef = z.string().regex(/^secret:[A-Z][A-Z0-9_]{0,63}$/);
const template = z.string().min(1).max(2000); // {{body.a.b}} {{headers.x}} {{query.x}} {{body}}
const duration = z.string().regex(/^\d+(m|h|d)$/);

export const stageNames = ["triage", "spec", "implement", "review"] as const;
export type StageName = (typeof stageNames)[number];

/** Passed to T3's t3_thread_launch as modelSelection. */
export const modelSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    options: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
  })
  .strict();
export type FactoryModel = z.infer<typeof modelSchema>;

const intake = z.enum(["auto", "hold"]); // hold: new items wait for `agentgate factory approve`
/** MCP server aliases a factory thread may use besides agentgate's own tools. */
const mcpAliases = z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)).max(20);
export const githubSourceSchema = z
  .object({
    id: name,
    type: z.literal("github"),
    repo,
    label: z.string().min(1).max(50),
    intake: intake.default("auto"),
    webhook: z.object({ secret: secretRef }).strict().optional(), // a valid delivery triggers a poll
  })
  .strict();
export const linearSourceSchema = z
  .object({
    id: name,
    type: z.literal("linear"),
    repo,
    team: z.string().min(1).max(20),
    label: z.string().min(1).max(80),
    apiKey: secretRef,
    intake: intake.default("auto"),
    webhook: z.object({ secret: secretRef }).strict().optional(),
  })
  .strict();
export const webhookSourceSchema = z
  .object({
    id: name,
    type: z.literal("webhook"),
    repo,
    intake: intake.default("hold"), // anyone with the URL can add items, so a person approves them first
    signature: z
      .object({
        header: z.string().min(1).max(100),
        encoding: z.enum(["hex", "base64"]),
        prefix: z.string().max(20).default(""),
        secret: secretRef,
      })
      .strict()
      .optional(), // without it, the unguessable URL is the only check
    title: template,
    body: template.default("{{body}}"),
    dedupe: template.optional(),
    dedupeWindow: duration.default("1h"),
  })
  .strict();
export const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof weekdays)[number];
/** `every` counts from the last run; `at` is a time of day on some weekdays in a timezone. */
export const scoutScheduleSchema = z.union([
  z.object({ every: duration }).strict(), // the loader refuses less than 1h
  z
    .object({
      at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      days: z
        .array(z.enum(weekdays))
        .min(1)
        .max(7)
        .default([...weekdays]),
      timezone: z.string().min(1).max(64).default("UTC"), // the loader checks it with Intl
    })
    .strict(),
]);
export type ScoutSchedule = z.infer<typeof scoutScheduleSchema>;
/** A scout: on its schedule, a T3 thread follows `scouts/<id>.md` and reports findings, each of which becomes an item. */
export const scoutSourceSchema = z
  .object({
    id: name,
    type: z.literal("scout"),
    repo,
    schedule: scoutScheduleSchema,
    intake: intake.default("auto"),
    dedupeWindow: duration.default("14d"), // a finding whose key an item of this scout had within it is skipped
    model: modelSchema.optional(),
    mcp: mcpAliases.optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export const factorySourceSchema = z.discriminatedUnion("type", [
  githubSourceSchema,
  linearSourceSchema,
  webhookSourceSchema,
  scoutSourceSchema,
]);
export type FactorySource = z.infer<typeof factorySourceSchema>;

/** `factory.yaml`. A public contract: `factory.schema.json` is generated from it for editors. */
export const factoryConfigSchema = z
  .object({
    version: z.literal(1),
    name,
    description: z.string().max(500).optional(),
    repositories: z.record(
      repo,
      z
        .object({
          reviewers: z.array(z.string().min(1).max(100)).max(10).default([]),
          /** Let T3 Code's PR watch wake the implement thread on any comment. Off: only the factory wakes it, with
           * collaborators' comments only. */
          watchPullRequests: z.boolean().default(false),
        })
        .strict(),
    ),
    secrets: z.array(secretNameSchema).max(100).default([]),
    limits: z
      .object({
        threads: z.number().int().min(1).max(20).default(3),
        waitForQuota: z.boolean().default(true),
        waitingForYou: z.number().int().min(1).max(100).default(5),
        itemTokens: z.number().int().positive().default(30_000_000),
        reviewRounds: z.number().int().min(0).max(5).default(3),
        nudges: z.number().int().min(0).max(10).default(3),
        stalledAfter: duration.default("15m"),
      })
      .strict()
      .prefault({}),
    sources: z.array(factorySourceSchema).max(50).default([]),
    learning: z
      .object({ every: duration.default("7d") })
      .strict()
      .prefault({}),
    scoring: z
      .object({ sample: z.number().min(0).max(100).default(25) })
      .strict()
      .prefault({}),
  })
  .strict();
export type FactoryConfig = z.infer<typeof factoryConfigSchema>;

/** Frontmatter of stages/<stage>.md; the body replaces the built-in brief. */
export const stageFileSchema = z
  .object({
    start: z.enum(["auto", "manual"]).default("auto"),
    skill: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
      .optional(), // adds "Use the <skill> skill."
    model: modelSchema.optional(),
    /** The MCP servers (aliases) this stage's threads may use besides agentgate's own tools; none when absent. */
    mcp: mcpAliases.optional(),
  })
  .strict();
export type StageFile = z.infer<typeof stageFileSchema>;

/** Frontmatter of scorers/<name>.md; the body is the judge's rubric. */
export const scorerFileSchema = z
  .object({
    description: z.string().min(1).max(300),
    stages: z.array(z.enum(stageNames)).min(1),
    labels: z
      .array(
        z
          .object({
            value: z.string().regex(/^[a-z0-9_-]{1,40}$/),
            description: z.string().max(300),
            score: z.number().min(0).max(1),
          })
          .strict(),
      )
      .min(2)
      .max(10),
    pass: z.number().min(0).max(1),
    sample: z.number().min(0).max(100).optional(), // overrides scoring.sample
    model: modelSchema.optional(),
  })
  .strict();
export type ScorerFile = z.infer<typeof scorerFileSchema>;

/**
 * `settings.factory`: where the factory's folder lives and which machine runs it. Not strict, like the settings record
 * it sits in, so an older node keeps reading it after a newer one adds a field.
 */
export const factoryPointerSchema = z.object({
  repo,
  path: z.string().max(200).default(""), // folder inside the repo; "" is the root
  ref: z.string().min(1).max(200).optional(), // default: the repo's default branch
  node: z.string().min(1).max(512), // the machine that runs the factory
  // Set by `factory init`: the PR that adds the folder. Once it merges, the factory follows the default branch.
  init: z.object({ pr: z.number().int().positive() }).optional(),
});
export type FactoryPointer = z.infer<typeof factoryPointerSchema>;

/** The branch `factory init` pushes the template to. */
export const FACTORY_INIT_BRANCH = "agentgate/factory-init";

/** The synced `secret` record. `~hook:` ids are agentgate's own (webhook URL keys), never declared in a folder. */
export const secretRecordSchema = z.object({
  id: z.union([secretNameSchema, z.string().regex(/^~hook:[a-z0-9][a-z0-9-]{0,39}$/)]),
  value: z.string().min(1).max(16384),
  from: z.string().min(1).max(512), // node that set it
});
export type SecretRecord = z.infer<typeof secretRecordSchema>;

/** An item that waits for the maintainer keeps its phase and has `needsYou`; only `shipped` and `closed` end it. */
export const itemPhases = [
  "held",
  "triage",
  "spec",
  "implement",
  "pr",
  "review",
  "ready",
  "shipped",
  "closed",
] as const;
export type ItemPhase = (typeof itemPhases)[number];
export const runKinds = ["triage", "spec", "implement", "review", "judge", "learn", "scout"] as const;
export type RunKind = (typeof runKinds)[number];
/** waiting: the thread asked a person a question. silent: the thread ended without a report. */
export const runStates = [
  "queued",
  "starting",
  "running",
  "waiting",
  "reported",
  "silent",
  "failed",
  "cancelled",
] as const;
export type RunState = (typeof runStates)[number];

export const needsYouSchema = z
  .object({
    reason: z.enum(["decision", "blocked", "approval", "budget", "stalled", "held", "failed", "orphaned", "stuck"]),
    question: z.string().optional(),
    recommendation: z.string().optional(),
    link: z.string().optional(),
  })
  .strict();
export type NeedsYou = z.infer<typeof needsYouSchema>;

export const outcomes = [
  "done",
  "not-a-bug",
  "duplicate",
  "already-fixed",
  "blocked",
  "needs-decision",
  "nothing-to-do",
] as const;
export type Outcome = (typeof outcomes)[number];

const commitSha = z.string().regex(/^[0-9a-f]{7,64}$/);
export const stageResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("triage"),
      route: z.enum(["implement", "spec"]),
      reproduction: z.union([
        z.object({ command: z.string().min(1).max(2000), failsBefore: z.literal(true) }).strict(),
        z.object({ notPossible: z.string().min(1).max(2000) }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("spec"),
      spec: z.string().max(64 * 1024),
      review: z.string().max(64 * 1024),
      approved: z.boolean(),
      feedback: z
        .string()
        .max(64 * 1024)
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("implement"),
      prUrl: z.string().url().max(2048),
      commit: commitSha,
      claims: z
        .array(z.object({ claim: z.string().min(1).max(2000), evidence: z.string().min(1).max(4000) }).strict())
        .max(50),
      notChecked: z.array(z.string().max(2000)).max(50),
    })
    .strict(),
  z
    .object({
      kind: z.literal("review"),
      prUrl: z.string().url().max(2048),
      commit: commitSha,
      findings: z
        .array(
          z
            .object({
              file: z.string().min(1).max(1024),
              line: z.number().int().positive().optional(),
              severity: z.enum(["important", "nit", "pre-existing"]),
              text: z.string().min(1).max(4000),
            })
            .strict(),
        )
        .max(100),
      testsFailWithoutFix: z.union([z.boolean(), z.literal("no-new-tests")]),
      risk: z
        .object({
          // two-way: reverting the PR undoes it. one-way: it cannot be walked back (stored data changed or deleted, a
          // contract other systems use changed, something sent).
          door: z.enum(["one-way", "two-way"]),
          // The widest thing a mistake here can break.
          reach: z.enum(["local", "module", "app", "data"]),
          // Changes in the diff the item did not ask for, each "file: what".
          unrelated: z.array(z.string().min(1).max(500)).max(20),
          // Where a person should look first, and why.
          focus: z.array(z.string().min(1).max(500)).max(10),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("judge"),
      scorer: name,
      label: z.string().regex(/^[a-z0-9_-]{1,40}$/),
      reasoning: z.string().max(4000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("learn"),
      prUrl: z.string().url().max(2048).optional(),
      lessons: z.array(z.string().min(1).max(2000)).max(50),
    })
    .strict(),
  z
    .object({
      kind: z.literal("scout"),
      findings: z
        .array(
          z
            .object({
              key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), // the same problem keeps the same key across runs
              title: z.string().trim().min(1).max(300),
              body: z.string().min(1).max(32_000),
            })
            .strict(),
        )
        .max(50), // a bound on the report's size, not a setting
    })
    .strict(),
]);
export type StageResult = z.infer<typeof stageResultSchema>;

/** What a stage thread sends through `factory_report`. The shape only: which fields an outcome requires is the controller's check. */
export const factoryReportSchema = z
  .object({
    run: z.string().min(1).max(100),
    outcome: z.enum(outcomes),
    summary: z.string().max(2000), // the factory puts it into comments after defusing mentions
    blocked: z
      .object({ missing: z.string().min(1).max(2000) })
      .strict()
      .optional(),
    decision: z
      .object({
        question: z.string().min(1).max(2000),
        recommendation: z.string().min(1).max(2000),
        options: z.array(z.string().min(1).max(500)).max(10).optional(),
      })
      .strict()
      .optional(),
    duplicateOf: z.string().min(1).max(2048).optional(),
    result: stageResultSchema.optional(),
  })
  .strict();
export type FactoryReport = z.infer<typeof factoryReportSchema>;

/** The moments the factory writes back to an item's source, at most once each (`waiting` once per question). */
export const writeBackMoments = [
  "taken",
  "triaged",
  "spec-approved",
  "pr-opened",
  "ready",
  "shipped",
  "closed",
  "waiting",
] as const;
export type Moment = (typeof writeBackMoments)[number];

/**
 * The JSON in `<!-- agentgate-factory:1 {...} -->`, read back from issues and PRs. Not strict: a newer factory may add
 * a field, and an older one must still recognize its comments.
 */
export const markerPayloadSchema = z.object({
  item: z.string().min(1),
  key: z.string().min(1),
  stage: z.enum(stageNames).nullable(),
  outcome: z.enum(outcomes).nullable(),
  route: z.enum(["implement", "spec"]).nullable(),
  commit: z.string().nullable(), // the commit the comment is about, when there is one
  factory: z.string().min(1), // the factory folder's commit
  node: z.string().min(1),
  state: z.enum(["open", "finished"]),
});
export type MarkerPayload = z.infer<typeof markerPayloadSchema>;

export const boardThreadSchema = z.object({
  id: z.string(),
  title: z.string(),
  project: z.string().optional(),
  status: z.string(),
  needsYou: z.boolean(),
  item: z.string().optional(),
  link: z.string().optional(),
  updatedAt: z.number(),
});
export type BoardThread = z.infer<typeof boardThreadSchema>;

export const boardItemSchema = z.object({
  id: z.string(),
  key: z.string(),
  repo: z.string(),
  title: z.string(),
  url: z.string().optional(),
  source: z.string(),
  phase: z.enum(itemPhases),
  heldBy: z.string(), // the machine whose tables hold it
  run: z
    .object({
      id: z.string(),
      kind: z.enum(runKinds),
      state: z.enum(runStates),
      node: z.string().optional(),
      threadLink: z.string().optional(),
      startedAt: z.number().optional(),
    })
    .optional(),
  needsYou: needsYouSchema.optional(),
  pr: z
    .object({
      url: z.string(),
      commit: z.string().optional(),
      checks: z.enum(["pending", "passing", "failing"]).optional(),
      reviewRound: z.number().optional(),
      openFindings: z.number().optional(),
    })
    .optional(),
  tokens: z.number(),
  /** A run's thread has worked for a while and no provider session of it was counted: its sessions bypass agentgate. */
  tokensUnknown: z.boolean().optional(),
  inPhaseSince: z.number(),
  updatedAt: z.number(),
});
export type BoardItem = z.infer<typeof boardItemSchema>;

export const factoryBoardSchema = z.object({
  node: z.string(), // the machine answering
  factory: z
    .object({
      repo: z.string(),
      path: z.string(),
      ref: z.string().optional(),
      node: z.string(),
      online: z.boolean(),
      lastSeenAt: z.number().optional(),
    })
    .nullable(),
  config: z
    .object({ commit: z.string(), name: z.string(), loadedAt: z.number(), error: z.string().optional() })
    .nullable(),
  t3: z.object({
    stream: z.enum(["live", "polling", "down"]),
    mcp: z.enum(["signed-in", "signing-in", "failed", "off"]),
    mcpExpiresAt: z.number().optional(),
    error: z.string().optional(),
  }),
  capacity: z.object({
    threads: z.number(),
    working: z.number(),
    waitingForYou: z.number(),
    waitingForYouLimit: z.number(),
    quota: z.union([z.literal("ok"), z.object({ waitingUntil: z.number().optional() })]),
    intake: z.enum(["on", "paused-for-you", "off"]),
    /** `agentgate factory pause`: no intake, no launches and no nudges until `resume`. */
    paused: z.boolean().optional(),
    mainRed: z.array(z.string()), // repositories whose default branch is red
  }),
  items: z.array(boardItemSchema), // open items, plus items finished in the last 7 days
  machines: z.array(z.object({ node: z.string(), online: z.boolean(), threads: z.array(boardThreadSchema) })),
  sources: z.array(
    z.object({
      id: z.string(),
      // A string, not an enum: an older machine reading a newer factory machine's board must not fail on a new type.
      type: z.string(),
      repo: z.string(),
      lastPollAt: z.number().optional(),
      error: z.string().optional(),
      // The URL only in GET /api/factory and the CLI: the token-less page and factory_status never show it.
      webhook: z.object({ configured: z.boolean(), url: z.string().optional() }).optional(),
      scout: z
        .object({
          schedule: z.string(), // "every 6h", "09:00 Mon, Fri (Europe/Copenhagen)"
          enabled: z.boolean(),
          nextAt: z.number().optional(), // absent while intake is not on or the scout is disabled
          lastRun: z
            .object({
              id: z.string(),
              state: z.enum(runStates),
              at: z.number(),
              threadLink: z.string().optional(),
              filed: z.number(),
              skipped: z.number(),
            })
            .optional(),
        })
        .optional(),
    }),
  ),
  metrics: z.object({
    merged: z.number(),
    mergeRate: z.number(),
    reverts14d: z.number(),
    medianHoursToMerge: z.number().optional(),
    humanTouchesPerItem: z.number().optional(),
    tokensPerMergedPr: z.number().optional(),
    scorers: z.array(
      z.object({
        name: z.string(),
        passRate: z.number(),
        runs: z.number(),
        byConfig: z.array(z.object({ commit: z.string(), passRate: z.number(), runs: z.number() })),
      }),
    ),
  }), // the last 7 days
  events: z.array(
    z.object({ seq: z.number(), at: z.number(), item: z.string().optional(), kind: z.string(), text: z.string() }),
  ), // the newest 50
});
export type FactoryBoard = z.infer<typeof factoryBoardSchema>;

/** GET /api/factory/items/:id and `agentgate factory show <item> --json`: one item with its runs, write-backs and events. */
export const factoryItemDetailSchema = z.object({
  item: boardItemSchema,
  runs: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(runKinds),
      attempt: z.number(),
      state: z.enum(runStates),
      node: z.string().optional(),
      threadLink: z.string().optional(),
      error: z.string().optional(),
      tokens: z.number(),
      queuedAt: z.number(),
      startedAt: z.number().optional(),
      endedAt: z.number().optional(),
    }),
  ),
  writebacks: z.array(
    z.object({
      moment: z.enum(writeBackMoments),
      status: z.enum(["posted", "failed", "uncertain"]),
      at: z.number(),
    }),
  ),
  events: factoryBoardSchema.shape.events,
});
export type FactoryItemDetail = z.infer<typeof factoryItemDetailSchema>;

/** What `factory init` did: the draft PR with the template, and the factory, already on at its branch. */
export const factoryInitResultSchema = z.object({
  prUrl: z.string().url(),
  branch: z.literal(FACTORY_INIT_BRANCH),
  /** What init could not set up, each a sentence for the person. */
  warnings: z.array(z.string()),
  factory: factoryBoardSchema.shape.factory,
  config: factoryBoardSchema.shape.config,
});
export type FactoryInitResult = z.infer<typeof factoryInitResultSchema>;

/** PUT /api/factory */
export const factoryUseInputSchema = z
  .object({
    repo,
    path: factoryPointerSchema.shape.path.removeDefault().optional(),
    ref: factoryPointerSchema.shape.ref,
    node: factoryPointerSchema.shape.node.optional(),
  })
  .strict();
/** POST /api/factory/init, `agentgate factory init` */
export const factoryInitInputSchema = z.object({ repo, node: factoryPointerSchema.shape.node.optional() }).strict();
export type FactoryInitInput = z.infer<typeof factoryInitInputSchema>;
/** POST /api/factory/sources, `agentgate factory source add`: a PR on the factory folder that adds a source. */
export const factorySourceAddInputSchema = z
  .object({
    source: z.discriminatedUnion("type", [webhookSourceSchema, scoutSourceSchema]),
    prompt: z.string().trim().min(1).max(32_000).optional(), // a scout's scouts/<id>.md; required for one
  })
  .strict();
export type FactorySourceAddInput = z.input<typeof factorySourceAddInputSchema>;
export const factorySourceAddResultSchema = z.object({
  prUrl: z.string().url(),
  branch: z.string(),
  /** Each a sentence for the person: a tag the factory follows, a secret to set. */
  warnings: z.array(z.string()),
});
export type FactorySourceAddResult = z.infer<typeof factorySourceAddResultSchema>;
/** POST /api/factory/items */
export const factoryItemInputSchema = z
  .object({
    repo,
    title: z.string().trim().min(1).max(300),
    body: z
      .string()
      .max(64 * 1024)
      .optional(),
  })
  .strict();
/** POST /api/factory/items/:id/:action */
export const factoryActionInputSchema = z.object({ reason: z.string().max(2000).optional() }).strict();
/** PUT /api/factory/secrets/:name */
export const factorySecretInputSchema = z.object({ value: secretRecordSchema.shape.value }).strict();
/** POST /api/factory/command: how the CLI runs `agentgate factory <name> ...` in the daemon. */
export const factoryCommandInputSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    args: z.array(z.string().max(64 * 1024)).max(100),
    stdin: z
      .string()
      .max(1024 * 1024)
      .optional(),
  })
  .strict();
export const factoryCommandResultSchema = z.object({ code: z.number().int(), output: z.array(z.string()) });
export type FactoryCommandResult = z.infer<typeof factoryCommandResultSchema>;

/** The JSON Schema of `factory.yaml` for editors. Input mode: a key with a default may be left out. */
export const factoryJsonSchema = () => z.toJSONSchema(factoryConfigSchema, { io: "input" });
