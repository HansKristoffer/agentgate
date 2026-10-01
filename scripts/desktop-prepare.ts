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
const universal = target === "universal-apple-darwin";
if (!target || (!universal && !targets[target]))
  throw new Error(`Unsupported Agentgate daemon target: ${target}`);
const dir = resolve(root, "apps/desktop/src-tauri/binaries");
mkdirSync(dir, { recursive: true });

async function run(cmd: string[]) {
  const child = Bun.spawn(cmd, {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if ((await child.exited) !== 0) process.exit(1);
}
const compile = (triple: string) =>
  run([
    process.execPath,
    "build",
    resolve(root, "apps/agentgate/src/cli.ts"),
    "--compile",
    "--minify",
    `--target=bun-${targets[triple]}`,
    "--outfile",
    `${dir}/agentgate-${triple}`,
  ]);

if (!universal) await compile(target);
else {
  // Each arch build needs its own slice and the universal bundle one fat
  // sidecar holding both, joined by lipo.
  const slices = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
  for (const slice of slices) await compile(slice);
  await run([
    "lipo",
    "-create",
    ...slices.map((s) => `${dir}/agentgate-${s}`),
    "-output",
    `${dir}/agentgate-${target}`,
  ]);
}
