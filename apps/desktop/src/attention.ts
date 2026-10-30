import { outdatedNodes, type AccountStatus, type Status } from "@agentgate/protocol";

export type Page = "accounts" | "servers" | "skills" | "projects" | "nodes";
/** `signIn`: signing in to Infisical again, from the daemon's own machine, fixes it. */
export type Problem = { key: string; page: Page; title: string; detail?: string; signIn?: boolean };
const loginName = { github: "GitHub", infisical: "Infisical", "infisical-identity": "Infisical machine identity" };

/** What an account needs before it can serve sessions again, or undefined while it works. Overview and Accounts both
 * label accounts with it. */
export const accountProblem = (a: AccountStatus) =>
  a.waitingFor
    ? `Waiting for ${a.waitingFor}`
    : a.needsLogin || a.expired
      ? "Needs sign-in"
      : a.refreshError
        ? "Refresh failed"
        : !a.account.enabled
          ? "Disabled"
          : a.exhausted
            ? "Limit reached"
            : undefined;

/** Everything the user has to fix by hand, each pointing at the page where they fix it. States that clear on their own
 * (a reached limit, an offline laptop, a login another machine refreshes) or that the user chose (a disabled account)
 * are left out. */
export function problems(
  data: Pick<
    Status,
    | "accounts"
    | "servers"
    | "skillHealth"
    | "skillConflicts"
    | "skillRepos"
    | "fileErrors"
    | "nodes"
    | "relay"
    | "logins"
  >,
): Problem[] {
  const list: Problem[] = [];
  for (const a of data.accounts) {
    const problem = accountProblem(a);
    if (problem === "Needs sign-in")
      list.push({ key: `account:${a.account.id}`, page: "accounts", title: `Sign in to ${a.account.label} again` });
    else if (problem === "Refresh failed")
      list.push({
        key: `account:${a.account.id}`,
        page: "accounts",
        title: `${a.account.label} couldn't refresh its login`,
        detail: a.refreshError,
      });
  }
  for (const s of data.servers) {
    const name = s.label ?? s.id;
    const key = `server:${s.id}`;
    if (s.needsLogin) list.push({ key, page: "servers", title: `Sign in to ${name}` });
    else if (s.available === false || s.refreshError)
      list.push({ key, page: "servers", title: `${name} can't connect`, detail: s.refreshError });
  }
  const skillErrors = data.skillHealth.errors.length + data.skillConflicts.length;
  if (skillErrors)
    list.push({
      key: "skills",
      page: "skills",
      title: `${skillErrors} ${skillErrors === 1 ? "skill" : "skills"} couldn't be linked`,
      detail: [...data.skillHealth.errors.map((e) => e.path), ...data.skillConflicts].join(", "),
    });
  for (const r of data.skillRepos.filter((r) => r.error))
    list.push({
      key: `repo:${r.url}`,
      page: "skills",
      title: `${r.url.replace("https://github.com/", "")} couldn't sync`,
      detail: r.error,
    });
  for (const [project, error] of Object.entries(data.fileErrors))
    list.push({
      key: `files:${project}`,
      page: "projects",
      title: `Env files for ${project} aren't syncing`,
      detail: error,
    });
  const outdated = outdatedNodes(data.nodes);
  if (outdated.length)
    list.push({
      key: "outdated",
      page: "nodes",
      title: `${outdated.length} ${outdated.length === 1 ? "machine" : "machines"} on an older version`,
      detail: `${outdated.map((n) => n.id).join(", ")}. Paired machines work best on the same release.`,
    });
  for (const n of data.nodes) {
    if (n.update?.state === "failed")
      list.push({ key: `update:${n.id}`, page: "nodes", title: `Update failed on ${n.id}`, detail: n.update.error });
    // An offline machine fails to sync until it is back, which is expected.
    else if (n.online && n.syncError)
      list.push({ key: `sync:${n.id}`, page: "nodes", title: `${n.id} isn't syncing`, detail: n.syncError });
  }
  // In place but not working, e.g. a shared Infisical session that expired on every machine at once.
  for (const l of data.logins.filter((l) => l.problems.length)) {
    const reasons = [...new Set(l.problems.map((p) => p.problem))];
    list.push({
      key: `login:${l.id}`,
      page: "nodes",
      title: `The ${loginName[l.id]} login doesn't work on ${l.problems.map((p) => p.node).join(", ")}`,
      detail: `${l.account}: ${reasons.length === 1 ? reasons[0] : l.problems.map((p) => `${p.node}: ${p.problem}`).join("; ")}`,
      signIn: l.id === "infisical",
    });
  }
  const relay = data.relay?.pushError ?? data.relay?.pullError;
  if (relay) list.push({ key: "relay", page: "nodes", title: "The relay isn't syncing", detail: relay });
  return list;
}
