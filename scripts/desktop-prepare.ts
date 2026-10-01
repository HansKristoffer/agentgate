import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const target =
  process.env.TAURI_ENV_TARGET_TRIPLE ??
  Bun.spawnSync(["rustc", "-vV"])
    .stdout.toString()
    .match(/^host: (.+)$/m)?.[1];
const targets: Record<string, string> = {
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-x64",
  "x86_64-unknown-linux-gnu": "linux-x64",
  "aarch64-unknown-linux-gnu": "linux-arm64",
};
if (!target || !targets[target])
  throw new Error(`Unsupported Agentgate daemon target: ${target}`);
const dir = resolve(root, "apps/desktop/src-tauri/binaries");
mkdirSync(dir, { recursive: true });
const child = Bun.spawn(
  [
    process.execPath,
    "build",
    resolve(root, "apps/agentgate/src/cli.ts"),
    "--compile",
    "--minify",
    `--target=bun-${targets[target]}`,
    "--outfile",
    `${dir}/agentgate-${target}`,
  ],
  { cwd: root, stdio: ["inherit", "inherit", "inherit"] },
);
if ((await child.exited) !== 0) process.exit(1);
