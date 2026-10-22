import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { sh, tmp, removeTmp } from "./fixtures/git.ts";
import {
  CheckoutFiles,
  StoreBusy,
  fileContent,
  fillCheckout,
  keyForProject,
  localEdits,
  lockStore,
  placeEdit,
  readStore,
  reconcile,
  repoKey,
  setFileContent,
  writeStore,
} from "../src/checkout-files.ts";
import { Store, exportBackup } from "../src/store.ts";
import { publicProject } from "../src/remote.ts";

afterAll(removeTmp);

/** Fixture stores in buncargo's format (docs/internals/checkout-files.md). */
const sha = (data: string) => new Bun.CryptoHasher("sha256").update(data).digest("hex");
function fixtureStore(
  dir: string,
  files: Record<string, { data: string; updatedAt: string; machine?: boolean }>,
  version = 1,
) {
  mkdirSync(dir, { recursive: true });
  for (const [path, f] of Object.entries(files)) {
    mkdirSync(join(dir, "data", path, ".."), { recursive: true });
    writeFileSync(join(dir, "data", path), f.data);
  }
  const entries = Object.fromEntries(
    Object.entries(files).map(([path, f]) => [
      path,
      { sha256: sha(f.data), updatedAt: f.updatedAt, machine: !!f.machine },
    ]),
  );
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version, files: entries }));
}
const contents = (dir: string) =>
  Object.fromEntries(
    [...readStore(dir).files].map(([path, f]) => [path, f.machine ? "(machine)" : f.data!.toString()]),
  );

const stores: Store[] = [],
  watchers: CheckoutFiles[] = [];
afterEach(() => {
  for (const w of watchers.splice(0)) w.close();
  for (const s of stores.splice(0)) s.close();
});
const files = (n: { s: Store; root: string }) => {
  const f = new CheckoutFiles(n.s, n.root);
  watchers.push(f);
  return f;
};
function node(name: string, protocol = 6) {
  const s = new Store(":memory:");
  s.setLocal("node", name);
  stores.push(s);
  return { s, root: join(tmp(), ".buncargo", "files"), protocol };
}
/** Every node knows every node, as paired machines do. */
function pair(...nodes: ReturnType<typeof node>[]) {
  for (const n of nodes) for (const m of nodes) n.s.put("node", m.s.nodeId, { id: m.s.nodeId, protocol: m.protocol });
}
const copy = (from: Store, to: Store) => {
  for (const r of from.changes(0).records) to.merge(r);
};

const KEY = "github.com/bliss-budget/budget-app";

/** A checkout using buncargo, whose own CLI logs its calls. No `node_modules/.bin`: agentgate must not need one. */
function fakeBuncargo(cwd: string, status: unknown = {}) {
  writeFileSync(join(cwd, "dev.config.ts"), "");
  mkdirSync(join(cwd, "node_modules", "buncargo"), { recursive: true });
  writeFileSync(
    join(cwd, "node_modules", "buncargo", "package.json"),
    JSON.stringify({ bin: { buncargo: "./cli.js" } }),
  );
  writeFileSync(
    join(cwd, "node_modules", "buncargo", "cli.js"),
    `const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync("calls.log", process.env.HOME + " " + args.join(" ") + "\\n");
if (args[1] === "status") console.log(${JSON.stringify(JSON.stringify(status))});
`,
  );
}

test("repository keys follow the contract", () => {
  expect(repoKey("https://github.com/Bliss-Budget/budget-app.git")).toBe(KEY);
  expect(repoKey("git@github.com:Bliss-Budget/budget-app.git")).toBe(KEY);
  expect(repoKey("ssh://git@github.com:22/Bliss-Budget/budget-app/")).toBe(KEY);
  expect(repoKey("https://user:p%40ss@GitHub.com:8443/Bliss-Budget/budget-app.git/")).toBe(KEY);
  expect(repoKey("https://gitlab.com/group/sub/repo")).toBe("gitlab.com/group/sub/repo");
  expect(repoKey("/srv/repos/thing.git")).toBeUndefined();
  expect(repoKey("https://github.com/a b/c")).toBeUndefined();
  expect(keyForProject("Bliss-Budget/budget-app")).toBe(KEY);
});

test("a lock is taken atomically and a stale one (dead process, or over 30 seconds old) is taken over", () => {
  const dir = tmp();
  const release = lockStore(dir);
  expect(() => lockStore(dir)).toThrow(StoreBusy);
  release();
  expect(existsSync(join(dir, ".lock"))).toBe(false);

  const owner = (pid: number, createdAt: string, host = hostname()) => {
    mkdirSync(join(dir, ".lock"), { recursive: true });
    writeFileSync(join(dir, ".lock", "owner.json"), JSON.stringify({ pid, host, createdAt }));
  };
  const now = Date.now(),
    recent = new Date(now - 1000).toISOString();
  owner(2 ** 22 + 17, recent); // no such process here
  lockStore(dir, now)();
  owner(process.pid, new Date(now - 31_000).toISOString());
  lockStore(dir, now)();
  owner(process.pid, recent, "another-host");
  expect(() => lockStore(dir, now)).toThrow(StoreBusy);
});

test("readers trust the manifest: a mismatched data file is a write in progress, an unlisted one is ignored", () => {
  const dir = tmp();
  fixtureStore(dir, { ".env": { data: "A=1\n", updatedAt: "2026-10-01T00:00:00.000Z" } });
  writeFileSync(join(dir, "data", "stray"), "not listed");
  expect(contents(dir)).toEqual({ ".env": "A=1\n" });
  writeFileSync(join(dir, "data", ".env"), "A=2\n");
  expect(readStore(dir).state).toBe("pending");

  // Writing follows the protocol: data and manifest replaced, removed data files gone, permissions private.
  writeStore(
    dir,
    [{ path: "apps/x/.env", data: Buffer.from("B=1\n"), updatedAt: "2026-10-02T00:00:00.000Z" }],
    [".env"],
  );
  expect(contents(dir)).toEqual({ "apps/x/.env": "B=1\n" });
  expect(existsSync(join(dir, "data", ".env"))).toBe(false);
  expect(statSync(join(dir, "data", "apps/x/.env")).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "data", "apps")).mode & 0o777).toBe(0o700);
  expect(() =>
    writeStore(dir, [{ path: "../escape", data: Buffer.from(""), updatedAt: "2026-10-02T00:00:00.000Z" }], []),
  ).toThrow();
});

test("stores sync through the project record, without machine files or machine-bound stores", () => {
  const a = node("a"),
    b = node("b");
  pair(a, b);
  fixtureStore(join(a.root, KEY), {
    ".env.local": { data: "TOKEN=1\n", updatedAt: "2026-10-01T00:00:00.000Z" },
    "apps/expo-app/.env": { data: "EXPO=1\n", updatedAt: "2026-10-01T00:00:00.000Z" },
    ".env.machine": { data: "HOST=laptop\n", updatedAt: "2026-10-01T00:00:00.000Z", machine: true },
  });
  fixtureStore(join(a.root, "local", "0123456789abcdef"), {
    ".env": { data: "LOCAL=1\n", updatedAt: "2026-10-01T00:00:00.000Z" },
  });
  files(a).sync();
  const record = a.s.get("project", "bliss-budget/budget-app")!;
  expect(record.files!.map((f) => f.path)).toEqual([".env.local", "apps/expo-app/.env"]);
  expect(a.s.list("project")).toHaveLength(1);

  copy(a.s, b.s);
  files(b).sync();
  expect(contents(join(b.root, KEY))).toEqual({ ".env.local": "TOKEN=1\n", "apps/expo-app/.env": "EXPO=1\n" });
  expect(readStore(join(b.root, KEY)).files.get(".env.local")!.updatedAt).toBe("2026-10-01T00:00:00.000Z");

  // B keeps a machine file of its own; A removes a file and edits another. The newer edit and the deletion arrive,
  // and B's machine file stays.
  const manifest = JSON.parse(readFileSync(join(b.root, KEY, "manifest.json"), "utf8"));
  manifest.files[".env.server"] = { sha256: sha("x"), updatedAt: "2026-10-01T00:00:00.000Z", machine: true };
  writeFileSync(join(b.root, KEY, "manifest.json"), JSON.stringify(manifest));
  writeStore(
    join(a.root, KEY),
    [{ path: ".env.local", data: Buffer.from("TOKEN=2\n"), updatedAt: "2026-10-03T00:00:00.000Z" }],
    ["apps/expo-app/.env"],
  );
  reconcile(a.s, a.root, KEY);
  copy(a.s, b.s);
  reconcile(b.s, b.root, KEY);
  expect(contents(join(b.root, KEY))).toEqual({ ".env.local": "TOKEN=2\n", ".env.server": "(machine)" });
});

test("concurrent edits on two machines: each file goes to its newer save, and a deletion survives losing the record", () => {
  const a = node("a"),
    b = node("b");
  pair(a, b);
  fixtureStore(join(a.root, KEY), {
    ".env": { data: "V=1\n", updatedAt: "2026-10-01T00:00:00.000Z" },
    "old.env": { data: "O\n", updatedAt: "2026-10-01T00:00:00.000Z" },
  });
  reconcile(a.s, a.root, KEY);
  copy(a.s, b.s);
  reconcile(b.s, b.root, KEY);

  // Offline from each other: A deletes old.env, B saves a newer .env and a new file.
  writeStore(join(a.root, KEY), [], ["old.env"]);
  reconcile(a.s, a.root, KEY);
  writeStore(
    join(b.root, KEY),
    [
      { path: ".env", data: Buffer.from("V=2\n"), updatedAt: "2026-10-05T00:00:00.000Z" },
      { path: "b.env", data: Buffer.from("B\n"), updatedAt: "2026-10-05T00:00:00.000Z" },
    ],
    [],
  );
  reconcile(b.s, b.root, KEY);
  // B's record wins the record-level merge on A (it has more edits); A's deletion is still kept.
  b.s.put("project", "bliss-budget/budget-app", b.s.get("project", "bliss-budget/budget-app")!);
  copy(b.s, a.s);
  reconcile(a.s, a.root, KEY);
  copy(a.s, b.s);
  reconcile(b.s, b.root, KEY);
  const want = { ".env": "V=2\n", "b.env": "B\n" };
  expect(contents(join(a.root, KEY))).toEqual(want);
  expect(contents(join(b.root, KEY))).toEqual(want);
});

test("a store in a format this agentgate does not know is left alone, and old nodes hold the record back", () => {
  const a = node("a"),
    old = node("old", 5);
  pair(a, old);
  fixtureStore(join(a.root, KEY), { ".env": { data: "V=1\n", updatedAt: "2026-10-01T00:00:00.000Z" } }, 2);
  const before = readFileSync(join(a.root, KEY, "manifest.json"), "utf8");
  a.s.put("project", "bliss-budget/budget-app", {
    id: "bliss-budget/budget-app",
    files: [{ path: "x.env", data: btoa("X"), updatedAt: "2026-10-09T00:00:00.000Z" }],
  });
  reconcile(a.s, a.root, KEY);
  expect(readFileSync(join(a.root, KEY, "manifest.json"), "utf8")).toBe(before);
  expect(JSON.parse(a.s.local("checkoutFiles:errors")!)["bliss-budget/budget-app"]).toContain("newer format");

  const c = node("c"),
    other = node("other", 5);
  pair(c, other);
  fixtureStore(join(c.root, KEY), { ".env": { data: "V=1\n", updatedAt: "2026-10-01T00:00:00.000Z" } });
  reconcile(c.s, c.root, KEY);
  expect(c.s.get("project", "bliss-budget/budget-app")).toBeUndefined();
  expect(JSON.parse(c.s.local("checkoutFiles:errors")!)["bliss-budget/budget-app"]).toContain(
    "Update agentgate on other",
  );
  // Errors name files and machines, never their values.
  expect(c.s.local("checkoutFiles:errors")).not.toContain("V=1");
});

test("a checkout without buncargo gets missing store files and keeps its own", async () => {
  const root = tmp(),
    cwd = tmp();
  fixtureStore(join(root, KEY), {
    ".env": { data: "STORE=1\n", updatedAt: "2026-10-01T00:00:00.000Z" },
    "apps/expo-app/.env": { data: "EXPO=1\n", updatedAt: "2026-10-01T00:00:00.000Z" },
    ".env.machine": { data: "M\n", updatedAt: "2026-10-01T00:00:00.000Z", machine: true },
  });
  writeFileSync(join(root, KEY, "data", ".env.machine"), "M\n");
  writeFileSync(join(cwd, ".env"), "MINE=1\n");
  await fillCheckout(root, cwd, KEY);
  expect(readFileSync(join(cwd, ".env"), "utf8")).toBe("MINE=1\n");
  expect(readFileSync(join(cwd, "apps/expo-app/.env"), "utf8")).toBe("EXPO=1\n");
  expect(statSync(join(cwd, "apps/expo-app/.env")).mode & 0o777).toBe(0o600);
  expect(existsSync(join(cwd, ".env.machine"))).toBe(false);
});

test("in a buncargo checkout, buncargo's status picks what a handoff carries and its pull fills the checkout", async () => {
  const home = tmp(),
    root = join(home, ".buncargo", "files"),
    cwd = tmp();
  const status = {
    version: 1,
    repoKey: KEY,
    files: [
      { path: ".env.local", state: "local-edits", machine: false },
      { path: "apps/api/.env", state: "conflict", machine: false },
      { path: ".env.host", state: "local-edits", machine: true },
      { path: ".env", state: "in-sync", machine: false },
      { path: ".env.gone", state: "local-edits", machine: false },
    ],
  };
  fakeBuncargo(cwd, status);
  for (const f of [".env.local", "apps/api/.env", ".env.host", ".env"]) {
    mkdirSync(join(cwd, f, ".."), { recursive: true });
    writeFileSync(join(cwd, f), "x");
  }

  expect(await localEdits(root, cwd, [])).toEqual([".env.local", "apps/api/.env"]);
  await fillCheckout(root, cwd, KEY);
  expect(readFileSync(join(cwd, "calls.log"), "utf8")).toBe(`${home} files status --json\n${home} files pull\n`);
});

test("a handed-off file replaces the checkout's copy only when that copy has no edits of its own", () => {
  const root = tmp(),
    cwd = tmp();
  fixtureStore(join(root, KEY), { ".env": { data: "STORE\n", updatedAt: "2026-10-01T00:00:00.000Z" } });
  writeFileSync(join(cwd, ".env"), "STORE\n");
  expect(placeEdit(root, KEY, cwd, ".env", Buffer.from("ARRIVED\n"))).toBe(true);
  expect(readFileSync(join(cwd, ".env"), "utf8")).toBe("ARRIVED\n");
  writeFileSync(join(cwd, ".env"), "MINE\n");
  expect(placeEdit(root, KEY, cwd, ".env", Buffer.from("ARRIVED AGAIN\n"))).toBe(false);
  expect(readFileSync(join(cwd, ".env"), "utf8")).toBe("MINE\n");
  expect(placeEdit(root, KEY, cwd, "new/.env", Buffer.from("NEW\n"))).toBe(true);
});

test("editing a file in the app saves it for every machine and updates this machine's checkouts without edits of their own", async () => {
  const a = node("a");
  pair(a);
  fixtureStore(join(a.root, KEY), {
    ".env": { data: "OLD=1\n", updatedAt: "2026-10-01T00:00:00.000Z" },
    ".env.machine": { data: "HOST=laptop\n", updatedAt: "2026-10-01T00:00:00.000Z", machine: true },
  });
  files(a).sync();
  const clean = tmp(),
    edited = tmp();
  writeFileSync(join(clean, ".env"), "OLD=1\n");
  writeFileSync(join(edited, ".env"), "MINE=1\n");
  const withBuncargo = tmp();
  fakeBuncargo(withBuncargo);
  writeFileSync(join(withBuncargo, ".env"), "OLD=1\n");
  a.s.setLocal(
    "checkouts",
    JSON.stringify({
      [clean]: "Bliss-Budget/budget-app",
      [edited]: "bliss-budget/budget-app",
      [withBuncargo]: "bliss-budget/budget-app",
    }),
  );

  const opened = fileContent(a.s, a.root, "bliss-budget/budget-app", ".env");
  expect(opened.content).toBe("OLD=1\n");
  expect(fileContent(a.s, a.root, "bliss-budget/budget-app", ".env.local")).toEqual({ content: "", sha256: sha("") });
  expect(() => fileContent(a.s, a.root, "bliss-budget/budget-app", ".env.machine")).toThrow("one machine");

  await setFileContent(a.s, a.root, "bliss-budget/budget-app", ".env", "NEW=2\n", opened.sha256);
  expect(contents(join(a.root, KEY))[".env"]).toBe("NEW=2\n");
  expect(a.s.get("project", "bliss-budget/budget-app")!.files!.find((f) => f.path === ".env")!.data).toBe(
    btoa("NEW=2\n"),
  );
  expect(readFileSync(join(clean, ".env"), "utf8")).toBe("NEW=2\n");
  expect(readFileSync(join(edited, ".env"), "utf8")).toBe("MINE=1\n");
  // Buncargo's pull decides for its checkouts, by its own record of each checkout's copy.
  expect(readFileSync(join(withBuncargo, ".env"), "utf8")).toBe("OLD=1\n");
  expect(readFileSync(join(withBuncargo, "calls.log"), "utf8")).toEndWith(" files pull .env\n");
  await expect(setFileContent(a.s, a.root, "bliss-budget/budget-app", "../.env", "x")).rejects.toThrow("plain path");
  // An editor still open on the old version cannot replace the new one.
  await expect(
    setFileContent(a.s, a.root, "bliss-budget/budget-app", ".env", "STALE=1\n", opened.sha256),
  ).rejects.toThrow("changed since you opened it");
  expect(contents(join(a.root, KEY))[".env"]).toBe("NEW=2\n");
});

test("file contents stay out of the API's project view and backups without secrets", () => {
  const { s } = node("a");
  const project = s.put("project", "o/r", {
    id: "o/r",
    fileList: [".env"],
    files: [
      { path: ".env", data: btoa("SECRET=1"), updatedAt: "2026-10-01T00:00:00.000Z" },
      { path: "old", updatedAt: "2026-10-02T00:00:00.000Z", deleted: true },
    ],
  });
  const shown = JSON.stringify(publicProject(project, { summary: () => undefined } as never));
  expect(shown).not.toContain(btoa("SECRET=1"));
  expect(JSON.parse(shown).files).toEqual([{ path: ".env", updatedAt: "2026-10-01T00:00:00.000Z" }]);
  expect(JSON.stringify(exportBackup(s, false))).not.toContain(btoa("SECRET=1"));
  expect(JSON.stringify(exportBackup(s, true))).toContain(btoa("SECRET=1"));
});

test("a save follows into every worktree of a registered checkout, and logs what each did without the contents", async () => {
  const a = node("a");
  pair(a);
  fixtureStore(join(a.root, KEY), { ".env": { data: "OLD=1\n", updatedAt: "2026-10-01T00:00:00.000Z" } });
  files(a).sync();
  // SkillLinks registers only the main checkout; its worktrees live elsewhere, as T3 Code's do.
  const main = tmp(),
    trees = tmp();
  sh(main, "init", "-b", "main");
  writeFileSync(join(main, ".gitignore"), ".env\nnode_modules\ncalls.log\ndev.config.ts\n");
  sh(main, "add", "-A");
  sh(main, "commit", "-m", "init");
  const [plain, withBuncargo, gone] = ["plain", "buncargo", "gone"].map((name) => join(trees, name));
  for (const [i, wt] of [plain, withBuncargo, gone].entries()) sh(main, "worktree", "add", "-b", `b${i}`, wt!);
  rmSync(gone!, { recursive: true }); // prunable: git still lists it
  fakeBuncargo(withBuncargo!);
  for (const cwd of [main, plain!, withBuncargo!]) writeFileSync(join(cwd, ".env"), "OLD=1\n");
  writeFileSync(join(main, ".env"), "MINE=1\n");
  a.s.setLocal("checkouts", JSON.stringify({ [main]: "bliss-budget/budget-app" }));

  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const saved = await setFileContent(a.s, a.root, "bliss-budget/budget-app", ".env", "NEW=2\n", sha("OLD=1\n"));
    expect(saved.checkouts).toEqual({ updated: 1, kept: 1, pulled: 1, failed: 0 });
    expect(log.mock.calls.flat()).toContain(
      "checkout files: bliss-budget/budget-app .env saved; followed 3 checkouts (1 updated, 1 kept, 1 pulled)",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("NEW=2");
  } finally {
    log.mockRestore();
  }
  expect(readFileSync(join(plain!, ".env"), "utf8")).toBe("NEW=2\n");
  expect(readFileSync(join(main, ".env"), "utf8")).toBe("MINE=1\n");
  expect(readFileSync(join(withBuncargo!, "calls.log"), "utf8")).toEndWith(" files pull .env\n");
  expect(existsSync(gone!)).toBe(false);
});

test("a SQLite write that fails says which write, which database and what the disks have free", () => {
  const dir = tmp(),
    s = new Store(join(dir, "agentgate.db"));
  stores.push(s);
  s.setLocal("node", "a");
  s.put("node", "a", { id: "a", protocol: 6 });
  const root = join(tmp(), ".buncargo", "files");
  fixtureStore(join(root, KEY), { ".env": { data: "x".repeat(200_000), updatedAt: "2026-10-01T00:00:00.000Z" } });
  // SQLITE_FULL without a full disk, as a database at its page limit gives it.
  const pages = (s.db.query("pragma page_count").get() as { page_count: number }).page_count;
  s.db.run(`pragma max_page_count = ${pages}`);
  let error: Error | undefined;
  try {
    reconcile(s, root, KEY);
  } catch (e) {
    error = e as Error;
  }
  expect(error?.message).toContain(`in ${join(dir, "agentgate.db")} failed: database or disk is full (SQLITE_FULL; `);
  expect(error?.message).toMatch(/GiB free in .*GiB free in /);
  expect(error?.message).not.toContain("xxxx");
});
