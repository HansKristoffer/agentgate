import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportBackup, Store } from "../src/store.ts";
import {
  forgetLogin,
  host,
  listLogins,
  setInfisicalIdentity,
  shareLogins,
  signInInfisical,
  startInfisicalSignIn,
  syncLogins,
} from "../src/logins.ts";

const temp = mkdtempSync(join(tmpdir(), "agentgate-logins-"));
const original = { ...host };
const originalFetch = globalThis.fetch;
/** GitHub's answer to the shared token. */
let github = 200;
globalThis.fetch = (async () => new Response("{}", { status: github })) as unknown as typeof fetch;
afterAll(() => {
  Object.assign(host, original);
  globalThis.fetch = originalFetch;
  rmSync(temp, { recursive: true, force: true });
});
const node = (name: string) => {
  const s = new Store(":memory:");
  s.setLocal("node", name);
  for (const id of ["a", "b"]) s.put("node", id, { id, protocol: 4 });
  return s;
};
const sync = (from: Store, to: Store) => {
  for (const r of from.changes(0).records) to.merge(r);
};

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
  host.infisical = async (args) => {
    const cli = infisicalCli.get(home);
    if (!cli) return undefined;
    cli.calls.push(args);
    if (args[0] === "--version") return { ok: true, out: `infisical version ${cli.version}` };
    if (args[1] === "status") {
      const session = {
        principalType: "user",
        email: "me@example.com",
        status: cli.status,
        token: { exp: 1793109462 },
      };
      return { ok: cli.status === "authenticated", out: JSON.stringify({ sessions: [session] }) };
    }
    return { ok: false, out: "" };
  };
  return me;
};
/** A fake Infisical CLI per home: its version, its session's state, and every command it ran. */
const infisicalCli = new Map<string, { version: string; status: string; calls: string[][] }>();
const cli = (home: string, status = "authenticated", version = "0.43.145") => {
  const me = { version, status, calls: [] as string[][] };
  infisicalCli.set(home, me);
  return me;
};
const infisical = (home: string, email: string, session: string) => {
  mkdirSync(join(home, ".infisical"), { recursive: true });
  mkdirSync(join(home, "infisical-keyring"), { recursive: true });
  writeFileSync(
    join(home, ".infisical/infisical-config.json"),
    JSON.stringify({
      loggedInUserEmail: email,
      loggedInUsers: [{ email }, { email: "other@example.com" }],
      vaultBackendType: "file",
      vaultBackendPassphrase: "cGFzcw==",
    }),
  );
  writeFileSync(join(home, "infisical-keyring", email), session);
};

test("a machine without gh or Infisical shares nothing", async () => {
  const a = node("a"),
    home = join(temp, "empty");
  on(home);
  expect(await shareLogins(a)).toEqual([
    { id: "github", skipped: "gh is not logged in to github.com (gh auth login)" },
    { id: "infisical", skipped: "the Infisical CLI is not logged in" },
  ]);
  expect(a.list("login")).toEqual([]);
  // Infisical in the system keychain cannot be read; the user is told how to move it.
  mkdirSync(join(home, ".infisical"), { recursive: true });
  writeFileSync(
    join(home, ".infisical/infisical-config.json"),
    JSON.stringify({ loggedInUserEmail: "me@example.com", vaultBackendType: "auto" }),
  );
  expect((await shareLogins(a, "infisical"))[0]!.skipped).toContain("infisical vault set file");
});

test("other machines sign in with a shared login once, and again when the sharing machine's login changes", async () => {
  const a = node("a"),
    b = node("b"),
    homeA = join(temp, "a"),
    homeB = join(temp, "b");
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
  expect(JSON.parse(readFileSync(join(homeB, ".infisical/infisical-config.json"), "utf8")).loggedInUsers).toEqual([
    { email: "me@example.com" },
  ]);
  expect(listLogins(b).map((l) => [l.id, l.signedIn])).toEqual([
    ["github", true],
    ["infisical", true],
  ]);

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
  const a = node("a"),
    b = node("b");
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

test("an Infisical machine identity is checked, written on every machine, and removed everywhere when forgotten", async () => {
  const a = node("a"),
    b = node("b"),
    homeA = join(temp, "id-a"),
    homeB = join(temp, "id-b");
  const file = (home: string) => join(home, ".infisical", "universal-auth.json");
  const identity = { clientId: "client-1", clientSecret: "secret-1", siteUrl: "https://eu.infisical.com/api" };
  const original = globalThis.fetch;
  const logins: unknown[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    logins.push([url, JSON.parse(String(init.body))]);
    return new Response("{}", { status: JSON.parse(String(init.body)).clientSecret === "secret-1" ? 200 : 401 });
  }) as unknown as typeof fetch;
  try {
    on(homeA);
    await expect(setInfisicalIdentity(a, identity)).rejects.toThrow("Update agentgate on a, b first");
    for (const s of [a, b]) for (const id of ["a", "b"]) s.put("node", id, { id, protocol: 5 });
    await expect(setInfisicalIdentity(a, { ...identity, clientSecret: "wrong" })).rejects.toThrow("did not accept");
    expect(a.list("login")).toEqual([]);

    await setInfisicalIdentity(a, identity);
    expect(logins.at(-1)).toEqual([
      "https://eu.infisical.com/api/v1/auth/universal-auth/login",
      { clientId: "client-1", clientSecret: "secret-1" },
    ]);
    // The machine it was set on uses it too; the secret never shows in the listing.
    const written = { clientId: "client-1", clientSecret: "secret-1", siteUrl: "https://eu.infisical.com" };
    expect(JSON.parse(readFileSync(file(homeA), "utf8"))).toEqual(written);
    expect(JSON.stringify(listLogins(a))).not.toContain("secret-1");

    sync(a, b);
    on(homeB);
    await syncLogins(b);
    expect(JSON.parse(readFileSync(file(homeB), "utf8"))).toEqual(written);
    expect(listLogins(b)).toEqual([
      { id: "infisical-identity", account: "client-1", from: "a", signedIn: true, error: undefined, problems: [] },
    ]);

    on(homeA);
    forgetLogin(a, "infisical-identity");
    expect(existsSync(file(homeA))).toBe(false);
    sync(a, b);
    on(homeB);
    await syncLogins(b);
    expect(existsSync(file(homeB))).toBe(false);
  } finally {
    globalThis.fetch = original;
  }
});

test("an expired Infisical session shows as not working on every machine that has it, and where", async () => {
  const a = node("a"),
    b = node("b"),
    homeA = join(temp, "exp-a"),
    homeB = join(temp, "exp-b");
  on(homeA);
  infisical(homeA, "me@example.com", "session-1");
  const cliA = cli(homeA, "expired");
  await shareLogins(a, "infisical");
  await syncLogins(a);
  sync(a, b);
  on(homeB);
  cli(homeB, "expired");
  await syncLogins(b);
  sync(b, a);

  // Signed in here from the files' point of view, but not working, and both machines see where.
  const expired = "the Infisical session expired on 2026-10-27";
  expect(listLogins(a)[0]).toMatchObject({
    problems: [
      { node: "a", problem: expired },
      { node: "b", problem: expired },
    ],
  });
  expect(listLogins(b)[0]).toMatchObject({
    signedIn: true,
    problems: [
      { node: "a", problem: expired },
      { node: "b", problem: expired },
    ],
  });
  // The check is the CLI's own status command, which never starts a login.
  expect(cliA.calls).toContainEqual(["login", "status", "--json"]);

  // A CLI too old for `login status` would take it for a login, so it is not asked and nothing is claimed.
  const old = cli(homeB, "expired", "0.43.85");
  await syncLogins(b);
  expect(old.calls).toEqual([["--version"]]);
  sync(b, a);
  expect(listLogins(a)[0]!.problems.map((p) => p.node)).toEqual(["a"]);

  // Forgetting the login clears this machine's report with it.
  on(homeA);
  forgetLogin(a, "infisical");
  expect(a.get("node", "a")!.loginProblems).toBeUndefined();
});

test("signing in to Infisical again shares the fresh session, after which every machine works", async () => {
  const a = node("a"),
    b = node("b"),
    homeA = join(temp, "sign-a"),
    homeB = join(temp, "sign-b");
  on(homeA);
  infisical(homeA, "me@example.com", "session-old");
  const config = join(homeA, ".infisical/infisical-config.json");
  writeFileSync(
    config,
    JSON.stringify({
      ...JSON.parse(readFileSync(config, "utf8")),
      activeProfile: "me@example.com",
      profiles: [
        { name: "other", email: "other@example.com" },
        { name: "me@example.com", email: "me@example.com" },
      ],
    }),
  );
  const cliA = cli(homeA, "expired");
  await shareLogins(a, "infisical");
  await syncLogins(a);
  sync(a, b);
  on(homeB);
  cli(homeB, "expired");
  await syncLogins(b);

  on(homeA);
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fake = host.infisical;
  host.infisical = async (args, o = {}) => {
    if (args[0] !== "login" || args[1] !== "--profile") return fake(args, o);
    cliA.calls.push(args);
    o.stderr?.(
      "\n\nTo complete your login, open this address in your browser: https://eu.infisical.com/login?callback_port=4242 \n",
    );
    await finished;
    writeFileSync(join(homeA, "infisical-keyring/me@example.com"), "session-new");
    cliA.status = "authenticated";
    return { ok: true, out: "" };
  };

  // The daemon answers with the browser address while the login waits for the browser.
  expect(await startInfisicalSignIn(a)).toBe("https://eu.infisical.com/login?callback_port=4242");
  expect(cliA.calls).toContainEqual(["login", "--profile", "me@example.com"]);
  finish();
  // The share follows the finished login in the background.
  while (!JSON.stringify(a.get("login", "infisical")).includes("session-new")) await Bun.sleep(1);
  await syncLogins(a);
  sync(a, b);
  on(homeB);
  infisicalCli.get(homeB)!.status = "authenticated";
  await syncLogins(b);
  expect(readFileSync(join(homeB, "infisical-keyring/me@example.com"), "utf8")).toBe("session-new");
  sync(b, a);
  expect(listLogins(a)[0]!.problems).toEqual([]);
});

test("signing in to Infisical fails plainly when the CLI here has no login for the shared account", async () => {
  const a = node("a"),
    home = join(temp, "sign-none");
  on(home);
  infisical(home, "me@example.com", "session-1");
  cli(home);
  await shareLogins(a, "infisical");
  writeFileSync(
    join(home, ".infisical/infisical-config.json"),
    JSON.stringify({ loggedInUserEmail: "other@example.com", vaultBackendType: "file" }),
  );
  await expect(signInInfisical(a)).rejects.toThrow("has no login for me@example.com");
});

test("a GitHub token GitHub no longer accepts shows as not working", async () => {
  const a = node("a");
  on(join(temp, "gh-revoked")).token = "gho_revoked";
  await shareLogins(a, "github");
  github = 401;
  try {
    await syncLogins(a);
  } finally {
    github = 200;
  }
  expect(listLogins(a)[0]!.problems).toEqual([
    {
      node: "a",
      problem: "GitHub rejected the shared token; run gh auth login on a, then agentgate logins share github",
    },
  ]);
  await syncLogins(a);
  expect(listLogins(a)[0]!.problems).toEqual([]);
});
