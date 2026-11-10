import { parseArgs } from "node:util";
import {
  FACTORY_INIT_BRANCH,
  factoryInitInputSchema,
  factoryInitResultSchema,
  folderLabel,
  type FactoryInitInput,
  type FactoryInitResult,
} from "@agentgate/protocol";
import { defaultNode, protectionWarning, useFactory } from "./config.ts";
import { storedFiles } from "./folder.ts";
import { branchExists, ensureLabel, fileExists, openPr, openPrFor, pushNewBranch } from "./gh.ts";
import { operation, requireFactoryProtocol, shortError, UsageError, type FactoryRuntime } from "./runtime.ts";
import { changeStored } from "./stored.ts";

/**
 * `agentgate factory init`: a factory for one repository, from nothing. The template goes to a branch of the
 * repository with a draft PR, through this machine's `gh` login and without a checkout, and the factory is turned on at
 * that branch at once. When the PR merges, the folder loop moves the factory to the default branch (`followInit` in
 * config.ts). With `--store agentgate` the template becomes the folder agentgate stores, and nothing is pushed.
 */

const FOLDER = "factory";
const LABEL = "factory";
const SCHEMA_URL =
  "https://raw.githubusercontent.com/HansKristoffer/agentgate/main/packages/protocol/factory.schema.json";

/** The files of a new factory folder for `repo`, by their path in the repository. */
export function initTemplate(repo: string): Record<string, string> {
  const name =
    repo
      .split("/")[1]!
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .slice(0, 40) || "factory";
  const yaml = [
    `# yaml-language-server: $schema=${SCHEMA_URL}`,
    "version: 1",
    `name: ${name}`,
    `description: The software factory for ${repo}.`,
    "repositories:",
    `  ${repo}: {}`,
    "sources:",
    "  - id: issues",
    "    type: github",
    `    repo: ${repo}`,
    `    label: ${LABEL}`,
    "",
  ].join("\n");
  const rulings = [
    "# Rulings",
    "",
    "<!-- Your standing decisions for the factory, one per line. The factory adds them to every brief and leaves out",
    "comments like this one. Most projects settle these two; write your answer as a line below.",
    "",
    "- Existing data and formats: greenfield, so change schemas freely with no migrations, backfills or compatibility",
    "  code; or live, so every schema change needs a migration that can run twice.",
    "- Packages you own (name them): when the cause of a bug lives in one, the fix goes there, as an item in its",
    "  repository, not around it here.",
    "-->",
    "",
  ].join("\n");
  return { [`${FOLDER}/factory.yaml`]: yaml, [`${FOLDER}/rulings.md`]: rulings };
}

function prBody(repo: string) {
  return [
    "This adds a software factory for this repository: AgentGate works issues labelled `factory` in T3 Code threads, up to a pull request ready for review. It never merges.",
    "",
    `- \`${FOLDER}/factory.yaml\` names the repository and its source, open issues labelled \`${LABEL}\`. Stage briefs, scouts and skills can be added next to it.`,
    `- \`${FOLDER}/rulings.md\` holds your standing decisions, added to every brief.`,
    "",
    `The factory already runs at this branch. Merging this PR moves it to the default branch; change the folder later through PRs like this one. Label an issue in ${repo} with \`${LABEL}\` to start.`,
  ].join("\n");
}

/** Creates the label the template's source takes; a label it cannot create is a warning, not a failed init. */
const labelWarnings = (repo: string) =>
  ensureLabel(repo, LABEL, "5319e7", "Issues the AgentGate software factory works").then(
    (): string[] => [],
    (e) => [`Creating the ${LABEL} label failed (${shortError(e)}); create it before labelling issues`],
  );

/** The `init` operation. Refuses before writing anything when a factory is on, the machine is unknown, or the
 * repository already has a factory folder or an init branch. */
async function initFactory(f: FactoryRuntime, input: FactoryInitInput): Promise<FactoryInitResult> {
  const { s } = f;
  const { repo, node = defaultNode(s), store = "github" } = input;
  const on = f.pointer();
  if (on) throw new Error(`The factory is on, ${folderLabel(on)}; turn it off with agentgate factory off before init`);
  requireFactoryProtocol(s);
  if (!s.get("node", node)) throw new Error(`No machine is named ${node}; agentgate status lists them`);
  if (store === "agentgate") return initStored(f, repo, node);
  if (await fileExists(repo, `${FOLDER}/factory.yaml`))
    throw new Error(
      `${repo} already has ${FOLDER}/factory.yaml; turn it on with agentgate factory use ${repo}:${FOLDER}`,
    );
  // A branch without an open PR is an earlier init that failed after pushing: this one takes it over.
  const earlier = await branchExists(repo, FACTORY_INIT_BRANCH);
  if (earlier) {
    const open = await openPrFor(repo, FACTORY_INIT_BRANCH);
    if (open) throw new Error(`An init PR for ${repo} is open: ${open}. Merge or close it first`);
  }

  await pushNewBranch(
    repo,
    FACTORY_INIT_BRANCH,
    "chore(factory): start a software factory",
    initTemplate(repo),
    undefined,
    earlier,
  );
  const pr = await openPr(repo, FACTORY_INIT_BRANCH, "chore(factory): start a software factory", prBody(repo), {
    draft: true,
  });
  const warnings = await labelWarnings(repo);
  const status = await useFactory(
    f,
    { repo, path: FOLDER, ref: FACTORY_INIT_BRANCH, node },
    { init: { pr: pr.number } },
  );
  // `use` warned about the init branch, which goes away; the default branch is where the folder lives from the merge.
  const { warning } = await protectionWarning({ repo });
  if (warning) warnings.push(warning);
  return factoryInitResultSchema.parse({
    prUrl: pr.url,
    branch: FACTORY_INIT_BRANCH,
    warnings,
    factory: status.factory,
    config: status.config,
  });
}

/** The template as the folder agentgate stores, the label, and the factory on it. Refuses while a stored folder
 * exists, which `use --store agentgate` turns on instead. */
async function initStored(f: FactoryRuntime, repo: string, node: string): Promise<FactoryInitResult> {
  if (storedFiles(f.s))
    throw new Error(
      "agentgate already stores a factory folder; turn it on with agentgate factory use --store agentgate, or remove it with agentgate factory folder delete",
    );
  const files = Object.fromEntries(
    Object.entries(initTemplate(repo)).map(([path, text]) => [path.slice(FOLDER.length + 1), text]),
  );
  await changeStored(f, files);
  const warnings = await labelWarnings(repo);
  const status = await useFactory(f, { store: "agentgate", node });
  return factoryInitResultSchema.parse({ warnings, factory: status.factory, config: status.config });
}

export function setup(f: FactoryRuntime): void {
  operation(f, {
    name: "init",
    summary: "start a factory for a repository: a template PR (or a folder agentgate stores), turned on",
    input: factoryInitInputSchema,
    local: true,
    run: (input) => initFactory(f, input),
    terminal: {
      usage: "init <owner/repo> [--store github|agentgate] [--node <machine>] [--json]",
      parse(args) {
        const { values, positionals } = parseArgs({
          args,
          options: { node: { type: "string" }, store: { type: "string" }, json: { type: "boolean" } },
          allowPositionals: true,
        });
        if (positionals.length !== 1) throw new UsageError();
        const { node, store, json } = values;
        return { input: { repo: positionals[0], ...(node && { node }), ...(store && { store }) }, json };
      },
      print(result, { input, json }) {
        if (json) return [JSON.stringify(result)];
        return [
          ...(result.prUrl
            ? [
                `Opened ${result.prUrl}`,
                `The factory runs ${input.repo}:${FOLDER} at ${FACTORY_INIT_BRANCH} on ${result.factory?.node}; merging the PR moves it to the default branch.`,
              ]
            : [
                `The factory runs on ${result.factory?.node} with a folder agentgate stores; edit it with agentgate factory folder.`,
              ]),
          ...result.warnings.map((warning) => `Warning: ${warning}`),
        ];
      },
    },
  });
}
