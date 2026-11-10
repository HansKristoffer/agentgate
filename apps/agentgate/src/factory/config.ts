import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  factoryConfigSchema,
  factoryMoveInputSchema,
  type FactoryCheck,
  factoryUseInputSchema,
  movingLabel,
  scoutFileSchema,
  stageFileSchema,
  stageNames,
  type FactoryConfig,
  type FactoryMoveInput,
  type FactoryPointer,
  type FactoryStatus,
  type FactoryUseInput,
  type StageFile,
  type StageName,
} from "@agentgate/protocol";
import { getErrorMessage, safeJsonParse } from "hanzio";
import { z } from "zod";
import { PeerError } from "../handoff/jobs.ts";
import type { Store } from "../store.ts";
import { lastSeen } from "../sync.ts";
import { hasUnsentWrites, items } from "./db.ts";
import { fetcher, folderPath, NO_STORED_FOLDER, pruneFolders, storedFiles } from "./folder.ts";
import { folderStore, type FolderStore } from "./folder-store.ts";
import { branchProtected, defaultBranch, protectionAvailable } from "./gh.ts";
import {
  Backoff,
  FACTORY_PROTOCOL,
  noWords,
  operation,
  requireFactoryProtocol,
  toFactoryMachine,
  UsageError,
  type Caller,
  type FactoryRuntime,
} from "./runtime.ts";

/**
 * The factory's folder: where `agentgate factory use` points it, the loop that reads it when it changes (from git or
 * from agentgate, folder-store.ts), and the loader that checks it as a whole. A broken commit never replaces the
 * last good folder; items finish under the commit they started with (`folderAt`). And the pointer itself: which machine
 * runs the factory, and moving it to another (`moveFactory`).
 */

export interface LoadedFolder {
  commit: string;
  dir: string; // <agentgate home>/factory/<commit>
  config: FactoryConfig; // factory.yaml with defaults applied
  secrets: string[]; // the names factory.yaml uses as `secret:NAME`
  stages: Partial<Record<StageName, { file: StageFile; brief: string }>>;
  scouts: Record<string, { prompt: string }>; // scouts/<id>.md of each scout source
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

/** Every `secret:NAME` in the config. */
function secretRefs(value: unknown): { name: string }[] {
  if (typeof value === "string") return value.startsWith("secret:") ? [{ name: value.slice(7) }] : [];
  if (Array.isArray(value)) return value.flatMap((v) => secretRefs(v));
  if (value && typeof value === "object") return Object.values(value).flatMap((v) => secretRefs(v));
  return [];
}

/** Reads and checks the whole folder. Throws a FolderError naming the file and field. */
export function loadFolder(dir: string, commit: string): LoadedFolder {
  if (!existsSync(join(dir, "factory.yaml")))
    throw new FolderError("factory.yaml", "", "the folder has no factory.yaml");
  const raw = yaml("factory.yaml", readFileSync(join(dir, "factory.yaml"), "utf8"));
  const listed = (raw as { sources?: unknown }).sources;
  if (Array.isArray(listed)) {
    const at = listed.findIndex((x) => (x as { type?: unknown } | null)?.type === "scout");
    if (at >= 0)
      throw new FolderError("factory.yaml", `sources[${at}].type`, "a scout is set in scouts/<id>.md, not here");
  }
  const parsed = check(factoryConfigSchema, raw, "factory.yaml");
  const config: FactoryConfig = { ...parsed, sources: [...parsed.sources] };

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
  // The secrets are the `secret:NAME` values the file uses; nothing declares them again.
  const secrets = [...new Set(secretRefs(config).map((ref) => ref.name))];

  const scouts: LoadedFolder["scouts"] = {};
  for (const name of markdownFiles(join(dir, "scouts"))) {
    const file = `scouts/${name}.md`;
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name))
      throw new FolderError(file, "", "a scout's name is up to 40 lowercase letters, digits and dashes");
    const first = ids.get(name);
    if (first !== undefined) throw new FolderError(file, "", `${name} is also the id of sources[${first}]`);
    const { data, body } = markdown(dir, file);
    const settings = check(scoutFileSchema, data, file);
    const repo = repos.get(settings.repo.toLowerCase());
    if (!repo) throw new FolderError(file, "repo", `${settings.repo} is not under repositories in factory.yaml`);
    const { schedule } = settings;
    if ("every" in schedule && durationMs(schedule.every) < MIN_SCOUT_EVERY)
      throw new FolderError(file, "schedule.every", "a scout runs at most once an hour");
    if ("timezone" in schedule && !knownTimezone(schedule.timezone))
      throw new FolderError(file, "schedule.timezone", `${schedule.timezone} is not a timezone`);
    if (!body) throw new FolderError(file, "", "the prompt is empty");
    config.sources.push({ ...settings, id: name, type: "scout", repo });
    scouts[name] = { prompt: body };
  }

  const stages: LoadedFolder["stages"] = {};
  for (const name of markdownFiles(join(dir, "stages"))) {
    const file = `stages/${name}.md`;
    const stage = stageNames.find((s) => s === name);
    if (!stage) throw new FolderError(file, "", `not a stage; the stages are ${stageNames.join(", ")}`);
    const { data, body } = markdown(dir, file);
    stages[stage] = { file: check(stageFileSchema, data, file), brief: body };
  }

  // HTML comments are notes for the person editing the file, such as the prompts `factory init` writes; briefs skip them.
  const rulings = existsSync(join(dir, "rulings.md"))
    ? readFileSync(join(dir, "rulings.md"), "utf8")
        .replace(/<!--[\s\S]*?-->\n?/g, "")
        .trim()
    : "";
  const skills = join(dir, "skills");
  const skillsDir = existsSync(skills) && statSync(skills).isDirectory() ? skills : undefined;
  return { commit, dir, config, secrets, stages, scouts, rulings, ...(skillsDir && { skillsDir }) };
}

// What the factory machine knows about its folder, kept across restarts. `fetched` is the newest commit tried,
// `commit` the last good one; they differ while the newest is broken.
const STATE_KEY = "factoryFolder";
interface FolderState {
  source: string; // the pointer the state belongs to
  fetched?: string;
  commit?: string;
  tree?: string; // the folder's git tree at `commit`: a newer commit with the same tree changes nothing
  loadedAt?: number;
  triedAt?: number;
  error?: string; // why `fetched` did not load
  fetchError?: string; // why the last fetch failed
}
function readState(f: FactoryRuntime, pointer: FactoryPointer): FolderState {
  const source = folderStore(f, pointer).key;
  const state = safeJsonParse<FolderState>(f.s.local(STATE_KEY) ?? "{}").data;
  return state?.source === source ? state : { source };
}

/** Whether the factory runs on the stored folder, which then loads each change at once and cannot be deleted. */
export const runsOnStoredFolder = (f: FactoryRuntime) => f.pointer()?.store === "agentgate";

interface Memory {
  folders: Map<string, LoadedFolder>; // by commit
  queue: Promise<void>; // one fetch at a time
  /** A fetch that failed is tried again after 2 minutes, doubling up to an hour, like the skill sync. */
  fetches: Backoff;
}
const memory = (f: FactoryRuntime) =>
  f.memory("folders", (): Memory => ({
    folders: new Map(),
    queue: Promise.resolve(),
    fetches: new Backoff(f.s, { baseMs: 2 * 60_000, maxMs: 3600_000 }),
  }));
const FETCH = "fetch";

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
  const commit = pointer && readState(f, pointer).commit;
  return commit ? folderAt(f, commit) : undefined;
}

/** The folder an item or run started under, or the current one once that commit's folder is gone. */
export const folderFor = (f: FactoryRuntime, commit: string) => folderAt(f, commit) ?? currentFolder(f);

export const DEFAULT_LIMITS = factoryConfigSchema.shape.limits.parse(undefined);

const MIN_SCOUT_EVERY = 3600_000;
const knownTimezone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

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
  if (!force && !m.fetches.due(FETCH)) return;

  const folder = folderStore(f, pointer);
  const state = readState(f, pointer);
  const save = (next: FolderState) => {
    // The pointer may have moved while git ran; that state belongs to the old one.
    const now = f.pointer();
    if (now && folderStore(f, now).key === state.source) s.setLocal(STATE_KEY, JSON.stringify(next));
  };

  // Without the last good folder on disk, fetch whatever the ref points at now.
  const since = force || (state.fetched === state.commit && !currentFolder(f)) ? undefined : state.fetched;
  let fetched: Awaited<ReturnType<FolderStore["read"]>>;
  try {
    const tree = currentFolder(f) ? state.tree : undefined;
    fetched = await folder.read({ since, signal: f.ctx.abort.signal, ...(tree && { tree }) });
  } catch (e) {
    const error = getErrorMessage(e);
    m.fetches.failed(FETCH);
    if (state.fetchError !== error) {
      console.error(`factory: ${error}`);
      events.emit({ kind: "config", error, text: `Fetching the factory folder failed: ${error}` });
    }
    save({ ...state, fetchError: error });
    return;
  }

  if (m.fetches.ok(FETCH)) console.log(`factory: fetching ${folder.label} works again`);
  if (!fetched) {
    if (state.fetchError) save({ ...state, fetchError: undefined });
  } else if (!fetched.dir) {
    // The folder did not change: the loaded one stays, with its commit and events.
    save({ ...state, fetched: fetched.commit, error: undefined, fetchError: undefined });
  } else {
    try {
      const loaded = loadFolder(fetched.dir, fetched.commit);
      m.folders.set(loaded.commit, loaded);
      save({
        source: state.source,
        fetched: loaded.commit,
        commit: loaded.commit,
        ...(fetched.tree && { tree: fetched.tree }),
        loadedAt: s.now(),
      });
      events.emit({
        kind: "config",
        commit: loaded.commit,
        text: `Loaded ${loaded.config.name} at ${short(loaded.commit)}`,
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
  const current = pointer && readState(f, pointer).commit;
  if (current) keep.add(current);
  const m = memory(f);
  for (const commit of m.folders.keys()) if (!keep.has(commit)) m.folders.delete(commit);
  pruneFolders(keep);
}

const openItems = (f: FactoryRuntime) => items.list(f.s, { open: true }).length;

function factoryStatus(f: FactoryRuntime): FactoryStatus {
  const { s } = f;
  const pointer = f.pointer();
  if (!pointer) return { factory: null, config: null };
  const seen = lastSeen(s, pointer.node);
  const { moveTo, ...rest } = pointer;
  const factory = {
    ...rest,
    label: folderStore(f, pointer).label,
    online: pointer.node === s.nodeId || s.now() - seen < 60_000,
    ...(seen > 0 && { lastSeenAt: seen }),
    // Only the factory machine knows how many of its items are open.
    ...(moveTo && { moving: { to: moveTo, ...(f.isFactoryNode() && { open: openItems(f) }) } }),
  };
  const state = readState(f, pointer);
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
        repositories: Object.keys(folder.config.repositories),
      },
    };
  // Nothing good loaded yet: the commit that failed, if git got that far.
  if (error) return { factory, config: { commit: state.fetched ?? "", name: "", loadedAt: state.triedAt ?? 0, error } };
  return { factory, config: null };
}

/** An always-on machine is the natural host; otherwise this one. */
export const defaultNode = (s: Store) => s.list("node").find((n) => n.alwaysOn)?.id ?? s.nodeId;

/** The pointer is written only here: `use`, `move` and `off`. The generic settings patch has no `factory`, so nothing
 * else can drop `moveTo`, or skip the protocol check. */
function setPointer(s: Store, pointer: FactoryPointer | undefined) {
  s.transaction(() => {
    const { factory: _, ...rest } = s.settings();
    s.put("setting", "settings", pointer ? { ...rest, factory: pointer } : rest);
  });
}

/** The `use` operation. On the factory machine, the folder is fetched before it returns. */
export async function useFactory(f: FactoryRuntime, parsed: FactoryUseInput) {
  const { s } = f;
  requireFactoryProtocol(s);
  // Another folder is no reason to change machines, which would freeze the open items of the one it runs on, nor to
  // forget a move that waits.
  const current = f.pointer();
  const node = parsed.node ?? current?.node ?? defaultNode(s);
  const moveTo = node === current?.node ? current.moveTo : undefined;
  if (!s.get("node", node)) throw new Error(`No machine is named ${node}; agentgate status lists them`);
  if (parsed.store === "agentgate") {
    if (!storedFiles(s)) throw new Error(NO_STORED_FOLDER);
    setPointer(s, { store: "agentgate", node, ...(moveTo && { moveTo }) });
    await sync(f, true);
    return factoryStatus(f);
  }
  const pointer = {
    store: "github" as const,
    repo: parsed.repo,
    path: folderPath(parsed.path ?? ""),
    ...(parsed.ref && { ref: parsed.ref }),
    node,
    ...(moveTo && { moveTo }),
  };
  setPointer(s, pointer);
  await sync(f, true);
  return { ...factoryStatus(f), ...(await protectionWarning(pointer)) };
}

/** Loads the stored folder now on the factory machine, after a change to it; other machines load it within the folder
 * loop's 2 minutes. */
export async function storedChanged(f: FactoryRuntime) {
  if (runsOnStoredFolder(f) && f.isFactoryNode()) await sync(f, true);
}

/** The pointer that `node` can take, and apart from it the machine a move already waits for. */
function movable(f: FactoryRuntime, node: string) {
  const { s } = f;
  const current = f.pointer();
  if (!current) throw new Error("The factory is off; turn it on with agentgate factory use <owner/repo>");
  if (!s.get("node", node)) throw new Error(`No machine is named ${node}; agentgate status lists them`);
  requireFactoryProtocol(s);
  const { moveTo, ...pointer } = current;
  return { pointer, moveTo };
}

/** Whether the factory can leave this machine: no item is open, and the outbox has sent what it owed. No other machine
 * can send those comments, and an issue whose `closed` comment never arrived looks open to the next machine's intake. */
const drained = (f: FactoryRuntime) => !openItems(f) && !hasUnsentWrites(f.s);

/**
 * The factory machine's part of `move`: the same folder on another machine, keeping its ref. Only the factory machine
 * drives items, so it finishes the open ones first: the pointer records where the factory goes (`moveTo`), intake
 * takes nothing new, and `finishMove` moves the pointer once the machine is drained. Drained already, it moves at once,
 * and naming the machine that already runs it cancels a move it waits for.
 */
function startMove(f: FactoryRuntime, node: string) {
  const { s } = f;
  const { pointer, moveTo } = movable(f, node);
  if (node === pointer.node) {
    if (moveTo) {
      setPointer(s, pointer);
      f.events.emit({ kind: "note", text: `The factory's move to ${moveTo} was cancelled` });
    }
  } else if (drained(f)) {
    setPointer(s, { ...pointer, node });
  } else if (node !== moveTo) {
    setPointer(s, { ...pointer, moveTo: node });
    const text = `${movingLabel({ to: node, open: openItems(f) })}; nothing new is taken in until then`;
    f.events.emit({ kind: "note", text });
  }
  return factoryStatus(f);
}

/** The move loop: the machine is drained, so the factory goes where `move` said. */
function finishMove(f: FactoryRuntime) {
  const pointer = f.pointer();
  if (!pointer?.moveTo || !drained(f)) return;
  const { moveTo, ...rest } = pointer;
  setPointer(f.s, { ...rest, node: moveTo });
  f.events.emit({ kind: "note", text: `The last open item finished, so the factory moved to ${moveTo}` });
}

/**
 * The `move` operation, which runs where it is asked. Without `now` the factory machine decides (`startMove`), since
 * only it knows what it has open: another machine sends it the same operation. With `now` the pointer moves at once,
 * from any machine, for when the factory machine is gone or its items are not worth the wait: they stay frozen in its
 * tables.
 */
async function moveFactory(f: FactoryRuntime, { node, now }: FactoryMoveInput, caller: Caller): Promise<FactoryStatus> {
  // Checked here first, so a mistyped machine is refused the same way whichever machine is asked.
  const { pointer } = movable(f, node);
  if (now) {
    setPointer(f.s, { ...pointer, node });
    // On the machine it moved to, the folder loads before this answers.
    await sync(f, true);
    return factoryStatus(f);
  }
  try {
    const forward = toFactoryMachine(f);
    return forward ? ((await forward({ name: "move", input: { node }, caller })) as FactoryStatus) : startMove(f, node);
  } catch (e) {
    // The factory machine's own answer, or this machine's when it runs the factory.
    if (e instanceof PeerError || f.isFactoryNode()) throw e;
    throw new Error(
      `${getErrorMessage(e)}; agentgate factory move ${node} --now moves it without waiting for that machine`,
    );
  }
}

/** Any thread that can push to the folder's branch changes the briefs of every later run, and GitHub can refuse such
 * pushes where the plan allows it (free private repositories cannot). So `use` says once when the branch is open and
 * could be protected; a warning the person cannot act on is noise. A tag, or a GitHub that cannot be asked, says
 * nothing. */
async function protectionWarning(pointer: { repo: string; ref?: string }) {
  try {
    const branch = pointer.ref ?? (await defaultBranch(pointer.repo));
    if (await branchProtected(pointer.repo, branch)) return {};
    if (!(await protectionAvailable(pointer.repo, branch))) return {};
    return {
      warning: `${branch} of ${pointer.repo} is not protected, so a factory thread that pushes there changes every later brief. Protect it on GitHub.`,
    };
  } catch {
    return {};
  }
}

/** The `off` operation. */
function turnOff(f: FactoryRuntime) {
  const { s } = f;
  if (!f.pointer()) return factoryStatus(f);
  setPointer(s, undefined);
  s.setLocal(STATE_KEY, undefined);
  prune(f);
  f.events.emit({ kind: "factory.off", text: "The factory was turned off" });
  return factoryStatus(f);
}

/** The `reload` operation, on the factory machine: fetch and check the folder now, even if the ref has not moved. */
async function reloadFactory(f: FactoryRuntime) {
  const pointer = f.pointer();
  if (!pointer) throw new Error("The factory is off; turn it on with agentgate factory use <owner/repo>");
  if (!f.isFactoryNode()) throw new Error(`The factory runs on ${pointer.node}: reload it there`);
  await sync(f, true);
  return factoryStatus(f);
}

function describe({ factory, config, warning }: FactoryStatus & { warning?: string }) {
  if (!factory) return ["The factory is off."];
  const offline = factory.online ? "" : " (offline)";
  const lines = [`Factory folder ${factory.label}, run by ${factory.node}${offline}.`];
  if (factory.moving)
    lines.push(
      `${movingLabel(factory.moving)}; nothing new is taken in until then. agentgate factory move ${factory.moving.to} --now does not wait, and leaves the open items frozen on ${factory.node}; agentgate factory move ${factory.node} cancels.`,
    );
  if (config?.name) lines.push(`Loaded ${config.name} at ${short(config.commit)}.`);
  if (config?.error) lines.push(`Error: ${config.error}`);
  if (!config) lines.push("Not loaded on this machine yet.");
  if (warning) lines.push(`Warning: ${warning}`);
  return lines;
}

/** The status as the terminal prints it; a folder that did not load is a failure. */
const printed = (status: FactoryStatus & { warning?: string }) => ({
  lines: describe(status),
  code: status.config?.error ? 1 : 0,
});

/** The preflight's checks of the pointer: every paired machine can sync it, and the folder it names loads. */
function folderChecks(f: FactoryRuntime): FactoryCheck[] {
  const old = f.s
    .list("node")
    .filter((n) => (n.protocol ?? 0) < FACTORY_PROTOCOL)
    .map((n) => n.id);
  const checks: FactoryCheck[] = [
    {
      id: "releases",
      title: "Every paired machine runs a release that knows the factory",
      state: old.length ? "fail" : "ok",
      ...(old.length && {
        detail: `${old.join(", ")} cannot sync the factory's settings, secrets or stored folder`,
        fix: `update agentgate on ${old.join(", ")}`,
      }),
    },
  ];
  const pointer = f.pointer();
  if (!pointer) return checks;
  const { config } = factoryStatus(f);
  const where = runsOnStoredFolder(f) ? "with agentgate factory folder put" : `in ${folderStore(f, pointer).label}`;
  const fix = `fix the file the error names ${where}, then agentgate factory reload`;
  const folder = { id: "folder", title: "The factory's folder loads" };
  checks.push(
    !config
      ? { ...folder, state: "unknown", detail: "not loaded on this machine yet", fix: "agentgate factory reload" }
      : config.error
        ? { ...folder, state: "fail", detail: config.error, fix }
        : { ...folder, state: "ok", detail: `${config.name} at ${short(config.commit)}` },
  );
  return checks;
}

export function setup(f: FactoryRuntime): void {
  f.checks.push({ name: "Folder", run: () => folderChecks(f) });
  operation(f, {
    name: "use",
    summary: "turn the factory on at a folder that exists, or change its folder",
    input: factoryUseInputSchema,
    local: true,
    run: (input) => useFactory(f, input),
    terminal: {
      usage:
        "use <owner/repo>[:<path>] [--ref <branch|tag>] [--node <machine>] | use --store agentgate [--node <machine>]",
      parse(args) {
        const { values, positionals } = parseArgs({
          args,
          options: { ref: { type: "string" }, node: { type: "string" }, store: { type: "string" } },
          allowPositionals: true,
        });
        const { store, ...rest } = values;
        if (store === "agentgate") {
          if (positionals.length || rest.ref) throw new UsageError();
          return { input: { store, ...(rest.node && { node: rest.node }) } };
        }
        if (store !== undefined && store !== "github") throw new Error("--store is github or agentgate");
        if (positionals.length !== 1) throw new UsageError();
        const [repo, ...path] = positionals[0]!.split(":");
        return { input: { repo, path: path.join(":"), ...rest } };
      },
      print: printed,
    },
  });
  operation(f, {
    name: "move",
    summary: "run it on another machine once its open items finish; --now does not wait, and leaves them frozen",
    input: factoryMoveInputSchema,
    local: true,
    run: (input, caller) => moveFactory(f, input, caller),
    terminal: {
      usage: "move <machine> [--now]",
      parse(args) {
        const { values, positionals } = parseArgs({
          args,
          options: { now: { type: "boolean" } },
          allowPositionals: true,
        });
        if (positionals.length !== 1) throw new UsageError();
        return { input: { node: positionals[0], ...(values.now && { now: true }) } };
      },
      print: printed,
    },
  });
  operation(f, {
    name: "off",
    summary: "turn the factory off on every machine",
    input: z.object({}),
    local: true,
    run: () => turnOff(f),
    terminal: { usage: "off", parse: noWords, print: printed },
  });
  operation(f, {
    name: "reload",
    summary: "fetch and check the folder now",
    input: z.object({}),
    run: () => reloadFactory(f),
    terminal: { usage: "reload", parse: noWords, print: printed },
  });

  f.loops.push({ name: "factory-folder", everyMs: 2 * 60_000, where: "factory-node", run: () => sync(f) });
  f.loops.push({ name: "factory-move", everyMs: 30_000, where: "factory-node", run: async () => finishMove(f) });
  f.boardParts.push(async () => factoryStatus(f));
}
