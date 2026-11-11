import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { getErrorMessage } from "hanzio";
import { join } from "node:path";
import { projectIdSchema, projectSchema } from "@agentgate/protocol";
import { canonicalProject, parseRemote, scanRepos } from "../mcp/gateway.ts";
import { z } from "zod";
import { defineLocal } from "../local-state.ts";
import { registeredCheckouts } from "../skill-links.ts";
import { run } from "./code.ts";
import type { Handoffs } from "./jobs.ts";
import { T3PermissionError, t3Client, t3Local, t3State, type T3 } from "./t3.ts";

/** Every T3 project's checkout is registered for skill links, whatever the setting: Claude Code and Codex read skills
 * before the shim could report the checkout, so a project T3 cloned or the user added would miss them the first time.
 *
 * T3 project sync (the `t3ProjectSync` setting). Each node marks the GitHub repositories its T3 Code has as projects
 * by setting `t3Title` on the synced project record, once. Each node adds every marked repository its T3 Code lacks,
 * reusing a checkout it already has or letting T3 clone it with this machine's GitHub login. Additions only:
 * removing a T3 project stays on that machine, and a repository this node had once is never added again. A clone
 * counts once it has arrived: removing a failed clone in T3 lets the next round try again. */

// Renamed from t3:knownRepos, which also held clones that never arrived.
const KNOWN = defineLocal("t3:repos", z.array(z.string()));
const OLD_KNOWN = defineLocal("t3:knownRepos", z.string());
/** Clones this node started, as lowercase `owner/repo` → destination. Whatever arrives there counts, even when its
 * origin names another repository: GitHub redirects a renamed one, so a clone of `old/name` checks out `new/name`. */
const CLONES = defineLocal("t3:clones", z.record(z.string(), z.string()));

/** T3 projects on this node, with the GitHub `owner/repo` and origin URL of those whose checkout has one. */
export async function t3Projects(t3: T3) {
  const out: { repo?: string; origin?: string; project: Awaited<ReturnType<T3["shell"]>>["projects"][number] }[] = [];
  for (const project of (await t3.shell()).projects) {
    const origin = await originOf(project.workspaceRoot);
    const repo = github(origin) ? parseRemote(origin) : undefined;
    out.push(repo && projectIdSchema.safeParse(repo).success ? { repo, origin, project } : { project });
  }
  return out;
}

/** A checkout's origin URL, or "". Sync runs every 30 s over every T3 project, so a main checkout's config is read
 * rather than spawning git, as scanRepos does. A worktree's .git is a file and a folder inside a checkout has none:
 * those ask git. */
async function originOf(path: string) {
  if (!existsSync(path)) return "";
  const config = join(path, ".git", "config");
  if (!existsSync(config)) return (await run(path, ["config", "--get", "remote.origin.url"])).out;
  const url = readFileSync(config, "utf8").match(/\[remote "origin"\][^[]*?\burl\s*=\s*(.+)/)?.[1];
  return url?.trim() ?? "";
}

// ponytail: an SSH host alias (git@github-work:…) is not recognised; match on `gh` hosts if anyone uses one.
const github = (url: string) => /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?(?:www\.)?github\.com[:/]/i.test(url.trim());

export async function syncT3Projects(h: Handoffs) {
  const s = h.s;
  // Shown with the T3 connection (t3State).
  const report = (errors: string[]) => {
    t3Local.set(s, "projectSyncError", errors.length ? errors.join("; ") : undefined);
  };
  if (!t3State(s).connected) return report([]);
  const t3 = t3Client(s);
  // T3 Code not running is normal on a laptop, and the T3 connection status already says so: try next round.
  const all = await t3Projects(t3).catch(() => undefined);
  if (!all) return report([]);
  const here = all.filter((p): p is typeof p & { repo: string; origin: string } => !!p.repo);
  // Registering spawns git; a checkout already registered for its repository needs none.
  const registered = registeredCheckouts(s);
  const isRegistered = (path: string, repo: string) => {
    try {
      return registered[realpathSync(path)]?.toLowerCase() === canonicalProject(s, repo).toLowerCase();
    } catch {
      return false;
    }
  };
  const fresh = here.filter((p) => !isRegistered(p.project.workspaceRoot, p.repo));
  if (fresh.length) h.register(fresh.map((p) => ({ path: p.project.workspaceRoot, project: p.repo })));
  if (!s.settings().t3ProjectSync) return report([]);
  OLD_KNOWN.set(s, undefined, undefined);
  const known = new Set(KNOWN.get(s));
  const remember = (repo: string) => {
    known.add(repo.toLowerCase());
    KNOWN.set(s, undefined, [...known]);
  };
  const clones = CLONES.get(s) ?? {};
  const saveClones = () => CLONES.set(s, undefined, Object.keys(clones).length ? clones : undefined);
  // Repositories by error, so a cause they share is said once.
  const errors = new Map<string, string[]>();
  // A permission T3 Code refused is refused for every clone; stop asking until agentgate is paired again.
  let denied: string | undefined;

  // T3 clones over SSH unless told otherwise; follow how this machine's checkouts reach GitHub, HTTPS by default.
  const protocol = here.length && here.every((p) => !/^https:/i.test(p.origin)) ? "ssh" : "https";
  for (const { repo, project } of here) {
    remember(repo);
    const id = canonicalProject(s, repo);
    const record = s.get("project", id);
    if (!record?.t3Title) s.put("project", id, { ...(record ?? projectSchema.parse({ id })), t3Title: project.title });
  }

  // A clone that arrived under the name it was started with is known now.
  for (const key of Object.keys(clones)) if (known.has(key)) delete clones[key];
  saveClones();

  const local = localCheckouts(h);
  for (const p of s.list("project")) {
    if (!p.t3Title || known.has(p.id.toLowerCase())) continue;
    try {
      const key = p.id.toLowerCase();
      const path = local.get(key);
      // The project T3 Code keeps for a clone this node started: without a checkout yet, it is running or failed.
      const started = clones[key] && all.find((a) => a.project.workspaceRoot === clones[key]);
      if (path) {
        await t3.rpc((call) =>
          call("projects.mutate", {
            type: "project.create",
            commandId: crypto.randomUUID(),
            projectId: crypto.randomUUID(),
            title: p.t3Title,
            workspaceRoot: path,
          }),
        );
        remember(p.id);
      } else if (started) {
        if (started.repo) remember(p.id);
      } else if (!denied) {
        const name = p.id.split("/")[1]!;
        mkdirSync(h.options.cloneDir, { recursive: true });
        let dir = join(h.options.cloneDir, name);
        for (let n = 2; existsSync(dir); n++) dir = join(h.options.cloneDir, `${name}-${n}`);
        // T3 registers the project at once and clones in the background, showing progress in its sidebar.
        await t3.rpc((call) =>
          call("projectClone.start", {
            projectId: crypto.randomUUID(),
            title: p.t3Title,
            createdAt: new Date(s.now()).toISOString(),
            provider: "github",
            repository: p.id,
            destinationPath: dir,
            protocol,
          }),
        );
        clones[key] = dir;
        saveClones();
      }
    } catch (e) {
      if (e instanceof T3PermissionError) denied = e.message;
      else {
        const message = getErrorMessage(e);
        errors.set(message, [...(errors.get(message) ?? []), p.id]);
      }
    }
  }
  report([...(denied ? [denied] : []), ...[...errors].map(([message, repos]) => `${repos.join(", ")}: ${message}`)]);
}

/** This node's main checkouts by lowercase `owner/repo`: registered ones, then clones in the clone folder. */
function localCheckouts(h: Handoffs) {
  const found = new Map<string, string>();
  const add = (repo: string, path: string) => {
    if (existsSync(join(path, ".git")) && !found.has(repo.toLowerCase())) found.set(repo.toLowerCase(), path);
  };
  for (const [path, repo] of Object.entries(registeredCheckouts(h.s))) add(repo, path);
  if (existsSync(h.options.cloneDir)) for (const { repo, path } of scanRepos(h.options.cloneDir)) add(repo, path);
  return found;
}
