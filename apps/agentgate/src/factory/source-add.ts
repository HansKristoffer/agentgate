import { parseArgs } from "node:util";
import {
  factorySourceAddInputSchema,
  factorySourceAddResultSchema,
  type FactorySourceAddInput,
  type FactorySourceAddResult,
} from "@agentgate/protocol";
import { jsonInput } from "../http.ts";
import { branchExists, defaultBranch, fileExists, openPr, openPrFor, pushNewBranch, readFile } from "./gh.ts";
import { asInput, type FactoryRuntime } from "./runtime.ts";

/**
 * `agentgate factory source add` and `POST /api/factory/sources`: a webhook source or a scout, added to the factory's
 * folder in a PR, through this machine's `gh` login and without a checkout. The source starts once the PR merges and
 * the folder loop loads it. `factory.yaml` is edited as text, so its comments and layout stay, and the result is
 * checked by parsing it again.
 */

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A plain scalar YAML reads back as the same string; anything else is written as a JSON string, which YAML reads. */
const PLAIN = /^[A-Za-z_][A-Za-z0-9_./-]*$/;
const KEYWORDS = /^(true|false|yes|no|on|off|y|n|null|~)$/i;
const scalar = (value: Exclude<Json, Json[] | object>) =>
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

/** The source as one entry of the `sources` list, its dash at `indent`. */
export function sourceYaml(source: { [key: string]: Json }, indent = "  ") {
  const [first, ...rest] = yamlLines(source, `${indent}  `);
  return [`${indent}- ${first!.trimStart()}`, ...rest].join("\n");
}

const lineIndent = (line: string) => line.length - line.trimStart().length;
const isContent = (line: string) => line.trim() !== "" && !line.trimStart().startsWith("#");

/** `lines` with `entry` added at the end of the top-level block list `key`, or undefined when `key` is not one. */
function appendToBlockList(lines: string[], key: string, entry: (indent: string) => string): string[] | undefined {
  const at = lines.findIndex((l) => new RegExp(`^${key}:\\s*(#.*)?$`).test(l));
  if (at < 0) return undefined;
  let first = at + 1;
  while (first < lines.length && !isContent(lines[first]!)) first++;
  const firstLine = lines[first];
  if (firstLine === undefined || !firstLine.trimStart().startsWith("-")) {
    // `key:` with no items before the next top-level key or the end: an empty list.
    if (firstLine === undefined || lineIndent(firstLine) === 0)
      return [...lines.slice(0, at + 1), entry("  "), ...lines.slice(at + 1)];
    return undefined;
  }
  const itemIndent = lineIndent(firstLine);
  let last = first;
  for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!isContent(line)) continue;
    const indent = lineIndent(line);
    if (indent < itemIndent || (indent === itemIndent && !line.trimStart().startsWith("-"))) break;
    last = i;
  }
  return [...lines.slice(0, last + 1), entry(" ".repeat(itemIndent)), ...lines.slice(last + 1)];
}

/** `lines` with `key: [...]` on one line holding `name` too, or undefined when it is not written that way. */
function appendToFlowList(lines: string[], key: string, name: string): string[] | undefined {
  const at = lines.findIndex((l) => new RegExp(`^${key}:\\s*\\[[^\\]]*\\]\\s*(#.*)?$`).test(l));
  if (at < 0) return undefined;
  const line = lines[at]!;
  const close = line.indexOf("]");
  const inside = line.slice(line.indexOf("[") + 1, close).trim();
  const next = `${line.slice(0, line.indexOf("[") + 1)}${inside ? `${inside}, ` : ""}${name}${line.slice(close)}`;
  return [...lines.slice(0, at), next, ...lines.slice(at + 1)];
}

const hasTopKey = (lines: string[], key: string) => lines.some((l) => new RegExp(`^${key}:`).test(l));

function withSource(lines: string[], source: { [key: string]: Json }) {
  const entry = (indent: string) => sourceYaml(source, indent);
  if (!hasTopKey(lines, "sources")) return [...lines, "sources:", entry("  ")];
  const empty = lines.findIndex((l) => /^sources:\s*\[\s*\]\s*(#.*)?$/.test(l));
  if (empty >= 0) return [...lines.slice(0, empty), "sources:", entry("  "), ...lines.slice(empty + 1)];
  return appendToBlockList(lines, "sources", entry);
}

function withSecret(lines: string[], name: string) {
  if (!hasTopKey(lines, "secrets")) return [...lines, `secrets: [${name}]`];
  return (
    appendToFlowList(lines, "secrets", name) ?? appendToBlockList(lines, "secrets", (indent) => `${indent}- ${name}`)
  );
}

const parse = (text: string) => (Bun.YAML.parse(text) ?? {}) as Record<string, unknown>;

/**
 * factory.yaml with `source` at the end of `sources`, and `secret` under `secrets` when it is not there. Throws, with
 * the snippet to add by hand, when the file is not laid out in a way this can edit, or the edit would change
 * anything else.
 */
export function insertSource(text: string, source: { [key: string]: Json }, secret?: string): string {
  const old = parse(text);
  const oldSecrets = Array.isArray(old.secrets) ? (old.secrets as unknown[]) : [];
  const addSecret = !!secret && !oldSecrets.includes(secret);
  const snippet = ["sources:", sourceYaml(source), ...(addSecret ? [`secrets: [..., ${secret}]`] : [])].join("\n");
  const refuse = (why: string) =>
    new Error(`factory.yaml could not be edited (${why}); add this to it by hand:\n\n${snippet}`);

  let lines = text.replace(/\n+$/, "").split("\n");
  const sourced = withSource(lines, source);
  if (!sourced) throw refuse("its sources are not a block list");
  lines = sourced;
  if (addSecret) {
    const secreted = withSecret(lines, secret);
    if (!secreted) throw refuse("its secrets are not a list");
    lines = secreted;
  }
  const next = `${lines.join("\n")}\n`;

  let parsed: Record<string, unknown>;
  try {
    parsed = parse(next);
  } catch {
    throw refuse("the edit did not parse");
  }
  const oldSources = Array.isArray(old.sources) ? old.sources : [];
  const expected = {
    ...old,
    sources: [...oldSources, source],
    ...((addSecret || "secrets" in old) && { secrets: addSecret ? [...oldSecrets, secret] : old.secrets }),
  };
  if (!Bun.deepEquals(parsed, expected)) throw refuse("the edit changed more than the new source");
  return next;
}

// ---- the PR

function prBody(input: FactorySourceAddInput, folder: string, secret: string | undefined) {
  const { source } = input;
  const lines =
    source.type === "scout"
      ? [
          `This adds the scout \`${source.id}\` to the software factory. On its schedule, a T3 Code thread follows \`${folder}scouts/${source.id}.md\` in a worktree of ${source.repo} and reports what it finds; each finding becomes a factory item that is triaged, fixed and reviewed.`,
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

/** `agentgate factory source add` and `POST /api/factory/sources`. Refuses before writing anything when the factory is
 * off, the id is taken, the repository is not the factory's, or the branch exists. */
export async function addSource(f: FactoryRuntime, input: unknown): Promise<FactorySourceAddResult> {
  const parsed = factorySourceAddInputSchema.parse(input);
  // Written as given, so the folder does not fill up with defaults.
  const raw = (input as { source: { [key: string]: Json } }).source;
  const { source } = parsed;
  if (source.type === "scout" && !parsed.prompt) throw new Error(`The scout ${source.id} needs a prompt`);
  if (source.type !== "scout" && parsed.prompt) throw new Error("Only a scout has a prompt");
  const pointer = f.pointer();
  if (!pointer) throw new Error("The factory is off; turn it on with agentgate factory use <owner/repo>");

  const { repo, path, ref } = pointer;
  const folder = path ? `${path}/` : "";
  const warnings: string[] = [];
  let base = ref;
  if (ref && !(await branchExists(repo, ref))) {
    base = undefined;
    warnings.push(
      `The factory follows ${ref}, which is not a branch, so the PR goes to the default branch; ${source.id} starts once ${ref} includes it`,
    );
  }
  base ??= await defaultBranch(repo);

  const yaml = await readFile(repo, `${folder}factory.yaml`, base);
  if (yaml === undefined) throw new Error(`${repo} has no ${folder}factory.yaml on ${base}`);
  const config = parse(yaml);
  const sources = Array.isArray(config.sources) ? (config.sources as { id?: unknown }[]) : [];
  if (sources.some((s) => s.id === source.id)) throw new Error(`The factory already has a source ${source.id}`);
  const repos = Object.keys((config.repositories as object | undefined) ?? {});
  if (!repos.some((r) => r.toLowerCase() === source.repo.toLowerCase()))
    throw new Error(`${source.repo} is not under repositories in factory.yaml; add it there first`);
  const scoutFile = `${folder}scouts/${source.id}.md`;
  if (source.type === "scout" && (await fileExists(repo, scoutFile, base)))
    throw new Error(`${repo} already has ${scoutFile} on ${base}`);
  const branch = `agentgate/factory-source-${source.id}`;
  if (await branchExists(repo, branch)) {
    const open = await openPrFor(repo, branch);
    throw new Error(
      open
        ? `A PR that adds ${source.id} is open: ${open}`
        : `${repo} has a ${branch} branch already; delete it on GitHub, then add the source again`,
    );
  }

  const secret = source.type === "webhook" ? source.signature?.secret.slice("secret:".length) : undefined;
  const files = {
    [`${folder}factory.yaml`]: insertSource(yaml, raw, secret),
    ...(source.type === "scout" && { [scoutFile]: `${parsed.prompt!.trim()}\n` }),
  };
  const title = `chore(factory): add the ${source.type === "scout" ? "scout" : "webhook source"} ${source.id}`;
  await pushNewBranch(repo, branch, title, files, base);
  const pr = await openPr(repo, branch, title, prBody(parsed, folder, secret), { base });
  if (secret)
    warnings.push(`Set the signing secret with agentgate factory secret set ${secret} before deliveries arrive`);
  return factorySourceAddResultSchema.parse({ prUrl: pr.url, branch, warnings });
}

const USAGE = "usage: agentgate factory source add [--json] < source.yaml";

export function setup(f: FactoryRuntime): void {
  f.commands.set("source", {
    usage: "source add [--json] < source.yaml  add a webhook source or scout in a PR; the YAML has source and prompt",
    local: true,
    async run(args, io) {
      const { values, positionals } = parseArgs({
        args,
        options: { json: { type: "boolean" } },
        allowPositionals: true,
      });
      if (positionals.length !== 1 || positionals[0] !== "add" || !io.stdin?.trim()) {
        io.out(USAGE);
        return 2;
      }
      // The daemon runs this, maybe on another machine, so the input comes on stdin rather than as file paths.
      let input: unknown;
      try {
        input = Bun.YAML.parse(io.stdin);
      } catch {
        throw new Error("stdin is not YAML; give { source: {...}, prompt?: ... }");
      }
      const result = await addSource(f, input);
      if (values.json) io.out(JSON.stringify(result));
      else {
        io.out(`Opened ${result.prUrl}; the source starts once it merges.`);
        for (const warning of result.warnings) io.out(`Warning: ${warning}`);
      }
      return 0;
    },
  });
  f.api.post("/sources", async (c) => {
    const body = await jsonInput(c.req.raw);
    return c.json(await asInput(() => addSource(f, body)));
  });
}
