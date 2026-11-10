import { parseArgs } from "node:util";
import { factorySourceAddInputSchema, type FactorySourceAddInput, type FolderChangeResult } from "@agentgate/protocol";
import { z } from "zod";
import { folderStore } from "./folder-store.ts";
import { operation, UsageError, type FactoryRuntime } from "./runtime.ts";

/**
 * The `source add` operation: a webhook source or a scout, proposed to the factory's folder (folder-store.ts), so a
 * folder in git gets a PR through this machine's `gh` login and the stored folder takes it at once. A webhook source is
 * added to `factory.yaml`, edited as text so its comments and layout stay, and checked by parsing it again; a scout is
 * its own file, `scouts/<id>.md`. The YAML editing here is also what `repo add|remove` (repos.ts) edit with.
 */

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A plain scalar YAML reads back as the same string; anything else is written as a JSON string, which YAML reads. */
const PLAIN = /^[A-Za-z_][A-Za-z0-9_./-]*$/;
const KEYWORDS = /^(true|false|yes|no|on|off|y|n|null|~)$/i;
export const scalar = (value: Exclude<Json, Json[] | object>) =>
  typeof value === "string" && PLAIN.test(value) && !KEYWORDS.test(value) ? value : JSON.stringify(value);

/** Block YAML for a source: nested objects indented, lists of scalars in flow style like `[mon, thu]`. */
function yamlLines(value: { [key: string]: Json }, indent: string): string[] {
  return Object.entries(value).flatMap(([key, v]) => {
    if (v === undefined) return [];
    if (Array.isArray(v)) {
      if (v.every((x) => x === null || typeof x !== "object"))
        return [`${indent}${key}: [${v.map((x) => scalar(x as Exclude<Json, object>)).join(", ")}]`];
      throw new Error(`a source has no list of objects; ${key} has one`);
    }
    if (v && typeof v === "object") return [`${indent}${key}:`, ...yamlLines(v, `${indent}  `)];
    return [`${indent}${key}: ${scalar(v)}`];
  });
}

/** A scout's file: its settings as frontmatter, without the id its name gives, and its prompt. */
export function scoutFile(source: { [key: string]: Json }, prompt: string) {
  const { id: _, type: __, ...settings } = source;
  return ["---", ...yamlLines(settings, ""), "---", "", prompt.trim(), ""].join("\n");
}

/** The source as one entry of the `sources` list, its dash at `indent`. */
export function sourceYaml(source: { [key: string]: Json }, indent = "  ") {
  const [first, ...rest] = yamlLines(source, `${indent}  `);
  return [`${indent}- ${first!.trimStart()}`, ...rest].join("\n");
}

const lineIndent = (line: string) => line.length - line.trimStart().length;
const isContent = (line: string) => line.trim() !== "" && !line.trimStart().startsWith("#");

/** The top-level block `key`: its line, the index after its last line, and its entries' indent, which is undefined
 * when nothing is under the key. Undefined when the key is absent or holds a value on its own line, such as `[]`. */
export function block(lines: string[], key: string) {
  const at = lines.findIndex((l) => l.startsWith(`${key}:`) && /^[^:]+:\s*(#.*)?$/.test(l));
  if (at < 0) return undefined;
  let indent: number | undefined;
  let end = at + 1;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!isContent(line)) continue;
    const n = lineIndent(line);
    // A list may sit at its key's own indent; anything else there is the next key.
    if ((n === 0 && !line.startsWith("-")) || (indent !== undefined && n < indent)) break;
    indent ??= n;
    end = i + 1;
  }
  return { at, end, indent };
}

/** The entries of a block, each from its first line to its last line that is not blank or a comment. */
export function entries(lines: string[], { at, end, indent }: NonNullable<ReturnType<typeof block>>) {
  const starts: number[] = [];
  for (let i = at + 1; i < end; i++) if (isContent(lines[i]!) && lineIndent(lines[i]!) === indent) starts.push(i);
  return starts.map((start, k) => {
    let last = start;
    for (let i = start + 1; i < (starts[k + 1] ?? end); i++) if (isContent(lines[i]!)) last = i;
    const text = lines
      .slice(start, last + 1)
      .map((l) => l.slice(indent))
      .join("\n");
    return { start, end: last + 1, text };
  });
}

export const hasTopKey = (lines: string[], key: string) => lines.some((l) => new RegExp(`^${key}:`).test(l));

function withSource(lines: string[], source: { [key: string]: Json }) {
  const entry = (indent: string) => sourceYaml(source, indent);
  if (!hasTopKey(lines, "sources")) return [...lines, "sources:", entry("  ")];
  const empty = lines.findIndex((l) => /^sources:\s*\[\s*\]\s*(#.*)?$/.test(l));
  if (empty >= 0) return [...lines.slice(0, empty), "sources:", entry("  "), ...lines.slice(empty + 1)];
  const list = block(lines, "sources");
  if (!list) return undefined;
  // `sources:` with nothing under it: an empty list.
  if (list.indent === undefined) return [...lines.slice(0, list.at + 1), entry("  "), ...lines.slice(list.at + 1)];
  if (!lines[entries(lines, list)[0]!.start]!.trimStart().startsWith("-")) return undefined;
  return [...lines.slice(0, list.end), entry(" ".repeat(list.indent)), ...lines.slice(list.end)];
}

export const parse = (text: string) => (Bun.YAML.parse(text) ?? {}) as Record<string, unknown>;

/**
 * `text` with `lines` edited, checked by parsing it again: it must parse to `expected` of what it parsed to before.
 * Throws, with what to do by hand, when the file is not laid out in a way this can edit (`lines` gave undefined, saying
 * `layout`), or the edit would change anything else.
 */
export function editYaml(
  text: string,
  change: {
    lines(lines: string[]): string[] | undefined;
    expected(old: Record<string, unknown>): unknown;
    layout: string;
    what: string;
    byHand: string;
  },
): string {
  const old = parse(text);
  const refuse = (why: string) => new Error(`factory.yaml could not be edited (${why}); ${change.byHand}`);
  const edited = change.lines(text.replace(/\n+$/, "").split("\n"));
  if (!edited) throw refuse(change.layout);
  const next = `${edited.join("\n")}\n`;
  let parsed: Record<string, unknown>;
  try {
    parsed = parse(next);
  } catch {
    throw refuse("the edit did not parse");
  }
  if (!Bun.deepEquals(parsed, change.expected(old))) throw refuse(`the edit changed more than ${change.what}`);
  return next;
}

/** factory.yaml with `source` at the end of `sources`. */
export const insertSource = (text: string, source: { [key: string]: Json }) =>
  editYaml(text, {
    lines: (lines) => withSource(lines, source),
    expected: (old) => ({ ...old, sources: [...(Array.isArray(old.sources) ? old.sources : []), source] }),
    layout: "its sources are not a block list",
    what: "the new source",
    byHand: `add this to it by hand:\n\n${["sources:", sourceYaml(source)].join("\n")}`,
  });

// ---- the PR

function prBody(input: FactorySourceAddInput, secret: string | undefined) {
  const { source } = input;
  const lines =
    source.type === "scout"
      ? [
          `This adds the scout \`${source.id}\` to the software factory. On its schedule, a T3 Code thread follows \`scouts/${source.id}.md\` of the factory folder in a worktree of ${source.repo} and reports what it finds; each finding becomes a factory item that is triaged, fixed and reviewed.`,
          "",
          `It starts once this PR merges. \`agentgate factory scout ${source.id}\` runs it at once.`,
        ]
      : [
          `This adds the webhook source \`${source.id}\` to the software factory: each delivery to its URL becomes an item in ${source.repo}${source.intake === "auto" ? "" : ", waiting for approval"}.`,
          "",
          "It starts once this PR merges. Its URL shows in the app's Factory view and in `agentgate factory status` within a minute after that; give it only to the sender.",
          ...(secret
            ? ["", `Set the signing secret on the factory's machine with \`agentgate factory secret set ${secret}\`.`]
            : []),
        ];
  return [...lines, "", "Opened by `agentgate factory source add`."].join("\n");
}

/** `raw` without the values its schema fills in anyway, so the folder gets only what was set: a key whose removal parses
 * to the same source is dropped, nested ones included. */
export function withoutDefaults(raw: { [key: string]: Json }, parse: (value: unknown) => unknown) {
  const full = parse(raw);
  const strip = (value: { [key: string]: Json }, rebuild: (next: { [key: string]: Json }) => unknown) => {
    const kept: { [key: string]: Json } = { ...value };
    for (const [key, v] of Object.entries(value)) {
      const { [key]: _, ...without } = kept;
      let same = false;
      try {
        same = Bun.deepEquals(parse(rebuild(without)), full);
      } catch {
        // Required: the source does not parse without it.
      }
      if (same) delete kept[key];
      else if (v && typeof v === "object" && !Array.isArray(v))
        kept[key] = strip(v, (next) => rebuild({ ...kept, [key]: next }));
    }
    return kept;
  };
  return strip(raw, (next) => next);
}

/** Refuses a source whose id factory.yaml or a scout file has, or whose repository factory.yaml does not list. */
function checkNew(yaml: string, source: { id: string; repo: string }, scoutExists: boolean) {
  const config = parse(yaml);
  const sources = Array.isArray(config.sources) ? (config.sources as { id?: unknown }[]) : [];
  if (sources.some((s) => s.id === source.id)) throw new Error(`The factory already has a source ${source.id}`);
  const repos = Object.keys((config.repositories as object | undefined) ?? {});
  if (!repos.some((r) => r.toLowerCase() === source.repo.toLowerCase()))
    throw new Error(`${source.repo} is not under repositories in factory.yaml; add it there first`);
  if (scoutExists) throw new Error(`The factory already has a scout ${source.id}`);
}

/** Refuses before writing anything when the factory is off, the id is taken, or the repository is not the factory's. */
async function addSource(f: FactoryRuntime, input: unknown): Promise<FolderChangeResult> {
  const parsed = factorySourceAddInputSchema.parse(input);
  const { source } = parsed;
  // What was set, so the folder does not fill up with defaults.
  const raw = withoutDefaults((input as { source: { [key: string]: Json } }).source, (value) =>
    factorySourceAddInputSchema.shape.source.parse(value),
  );
  if (source.type === "scout" && !parsed.prompt) throw new Error(`The scout ${source.id} needs a prompt`);
  if (source.type !== "scout" && parsed.prompt) throw new Error("Only a scout has a prompt");
  const pointer = f.pointer();
  if (!pointer) throw new Error("The factory is off; turn it on with agentgate factory use <owner/repo>");
  const secret = source.type === "webhook" ? source.signature?.secret.slice("secret:".length) : undefined;

  const folder = folderStore(f, pointer);
  const yaml = await folder.file("factory.yaml");
  if (yaml === undefined) throw new Error(`The factory folder, ${folder.label}, has no factory.yaml`);
  const scoutPath = `scouts/${source.id}.md`;
  checkNew(yaml, source, (await folder.file(scoutPath)) !== undefined);
  const proposed = await folder.propose({
    title: `chore(factory): add the ${source.type === "scout" ? "scout" : "webhook source"} ${source.id}`,
    body: prBody(parsed, secret),
    branch: `agentgate/factory-source-${source.id}`,
    files:
      source.type === "scout"
        ? { [scoutPath]: scoutFile(raw, parsed.prompt!) }
        : { "factory.yaml": insertSource(yaml, raw) },
  });
  if (secret)
    proposed.warnings.push(
      `Set the signing secret with agentgate factory secret set ${secret} before deliveries arrive`,
    );
  return proposed;
}

export function setup(f: FactoryRuntime): void {
  operation(f, {
    name: "source add",
    summary:
      "add a webhook source or scout: a PR on a folder in git, at once on the stored one; stdin has source and prompt",
    // `addSource` checks it, and needs it as it was given: it writes only what the person set, in their order.
    input: z.unknown(),
    local: true,
    run: (input) => addSource(f, input),
    terminal: {
      usage: "source add [--json] < source.yaml",
      // The daemon runs this, so the input comes on stdin rather than as file paths.
      stdin: true,
      parse(args, stdin) {
        const { values, positionals } = parseArgs({
          args,
          options: { json: { type: "boolean" } },
          allowPositionals: true,
        });
        if (positionals.length || !stdin?.trim()) throw new UsageError();
        try {
          return { input: Bun.YAML.parse(stdin), json: values.json };
        } catch {
          throw new Error("stdin is not YAML; give { source: {...}, prompt?: ... }");
        }
      },
      print: (result, { json }) =>
        json
          ? [JSON.stringify(result)]
          : [
              "pr" in result
                ? `Opened ${result.pr}; the source starts once it merges.`
                : "Added to the factory folder; the source starts within 2 minutes.",
              ...result.warnings.map((warning) => `Warning: ${warning}`),
            ],
    },
  });
}
