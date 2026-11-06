import { parseArgs } from "node:util";
import {
  FACTORY_INIT_BRANCH,
  factoryInitInputSchema,
  factoryInitResultSchema,
  type FactoryInitResult,
} from "@agentgate/protocol";
import { jsonInput } from "../http.ts";
import { defaultNode, protectionWarning, useFactory } from "./config.ts";
import { branchExists, ensureLabel, fileExists, openDraftPr, openPrFor, pushNewBranch } from "./gh.ts";
import { asInput, requireFactoryProtocol, shortError, type FactoryRuntime } from "./runtime.ts";

/**
 * `agentgate factory init`: a factory for one repository, from nothing. The template goes to a branch of the
 * repository with a draft PR, through this machine's `gh` login and without a checkout, and the factory is turned on at
 * that branch at once. When the PR merges, the folder loop moves the factory to the default branch (`followInit` in
 * config.ts).
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
    "<!-- Your standing decisions for the factory, one per line. The factory adds them to every brief. -->",
    "",
  ].join("\n");
  return { [`${FOLDER}/factory.yaml`]: yaml, [`${FOLDER}/rulings.md`]: rulings };
}

function prBody(repo: string) {
  return [
    "This adds a software factory for this repository: AgentGate works issues labelled `factory` in T3 Code threads, up to a pull request ready for review. It never merges.",
    "",
    `- \`${FOLDER}/factory.yaml\` names the repository and its source, open issues labelled \`${LABEL}\`. Stage briefs, judges and skills can be added next to it.`,
    `- \`${FOLDER}/rulings.md\` holds your standing decisions, added to every brief.`,
    "",
    `The factory already runs at this branch. Merging this PR moves it to the default branch; change the folder later through PRs like this one. Label an issue in ${repo} with \`${LABEL}\` to start.`,
  ].join("\n");
}

/** `agentgate factory init` and `POST /api/factory/init`. Refuses before writing anything when a factory is on, the
 * machine is unknown, or the repository already has a factory folder or an init branch. */
export async function initFactory(f: FactoryRuntime, input: unknown): Promise<FactoryInitResult> {
  const { s } = f;
  const { repo, node = defaultNode(s) } = factoryInitInputSchema.parse(input);
  const on = f.pointer();
  if (on) throw new Error(`The factory is on, at ${on.repo}; turn it off with agentgate factory off before init`);
  requireFactoryProtocol(s);
  if (!s.get("node", node)) throw new Error(`No machine is named ${node}; agentgate status lists them`);
  if (await fileExists(repo, `${FOLDER}/factory.yaml`))
    throw new Error(
      `${repo} already has ${FOLDER}/factory.yaml; turn it on with agentgate factory use ${repo}:${FOLDER}`,
    );
  if (await branchExists(repo, FACTORY_INIT_BRANCH)) {
    const open = await openPrFor(repo, FACTORY_INIT_BRANCH);
    throw new Error(
      open
        ? `An init PR for ${repo} is open: ${open}. Merge or close it first`
        : `${repo} has a ${FACTORY_INIT_BRANCH} branch from an earlier init; delete it on GitHub, then init again`,
    );
  }

  await pushNewBranch(repo, FACTORY_INIT_BRANCH, "chore(factory): start a software factory", initTemplate(repo));
  const pr = await openDraftPr(repo, FACTORY_INIT_BRANCH, "chore(factory): start a software factory", prBody(repo));
  const warnings: string[] = [];
  await ensureLabel(repo, LABEL, "5319e7", "Issues the AgentGate software factory works").catch((e) =>
    warnings.push(`Creating the ${LABEL} label failed (${shortError(e)}); create it before labelling issues`),
  );
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

export function setup(f: FactoryRuntime): void {
  f.commands.set("init", {
    usage: "init <owner/repo> [--node <machine>] [--json]  start a factory in a repository: a template PR, turned on",
    local: true,
    async run(args, io) {
      const { values, positionals } = parseArgs({
        args,
        options: { node: { type: "string" }, json: { type: "boolean" } },
        allowPositionals: true,
      });
      if (positionals.length !== 1) {
        io.out("usage: agentgate factory init <owner/repo> [--node <machine>] [--json]");
        return 2;
      }
      const result = await initFactory(f, { repo: positionals[0], ...(values.node && { node: values.node }) });
      if (values.json) io.out(JSON.stringify(result));
      else {
        io.out(`Opened ${result.prUrl}`);
        io.out(
          `The factory runs ${positionals[0]}:${FOLDER} at ${FACTORY_INIT_BRANCH} on ${result.factory?.node}; merging the PR moves it to the default branch.`,
        );
        for (const warning of result.warnings) io.out(`Warning: ${warning}`);
      }
      return 0;
    },
  });
  f.api.post("/init", async (c) => {
    const body = await jsonInput(c.req.raw);
    return c.json(await asInput(() => initFactory(f, body)));
  });
}
