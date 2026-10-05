import { appendFileSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Real git repositories for handoff tests: a bare origin reached through a GitHub-style URL (so `parseRemote` knows
 * the repository) via a private global git config, and clones of it. */
const config = join(realpathSync(mkdtempSync(join(tmpdir(), "agentgate-gitconfig-"))), "config");
writeFileSync(config, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
process.env.GIT_CONFIG_GLOBAL = config;
process.env.GIT_CONFIG_NOSYSTEM = "1";

export const tmp = (prefix = "agentgate-test-") => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

export function sh(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", env: process.env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

let n = 0;
/** An origin with one pushed commit, and `clones` clones of it. */
export function repos<K extends string>(...clones: K[]) {
  const root = tmp();
  const origin = join(root, "origin.git");
  const url = `https://github.com/test/repo${++n}.git`;
  appendFileSync(config, `[url "${origin}"]\n\tinsteadOf = ${url}\n`);
  sh(root, "init", "--bare", "-b", "main", origin);
  const seed = join(root, "seed");
  sh(root, "clone", url, seed);
  writeFileSync(join(seed, "README.md"), "hello\n");
  writeFileSync(join(seed, "old.txt"), "to be deleted\n");
  writeFileSync(join(seed, ".gitignore"), "node_modules\n");
  sh(seed, "add", "-A"); sh(seed, "commit", "-m", "init"); sh(seed, "push", "origin", "main");
  const paths = Object.fromEntries(clones.map((c) => { const p = join(root, c); sh(root, "clone", url, p); return [c, p]; }));
  return { root, origin, url, ...paths } as { root: string; origin: string; url: string } & Record<K, string>;
}
