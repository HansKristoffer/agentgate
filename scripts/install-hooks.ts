import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
if (!existsSync(resolve(root, ".git")) || !Bun.which("git")) process.exit(0);

const current = Bun.spawnSync(["git", "config", "--get", "core.hooksPath"], { cwd: root }).stdout.toString().trim();
if (current === ".githooks") process.exit(0);

Bun.spawnSync(["git", "config", "core.hooksPath", ".githooks"], {
  cwd: root,
  stdio: ["ignore", "ignore", "ignore"],
});
