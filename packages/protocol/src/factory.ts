import { z } from "zod";
import { safePath } from "./skills.ts";

/**
 * The software factory: the folder format that defines one (`factory.yaml`, `stages/`, `scouts/`), the records and
 * reports the daemon keeps about its items and runs, and the board the CLI, app and page show.
 */

/**
 * The `_meta` key the MCP shim sets from its session's T3CODE_THREAD_ID on every call it forwards, naming the T3 Code
 * thread that made it. Any local process can set it, so it routes reports but proves nothing.
 */
export const T3_THREAD_META_KEY = "dev.agentgate/t3Thread";

const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/); // source ids
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
/** MCP server aliases a factory thread may use besides agentgate's own tools, written as the repository's mapping has
 * them: an alias may have capitals there (`validId` in mcp/templates.ts), and the gateway matches it exactly. */
const mcpAliases = z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)).max(20);
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
    // Only deliveries whose rendered `value` is one of `in` become items; the rest are answered and dropped. Senders
    // that post every change to a record (Sentry's issue actions) need it to keep the changes that mean new work.
    only: z
      .object({ value: template, in: z.array(z.string().min(1).max(200)).min(1).max(50) })
      .strict()
      .optional(),
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
/** A scout: on its schedule, a T3 thread follows `scouts/<id>.md` and reports findings, each of which becomes an item.
 * The file's frontmatter holds these settings (`scoutFileSchema`), its body the prompt, and its name the id. */
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
/** The frontmatter of `scouts/<id>.md`. */
export const scoutFileSchema = scoutSourceSchema.omit({ id: true, type: true });
/** A source as `factory.yaml` lists it; scouts have a file each. */
export const yamlSourceSchema = z.discriminatedUnion("type", [
  githubSourceSchema,
  linearSourceSchema,
  webhookSourceSchema,
]);
export const factorySourceSchema = z.discriminatedUnion("type", [
  githubSourceSchema,
  linearSourceSchema,
  webhookSourceSchema,
  scoutSourceSchema,
]);
export type FactorySource = z.infer<typeof factorySourceSchema>;

const stageNote = z
  .object({ note: z.string().trim().min(1).max(4000) })
  .strict()
  .optional();

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
        })
        .strict(),
    ),
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
    sources: z.array(yamlSourceSchema).max(50).default([]),
    /** Per stage, a note for this project added after the stage's brief, built-in or replaced by stages/<stage>.md. */
    stages: z
      .object({ triage: stageNote, spec: stageNote, implement: stageNote, review: stageNote })
      .strict()
      .prefault({}),
  })
  .strict();
/** `factory.yaml` as loaded: its sources, then a scout source for each `scouts/<id>.md`. */
export type FactoryConfig = Omit<z.infer<typeof factoryConfigSchema>, "sources"> & { sources: FactorySource[] };

/** Frontmatter of stages/<stage>.md; the body replaces the built-in brief. */
export const stageFileSchema = z
  .object({
    start: z.enum(["auto", "manual"]).default("auto"),
    model: modelSchema.optional(),
    /** The MCP servers (aliases) this stage's threads may use besides agentgate's own tools; none when absent. */
    mcp: mcpAliases.optional(),
  })
  .strict();
export type StageFile = z.infer<typeof stageFileSchema>;

const pointerNode = z.string().min(1).max(512); // the machine that runs the factory
/** Set by `factory move` while the factory machine still has open items: the machine the factory moves to once they
 * finish. Until then intake takes nothing new, and the factory machine moves the pointer itself. */
const pointerMoveTo = pointerNode.optional();
/**
 * `settings.factory`: where the factory's folder lives and which machine runs it. `github` fetches it from a folder of a
 * repository; `agentgate` reads the synced `factoryFolder` record, for a project whose repository must not hold the
 * folder. Not strict, like the settings record it sits in, so an older node keeps reading it after a newer one adds a
 * field.
 */
export const factoryPointerSchema = z.discriminatedUnion("store", [
  z.object({
    store: z.literal("github"),
    repo,
    path: z.string().max(200).default(""), // folder inside the repo; "" is the root
    ref: z.string().min(1).max(200).optional(), // default: the repo's default branch
    node: pointerNode,
    moveTo: pointerMoveTo,
  }),
  z.object({ store: z.literal("agentgate"), node: pointerNode, moveTo: pointerMoveTo }),
]);
export type FactoryPointer = z.infer<typeof factoryPointerSchema>;
const factoryStores = ["github", "agentgate"] as const;
export type FactoryStore = (typeof factoryStores)[number];

/** What a board says while `factory move` waits for the factory machine's open items, and after the last one for the
 * comments it has not posted yet. */
export const movingLabel = ({ to, open }: { to: string; open?: number }) => {
  const when =
    open === undefined
      ? "its open items finish"
      : open === 0
        ? "its last comments are posted"
        : open === 1
          ? "1 item finishes"
          : `${open} items finish`;
  return `Moving to ${to} once ${when}`;
};

/** The relay's record limit is 1 MiB, so a stored folder stays under it with room for the envelope. */
const MAX_STORED_FOLDER = 900 * 1024;
const folderFilePath = z
  .string()
  .min(1)
  .max(200)
  .refine(safePath, "not a path inside the folder")
  .refine((path) => !path.startsWith(".") && !path.includes("/."), "a file or folder name starts with a dot");
/** The synced `factoryFolder` record (id `folder`): the factory folder agentgate stores, one text file per path. Its
 * commit is the SHA-256 of its files (`storedCommit` in factory/stored.ts). */
export const factoryFolderSchema = z
  .object({
    files: z
      .array(z.object({ path: folderFilePath, text: z.string().max(MAX_STORED_FOLDER) }))
      .min(1)
      .max(500),
    from: pointerNode, // the machine that saved it
  })
  .superRefine((folder, ctx) => {
    const paths = new Set(folder.files.map((file) => file.path.toLowerCase()));
    if (paths.size < folder.files.length)
      ctx.addIssue({ code: "custom", path: ["files"], message: "two files share a path" });
    const dirs = [...paths].flatMap((path) =>
      path
        .split("/")
        .slice(0, -1)
        .map((_, i, parts) => parts.slice(0, i + 1).join("/")),
    );
    if (dirs.some((dir) => paths.has(dir)))
      ctx.addIssue({ code: "custom", path: ["files"], message: "a file has the path of a folder" });
    if (folder.files.reduce((n, file) => n + file.text.length + file.path.length, 0) > MAX_STORED_FOLDER)
      ctx.addIssue({ code: "custom", path: ["files"], message: "the folder is larger than 900 KiB" });
  });
/** `folder ls`: the stored folder, or no files when there is none. */
export const storedFolderViewSchema = z.object({
  commit: z.string().optional(),
  files: z.array(z.object({ path: z.string(), text: z.string() })),
});
export type StoredFolderView = z.infer<typeof storedFolderViewSchema>;
/** `folder put`: files to write by path, `null` to delete one. The daemon checks the folder that results as a whole,
 * its paths and size included, so its refusal names the file. */
/** `base` is the commit the editor started from; a save over a folder that changed since is refused. */
export const storedFolderChangeSchema = z
  .object({ files: z.record(z.string(), z.string().nullable()), base: z.string().optional() })
  .strict();

/** The synced `secret` record. `~` ids are agentgate's own, never declared in a folder: `~hook:` webhook URL keys, and
 * `~notify`, the person's notify URL (factory/notify.ts). */
export const secretRecordSchema = z.object({
  id: z.union([secretNameSchema, z.string().regex(/^~hook:[a-z0-9][a-z0-9-]{0,39}$/), z.literal("~notify")]),
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
/** `canary`: the one short thread `agentgate factory doctor --canary` starts, which only reports. */
export const runKinds = ["triage", "spec", "implement", "review", "scout", "canary"] as const;
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

/** What the person must do for an item that waits for them: start it, answer what a stage asks, or decide what happens
 * to work that stopped (retry or drop). */
export const needsYouKinds = ["start", "answer", "stopped"] as const;
export type NeedsYouKind = (typeof needsYouKinds)[number];
/** Why it waits, for the text and the metrics; the daemon maps each to its kind. `question` is a thread's question card
 * in T3 Code, `deleted` a run's thread deleted there. */
export const needsYouCauses = [
  "held",
  "decision",
  "blocked",
  "question",
  "failed",
  "stalled",
  "stuck",
  "budget",
  "stopped",
  "handed-off",
  "deleted",
] as const;
export type NeedsYouCause = (typeof needsYouCauses)[number];

export const needsYouSchema = z
  .object({
    kind: z.enum(needsYouKinds),
    cause: z.enum(needsYouCauses),
    /** What happened, in a few words: the cause for a person. */
    title: z.string(),
    question: z.string(),
    // The rest of a long question, such as the spec a spec card asks to approve; `question` is its first line.
    detail: z.string().optional(),
    recommendation: z.string().optional(),
    options: z.array(z.string()).optional(),
    link: z.string().optional(),
    since: z.number(),
    /** The run that asks, which the answer goes back to. */
    run: z.string().optional(),
    /** A thread's question card: T3's pending request, answered at most once. */
    request: z.string().optional(),
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
/** Work the factory files as an issue without a source's label, so labelling it is the maintainer's approval. */
const suggestedIssue = z
  .object({ title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(8000) })
  .strict();
export const stageResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("triage"),
      route: z.enum(["implement", "spec"]),
      reproduction: z.union([
        z
          .object({
            command: z
              .string()
              .min(1)
              .max(2000)
              .describe(
                "What the next stage runs in its own fresh worktree to see the bug: a command that needs nothing outside the repository, or a test file's path and content with the command that runs it",
              ),
            failsBefore: z.literal(true),
          })
          .strict(),
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
      // Slices the spec leaves for later; each becomes an unlabelled issue when the item's PR goes ready.
      later: z.array(suggestedIssue).max(10).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("implement"),
      prUrl: z.string().url().max(2048),
      commit: commitSha,
      claims: z
        .array(
          z
            .object({ claim: z.string().trim().min(1).max(2000), evidence: z.string().trim().min(1).max(4000) })
            .strict(),
        )
        .max(50),
      notChecked: z.array(z.string().max(2000)).max(50),
      /** Calls the item, the spec and the rulings left open, for the person who merges: the PR's summary lists them
       * least confident first. */
      decisions: z
        .array(
          z
            .object({
              decision: z.string().trim().min(1).max(2000),
              confidence: z.enum(["low", "medium", "high"]),
            })
            .strict(),
        )
        .max(50),
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
              // A pre-existing finding becomes an issue under this title; without one, the text is the title.
              title: z.string().trim().min(1).max(200).optional(),
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

/** What an implement thread sends through `factory_pr_threads` after it pushed fixes for review conversations. A
 * declined conversation needs a note: the factory replies with it. */
export const factoryPrThreadsInputSchema = z
  .object({
    run: z.string().min(1).max(100),
    commit: commitSha, // the PR's head after the push
    conversations: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            outcome: z.enum(["fixed", "declined"]),
            note: z.string().trim().min(1).max(2000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type FactoryPrThreadsInput = z.infer<typeof factoryPrThreadsInputSchema>;

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
/** Every write the outbox sends: a comment for a moment, a reply in a review conversation, an issue the factory files,
 * and a notification to one of the person's outlets. */
export const writeMoments = [...writeBackMoments, "reply", "issue", "notify"] as const;
export type WriteMoment = (typeof writeMoments)[number];

/**
 * The JSON in `<!-- agentgate-factory:1 {...} -->`, read back from issues and PRs. Not strict: a newer factory may add
 * a field, and an older one must still recognize its comments. A comment that carries one is the factory's own, and
 * intake reads its `state`: an issue whose newest marker says `finished` is not taken in again. The rest says what the
 * comment was about, for whoever reads its source.
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
  pr: z.string().nullish(), // the item's PR, once it has one
  // The outbox write that posted the comment, so an uncertain one is settled by reading the comments back. A string,
  // not the enum: a moment a newer factory adds must not hide its marker from this one.
  moment: z.string().nullish(),
  ref: z.string().nullish(),
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

/** What a person can do to an item, each an operation: `agentgate factory <action> <item>`. */
export const itemActions = ["approve", "reject", "retry", "drop"] as const;
export type ItemAction = (typeof itemActions)[number];
/** One thing a person can do to an item now, as the daemon offers it: the CLI shows it as a command, the app as a
 * button. An action can appear twice, without and with text, such as approve on a decision. */
export const boardActionSchema = z.object({
  name: z.enum(itemActions),
  label: z.string(),
  /** What it will do, in a sentence. */
  effect: z.string(),
  /** It asks for text, sent as `reason`. */
  takesText: z.boolean(),
});
export type BoardAction = z.infer<typeof boardActionSchema>;
/** What an item that needs nobody waits for: a free thread, quota, the default branch's CI, its PR's checks, the next
 * review round, or the next try of a launch that failed. */
export const itemWaitsOn = ["thread", "quota", "default-branch", "checks", "review", "launch"] as const;
export const itemWaitingSchema = z.object({ on: z.enum(itemWaitsOn), since: z.number(), text: z.string() });
export type ItemWaiting = z.infer<typeof itemWaitingSchema>;

export const boardItemSchema = z.object({
  id: z.string(),
  key: z.string(),
  repo: z.string(),
  title: z.string(),
  url: z.string().optional(),
  source: z.string(),
  phase: z.enum(itemPhases),
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
  /** Why it waits while it needs nobody; absent while it needs you. */
  waiting: itemWaitingSchema.optional(),
  /** The actions the daemon takes for it now; it refuses the others. */
  actions: z.array(boardActionSchema),
  pr: z
    .object({
      url: z.string(),
      commit: z.string().optional(),
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
/** An item waits for the maintainer while it asks something or its PR is ready to merge. One rule for the app's dot and
 * queue and the daemon's intake count, so they never disagree. */
export const waitsForYou = (item: { needsYou?: unknown; phase: ItemPhase }) =>
  !!item.needsYou || item.phase === "ready";

/** One thing the factory needs, as `agentgate factory doctor` and the board show it. `unknown`: it could not be
 * answered, and `detail` says why. `fix` is the command or step that fixes it. */
export const factoryCheckSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: z.enum(["ok", "warn", "fail", "unknown"]),
  detail: z.string().optional(),
  fix: z.string().optional(),
});
export type FactoryCheck = z.infer<typeof factoryCheckSchema>;

export const factoryBoardSchema = z.object({
  node: z.string(), // the machine answering
  /** The factory machine's preflight while the factory is on, else none. The checks that ask gh or T3 Code are their
   * last answer, so a board never waits for them; a machine that cannot reach the factory machine says so here. */
  checks: z.array(factoryCheckSchema),
  factory: z
    .object({
      store: z.enum(factoryStores),
      repo: z.string().optional(), // store github: the folder's repository, path and ref
      path: z.string().optional(),
      ref: z.string().optional(),
      label: z.string(), // where the folder is, for a person: `owner/repo:path at ref`, or that agentgate stores it
      node: z.string(),
      online: z.boolean(),
      lastSeenAt: z.number().optional(),
      /** `factory move` waits: the factory moves to `to` once the `open` items of its machine finish, and it has
       * posted its last comments. Only that machine knows the count. */
      moving: z.object({ to: z.string(), open: z.number().optional() }).optional(),
    })
    .nullable(),
  config: z
    .object({
      commit: z.string(),
      name: z.string(),
      loadedAt: z.number(),
      error: z.string().optional(),
      /** The repositories the folder names, which `factory add` accepts. */
      repositories: z.array(z.string()).optional(),
    })
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
  /** Open items in the tables of the machine answering, while another machine runs the factory: nothing drives them
   * until the factory moves back, and `drop` on this machine closes one. */
  frozen: z.array(boardItemSchema).optional(),
  /** Each machine's open T3 Code threads of factory runs; with `factory status --all`, every open thread. */
  machines: z.array(
    z.object({
      node: z.string(),
      online: z.boolean(),
      threads: z.array(boardThreadSchema),
      /** The machine's other open threads, left out: other projects' titles are not the board's to show. */
      hidden: z.number().optional(),
    }),
  ),
  sources: z.array(
    z.object({
      id: z.string(),
      // A string, not an enum: an older machine reading a newer factory machine's board must not fail on a new type.
      type: z.string(),
      repo: z.string(),
      lastPollAt: z.number().optional(),
      error: z.string().optional(),
      // The URL and `error` only in GET /api/factory and the CLI: the token-less page and factory_status never show them.
      webhook: z
        .object({
          configured: z.boolean(),
          url: z.string().optional(),
          /** Whether the relay serves webhook URLs at all: one deployed before them answers 404. Absent until asked. */
          relayServes: z.boolean().optional(),
          /** Whether the factory machine's socket for this URL is open, so the relay can hand it a delivery. */
          connected: z.boolean().optional(),
          error: z.string().optional(), // why the socket is not open
          /** The last delivery through the relay, and the status it was answered with. */
          lastDelivery: z.object({ at: z.number(), status: z.number() }).optional(),
        })
        .optional(),
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
  }), // the last 7 days
  events: z.array(
    z.object({ seq: z.number(), at: z.number(), item: z.string().optional(), kind: z.string(), text: z.string() }),
  ), // the newest 50
});
export type FactoryBoard = z.infer<typeof factoryBoardSchema>;

/** `show`, and `agentgate factory show <item> --json`: one item with its runs, write-backs and events. */
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
  /** The outbox's writes for the item: comments for its moments, replies in its PR's review conversations, the issues
   * it filed for work it left alone, and its notifications. `unreachable` is sent again until it goes through;
   * `uncertain` may have been written, and a comment stays so until the factory reads it back; `failed` was refused, or
   * stayed unreachable for a day. */
  writebacks: z.array(
    z.object({
      moment: z.enum(writeMoments),
      status: z.enum(["pending", "sending", "posted", "failed", "unreachable", "uncertain"]),
      at: z.number(),
    }),
  ),
  events: factoryBoardSchema.shape.events,
});
export type FactoryItemDetail = z.infer<typeof factoryItemDetailSchema>;

/** What `factory init` did: the template written to the folder agentgate stores, and the factory on it. */
export const factoryInitResultSchema = z.object({
  /** What init could not set up, each a sentence for the person. */
  warnings: z.array(z.string()),
  factory: factoryBoardSchema.shape.factory,
  config: factoryBoardSchema.shape.config,
});
export type FactoryInitResult = z.infer<typeof factoryInitResultSchema>;

/** `use`: a folder on GitHub (`store` may be left out), or the one agentgate stores. */
export const factoryUseInputSchema = z.union([
  z
    .object({
      store: z.literal("github").optional(),
      repo,
      path: z.string().max(200).optional(),
      ref: z.string().min(1).max(200).optional(),
      node: pointerNode.optional(),
    })
    .strict(),
  z.object({ store: z.literal("agentgate"), node: pointerNode.optional() }).strict(),
]);
export type FactoryUseInput = z.infer<typeof factoryUseInputSchema>;
/** `move`. Without `now`, the factory machine finishes its open items first; with it, the factory moves at once and
 * they stay frozen there. */
export const factoryMoveInputSchema = z.object({ node: pointerNode, now: z.boolean().optional() }).strict();
export type FactoryMoveInput = z.infer<typeof factoryMoveInputSchema>;
/** `init`: a factory for `repo`, its folder stored in agentgate. `label` is the GitHub label its source takes. */
const labelName = githubSourceSchema.shape.label;
export const factoryInitInputSchema = z
  .object({ repo, node: pointerNode.optional(), label: labelName.optional() })
  .strict();
export type FactoryInitInput = z.infer<typeof factoryInitInputSchema>;
/** `repo add` and `repo remove`. */
export const factoryRepoInputSchema = z.object({ repo, label: labelName.optional() }).strict();
/** `source add`: a source for the factory folder, through `propose` like every change to it. */
export const factorySourceAddInputSchema = z
  .object({
    source: z.discriminatedUnion("type", [webhookSourceSchema, scoutSourceSchema]),
    prompt: z.string().trim().min(1).max(32_000).optional(), // a scout's scouts/<id>.md; required for one
  })
  .strict();
export type FactorySourceAddInput = z.input<typeof factorySourceAddInputSchema>;
/** What a change to the folder came to: in the folder now (a stored folder), waiting in a pull request (a folder in
 * git), or nothing to change. `warnings` are each a sentence for the person. */
export type FolderChangeResult = ({ applied: true } | { pr: string } | { unchanged: true }) & { warnings: string[] };
/** `add`, and the agents' `factory_add`. */
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
/** What `approve`, `reject`, `retry` and `drop` take besides the item. */
export const factoryActionInputSchema = z.object({ reason: z.string().max(2000).optional() }).strict();
/** `secret set` */
export const factorySecretInputSchema = z
  .object({ name: secretNameSchema, value: secretRecordSchema.shape.value })
  .strict();

/** What `use`, `move`, `off` and `reload` answer with: the pointer and the folder as the board shows them. */
export type FactoryStatus = Pick<FactoryBoard, "factory" | "config">;

/**
 * The factory operations the app calls, by name: what `POST /api/factory/op/<name>` takes and returns for each. A
 * name is the words after `agentgate factory`. The daemon registers every operation in `apps/agentgate/src/factory`,
 * where `operation` checks the ones named here against these types.
 */
export interface FactoryOps extends Record<
  ItemAction,
  { input: { item: string; reason?: string }; result: { message: string } }
> {
  add: {
    input: z.input<typeof factoryItemInputSchema>;
    result: { id: string; key: string; repo: string; phase: ItemPhase };
  };
  show: { input: { item: string }; result: FactoryItemDetail };
  pause: { input: NoInput; result: { message: string } };
  resume: { input: NoInput; result: { message: string } };
  init: { input: FactoryInitInput; result: FactoryInitResult };
  use: { input: z.input<typeof factoryUseInputSchema>; result: FactoryStatus & { warning?: string } };
  move: { input: FactoryMoveInput; result: FactoryStatus };
  off: { input: NoInput; result: FactoryStatus };
  reload: { input: NoInput; result: FactoryStatus };
  "source add": { input: FactorySourceAddInput; result: FolderChangeResult };
  "repo add": { input: z.input<typeof factoryRepoInputSchema>; result: FolderChangeResult };
  scout: { input: { id: string }; result: { run: string } | { skipped: string } };
  "folder ls": { input: NoInput; result: StoredFolderView };
  "folder put": { input: z.input<typeof storedFolderChangeSchema>; result: StoredFolderView };
  "secret list": { input: NoInput; result: { set: string[]; missing: string[] } };
  "secret set": { input: z.input<typeof factorySecretInputSchema>; result: { name: string } };
  "secret delete": { input: { name: string }; result: { name: string; deleted: boolean } };
  "t3 sign-in": { input: NoInput; result: { mcp: string; expiresAt?: number } };
  /** `url` sets the notify URL, `null` turns it off, and neither shows it: only its host, never the URL. */
  notify: { input: { url?: string | null }; result: { host?: string } };
}
/** An operation that takes nothing: `{}`. */
type NoInput = Record<string, never>;

/** `GET /api/factory/operations`: the operations `agentgate factory` runs, for its help, and so the CLI reads stdin
 * only for one that takes it. */
export interface FactoryOperationInfo {
  name: string;
  summary: string;
  usage: string;
  stdin?: boolean;
}

/** The operation `words` name: the one with the longest name they start with, so `secret set X` is `secret set`
 * and not `secret`. */
export function operationFor<T extends { name: string }>(operations: Iterable<T>, words: readonly string[]) {
  let found: T | undefined;
  for (const op of operations) {
    const name = op.name.split(" ");
    if (name.every((word, i) => words[i] === word) && name.length > (found?.name.split(" ").length ?? 0)) found = op;
  }
  return found;
}

/** `POST /api/factory/terminal`: the words after `agentgate factory` as the CLI got them, with stdin when the
 * operation they name takes it. The answer is what to print and the exit code. */
export const factoryCommandInputSchema = z
  .object({
    args: z
      .array(z.string().max(64 * 1024))
      .min(1)
      .max(100),
    stdin: z
      .string()
      .max(1024 * 1024)
      .optional(),
    cwd: z.string().max(4096).optional(), // the CLI's working directory, which a relative path names a file in
  })
  .strict();
export interface FactoryCommandResult {
  code: number;
  output: string[];
}

/** The JSON Schema of `factory.yaml` for editors. Input mode: a key with a default may be left out. */
export const factoryJsonSchema = () => z.toJSONSchema(factoryConfigSchema, { io: "input" });
