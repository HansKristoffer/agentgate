import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { typedSwitch } from "hanzio";
import { atomicWrite } from "./files.ts";
import { liveOnly, type Data, type Store } from "./store.ts";

/**
 * The GitHub CLI (gh) and Infisical CLI logins of one machine, shared with every paired machine so a new server clones
 * and reads secrets as the user. Nothing is shared until `agentgate logins share` runs on a machine that has the login.
 * The sharing node re-reads it each round, so a refreshed or replaced login follows; every other node signs in with it
 * whenever it changes.
 *
 * An Infisical user login expires and cannot be renewed, so for tools that run unattended the user can also set an
 * Infisical machine identity (Universal Auth) here. Every node, the one it was set on included, keeps it in
 * ~/.infisical/universal-auth.json, which hanzio reads when its process has no client credentials; forgetting it
 * removes that file everywhere.
 */

/** The node protocol that understands `login` records (see NODE_PROTOCOL in remote.ts). */
export const LOGINS_PROTOCOL = 4;
/** The node protocol that understands the `infisical-identity` login. */
export const IDENTITY_PROTOCOL = 5;
type Login = Data<"login">;
type LoginId = Login["id"];
/** Logins read from this machine's own tools; the machine identity is entered instead. */
const SHAREABLE = ["github", "infisical"] as const;
const IDENTITY = "infisical-identity";

/** The user's home and the `gh` command; tests point both elsewhere. */
export const host = {
  home: homedir(),
  async gh(args: string[], stdin?: string): Promise<{ ok: boolean; out: string } | undefined> {
    if (!Bun.which("gh")) return undefined;
    const child = Bun.spawn(["gh", ...args], {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      timeout: 30_000,
    });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { ok: code === 0, out: out.trim() };
  },
};
const realHome = (what: string) => {
  if (host.home === homedir()) liveOnly(what);
};
const infisical = () => ({
  config: join(host.home, ".infisical", "infisical-config.json"),
  keyring: join(host.home, "infisical-keyring"),
  identity: join(host.home, ".infisical", "universal-auth.json"),
});
const requireProtocol = (s: Store, protocol: number) => {
  const old = s.list("node").filter((n) => (n.protocol ?? 0) < protocol).map((n) => n.id);
  if (old.length) throw new Error(`Update agentgate on ${old.join(", ")} first: older versions can't sync this login`);
};

/** This machine's login, or why it has none to share. */
async function read(s: Store, id: (typeof SHAREABLE)[number]): Promise<Login | string> {
  if (id === "github") {
    const token = await host.gh(["auth", "token", "--hostname", "github.com"]);
    if (!token) return "gh is not installed";
    if (!token.ok || !token.out) return "gh is not logged in to github.com (gh auth login)";
    const user = await host.gh(["config", "get", "--host", "github.com", "user"]);
    return { id, from: s.nodeId, account: user?.ok ? user.out : "", token: token.out };
  }

  const files = infisical();
  if (!existsSync(files.config)) return "the Infisical CLI is not logged in";
  let config;
  try {
    config = JSON.parse(readFileSync(files.config, "utf8"));
  } catch {
    return "the Infisical CLI config could not be read";
  }
  const email = config?.loggedInUserEmail;
  if (typeof email !== "string" || !email) return "the Infisical CLI is not logged in";
  if (config.vaultBackendType !== "file") {
    return "the Infisical CLI keeps its login in the system keychain; run `infisical vault set file`, then `infisical login`";
  }
  const entry = join(files.keyring, email);
  if (!existsSync(entry)) return "the Infisical login file is missing; run `infisical login`";

  // Only the signed-in user: other machines get no keyring files for the rest.
  const users = Array.isArray(config.loggedInUsers)
    ? config.loggedInUsers.filter((u: { email?: unknown }) => u?.email === email)
    : [];
  const shared = JSON.stringify({ ...config, loggedInUsers: users }, null, 2);
  return { id, from: s.nodeId, account: email, config: shared, keyring: readFileSync(entry, "utf8") };
}

/** Sign this machine in with a login another machine shared. */
async function apply(l: Login) {
  await typedSwitch(l, "id", {
    [IDENTITY]: (l) => {
      atomicWrite(infisical().identity, JSON.stringify({ clientId: l.account, clientSecret: l.clientSecret, siteUrl: l.siteUrl }, null, 2));
    },
    github: async (l) => {
      const current = await host.gh(["auth", "token", "--hostname", "github.com"]);
      if (!current) throw new Error("install gh to sign in to GitHub");
      if (!current.ok || current.out !== l.token) {
        const login = await host.gh(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token"], l.token);
        if (!login?.ok) throw new Error("gh auth login failed");
      }
      // git itself uses gh's login over HTTPS, which is how T3 Code clones synced projects.
      const git = await host.gh(["auth", "setup-git", "--hostname", "github.com"]);
      if (!git?.ok) throw new Error("gh auth setup-git failed");
    },
    infisical: (l) => {
      const files = infisical();
      const entry = join(files.keyring, l.account);
      for (const file of [files.config, entry]) {
        const backup = `${file}.before-agentgate`;
        if (existsSync(file) && !existsSync(backup)) copyFileSync(file, backup);
      }
      atomicWrite(entry, l.keyring);
      atomicWrite(files.config, l.config);
    },
  });
}

const state = (s: Store, id: LoginId): { hash?: string; error?: string } => JSON.parse(s.local(`login:${id}`) ?? "{}");
const setState = (s: Store, id: LoginId, value: { hash?: string; error?: string }) => s.setLocal(`login:${id}`, JSON.stringify(value));
const hash = (l: Login) => new Bun.CryptoHasher("sha256").update(JSON.stringify(l)).digest("hex");

/** Share this machine's logins with every node. Logins this machine does not use are skipped, never shared. */
export async function shareLogins(s: Store, only?: LoginId) {
  realHome("Sharing this machine's logins");
  requireProtocol(s, LOGINS_PROTOCOL);
  if (only === IDENTITY) throw new Error("set the Infisical machine identity with agentgate logins identity");

  const out: { id: LoginId; account?: string; skipped?: string }[] = [];
  for (const id of only ? [only] : SHAREABLE) {
    const login = await read(s, id);
    if (typeof login === "string") {
      out.push({ id, skipped: login });
      continue;
    }
    s.put("login", id, login);
    setState(s, id, { hash: hash(login) });
    out.push({ id, account: login.account });
  }
  return out;
}

/** The Infisical instance this machine's CLI is signed in to, else Infisical Cloud (US). */
export function infisicalSite() {
  try {
    const domain = JSON.parse(readFileSync(infisical().config, "utf8"))?.LoggedInUserDomain;
    if (typeof domain === "string" && domain) return new URL(domain).origin;
  } catch { } // no CLI config
  return "https://app.infisical.com";
}

/** Check an Infisical machine identity with Infisical, then keep it on every machine. */
export async function setInfisicalIdentity(s: Store, input: { clientId: string; clientSecret: string; siteUrl: string }) {
  realHome("Setting the Infisical machine identity");
  requireProtocol(s, IDENTITY_PROTOCOL);
  const siteUrl = new URL(input.siteUrl).origin;
  const res = await fetch(`${siteUrl}/api/v1/auth/universal-auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ clientId: input.clientId, clientSecret: input.clientSecret }),
  }).catch(() => { throw new Error(`Infisical at ${siteUrl} is not reachable`); });
  await res.body?.cancel();
  if (!res.ok) throw new Error(`Infisical at ${siteUrl} did not accept this client id and secret (${res.status})`);
  s.put("login", IDENTITY, { id: IDENTITY, from: s.nodeId, account: input.clientId, clientSecret: input.clientSecret, siteUrl });
  await syncLogins(s);
}

/** Stop sharing a login. Machines already signed in stay signed in; the machine identity leaves every machine. */
export function forgetLogin(s: Store, id: LoginId) {
  if (!s.get("login", id)) throw new Error(`${id} is not shared`);
  if (id === IDENTITY) realHome("Forgetting the Infisical machine identity");
  s.del("login", id);
  if (id === IDENTITY) rmSync(infisical().identity, { force: true });
  s.setLocal(`login:${id}`, undefined);
}

/** One daemon round: the sharing node re-reads its logins, every other node signs in with any that changed. */
export async function syncLogins(s: Store) {
  for (const l of s.list("login")) {
    if (l.from === s.nodeId && l.id !== IDENTITY) {
      const current = await read(s, l.id);
      if (typeof current === "string") {
        setState(s, l.id, { error: `${current}; other machines keep the last shared login` });
        continue;
      }
      if (hash(current) !== hash(l)) s.put("login", l.id, current);
      setState(s, l.id, { hash: hash(current) });
      continue;
    }

    if (state(s, l.id).hash === hash(l)) continue;
    try {
      await apply(l);
      setState(s, l.id, { hash: hash(l) });
      s.log(l.id, l.account, "", 0, 0, `signed in with the login shared from ${l.from}`);
    } catch (e) {
      setState(s, l.id, { error: (e as Error).message });
    }
  }
  // A forgotten machine identity must stop being used here too, or tools keep authenticating with it.
  if (!s.get("login", IDENTITY) && s.local(`login:${IDENTITY}`)) {
    rmSync(infisical().identity, { force: true });
    s.setLocal(`login:${IDENTITY}`, undefined);
  }
}

/** Shared logins and whether this machine uses them. Never includes the secrets. */
export function listLogins(s: Store) {
  return s.list("login").map((l) => {
    const local = state(s, l.id);
    const signedIn = !local.error && local.hash === hash(l);
    return { id: l.id, account: l.account, from: l.from, signedIn, error: local.error };
  });
}
