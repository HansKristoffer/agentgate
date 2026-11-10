import { parseArgs } from "node:util";
import { factoryRepoInputSchema, type FolderChangeResult } from "@agentgate/protocol";
import { currentFolder } from "./config.ts";
import { items } from "./db.ts";
import { folderStore } from "./folder-store.ts";
import { ensureLabel } from "./gh.ts";
import { operation, shortError, UsageError, type FactoryRuntime } from "./runtime.ts";
import { block, editYaml, entries, hasTopKey, insertSource, parse, scalar } from "./source-add.ts";

/**
 * The repositories a factory works in: `repo add` and `repo remove` edit `repositories` and the sources in
 * `factory.yaml` as text, keeping the person's keys, order and comments, and propose the change like `source add`.
 * `factory init` starts its template with `addRepository` too, so the first repository and the next are written alike.
 */

export const DEFAULT_LABEL = "factory";

/** A name made of a repository's name: lowercase letters, digits and dashes, up to `max` characters. */
export const repoSlug = (repo: string, max = 40) =>
  repo
    .split("/")[1]!
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, max);

/** Creates the label a repository's source takes; a label it cannot create is a warning, not a failure. */
export const labelWarnings = (repo: string, label: string) =>
  ensureLabel(repo, label, "5319e7", "Issues the AgentGate software factory works").then(
    (): string[] => [],
    (e) => [`Creating the ${label} label failed (${shortError(e)}); create it before labelling issues`],
  );

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const repositories = (config: Record<string, unknown>) => Object.keys((config.repositories as object | null) ?? {});
const sourcesOf = (config: Record<string, unknown>) =>
  Array.isArray(config.sources) ? (config.sources as { id?: unknown; repo?: unknown }[]) : [];

/** The first of `issues`, `<name>-issues`, `<name>-issues-2`… that no source has. */
function sourceId(repo: string, taken: Set<unknown>) {
  const name = repoSlug(repo, 30) || "repo";
  for (let n = 1; ; n++) {
    const id = n === 1 ? (taken.has("issues") ? `${name}-issues` : "issues") : `${name}-issues-${n}`;
    if (!taken.has(id)) return id;
  }
}

function withRepository(lines: string[], repo: string) {
  const entry = (indent: string) => `${indent}${scalar(repo)}: {}`;
  if (!hasTopKey(lines, "repositories")) return [...lines, "repositories:", entry("  ")];
  const empty = lines.findIndex((l) => /^repositories:\s*\{\s*\}\s*(#.*)?$/.test(l));
  if (empty >= 0) return [...lines.slice(0, empty), "repositories:", entry("  "), ...lines.slice(empty + 1)];
  const map = block(lines, "repositories");
  if (!map) return undefined;
  return [...lines.slice(0, map.end), entry(" ".repeat(map.indent || 2)), ...lines.slice(map.end)];
}

/** factory.yaml with `repo` under `repositories` and a GitHub source for its issues labelled `label`. Throws, with what
 * to add by hand, when the file is not laid out in a way this can edit. */
export function addRepository(text: string, repo: string, label: string) {
  const withRepo = editYaml(text, {
    lines: (lines) => withRepository(lines, repo),
    expected: (old) => ({ ...old, repositories: { ...(old.repositories as object | null), [repo]: {} } }),
    layout: "its repositories are not a block mapping",
    what: "the new repository",
    byHand: `add ${repo}: {} under repositories by hand`,
  });
  const taken = new Set(sourcesOf(parse(text)).map((s) => s.id));
  return insertSource(withRepo, { id: sourceId(repo, taken), type: "github", repo, label });
}

/** factory.yaml without `repo` and the sources in it. */
function removeRepository(text: string, repo: string) {
  return editYaml(text, {
    lines(lines) {
      const map = block(lines, "repositories");
      const list = block(lines, "sources");
      if (!map || map.indent === undefined) return undefined;
      const drop = entries(lines, map).filter((e) => Object.keys(parse(e.text)).some((r) => same(r, repo)));
      const kept = list?.indent === undefined ? [] : entries(lines, list);
      const gone = kept.filter((e) => {
        const [source] = parse(e.text) as unknown as { repo?: unknown }[];
        return typeof source?.repo === "string" && same(source.repo, repo);
      });
      if (!drop.length) return undefined;
      const remove = new Set([...drop, ...gone].flatMap((e) => lines.slice(e.start, e.end).map((_, i) => e.start + i)));
      // A list left without entries is written `[]`, which reads back as an empty list rather than null.
      return lines.flatMap((line, i) =>
        remove.has(i)
          ? []
          : list && i === list.at && gone.length && gone.length === kept.length
            ? ["sources: []"]
            : [line],
      );
    },
    expected: (old) => ({
      ...old,
      repositories: Object.fromEntries(Object.entries(old.repositories as object).filter(([key]) => !same(key, repo))),
      ...(Array.isArray(old.sources) && {
        sources: sourcesOf(old).filter((s) => typeof s.repo !== "string" || !same(s.repo, repo)),
      }),
    }),
    layout: "its repositories are not a block mapping",
    what: "the repository and its sources",
    byHand: `remove ${repo} from repositories, and the sources in it, by hand`,
  });
}

/** factory.yaml where a change starts from, and how it spells `name` under `repositories` when it lists it. */
async function factoryYaml(f: FactoryRuntime, name: string) {
  const pointer = f.pointer();
  if (!pointer) throw new Error("The factory is off; start one with agentgate factory init <owner/repo>");
  const folder = folderStore(f, pointer);
  const yaml = await folder.file("factory.yaml");
  if (yaml === undefined) throw new Error(`The factory folder, ${folder.label}, has no factory.yaml`);
  const listed = repositories(parse(yaml)).find((r) => same(r, name));
  return { folder, yaml, listed };
}

const branchName = (verb: string, name: string) => `agentgate/factory-${verb}-${name.toLowerCase().replace("/", "-")}`;

/** The `repo add` operation. Changes nothing when the folder lists the repository already. */
async function addRepo(f: FactoryRuntime, name: string, label: string): Promise<FolderChangeResult> {
  const { folder, yaml, listed } = await factoryYaml(f, name);
  if (listed) return { unchanged: true, warnings: [] };
  const proposed = await folder.propose({
    title: `chore(factory): add ${name}`,
    body: [
      `This adds ${name} to the software factory, with its open issues labelled \`${label}\` as a source.`,
      "",
      `It starts once this PR merges. Label an issue in ${name} with \`${label}\` to start.`,
      "",
      "Opened by `agentgate factory repo add`.",
    ].join("\n"),
    branch: branchName("add", name),
    files: { "factory.yaml": addRepository(yaml, name, label) },
  });
  proposed.warnings.push(...(await labelWarnings(name, label)));
  return proposed;
}

/** The `repo remove` operation, on the factory machine: only it knows the open items, and the scouts of the folder it
 * loaded, whose files go with the repository. */
async function removeRepo(f: FactoryRuntime, name: string): Promise<FolderChangeResult> {
  const open = items.list(f.s, { open: true }).filter((i) => same(i.repo, name)).length;
  if (open)
    throw new Error(
      `${name} has ${open === 1 ? "1 open item" : `${open} open items`}; let them finish or drop them before removing it`,
    );
  const { folder, yaml, listed } = await factoryYaml(f, name);
  if (!listed) return { unchanged: true, warnings: [] };
  if (repositories(parse(yaml)).length === 1)
    throw new Error(`${listed} is the factory's only repository; turn the factory off instead`);
  const scouts = (currentFolder(f)?.config.sources ?? []).filter((s) => s.type === "scout" && same(s.repo, name));
  return folder.propose({
    title: `chore(factory): remove ${listed}`,
    body: [
      `This removes ${listed} from the software factory, with its sources${scouts.length ? ` and scouts (${scouts.map((s) => s.id).join(", ")})` : ""}. Its open issues are no longer taken in once this PR merges.`,
      "",
      "Opened by `agentgate factory repo remove`.",
    ].join("\n"),
    branch: branchName("remove", name),
    files: {
      "factory.yaml": removeRepository(yaml, name),
      ...Object.fromEntries(scouts.map((s) => [`scouts/${s.id}.md`, null])),
    },
  });
}

const print = (result: FolderChangeResult, said: { pr: string; applied: string; unchanged: string }) => [
  "pr" in result ? `Opened ${result.pr}; ${said.pr}.` : "applied" in result ? said.applied : said.unchanged,
  ...result.warnings.map((warning) => `Warning: ${warning}`),
];

export function setup(f: FactoryRuntime): void {
  operation(f, {
    name: "repo add",
    summary: "add a repository and its labelled issues: a PR on a folder in git, at once on the stored one",
    input: factoryRepoInputSchema,
    local: true,
    run: ({ repo, label = DEFAULT_LABEL }) => addRepo(f, repo, label),
    terminal: {
      usage: "repo add <owner/repo> [--label <label>]",
      parse(args) {
        const { values, positionals } = parseArgs({
          args,
          options: { label: { type: "string" } },
          allowPositionals: true,
        });
        if (positionals.length !== 1) throw new UsageError();
        return { input: { repo: positionals[0], ...(values.label && { label: values.label }) } };
      },
      print: (result, { input }) =>
        print(result, {
          pr: `the factory works in ${input.repo} once it merges`,
          applied: `The factory works in ${input.repo} now, on issues labelled ${input.label ?? DEFAULT_LABEL}.`,
          unchanged: `${input.repo} is in the factory already; nothing changed.`,
        }),
    },
  });
  operation(f, {
    name: "repo remove",
    summary: "remove a repository and its sources; refused while it has open items",
    input: factoryRepoInputSchema.omit({ label: true }),
    run: ({ repo }) => removeRepo(f, repo),
    terminal: {
      usage: "repo remove <owner/repo>",
      parse(args) {
        if (args.length !== 1) throw new UsageError();
        return { input: { repo: args[0] } };
      },
      print: (result, { input }) =>
        print(result, {
          pr: `the factory stops taking in ${input.repo}'s issues once it merges`,
          applied: `The factory no longer works in ${input.repo}.`,
          unchanged: `${input.repo} is not in the factory; nothing changed.`,
        }),
    },
  });
}
