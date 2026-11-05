import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  factoryConfigSchema,
  factoryUseInputSchema,
  scorerFileSchema,
  stageFileSchema,
  stageNames,
  type FactoryBoard,
  type FactoryConfig,
  type FactoryPointer,
  type ScorerFile,
  type StageFile,
  type StageName,
} from "@agentgate/protocol";
import { exponentialBackoff, getErrorMessage, safeJsonParse } from "hanzio";
import { z } from "zod";
import { patchSettings, revision } from "../configuration.ts";
import { jsonInput } from "../http.ts";
import type { Store } from "../store.ts";
import { lastSeen } from "../sync.ts";
import { items } from "./db.ts";
import { fetcher, folderPath, pruneFolders } from "./folder.ts";
import { asInput, requireFactoryProtocol, type FactoryRuntime } from "./runtime.ts";

/**
 * The factory's folder: where `agentgate factory use` points it, the loop that fetches it when its ref moves, and the
 * loader that checks it as a whole. A broken commit never replaces the last good folder; items finish under the
 * commit they started with (`folderAt`).
 */

export interface LoadedFolder {
  commit: string;
  dir: string; // <agentgate home>/factory/<commit>
  config: FactoryConfig; // factory.yaml with defaults applied
  stages: Partial<Record<StageName, { file: StageFile; brief: string }>>;
  scorers: Record<string, { file: ScorerFile; rubric: string }>;
  rulings: string; // "" when absent
  skillsDir?: string; // <dir>/skills when present
}

/** A problem in the folder, naming the file and, when there is one, the field. */
export class FolderError extends Error {
  constructor(
    readonly file: string,
    readonly field: string,
    message: string,
  ) {
    super(`${file}: ${field ? `${field}: ` : ""}${message}`);
    this.name = "FolderError";
  }
}

const fieldPath = (path: PropertyKey[]) =>
  path.reduce<string>(
    (out, k) => (typeof k === "number" ? `${out}[${k}]` : out ? `${out}.${String(k)}` : String(k)),
    "",
  );

function check<T extends z.ZodType>(schema: T, value: unknown, file: string): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  if (issue.code === "unrecognized_keys")
    throw new FolderError(file, fieldPath([...issue.path, issue.keys[0]!]), "unknown key");
  throw new FolderError(file, fieldPath(issue.path), issue.message);
}

function yaml(file: string, text: string): unknown {
  try {
    return Bun.YAML.parse(text) ?? {};
  } catch (error) {
    throw new FolderError(file, "", `invalid YAML: ${getErrorMessage(error)}`);
  }
}

/** Frontmatter is optional; without it, the whole file is the body. */
function markdown(dir: string, file: string) {
  const text = readFileSync(join(dir, file), "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    if (text.startsWith("---")) throw new FolderError(file, "", "the frontmatter has no closing ---");
    return { data: {}, body: text.trim() };
  }
  return { data: yaml(file, match[1]!), body: text.slice(match[0].length).trim() };
}

const markdownFiles = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name.slice(0, -3))
      .sort();
  } catch {
    // No such folder: it is optional.
    return [];
  }
};

/** Every `secret:NAME` in the config, with where it is. */
function secretRefs(value: unknown, path: PropertyKey[] = []): { name: string; path: PropertyKey[] }[] {
  if (typeof value === "string") return value.startsWith("secret:") ? [{ name: value.slice(7), path }] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => secretRefs(v, [...path, i]));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => secretRefs(v, [...path, k]));
  return [];
}

/** Reads and checks the whole folder. Throws a FolderError naming the file and field. */
export function loadFolder(dir: string, commit: string): LoadedFolder {
  if (!existsSync(join(dir, "factory.yaml")))
    throw new FolderError("factory.yaml", "", "the folder has no factory.yaml");
  const config = check(
    factoryConfigSchema,
    yaml("factory.yaml", readFileSync(join(dir, "factory.yaml"), "utf8")),
    "factory.yaml",
  );

  // GitHub names are case-insensitive: a source names its repository the way `repositories` spells it.
  const repos = new Map(Object.keys(config.repositories).map((r) => [r.toLowerCase(), r]));
  const ids = new Map<string, number>();
  config.sources.forEach((source, i) => {
    const repo = repos.get(source.repo.toLowerCase());
    if (!repo) throw new FolderError("factory.yaml", `sources[${i}].repo`, `${source.repo} is not under repositories`);
    source.repo = repo;
    const first = ids.get(source.id);
    if (first !== undefined)
      throw new FolderError("factory.yaml", `sources[${i}].id`, `${source.id} is also the id of sources[${first}]`);
    ids.set(source.id, i);
  });
  for (const ref of secretRefs(config))
    if (!config.secrets.includes(ref.name))
      throw new FolderError("factory.yaml", fieldPath(ref.path), `secret:${ref.name} is not declared under secrets`);

  const stages: LoadedFolder["stages"] = {};
  for (const name of markdownFiles(join(dir, "stages"))) {
    const file = `stages/${name}.md`;
    const stage = stageNames.find((s) => s === name);
    if (!stage) throw new FolderError(file, "", `not a stage; the stages are ${stageNames.join(", ")}`);
    const { data, body } = markdown(dir, file);
    stages[stage] = { file: check(stageFileSchema, data, file), brief: body };
  }

  const scorers: LoadedFolder["scorers"] = {};
  for (const name of markdownFiles(join(dir, "scorers"))) {
    const file = `scorers/${name}.md`;
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name))
      throw new FolderError(file, "", "a scorer's name is up to 40 lowercase letters, digits and dashes");
    const { data, body } = markdown(dir, file);
    const scorer = check(scorerFileSchema, data, file);
    const best = Math.max(...scorer.labels.map((l) => l.score));
    if (scorer.pass > best)
      throw new FolderError(file, "pass", `${scorer.pass} is above the best label's score, ${best}, so nothing passes`);
    scorers[name] = { file: scorer, rubric: body };
  }

  const rulings = existsSync(join(dir, "rulings.md")) ? readFileSync(join(dir, "rulings.md"), "utf8").trim() : "";
  const skills = join(dir, "skills");
  const skillsDir = existsSync(skills) && statSync(skills).isDirectory() ? skills : undefined;
  return { commit, dir, config, stages, scorers, rulings, ...(skillsDir && { skillsDir }) };
}

// What the factory machine knows about its folder, kept across restarts. `fetched` is the newest commit tried,
// `commit` the last good one; they differ while the newest is broken.
const STATE_KEY = "factoryFolder";
interface FolderState {
  source: string; // the pointer the state belongs to
  fetched?: string;
  commit?: string;
  loadedAt?: number;
  triedAt?: number;
  error?: string; // why `fetched` did not load
  fetchError?: string; // why the last fetch failed
}
const sourceOf = (p: FactoryPointer) => JSON.stringify([p.repo.toLowerCase(), p.path, p.ref ?? null]);

function readState(s: Store, pointer: FactoryPointer): FolderState {
  const state = safeJsonParse<FolderState>(s.local(STATE_KEY) ?? "{}").data;
  return state?.source === sourceOf(pointer) ? state : { source: sourceOf(pointer) };
}

interface Memory {
  folders: Map<string, LoadedFolder>; // by commit
  queue: Promise<void>; // one fetch at a time
  failures: number;
  retryAt: number;
}
const memories = new WeakMap<FactoryRuntime, Memory>();
function memory(f: FactoryRuntime) {
  let m = memories.get(f);
  if (!m) {
    m = { folders: new Map(), queue: Promise.resolve(), failures: 0, retryAt: 0 };
    memories.set(f, m);
  }
  return m;
}

/** The folder of a commit this machine fetched; kept while any open item uses that commit. */
export function folderAt(f: FactoryRuntime, commit: string): LoadedFolder | undefined {
  const m = memory(f);
  const known = m.folders.get(commit);
  if (known) return known;
  const dir = join(fetcher.root, commit);
  if (!/^[0-9a-f]{40,64}$/.test(commit) || !existsSync(dir)) return undefined;
  try {
    const folder = loadFolder(dir, commit);
    m.folders.set(commit, folder);
    return folder;
  } catch {
    // A commit that never loaded: no item started under it.
    return undefined;
  }
}

/** The last good folder, which new items start under. */
export function currentFolder(f: FactoryRuntime): LoadedFolder | undefined {
  const pointer = f.pointer();
  const commit = pointer && readState(f.s, pointer).commit;
  return commit ? folderAt(f, commit) : undefined;
}

/** The folder an item or run started under, or the current one once that commit's folder is gone. */
export const folderFor = (f: FactoryRuntime, commit: string) => folderAt(f, commit) ?? currentFolder(f);

export const DEFAULT_LIMITS = factoryConfigSchema.shape.limits.parse(undefined);

const UNITS = { m: 60_000, h: 3600_000, d: 86_400_000 } as const;
/** A folder duration such as `15m`, `1h` or `7d`, which the schema has checked, in milliseconds. */
export const durationMs = (d: string) => Number.parseInt(d, 10) * UNITS[d.slice(-1) as keyof typeof UNITS];

const short = (commit: string) => commit.slice(0, 7);

/** Fetches when the ref moved (always when forced), loads, and keeps the last good folder. Never throws. */
function sync(f: FactoryRuntime, force = false): Promise<void> {
  const m = memory(f);
  const run = m.queue.then(() => syncNow(f, m, force));
  m.queue = run.catch(() => {});
  return run;
}

async function syncNow(f: FactoryRuntime, m: Memory, force: boolean) {
  const { s, events } = f;
  const pointer = f.pointer();
  if (!pointer || !f.isFactoryNode()) return;
  if (!force && m.retryAt > s.now()) return;

  const state = readState(s, pointer);
  const save = (next: FolderState) => {
    // The pointer may have moved while git ran; that state belongs to the old one.
    const now = f.pointer();
    if (now && sourceOf(now) === state.source) s.setLocal(STATE_KEY, JSON.stringify(next));
  };

  // Without the last good folder on disk, fetch whatever the ref points at now.
  const since = force || (state.fetched === state.commit && !currentFolder(f)) ? undefined : state.fetched;
  let fetched: Awaited<ReturnType<typeof fetcher.fetch>>;
  try {
    fetched = await fetcher.fetch({ repo: pointer.repo, ref: pointer.ref, path: pointer.path, since });
  } catch (e) {
    const error = getErrorMessage(e);
    m.failures++;
    // 2 minutes, doubling up to an hour, like the skill sync.
    m.retryAt = s.now() + exponentialBackoff(m.failures, { baseMs: 2 * 60_000, maxMs: 3600_000, jitter: false });
    if (state.fetchError !== error) {
      console.error(`factory: ${error}`);
      events.emit({ kind: "config", error, text: `Fetching the factory folder failed: ${error}` });
    }
    save({ ...state, fetchError: error });
    return;
  }

  if (m.failures) console.log(`factory: fetching ${pointer.repo} works again`);
  m.failures = 0;
  m.retryAt = 0;
  if (!fetched) {
    if (state.fetchError) save({ ...state, fetchError: undefined });
  } else {
    try {
      const folder = loadFolder(fetched.dir, fetched.commit);
      m.folders.set(folder.commit, folder);
      save({ source: state.source, fetched: folder.commit, commit: folder.commit, loadedAt: s.now() });
      events.emit({
        kind: "config",
        commit: folder.commit,
        text: `Loaded ${folder.config.name} at ${short(folder.commit)}`,
      });
    } catch (e) {
      const error = getErrorMessage(e);
      save({ ...state, fetched: fetched.commit, error, fetchError: undefined, triedAt: s.now() });
      const kept = state.commit ? `kept ${short(state.commit)}` : "no folder is loaded";
      events.emit({ kind: "config", error, text: `${short(fetched.commit)} is broken, so ${kept}: ${error}` });
    }
  }
  prune(f);
}

/** Keeps the current folder and every folder an open item still uses. */
function prune(f: FactoryRuntime) {
  const pointer = f.pointer();
  const keep = new Set(items.list(f.s, { open: true }).map((i) => i.configCommit));
  const current = pointer && readState(f.s, pointer).commit;
  if (current) keep.add(current);
  const m = memory(f);
  for (const commit of m.folders.keys()) if (!keep.has(commit)) m.folders.delete(commit);
  pruneFolders(keep);
}

/** What the board shows about the pointer and the folder. */
type FactoryStatus = Pick<FactoryBoard, "factory" | "config">;

function factoryStatus(f: FactoryRuntime): FactoryStatus {
  const { s } = f;
  const pointer = f.pointer();
  if (!pointer) return { factory: null, config: null };
  const seen = lastSeen(s, pointer.node);
  const factory = {
    ...pointer,
    online: pointer.node === s.nodeId || s.now() - seen < 60_000,
    ...(seen > 0 && { lastSeenAt: seen }),
  };
  const state = readState(s, pointer);
  const folder = currentFolder(f);
  const error = [state.fetchError, state.error].filter(Boolean).join("; ") || undefined;
  if (folder)
    return {
      factory,
      config: {
        commit: folder.commit,
        name: folder.config.name,
        loadedAt: state.loadedAt ?? 0,
        ...(error && { error }),
      },
    };
  // Nothing good loaded yet: the commit that failed, if git got that far.
  if (error) return { factory, config: { commit: state.fetched ?? "", name: "", loadedAt: state.triedAt ?? 0, error } };
  return { factory, config: null };
}

/** An always-on machine is the natural host; otherwise this one. */
const defaultNode = (s: Store) => s.list("node").find((n) => n.alwaysOn)?.id ?? s.nodeId;

/** `agentgate factory use` and `PUT /api/factory`. On the factory machine, the folder is fetched before it returns. */
async function useFactory(f: FactoryRuntime, input: unknown) {
  const { s } = f;
  const parsed = factoryUseInputSchema.parse(input);
  requireFactoryProtocol(s);
  const node = parsed.node ?? defaultNode(s);
  if (!s.get("node", node)) throw new Error(`No machine is named ${node}; agentgate status lists them`);
  const pointer = {
    repo: parsed.repo,
    path: folderPath(parsed.path ?? ""),
    ...(parsed.ref && { ref: parsed.ref }),
    node,
  };
  patchSettings(s, { factory: pointer }, revision(s, "setting", "settings"));
  await sync(f, true);
  return factoryStatus(f);
}

/** `agentgate factory off` and `DELETE /api/factory`. */
function turnOff(f: FactoryRuntime) {
  const { s } = f;
  if (!f.pointer()) return factoryStatus(f);
  patchSettings(s, { factory: null }, revision(s, "setting", "settings"));
  s.setLocal(STATE_KEY, undefined);
  prune(f);
  f.events.emit({ kind: "factory.off", text: "The factory was turned off" });
  return factoryStatus(f);
}

/** `agentgate factory reload` and `POST /api/factory/reload`: fetch and check the folder now, even if the ref has not moved. */
async function reloadFactory(f: FactoryRuntime) {
  const pointer = f.pointer();
  if (!pointer) throw new Error("The factory is off; turn it on with agentgate factory use <owner/repo>");
  // The command reaches the factory machine through runCommand; a route answers for this machine only.
  if (!f.isFactoryNode()) throw new Error(`The factory runs on ${pointer.node}: reload it there`);
  await sync(f, true);
  return factoryStatus(f);
}

function describe({ factory, config }: FactoryStatus) {
  if (!factory) return ["The factory is off."];
  const path = factory.path ? `:${factory.path}` : "";
  const ref = factory.ref ? ` at ${factory.ref}` : "";
  const offline = factory.online ? "" : " (offline)";
  const lines = [`Factory folder ${factory.repo}${path}${ref}, run by ${factory.node}${offline}.`];
  if (config?.name) lines.push(`Loaded ${config.name} at ${short(config.commit)}.`);
  if (config?.error) lines.push(`Error: ${config.error}`);
  if (!config) lines.push("Not loaded on this machine yet.");
  return lines;
}

const print = (status: FactoryStatus, out: (line: string) => void) => {
  describe(status).forEach(out);
  return status.config?.error ? 1 : 0;
};

export function setup(f: FactoryRuntime): void {
  f.commands.set("use", {
    usage: "use <owner/repo>[:<path>] [--ref <branch|tag>] [--node <machine>]",
    local: true,
    run: async (args, io) => {
      const { values, positionals } = parseArgs({
        args,
        options: { ref: { type: "string" }, node: { type: "string" } },
        allowPositionals: true,
      });
      if (positionals.length !== 1) throw new Error("usage: agentgate factory use <owner/repo>[:<path>]");
      const [repo, ...path] = positionals[0]!.split(":");
      return print(await useFactory(f, { repo, path: path.join(":"), ...values }), io.out);
    },
  });
  f.commands.set("off", { usage: "off", local: true, run: async (_, io) => print(turnOff(f), io.out) });
  f.commands.set("reload", { usage: "reload", run: async (_, io) => print(await reloadFactory(f), io.out) });

  f.api.put("/", async (c) => {
    const body = await jsonInput(c.req.raw);
    return c.json(await asInput(() => useFactory(f, body)));
  });
  f.api.delete("/", async (c) => c.json(await asInput(() => turnOff(f))));
  f.api.post("/reload", async (c) => c.json(await asInput(() => reloadFactory(f))));

  f.loops.push({ name: "factory-folder", everyMs: 2 * 60_000, where: "factory-node", run: () => sync(f) });
  f.boardParts.push(async () => factoryStatus(f));
}
