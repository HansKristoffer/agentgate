import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, relative } from "node:path";
import { projectIdSchema, projectSchema, safePath, type CheckoutFile } from "@agentgate/protocol";
import { RELAY_LIMITS } from "@agentgate/protocol/relay";
import { z } from "zod";
import { worktrees } from "./handoff/code.ts";
import { canonicalProject } from "./mcp/gateway.ts";
import { CONFIG_DIR, DEV, sqliteDetail, type Store } from "./store.ts";

/** Checkout files (docs/internals/checkout-files.md): buncargo's per-machine file store of a repository's gitignored
 * files, carried between machines on the synced `project` record. Buncargo owns what happens inside a checkout; this
 * module owns the store's format on disk, its sync, and filling checkouts of repositories without buncargo. */

/** A checkout's dev daemon keeps its own store under its own HOME, which buncargo then runs with. */
export const FILES_ROOT = join(DEV ? join(CONFIG_DIR, "home") : homedir(), ".buncargo", "files");
/** The node protocol that keeps `files` and `fileList` on project records (see NODE_PROTOCOL in remote.ts). */
export const FILES_PROTOCOL = 6;
const KEY = /^[a-z0-9.-]+(\/[a-z0-9._-]+)+$/;
const LOCK_STALE = 30_000;

const sha256 = (data: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(data).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return code === 0 ? out.trim() : undefined;
}

/** The store key of a remote URL: `host/path`, lowercase, without user, port or `.git`; undefined when it is not one. */
export function repoKey(url: string): string | undefined {
  url = url.trim();
  const urlForm = url.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/]*@)?([^/:]+)(?::\d*)?\/(.*)$/i);
  const scpForm = url.includes("://") ? null : url.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);
  const m = urlForm ?? scpForm;
  if (!m) return undefined;

  const key = `${m[1]}/${m[2]}`.replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
  return KEY.test(key) ? key : undefined;
}

/** The store key of the repository `cwd` is in. Without a usable origin the store belongs to this machine and never
 * syncs. */
export async function checkoutKey(cwd: string): Promise<string> {
  const origin = repoKey((await git(cwd, "remote", "get-url", "origin")) ?? "");
  if (origin) return origin;
  const common = (await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")) ?? "";
  return `local/${sha256(realpathSync(common)).slice(0, 16)}`;
}

/** Projects are GitHub `owner/repo`; only github.com stores sync. */
// ponytail: other hosts stay on their machine; carry the host on the project when a non-GitHub repo needs it.
export function projectForKey(s: Store, key: string): string | undefined {
  const m = key.match(/^github\.com\/([^/]+\/[^/]+)$/);
  return m && projectIdSchema.safeParse(m[1]).success ? canonicalProject(s, m[1]!) : undefined;
}

export function keyForProject(id: string) {
  const key = `github.com/${id.toLowerCase()}`;
  return KEY.test(key) ? key : undefined;
}

// ---------------------------------------------------------------- the store on disk (buncargo's format)

const entrySchema = z.object({ sha256: z.string(), updatedAt: z.string(), machine: z.boolean().default(false) }).passthrough();
const manifestSchema = z.object({ version: z.number(), files: z.record(z.string(), z.unknown()).default({}) }).passthrough();

/** The store's files as its manifest has them, with the data of every file that may leave this machine. `pending`: a
 * data file does not match its entry yet (a write in progress), so read again shortly. */
export function readStore(dir: string) {
  const files = new Map<string, { sha256: string; updatedAt: string; machine: boolean; data?: Buffer }>();
  let raw: string;
  try {
    raw = readFileSync(join(dir, "manifest.json"), "utf8");
  } catch {
    return { state: "missing" as const, files };
  }
  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = manifestSchema.parse(JSON.parse(raw));
  } catch {
    return { state: "pending" as const, files };
  }
  if (manifest.version !== 1) return { state: "unsupported" as const, files };

  let pending = false;
  for (const [path, value] of Object.entries(manifest.files)) {
    const entry = entrySchema.safeParse(value);
    if (!entry.success || !safePath(path)) continue;

    const { sha256: hash, updatedAt, machine } = entry.data;
    if (machine) {
      files.set(path, { sha256: hash, updatedAt, machine });
      continue;
    }
    const data = regularFile(join(dir, "data", path));
    if (!data || sha256(data) !== hash) {
      pending = true;
      continue;
    }
    files.set(path, { sha256: hash, updatedAt, machine, data });
  }
  return { state: pending ? "pending" as const : "ok" as const, files };
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
      const takeOver = (e as NodeJS.ErrnoException).code === "EEXIST" && attempt === 0 && stale(lock, now);
      if (!takeOver) throw new StoreBusy(`the file store in ${dir} is busy`);
      rmSync(lock, { recursive: true, force: true });
    }
  }
  const owner = { pid: process.pid, host: hostname(), createdAt: iso(now) };
  writeFileSync(join(lock, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
  return () => rmSync(lock, { recursive: true, force: true });
}

function stale(lock: string, now: number) {
  let owner: { pid?: number; host?: string; createdAt?: string };
  try {
    owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
  } catch {
    // Created but not yet written, or abandoned in between.
    return now - (lstatSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0) > LOCK_STALE;
  }
  if (!(now - Date.parse(owner.createdAt ?? "") <= LOCK_STALE)) return true;
  if (owner.host !== hostname() || typeof owner.pid !== "number") return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Temp file and rename in the same directory, as the contract writes. */
function replace(file: string, data: Uint8Array | string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, file);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

/** Write and remove files under the lock: data first, then the manifest, then removed data files. Other entries, machine
 * ones included, stay as they are. */
export function writeStore(dir: string, put: { path: string; data: Buffer; updatedAt: string }[], remove: string[], now = Date.now()) {
  const release = lockStore(dir, now);
  try {
    let manifest: z.infer<typeof manifestSchema> = { version: 1, files: {} };
    try {
      manifest = manifestSchema.parse(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (manifest.version !== 1) throw new Error(`the file store in ${dir} has a newer format; update agentgate`);

    for (const f of put) {
      if (!safePath(f.path)) throw new Error(`unsafe checkout file path ${f.path}`);
      replace(join(dir, "data", f.path), f.data);
      manifest.files[f.path] = { sha256: sha256(f.data), updatedAt: f.updatedAt, machine: false };
    }
    for (const path of remove) delete manifest.files[path];
    replace(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    for (const path of remove) if (safePath(path)) rmSync(join(dir, "data", path), { force: true });
  } finally {
    release();
  }
}

// ---------------------------------------------------------------- merging the store with the record

const time = (f: CheckoutFile) => Date.parse(f.updatedAt);
const digest = (f: CheckoutFile) => f.deleted ? "" : sha256(Buffer.from(f.data ?? "", "base64"));
const byPath = (x: CheckoutFile, y: CheckoutFile) => x.path < y.path ? -1 : x.path > y.path ? 1 : 0;
const same = (a: CheckoutFile[], b: CheckoutFile[]) => {
  const plain = (fs: CheckoutFile[]) => JSON.stringify([...fs].sort(byPath).map(({ path, updatedAt, data, deleted }) => ({ path, updatedAt, data, deleted })));
  return plain(a) === plain(b);
};

/** Per file, the newer by `updatedAt`. A file missing on one side is unknown there, not deleted: deletions are entries. */
function mergeFiles(a: CheckoutFile[], b: CheckoutFile[]): CheckoutFile[] {
  const out = new Map(a.map((f) => [f.path, f]));
  for (const f of b) {
    const mine = out.get(f.path);
    const newer = !mine || time(f) > time(mine) || (time(f) === time(mine) && digest(f) > digest(mine));
    if (newer) out.set(f.path, f);
  }
  return [...out.values()].sort(byPath);
}

/** Whether a project record still fits one relay entry (1 MiB sealed), where the files make it largest. */
function fitsRelay(s: Store, project: z.input<typeof projectSchema>) {
  const record = { kind: "project", id: project.id, rev: Number.MAX_SAFE_INTEGER, node: s.nodeId, updated_at: Number.MAX_SAFE_INTEGER, deleted: 0, data: JSON.stringify(project) };
  const NONCE_AND_TAG = 28;
  return Buffer.byteLength(JSON.stringify({ protocol: 999, record })) + NONCE_AND_TAG <= RELAY_LIMITS.blobBytes;
}

/** Why `files` and `fileList` cannot be written yet: a node whose daemon would drop them when it saves a project.
 * FILES_PROTOCOL arrived in 0.20.0, so nodes on 0.20.0 or later keep them. */
function oldNodesError(s: Store) {
  const old = s.list("node").filter((n) => (n.protocol ?? 0) < FILES_PROTOCOL).map((n) => n.id);
  return old.length ? `Update agentgate on ${old.join(", ")} to 0.20.0 or later: older versions drop env files when they save a project, so none are saved until then` : undefined;
}

const errorsKey = "checkoutFiles:errors";
function storedErrors(s: Store): Record<string, string> {
  try {
    return JSON.parse(s.local(errorsKey) ?? "{}");
  } catch {
    return {};
  }
}
/** Why each project's env files are not syncing. An old node blocks every project with files, whether or not a pass
 * has had something to send since. */
export function filesErrors(s: Store): Record<string, string> {
  const errors = storedErrors(s), old = oldNodesError(s);
  if (old) for (const p of s.list("project")) if (p.files?.length || p.fileList?.length) errors[p.id] ??= old;
  return errors;
}
function report(s: Store, project: string, message: string | undefined) {
  const errors = storedErrors(s);
  if (errors[project] === message) return;
  if (message) {
    errors[project] = message;
    console.error(`checkout files: ${project}: ${message}`);
  } else {
    delete errors[project];
  }
  s.setLocal(errorsKey, Object.keys(errors).length ? JSON.stringify(errors) : undefined);
}

/** Name the write, so the cause in sqliteDetail shows against what failed. */
function dbWrite<T>(s: Store, what: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    const detail = sqliteDetail(e, s.db.filename);
    if (!detail) throw e;
    throw new Error(`${what} in ${s.db.filename} failed: ${detail}`, { cause: e });
  }
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
  try {
    base = JSON.parse(s.local(baseKey(project)) ?? "[]");
  } catch {
    // An unreadable note counts as none: nothing is taken as deleted here.
  }

  // This store as entries, plus a deletion for each file that left it since the last pass.
  const local: CheckoutFile[] = [];
  for (const [path, f] of store.files) if (!f.machine) local.push({ path, updatedAt: f.updatedAt, data: f.data!.toString("base64") });
  for (const b of base) {
    if (store.files.has(b.path)) continue;
    local.push(b.deleted ? b : { path: b.path, updatedAt: iso(s.now()), deleted: true });
  }
  const merged = mergeFiles(local, remote);

  const put = merged.filter((f) => {
    const mine = store.files.get(f.path);
    return !f.deleted && !mine?.machine && mine?.sha256 !== digest(f);
  });
  const remove = merged.filter((f) => f.deleted && store.files.get(f.path)?.machine === false).map((f) => f.path);
  if (put.length || remove.length) {
    const writes = put.map((f) => ({ path: f.path, data: Buffer.from(f.data!, "base64"), updatedAt: f.updatedAt }));
    writeStore(dir, writes, remove, s.now());
    console.log(`checkout files: ${project}: this machine's store took ${[...put.map((f) => f.path), ...remove.map((path) => `${path} (removed)`)].join(", ")} from the synced record`);
  }
  dbWrite(s, "saving what this pass reconciled", () => s.setLocal(baseKey(project), JSON.stringify(merged.map(({ data: _, ...f }) => f))));

  let error: string | undefined;
  if (merged.length && !same(merged, remote)) {
    const next = { ...(record ?? projectSchema.parse({ id: project })), files: merged };
    error = oldNodesError(s);
    if (!error && !fitsRelay(s, next)) error = "the files are larger than one synced record can carry (about 700 KiB in all); they stay on this machine";
    if (!error) dbWrite(s, `saving ${project}'s project record`, () => s.put("project", project, next));
  }
  dbWrite(s, "saving the sync error", () => report(s, project, error));
  return put.length > 0 || remove.length > 0;
}

/** Keys of every store under `root` that can sync. */
function storeKeys(root: string): string[] {
  const dirs = (path: string) => {
    try {
      return readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  };
  const keys: string[] = [];
  for (const owner of dirs(join(root, "github.com"))) {
    for (const repo of dirs(join(root, "github.com", owner))) {
      const key = `github.com/${owner}/${repo}`;
      if (KEY.test(key) && existsSync(join(root, key, "manifest.json"))) keys.push(key);
    }
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
  constructor(private s: Store, readonly root: string | null = FILES_ROOT) { }

  soon() {
    if (this.closed || !this.root) return;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [100, 1000, 5000].map((ms) => {
      const t = setTimeout(() => this.sync(), ms);
      t.unref?.();
      return t;
    });
  }

  sync() {
    const root = this.root;
    if (this.closed || !root) return;
    this.watch(root);

    const keys = new Set(storeKeys(root));
    for (const p of this.s.list("project")) {
      const key = p.files?.length ? keyForProject(p.id) : undefined;
      if (key) keys.add(key);
    }
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
      if (!existsSync(path)) {
        delete all[path];
        this.s.setLocal(createdKey, JSON.stringify(all));
      } else if (k === key) {
        void fillCheckout(this.root!, path, key).catch((e) => console.error(`checkout files: ${path}: ${(e as Error).message}`));
      }
    }
  }

  private watch(root: string) {
    if (this.watcher || !existsSync(root)) return;
    try {
      // ponytail: recursive watching where the platform has it; elsewhere the 30-second pass picks changes up.
      const watcher = watch(root, { recursive: true }, () => this.soon());
      watcher.on("error", () => {
        watcher.close();
        if (this.watcher === watcher) this.watcher = undefined;
      });
      this.watcher = watcher;
    } catch {
      // No recursive watching on this platform: the periodic pass is enough.
    }
  }

  close() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.watcher?.close();
  }
}

function createdCheckouts(s: Store): Record<string, string> {
  try {
    return JSON.parse(s.local(createdKey) ?? "{}");
  } catch {
    return {};
  }
}
/** Remember a checkout agentgate made, so later store updates reach it too. */
export const rememberCheckout = (s: Store, path: string, key: string) => s.setLocal(createdKey, JSON.stringify({ ...createdCheckouts(s), [path]: key }));

// ---------------------------------------------------------------- inside a checkout

/** The checkout's own buncargo CLI. Not `bunx buncargo`: without `node_modules/.bin` links (a worktree set up without
 * them) bunx falls back to a global buncargo, which can be a version without `files`. */
function buncargoBin(cwd: string): string | undefined {
  const dir = join(cwd, "node_modules", "buncargo");
  try {
    const { bin } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const path = typeof bin === "string" ? bin : bin?.buncargo;
    return typeof path === "string" ? join(dir, path) : undefined;
  } catch {
    return undefined;
  }
}

/** A checkout that uses buncargo: `dev.config.ts` and buncargo installed. Buncargo then owns its checkout files. */
const usesBuncargo = (cwd: string) => existsSync(join(cwd, "dev.config.ts")) && !!buncargoBin(cwd);

/** The checkout's buncargo, with the HOME whose store `root` is. Never reports output: it may hold values. */
async function buncargo(root: string, cwd: string, args: string[]): Promise<string> {
  const bin = buncargoBin(cwd);
  if (!bin) throw new Error("buncargo is not installed in this checkout");
  const child = Bun.spawn(["bun", bin, ...args], {
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
  if (usesBuncargo(cwd)) {
    await buncargo(root, cwd, ["files", "pull"]);
    return;
  }
  for (const [path, f] of readStore(join(root, key)).files) {
    const target = join(cwd, path);
    if (f.machine || !f.data || lstatSync(target, { throwIfNoEntry: false })) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.data, { mode: 0o600, flag: "wx" });
  }
}

const statusSchema = z.object({
  version: z.literal(1),
  files: z.array(z.object({ path: z.string(), state: z.string(), machine: z.boolean().default(false) }).passthrough()),
}).passthrough();

/** A regular file's bytes, or undefined. */
function regularFile(path: string): Buffer | undefined {
  return lstatSync(path, { throwIfNoEntry: false })?.isFile() ? readFileSync(path) : undefined;
}

/** The checkout files that differ from the store in `cwd`, which a handoff carries: buncargo's local edits and
 * conflicts, or, without buncargo, the listed files that differ from the store. Never a machine file. */
export async function localEdits(root: string, cwd: string, listed: string[]): Promise<string[]> {
  if (usesBuncargo(cwd)) {
    const out = await buncargo(root, cwd, ["files", "status", "--json"]);
    let status: z.infer<typeof statusSchema>;
    try {
      status = statusSchema.parse(JSON.parse(out));
    } catch {
      // Parse errors can quote the output, which may hold values.
      throw new Error("buncargo files status answered in a format agentgate does not know");
    }
    return status.files
      .filter((f) => !f.machine && (f.state === "local-edits" || f.state === "conflict"))
      .map((f) => f.path)
      .filter((path) => safePath(path) && regularFile(join(cwd, path)));
  }

  const store = readStore(join(root, await checkoutKey(cwd)));
  return listed.filter((path) => {
    const data = safePath(path) ? regularFile(join(cwd, path)) : undefined;
    const entry = store.files.get(path);
    return data && !entry?.machine && entry?.sha256 !== sha256(data);
  });
}

/** Every file the file store manages for this checkout, machine-specific ones included: a handoff's snapshot leaves
 * them to the store, which carries the edits (`localEdits`) and keeps each machine's own. */
export async function managedFiles(root: string, cwd: string, listed: string[]): Promise<string[]> {
  return [...new Set([...listed, ...readStore(join(root, await checkoutKey(cwd))).files.keys()])];
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
    const editedHere = !root || readStore(join(root, key)).files.get(path)?.sha256 !== sha256(current);
    if (editedHere) return false;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data, { mode: 0o600 });
  return true;
}

// ---------------------------------------------------------------- `agentgate project files`

/** The project and store key of the checkout at `top`. */
export async function checkoutProject(s: Store, top: string) {
  const key = await checkoutKey(top);
  const project = projectForKey(s, key);
  if (!project) throw new Error("this repository's origin is not on github.com, so its files cannot sync");
  return { key, project };
}

/** Save files from a checkout into the store (now, as a deliberate save) and keep them on the project's file list. */
export async function addFiles(s: Store, root: string, top: string, paths: string[]) {
  const { key, project } = await checkoutProject(s, top);
  const old = oldNodesError(s);
  if (old) throw new Error(old);

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

/** Save one file the app picked, after checking it belongs to a checkout of `project`. */
export async function addFileAt(s: Store, root: string, project: string, file: string) {
  file = realpathSync(file);
  const found = await git(dirname(file), "rev-parse", "--show-toplevel");
  if (!found) throw new Error("That file is not in a checkout of a repository");
  const top = realpathSync(found);

  const owner = (await checkoutProject(s, top)).project;
  if (owner.toLowerCase() !== project.toLowerCase()) throw new Error(`That file is in a checkout of ${owner}, not ${project}`);
  return addFiles(s, root, top, [relative(top, file)]);
}

/** Drop files from the project's file list and the store; other machines remove them from their stores too. */
export function removeFiles(s: Store, root: string, project: string, paths: string[]) {
  project = canonicalProject(s, project);
  const key = keyForProject(project);
  if (!key) throw new Error(`${project} has no file store`);
  writeStore(join(root, key), [], paths, s.now());

  const p = s.get("project", project);
  if (p?.fileList) s.put("project", project, { ...p, fileList: p.fileList.filter((f) => !paths.includes(f)) });
  reconcile(s, root, key);
  return project;
}

/** The store and its key for one of a project's files on this machine. */
function storeFile(s: Store, root: string, project: string, path: string) {
  project = canonicalProject(s, project);
  const key = keyForProject(project);
  if (!key) throw new Error(`${project} has no file store`);
  if (!safePath(path)) throw new Error(`${path} is not a plain path inside the checkout`);
  const store = readStore(join(root, key));
  if (store.state === "unsupported") throw new Error("the file store has a newer format; update agentgate");
  if (store.state === "pending") throw new StoreBusy("the file store is being written; try again");
  const f = store.files.get(path);
  if (f?.machine) throw new Error(`${path} is kept for one machine only`);
  return { project, key, f };
}

/** A file's text as this machine's store has it, for editing; empty when it is not saved yet. `sha256` is the sha256 of
 * that text (`cat | shasum -a 256`), so a save can refuse to replace a newer version. */
export function fileContent(s: Store, root: string, project: string, path: string) {
  const { f } = storeFile(s, root, project, path);
  try {
    return { content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(f?.data ?? new Uint8Array()), sha256: f?.sha256 ?? sha256("") };
  } catch {
    throw new Error(`${path} is not text, so it cannot be edited here`);
  }
}

/** This machine's checkouts of a repository: the main checkouts SkillLinks registered and the checkouts agentgate
 * created, each with every worktree of its repository. */
async function checkoutsOf(s: Store, project: string, key: string): Promise<string[]> {
  let registered: Record<string, string> = {};
  try { registered = JSON.parse(s.local("checkouts") ?? "{}"); } catch { } // SkillLinks.checkouts()
  const known = [
    ...Object.entries(registered).filter(([, p]) => p.toLowerCase() === project.toLowerCase()).map(([cwd]) => cwd),
    ...Object.entries(createdCheckouts(s)).filter(([, k]) => k === key).map(([cwd]) => cwd),
  ];
  const found = new Set<string>();
  for (const cwd of known) {
    if (!existsSync(cwd)) continue;
    found.add(realpathSync(cwd));
    for (const w of await worktrees(cwd).catch(() => [])) found.add(realpathSync(w.path));
  }
  return [...found];
}

type Followed = "updated" | "kept" | "pulled" | "failed";

/** Save a file's new text (now, as a deliberate save) for every machine. This machine's checkouts of the repository that
 * hold the previous version, or none, get the new one (through buncargo's pull where they use it); a checkout with its
 * own edits keeps them. With `expected` (fileContent's sha256), it refuses to replace a version saved in the meantime.
 * Logs one line with what each checkout did, never the contents. */
export async function setFileContent(s: Store, root: string, project: string, path: string, content: string, expected?: string) {
  const { project: id, key, f } = storeFile(s, root, project, path);
  if (expected !== undefined && expected !== (f?.sha256 ?? sha256(""))) throw new Error(`${path} changed since you opened it; open it again to see the new version`);
  const old = oldNodesError(s);
  if (old) throw new Error(old);
  const data = Buffer.from(content);
  if (data.byteLength > 1024 * 1024) throw new Error(`${path} is larger than 1 MiB`);

  const checkouts = await checkoutsOf(s, id, key);
  const followed = new Map<string, Followed>();
  const fail = (cwd: string, e: unknown) => {
    followed.set(cwd, "failed");
    console.error(`checkout files: ${cwd}: ${(e as Error).message}`);
  };
  // Before the store changes: placeEdit tells the previous version from a checkout's own edits by the store.
  for (const cwd of checkouts) {
    if (usesBuncargo(cwd)) continue;
    try {
      followed.set(cwd, placeEdit(root, key, cwd, path, data) ? "updated" : "kept");
    } catch (e) {
      fail(cwd, e);
    }
  }

  writeStore(join(root, key), [{ path, data, updatedAt: iso(s.now()) }], [], s.now());
  reconcile(s, root, key);
  // Buncargo keeps its own record of each checkout's copy, so its pull decides whether a checkout takes the new one.
  for (const cwd of checkouts) {
    if (!usesBuncargo(cwd)) continue;
    await buncargo(root, cwd, ["files", "pull", path]).then(() => followed.set(cwd, "pulled"), (e) => fail(cwd, e));
  }

  const counts = { updated: 0, kept: 0, pulled: 0, failed: 0 };
  for (const outcome of followed.values()) counts[outcome]++;
  const parts = Object.entries(counts).filter(([, n]) => n).map(([outcome, n]) => `${n} ${outcome}`);
  console.log(`checkout files: ${id} ${path} saved; followed ${checkouts.length} ${checkouts.length === 1 ? "checkout" : "checkouts"}${parts.length ? ` (${parts.join(", ")})` : ""}`);
  return { project: id, checkouts: counts };
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
  const error = store.state === "unsupported" ? "the store has a newer format" : filesErrors(s)[project];
  return { project, files, error };
}
