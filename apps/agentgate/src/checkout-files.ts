import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { projectIdSchema, projectSchema, safePath, type CheckoutFile } from "@agentgate/protocol";
import { RELAY_LIMITS } from "@agentgate/protocol/relay";
import { z } from "zod";
import { canonicalProject } from "./mcp/gateway.ts";
import { CONFIG_DIR, DEV, type Store } from "./store.ts";

/** Checkout files (docs/internals/checkout-files.md): buncargo's per-machine file store of a repository's gitignored
 * files, carried between machines on the synced `project` record. Buncargo owns what happens inside a checkout; this
 * module owns the store's format on disk, its sync, and filling checkouts of repositories without buncargo. */

/** A checkout's dev daemon keeps its own store: buncargo runs with this as HOME, so it finds the same one. */
export const FILES_HOME = DEV ? join(CONFIG_DIR, "home") : homedir();
export const FILES_ROOT = join(FILES_HOME, ".buncargo", "files");
/** The node protocol that keeps `files` and `fileList` on project records (see NODE_PROTOCOL in remote.ts). */
export const FILES_PROTOCOL = 6;
const KEY = /^[a-z0-9.-]+(\/[a-z0-9._-]+)+$/;
const LOCK_STALE = 30_000;

const sha256 = (data: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(data).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();

/** The store key of a remote URL: `host/path`, lowercase, without user, port or `.git`; undefined when it is not one. */
export function repoKey(url: string): string | undefined {
  url = url.trim();
  const m = url.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/]*@)?([^/:]+)(?::\d*)?\/(.*)$/i) ?? (!url.includes("://") ? url.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/) : null);
  if (!m) return undefined;
  const key = `${m[1]}/${m[2]}`.replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
  return KEY.test(key) ? key : undefined;
}

/** The key of a checkout without a usable origin. Such a store belongs to this machine and never syncs. */
export const localKey = (commonDir: string) => `local/${sha256(realpathSync(commonDir)).slice(0, 16)}`;

/** The store key of the repository `cwd` is in. */
export async function checkoutKey(cwd: string): Promise<string> {
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? out.trim() : "";
  };
  return repoKey(await git("remote", "get-url", "origin")) ?? localKey(await git("rev-parse", "--path-format=absolute", "--git-common-dir"));
}

/** Projects are GitHub `owner/repo`; only github.com stores sync. */
// ponytail: other hosts stay on their machine; carry the host on the project when a non-GitHub repo needs it.
export function projectForKey(s: Store, key: string): string | undefined {
  const m = key.match(/^github\.com\/([^/]+\/[^/]+)$/);
  return m && projectIdSchema.safeParse(m[1]).success ? canonicalProject(s, m[1]!) : undefined;
}
export const keyForProject = (id: string) => { const key = `github.com/${id.toLowerCase()}`; return KEY.test(key) ? key : undefined; };

// ---------------------------------------------------------------- the store on disk (buncargo's format)

const entrySchema = z.object({ sha256: z.string(), updatedAt: z.string(), machine: z.boolean().default(false) }).passthrough();
const manifestSchema = z.object({ version: z.number(), files: z.record(z.string(), z.unknown()).default({}) }).passthrough();
type Entry = z.infer<typeof entrySchema>;
export interface StoreFile { sha256: string; updatedAt: string; machine: boolean; data?: Buffer }
/** `pending`: a data file does not match its entry yet (a write in progress); read again shortly. */
export type StoreRead = { state: "ok" | "missing" | "pending"; files: Map<string, StoreFile> } | { state: "unsupported"; files: Map<string, StoreFile> };

/** The store's files as its manifest has them, with the data of every file that may leave this machine. */
export function readStore(dir: string): StoreRead {
  const files = new Map<string, StoreFile>();
  let raw: string;
  try { raw = readFileSync(join(dir, "manifest.json"), "utf8"); } catch { return { state: "missing", files }; }
  let manifest: z.infer<typeof manifestSchema>;
  try { manifest = manifestSchema.parse(JSON.parse(raw)); } catch { return { state: "pending", files }; }
  if (manifest.version !== 1) return { state: "unsupported", files };
  let pending = false;
  for (const [path, value] of Object.entries(manifest.files)) {
    const entry = entrySchema.safeParse(value);
    if (!entry.success || !safePath(path)) continue;
    const file: StoreFile = { sha256: entry.data.sha256, updatedAt: entry.data.updatedAt, machine: entry.data.machine };
    if (!file.machine) {
      try { file.data = readFileSync(join(dir, "data", path)); } catch { }
      if (!file.data || sha256(file.data) !== file.sha256) { pending = true; continue; }
    }
    files.set(path, file);
  }
  return { state: pending ? "pending" : "ok", files };
}

export class StoreBusy extends Error { }

/** `mkdir <dir>/.lock` with an owner file; a lock whose process is gone or that is older than 30 seconds is stale. */
export function lockStore(dir: string, now = Date.now()): () => void {
  const lock = join(dir, ".lock");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0 || !stale(lock, now)) throw new StoreBusy(`the file store in ${dir} is busy`);
      rmSync(lock, { recursive: true, force: true });
    }
  }
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), createdAt: iso(now) }), { mode: 0o600 });
  return () => rmSync(lock, { recursive: true, force: true });
}

function stale(lock: string, now: number) {
  let owner: { pid?: number; host?: string; createdAt?: string };
  try { owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")); } catch {
    // Created but not yet written, or abandoned in between.
    return now - (lstatSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0) > LOCK_STALE;
  }
  if (!(now - Date.parse(owner.createdAt ?? "") <= LOCK_STALE)) return true;
  if (owner.host !== hostname() || typeof owner.pid !== "number") return false;
  try { process.kill(owner.pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
}

function replace(file: string, data: Uint8Array | string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temp, file); } catch (e) { rmSync(temp, { force: true }); throw e; }
}

/** Write and remove files under the lock: data first, then the manifest, then removed data files. Other entries, machine
 * ones included, stay as they are. */
export function writeStore(dir: string, put: { path: string; data: Buffer; updatedAt: string }[], remove: string[], now = Date.now()) {
  const release = lockStore(dir, now);
  try {
    let manifest: z.infer<typeof manifestSchema> = { version: 1, files: {} };
    try { manifest = manifestSchema.parse(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (manifest.version !== 1) throw new Error(`the file store in ${dir} has a newer format; update agentgate`);
    for (const f of put) {
      if (!safePath(f.path)) throw new Error(`unsafe checkout file path ${f.path}`);
      replace(join(dir, "data", f.path), f.data);
      manifest.files[f.path] = { sha256: sha256(f.data), updatedAt: f.updatedAt, machine: false } satisfies Entry;
    }
    for (const path of remove) delete manifest.files[path];
    replace(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    for (const path of remove) if (safePath(path)) rmSync(join(dir, "data", path), { force: true });
  } finally { release(); }
}

// ---------------------------------------------------------------- merging the store with the record

const time = (f: CheckoutFile) => Date.parse(f.updatedAt);
const digest = (f: CheckoutFile) => f.deleted ? "" : sha256(Buffer.from(f.data ?? "", "base64"));

/** Per file, the newer by `updatedAt`. A file missing on one side is unknown there, not deleted: deletions are entries. */
export function mergeFiles(a: CheckoutFile[], b: CheckoutFile[]): CheckoutFile[] {
  const out = new Map(a.map((f) => [f.path, f]));
  for (const f of b) {
    const mine = out.get(f.path);
    if (!mine || time(f) > time(mine) || (time(f) === time(mine) && digest(f) > digest(mine))) out.set(f.path, f);
  }
  return [...out.values()].sort((x, y) => x.path < y.path ? -1 : x.path > y.path ? 1 : 0);
}

const normal = (fs: CheckoutFile[]) => JSON.stringify(mergeFiles([], fs).map(({ path, updatedAt, data, deleted }) => ({ path, updatedAt, data, deleted })));

/** Whether a project record still fits one relay entry (1 MiB sealed), where the files make it largest. */
function fitsRelay(s: Store, project: z.input<typeof projectSchema>) {
  const record = { kind: "project", id: project.id, rev: Number.MAX_SAFE_INTEGER, node: s.nodeId, updated_at: Number.MAX_SAFE_INTEGER, deleted: 0, data: JSON.stringify(project) };
  return Buffer.byteLength(JSON.stringify({ protocol: 999, record })) + 28 <= RELAY_LIMITS.blobBytes;
}

/** Nodes whose daemon would drop `files` and `fileList` when it saves a project. */
export const oldNodes = (s: Store) => s.list("node").filter((n) => (n.protocol ?? 0) < FILES_PROTOCOL).map((n) => n.id);

const errorsKey = "checkoutFiles:errors";
export function filesErrors(s: Store): Record<string, string> {
  try { return JSON.parse(s.local(errorsKey) ?? "{}"); } catch { return {}; }
}
function report(s: Store, project: string, message: string | undefined) {
  const errors = filesErrors(s);
  if (errors[project] === message) return;
  if (message) { errors[project] = message; console.error(`checkout files: ${project}: ${message}`); } else delete errors[project];
  s.setLocal(errorsKey, Object.keys(errors).length ? JSON.stringify(errors) : undefined);
}

/** What this node last made the store and the record agree on, without data: a file in it that left the store was
 * deleted here. Node-local. */
const baseKey = (project: string) => `checkoutFiles:base:${project.toLowerCase()}`;
const createdKey = "checkoutFiles:checkouts";

/** Bring one repository's store and record together. Returns whether the store changed. Throws StoreBusy to retry. */
export function reconcile(s: Store, root: string, key: string): boolean {
  const project = projectForKey(s, key);
  if (!project) return false;
  const dir = join(root, key);
  const store = readStore(dir);
  if (store.state === "unsupported") {
    report(s, project, `the file store in ${dir} has a newer format; it is left alone until agentgate is updated`);
    return false;
  }
  if (store.state === "pending") throw new StoreBusy(`the file store in ${dir} is being written`);
  const record = s.get("project", project);
  const remote = record?.files ?? [];
  let base: CheckoutFile[] = [];
  try { base = JSON.parse(s.local(baseKey(project)) ?? "[]"); } catch { }

  const local: CheckoutFile[] = [];
  for (const [path, f] of store.files) if (!f.machine) local.push({ path, updatedAt: f.updatedAt, data: f.data!.toString("base64") });
  for (const b of base) if (!store.files.has(b.path)) local.push(b.deleted ? b : { path: b.path, updatedAt: iso(s.now()), deleted: true });
  const merged = mergeFiles(local, remote);

  const put = merged.filter((f) => {
    const mine = store.files.get(f.path);
    return !f.deleted && !mine?.machine && mine?.sha256 !== digest(f);
  });
  const remove = merged.filter((f) => f.deleted && store.files.get(f.path)?.machine === false).map((f) => f.path);
  if (put.length || remove.length) writeStore(dir, put.map((f) => ({ path: f.path, data: Buffer.from(f.data!, "base64"), updatedAt: f.updatedAt })), remove, s.now());
  s.setLocal(baseKey(project), JSON.stringify(merged.map(({ data: _, ...f }) => f)));

  let error: string | undefined;
  if (merged.length && normal(merged) !== normal(remote)) {
    const next = { ...(record ?? projectSchema.parse({ id: project })), files: merged };
    const old = oldNodes(s);
    if (old.length) error = `Update agentgate on ${old.join(", ")} first: older versions drop checkout files when they save a project`;
    else if (!fitsRelay(s, next)) error = "the files are larger than one synced record can carry (about 700 KiB in all); they stay on this machine";
    else s.put("project", project, next);
  }
  report(s, project, error);
  return put.length > 0 || remove.length > 0;
}

/** Keys of every store under `root` that can sync. */
function storeKeys(root: string): string[] {
  const keys: string[] = [];
  const dirs = (path: string) => { try { return readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };
  for (const owner of dirs(join(root, "github.com"))) for (const repo of dirs(join(root, "github.com", owner))) {
    const key = `github.com/${owner}/${repo}`;
    if (KEY.test(key) && existsSync(join(root, key, "manifest.json"))) keys.push(key);
  }
  return keys;
}

/** Keeps every store under the root in step with its project record, and fills the checkouts agentgate created when
 * their store changes. No configuration: a store appearing is enough. Changes are picked up from file events, and a
 * periodic pass repairs what events miss. */
export class CheckoutFiles {
  private watcher?: FSWatcher;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private closed = false;

  /** `root` null turns the store off (in-memory stores, tests). */
  constructor(private s: Store, readonly root: string | null = FILES_ROOT, private io: { watch?: typeof watch } = {}) { }

  soon() {
    if (this.closed || !this.root) return;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [100, 1000, 5000].map((ms) => { const t = setTimeout(() => this.sync(), ms); t.unref?.(); return t; });
  }

  sync() {
    const root = this.root;
    if (this.closed || !root) return;
    this.watch(root);
    const keys = new Set(storeKeys(root));
    for (const p of this.s.list("project")) if (p.files?.length) { const key = keyForProject(p.id); if (key) keys.add(key); }
    for (const key of keys) {
      try {
        if (reconcile(this.s, root, key)) this.fill(key);
      } catch (e) {
        // A busy store is retried by the event that ends the write, or the next pass.
        if (!(e instanceof StoreBusy)) console.error(`checkout files: ${key}: ${(e as Error).message}`);
      }
    }
  }

  private fill(key: string) {
    const all = createdCheckouts(this.s);
    for (const [path, k] of Object.entries(all)) {
      if (!existsSync(path)) { delete all[path]; this.s.setLocal(createdKey, JSON.stringify(all)); continue; }
      if (k === key) void fillCheckout(this.root!, path, key).catch((e) => console.error(`checkout files: ${path}: ${(e as Error).message}`));
    }
  }

  private watch(root: string) {
    if (this.watcher || !existsSync(root)) return;
    try {
      // ponytail: recursive watching where the platform has it; elsewhere the 30-second pass picks changes up.
      const watcher = (this.io.watch ?? watch)(root, { recursive: true }, () => this.soon());
      watcher.on("error", () => { watcher.close(); if (this.watcher === watcher) this.watcher = undefined; });
      this.watcher = watcher;
    } catch { }
  }

  close() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.watcher?.close();
  }
}

function createdCheckouts(s: Store): Record<string, string> {
  try { return JSON.parse(s.local(createdKey) ?? "{}"); } catch { return {}; }
}
/** Remember a checkout agentgate made, so later store updates reach it too. */
export const rememberCheckout = (s: Store, path: string, key: string) => s.setLocal(createdKey, JSON.stringify({ ...createdCheckouts(s), [path]: key }));

// ---------------------------------------------------------------- inside a checkout

/** A checkout that uses buncargo: `dev.config.ts` and buncargo installed. Buncargo then owns its checkout files. */
export const usesBuncargo = (cwd: string) => existsSync(join(cwd, "dev.config.ts")) && existsSync(join(cwd, "node_modules", "buncargo"));

/** `bunx buncargo …` in a checkout, with the HOME whose store `root` is. Never reports output: it may hold values. */
export async function buncargo(root: string, cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["bunx", "buncargo", ...args], {
    cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore",
    env: { ...process.env, HOME: dirname(dirname(root)) },
  });
  const timer = setTimeout(() => child.kill(), 120_000);
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`buncargo ${args.slice(0, 2).join(" ")} failed (exit ${code})`);
  return out;
}

/** The store's files into a checkout: buncargo's pull where the checkout uses it, else each missing file, never
 * overwriting one. */
export async function fillCheckout(root: string, cwd: string, key: string) {
  if (usesBuncargo(cwd)) return void await buncargo(root, cwd, ["files", "pull"]);
  const store = readStore(join(root, key));
  for (const [path, f] of store.files) {
    if (f.machine || !f.data || lstatSync(join(cwd, path), { throwIfNoEntry: false })) continue;
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), f.data, { mode: 0o600, flag: "wx" });
  }
}

const statusSchema = z.object({
  version: z.literal(1),
  files: z.array(z.object({ path: z.string(), state: z.string(), machine: z.boolean().default(false) }).passthrough()),
}).passthrough();

/** A regular file's bytes, or undefined. */
export function regularFile(path: string): Buffer | undefined {
  return lstatSync(path, { throwIfNoEntry: false })?.isFile() ? readFileSync(path) : undefined;
}

/** The checkout files that differ from the store in `cwd`, which a handoff carries: buncargo's local edits and
 * conflicts, or, without buncargo, the listed files that differ from the store. Never a machine file. */
export async function localEdits(root: string, cwd: string, listed: string[]): Promise<string[]> {
  if (usesBuncargo(cwd)) {
    const out = await buncargo(root, cwd, ["files", "status", "--json"]);
    let status: z.infer<typeof statusSchema>;
    // Parse errors can quote the output, which may hold values.
    try { status = statusSchema.parse(JSON.parse(out)); } catch { throw new Error("buncargo files status answered in a format agentgate does not know"); }
    return status.files.filter((f) => !f.machine && (f.state === "local-edits" || f.state === "conflict") && safePath(f.path) && regularFile(join(cwd, f.path))).map((f) => f.path);
  }
  const store = readStore(join(root, await checkoutKey(cwd)));
  return listed.filter((path) => {
    const data = safePath(path) ? regularFile(join(cwd, path)) : undefined;
    const entry = store.files.get(path);
    return data && !entry?.machine && entry?.sha256 !== sha256(data);
  });
}

/** Write a handed-off checkout file unless the checkout has its own edits to it (different from both the arriving copy
 * and the store's). Returns false when it kept the checkout's own. */
export function placeEdit(root: string | undefined, key: string, cwd: string, path: string, data: Buffer): boolean {
  const target = join(cwd, path);
  const st = lstatSync(target, { throwIfNoEntry: false });
  if (st && !st.isFile()) return false;
  if (st) {
    const current = readFileSync(target);
    if (current.equals(data)) return true;
    if (!root || readStore(join(root, key)).files.get(path)?.sha256 !== sha256(current)) return false;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data, { mode: 0o600 });
  return true;
}

// ---------------------------------------------------------------- `agentgate project files`

/** The project of a checkout, for `project files`. */
async function checkoutProject(s: Store, cwd: string) {
  const key = await checkoutKey(cwd);
  const project = projectForKey(s, key);
  if (!project) throw new Error("this repository's origin is not on github.com, so its files cannot sync");
  return { key, project };
}

/** Save files from a checkout into the store (now, as a deliberate save) and keep them on the project's file list. */
export async function addFiles(s: Store, root: string, top: string, paths: string[]) {
  const { key, project } = await checkoutProject(s, top);
  const old = oldNodes(s);
  if (old.length) throw new Error(`Update agentgate on ${old.join(", ")} first: older versions drop checkout files when they save a project`);
  const put = paths.map((path) => {
    if (!safePath(path)) throw new Error(`${path} is not a plain path inside the checkout`);
    const data = regularFile(join(top, path));
    if (!data) throw new Error(`${path} is not a file in ${top}`);
    if (data.byteLength > 1024 * 1024) throw new Error(`${path} is larger than 1 MiB`);
    return { path, data, updatedAt: iso(s.now()) };
  });
  writeStore(join(root, key), put, [], s.now());
  const p = s.get("project", project) ?? projectSchema.parse({ id: project });
  s.put("project", project, { ...p, fileList: [...new Set([...p.fileList ?? [], ...paths])].sort() });
  reconcile(s, root, key);
  return project;
}

/** Drop files from the project's file list and the store; other machines remove them from their stores too. */
export async function removeFiles(s: Store, root: string, top: string, paths: string[]) {
  const { key, project } = await checkoutProject(s, top);
  writeStore(join(root, key), [], paths, s.now());
  const p = s.get("project", project);
  if (p?.fileList) s.put("project", project, { ...p, fileList: p.fileList.filter((f) => !paths.includes(f)) });
  reconcile(s, root, key);
  return project;
}

/** Each store file of the checkout's repository, whether it is listed, and the project's sync error. */
export async function listFiles(s: Store, root: string, top: string) {
  const { key, project } = await checkoutProject(s, top);
  const store = readStore(join(root, key));
  const listed = new Set(s.get("project", project)?.fileList ?? []);
  const files = [...new Set([...store.files.keys(), ...listed])].sort().map((path) => {
    const f = store.files.get(path);
    return { path, updatedAt: f?.updatedAt, machine: !!f?.machine, listed: listed.has(path), stored: !!f };
  });
  return { project, store: join(root, key), files, error: store.state === "unsupported" ? "the store has a newer format" : filesErrors(s)[project] };
}
