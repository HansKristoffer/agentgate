import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { projectIdSchema, projectSchema } from "@agentgate/protocol";
import { canonicalProject, parseRemote, scanRepos } from "../mcp/gateway.ts";
import { run } from "./code.ts";
import type { Handoffs } from "./jobs.ts";
import { t3Client, t3State, type T3 } from "./t3.ts";

/** T3 project sync (the `t3ProjectSync` setting). Each node marks the GitHub repositories its T3 Code has as projects
 * by setting `t3Title` on the synced project record, once. Each node adds every marked repository its T3 Code lacks,
 * reusing a checkout it already has or letting T3 clone it with this machine's GitHub login. Additions only:
 * removing a T3 project stays on that machine, and a repository this node had once is never added again. */

const KNOWN = "t3:knownRepos";

/** T3 projects on this node with the GitHub `owner/repo` of their origin. */
export async function t3Projects(t3: T3) {
  const out: { repo: string; project: Awaited<ReturnType<T3["shell"]>>["projects"][number] }[] = [];
  for (const project of (await t3.shell()).projects) {
    if (!existsSync(project.workspaceRoot)) continue;
    const origin = (await run(project.workspaceRoot, ["config", "--get", "remote.origin.url"])).out;
    const repo = github(origin) ? parseRemote(origin) : undefined;
    if (repo && projectIdSchema.safeParse(repo).success) out.push({ repo, project });
  }
  return out;
}

// ponytail: an SSH host alias (git@github-work:…) is not recognised; match on `gh` hosts if anyone uses one.
const github = (url: string) => /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?(?:www\.)?github\.com[:/]/i.test(url.trim());

export async function syncT3Projects(h: Handoffs) {
  const s = h.s;
  const report = (errors: string[]) => s.setLocal("t3:projectSyncError", errors.length ? errors.join("; ") : undefined);
  if (!s.settings().t3ProjectSync || !t3State(s).connected) return report([]);
  const t3 = t3Client(s);
  const known = new Set<string>(JSON.parse(s.local(KNOWN) ?? "[]"));
  const remember = (repo: string) => { known.add(repo.toLowerCase()); s.setLocal(KNOWN, JSON.stringify([...known])); };
  const errors: string[] = [];

  // T3 Code not running is normal on a laptop, and the T3 connection status already says so: try next round.
  const here = await t3Projects(t3).catch(() => undefined);
  if (!here) return report([]);
  for (const { repo, project } of here) {
    remember(repo);
    const id = canonicalProject(s, repo);
    const record = s.get("project", id);
    if (!record?.t3Title) s.put("project", id, { ...(record ?? projectSchema.parse({ id })), t3Title: project.title });
  }

  const local = localCheckouts(h);
  for (const p of s.list("project")) {
    if (!p.t3Title || known.has(p.id.toLowerCase())) continue;
    try {
      const path = local.get(p.id.toLowerCase());
      if (path) {
        await t3.rpc((call) => call("projects.mutate", { type: "project.create", commandId: crypto.randomUUID(), projectId: crypto.randomUUID(), title: p.t3Title, workspaceRoot: path }));
      } else {
        const name = p.id.split("/")[1]!;
        mkdirSync(h.options.cloneDir, { recursive: true });
        let dir = join(h.options.cloneDir, name);
        for (let n = 2; existsSync(dir); n++) dir = join(h.options.cloneDir, `${name}-${n}`);
        // T3 registers the project at once and clones in the background, showing progress in its sidebar.
        await t3.rpc((call) => call("projectClone.start", {
          projectId: crypto.randomUUID(), title: p.t3Title, createdAt: new Date(s.now()).toISOString(),
          provider: "github", repository: p.id, destinationPath: dir,
        }));
      }
      remember(p.id);
    } catch (e) {
      errors.push(`${p.id}: ${(e as Error).message}`);
    }
  }
  report(errors);
}

/** This node's main checkouts by lowercase `owner/repo`: registered ones, then clones in the clone folder. */
function localCheckouts(h: Handoffs) {
  const found = new Map<string, string>();
  const add = (repo: string, path: string) => { if (existsSync(join(path, ".git")) && !found.has(repo.toLowerCase())) found.set(repo.toLowerCase(), path); };
  let registered: Record<string, string> = {};
  try { registered = JSON.parse(h.s.local("checkouts") ?? "{}"); } catch { } // SkillLinks.checkouts()
  for (const [path, repo] of Object.entries(registered)) add(repo, path);
  if (existsSync(h.options.cloneDir)) for (const { repo, path } of scanRepos(h.options.cloneDir)) add(repo, path);
  return found;
}
