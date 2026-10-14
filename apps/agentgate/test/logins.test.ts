import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportBackup, Store } from "../src/store.ts";
import { forgetLogin, host, listLogins, shareLogins, syncLogins } from "../src/logins.ts";

const temp = mkdtempSync(join(tmpdir(), "agentgate-logins-"));
const original = { ...host };
afterAll(() => { Object.assign(host, original); rmSync(temp, { recursive: true, force: true }); });
const node = (name: string) => { const s = new Store(":memory:"); s.setLocal("node", name); for (const id of ["a", "b"]) s.put("node", id, { id, protocol: 4 }); return s; };
const sync = (from: Store, to: Store) => { for (const r of from.changes(0).records) to.merge(r); };

/** A fake gh per home: its github.com token, and every command it ran. */
const gh = new Map<string, { token?: string; calls: string[][] }>();
const on = (home: string) => {
  const me = gh.get(home) ?? { calls: [] };
  gh.set(home, me);
  host.home = home;
  host.gh = async (args, stdin) => {
    me.calls.push(args);
    if (args[1] === "token") return me.token ? { ok: true, out: me.token } : { ok: false, out: "" };
    if (args[0] === "config") return { ok: true, out: "octocat" };
    if (args[1] === "login") me.token = stdin;
    return { ok: true, out: "" };
  };
  return me;
};
const infisical = (home: string, email: string, session: string) => {
  mkdirSync(join(home, ".infisical"), { recursive: true }); mkdirSync(join(home, "infisical-keyring"), { recursive: true });
  writeFileSync(join(home, ".infisical/infisical-config.json"), JSON.stringify({ loggedInUserEmail: email, loggedInUsers: [{ email }, { email: "other@example.com" }], vaultBackendType: "file", vaultBackendPassphrase: "cGFzcw==" }));
  writeFileSync(join(home, "infisical-keyring", email), session);
};

test("a machine without gh or Infisical shares nothing", async () => {
  const a = node("a"), home = join(temp, "empty");
  on(home);
  expect(await shareLogins(a)).toEqual([
    { id: "github", skipped: "gh is not logged in to github.com (gh auth login)" },
    { id: "infisical", skipped: "the Infisical CLI is not logged in" },
  ]);
  expect(a.list("login")).toEqual([]);
  // Infisical in the system keychain cannot be read; the user is told how to move it.
  mkdirSync(join(home, ".infisical"), { recursive: true });
  writeFileSync(join(home, ".infisical/infisical-config.json"), JSON.stringify({ loggedInUserEmail: "me@example.com", vaultBackendType: "auto" }));
  expect((await shareLogins(a, "infisical"))[0]!.skipped).toContain("infisical vault set file");
});

test("other machines sign in with a shared login once, and again when the sharing machine's login changes", async () => {
  const a = node("a"), b = node("b"), homeA = join(temp, "a"), homeB = join(temp, "b");
  on(homeA).token = "gho_shared";
  infisical(homeA, "me@example.com", "session-1");
  expect((await shareLogins(a)).map((r) => r.account)).toEqual(["octocat", "me@example.com"]);
  expect(exportBackup(a, false).records.some((r) => r.kind === "login")).toBe(false);

  sync(a, b);
  const ghB = on(homeB);
  await syncLogins(b);
  expect(ghB.token).toBe("gho_shared");
  expect(ghB.calls.some((c) => c.join(" ") === "auth setup-git --hostname github.com")).toBe(true);
  expect(readFileSync(join(homeB, "infisical-keyring/me@example.com"), "utf8")).toBe("session-1");
  expect(JSON.parse(readFileSync(join(homeB, ".infisical/infisical-config.json"), "utf8")).loggedInUsers).toEqual([{ email: "me@example.com" }]);
  expect(listLogins(b).map((l) => [l.id, l.signedIn])).toEqual([["github", true], ["infisical", true]]);

  // Unchanged: nothing is run or written again, so a session Infisical refreshed here is kept.
  ghB.calls.length = 0;
  writeFileSync(join(homeB, "infisical-keyring/me@example.com"), "refreshed-on-b");
  await syncLogins(b);
  expect(ghB.calls.filter((c) => c[1] !== "token")).toEqual([]);
  expect(readFileSync(join(homeB, "infisical-keyring/me@example.com"), "utf8")).toBe("refreshed-on-b");

  // The sharing machine logs in again; its next round shares the new session and b follows.
  on(homeA);
  writeFileSync(join(homeA, "infisical-keyring/me@example.com"), "session-2");
  await syncLogins(a);
  sync(a, b);
  on(homeB);
  await syncLogins(b);
  expect(readFileSync(join(homeB, "infisical-keyring/me@example.com"), "utf8")).toBe("session-2");
  expect(readFileSync(join(homeB, "infisical-keyring/me@example.com.before-agentgate"), "utf8")).toBe("refreshed-on-b");

  forgetLogin(a, "infisical");
  sync(a, b);
  expect(listLogins(b).map((l) => l.id)).toEqual(["github"]);
});

test("a machine without gh reports it and signs in once gh is installed", async () => {
  const a = node("a"), b = node("b");
  on(join(temp, "c")).token = "gho_x";
  await shareLogins(a, "github");
  sync(a, b);
  host.home = join(temp, "d");
  host.gh = async () => undefined;
  await syncLogins(b);
  expect(listLogins(b)[0]).toMatchObject({ signedIn: false, error: "install gh to sign in to GitHub" });
  on(join(temp, "d"));
  await syncLogins(b);
  expect(listLogins(b)[0]).toMatchObject({ signedIn: true, error: undefined });
});

test("sharing waits until every machine understands shared logins", async () => {
  const a = node("a");
  a.put("node", "old", { id: "old", protocol: 3 });
  on(join(temp, "e")).token = "gho_x";
  await expect(shareLogins(a)).rejects.toThrow("Update agentgate on old first");
});
