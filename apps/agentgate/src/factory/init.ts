import { parseArgs } from "node:util";
import {
  factoryInitInputSchema,
  factoryInitResultSchema,
  type FactoryInitInput,
  type FactoryInitResult,
} from "@agentgate/protocol";
import { defaultNode, useFactory } from "./config.ts";
import { storedFiles, type FolderFiles } from "./folder.ts";
import { folderStore } from "./folder-store.ts";
import { addRepository, DEFAULT_LABEL, labelWarnings, repoSlug } from "./repos.ts";
import { operation, requireFactoryProtocol, UsageError, type FactoryRuntime } from "./runtime.ts";
import { changeStored } from "./stored.ts";

/**
 * `agentgate factory init`: a factory for one repository, from nothing. The template becomes the folder agentgate
 * stores, the source's label is created through this machine's `gh` login, and the factory is turned on. Nothing is
 * pushed: `folder export` writes the folder out for a repository, and `use` turns the factory on at a folder in git.
 */

const SCHEMA_URL =
  "https://raw.githubusercontent.com/HansKristoffer/agentgate/main/packages/protocol/factory.schema.json";

/** The files of a new factory folder for `repo`, its source taking issues labelled `label`. */
export function initTemplate(repo: string, label = DEFAULT_LABEL): FolderFiles {
  const yaml = [
    `# yaml-language-server: $schema=${SCHEMA_URL}`,
    "version: 1",
    `name: ${repoSlug(repo) || "factory"}`,
    `description: The software factory for ${repo}.`,
    "repositories: {}",
    "sources: []",
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
  return { "factory.yaml": addRepository(yaml, repo, label), "rulings.md": rulings };
}

/** The `init` operation. Refuses before writing anything when a factory is on, the machine is unknown, or agentgate
 * stores a folder already, which `use --store agentgate` turns on instead. */
async function initFactory(f: FactoryRuntime, input: FactoryInitInput): Promise<FactoryInitResult> {
  const { s } = f;
  const { repo, node = defaultNode(s), label = DEFAULT_LABEL } = input;
  const on = f.pointer();
  if (on)
    throw new Error(
      `The factory is on, ${folderStore(f, on).label}; add ${repo} to it with agentgate factory repo add ${repo}`,
    );
  requireFactoryProtocol(s);
  if (!s.get("node", node)) throw new Error(`No machine is named ${node}; agentgate status lists them`);
  if (storedFiles(s))
    throw new Error(
      "agentgate already stores a factory folder; turn it on with agentgate factory use --store agentgate, or remove it with agentgate factory folder delete",
    );
  await changeStored(f, initTemplate(repo, label));
  const warnings = await labelWarnings(repo, label);
  const status = await useFactory(f, { store: "agentgate", node });
  return factoryInitResultSchema.parse({ warnings, factory: status.factory, config: status.config });
}

export function setup(f: FactoryRuntime): void {
  operation(f, {
    name: "init",
    summary: "start a factory for a repository, its folder stored in agentgate, and turn it on",
    input: factoryInitInputSchema,
    local: true,
    run: (input) => initFactory(f, input),
    terminal: {
      usage: "init <owner/repo> [--label <label>] [--node <machine>] [--json]",
      parse(args) {
        const { values, positionals } = parseArgs({
          args,
          options: { label: { type: "string" }, node: { type: "string" }, json: { type: "boolean" } },
          allowPositionals: true,
        });
        if (positionals.length !== 1) throw new UsageError();
        const { label, node, json } = values;
        return { input: { repo: positionals[0], ...(label && { label }), ...(node && { node }) }, json };
      },
      print: (result, { json }) =>
        json
          ? [JSON.stringify(result)]
          : [
              `The factory runs on ${result.factory?.node} with a folder agentgate stores; edit it with agentgate factory folder.`,
              ...result.warnings.map((warning) => `Warning: ${warning}`),
            ],
    },
  });
}
