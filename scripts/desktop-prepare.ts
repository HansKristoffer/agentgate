// Compiles the daemon the desktop app bundles into apps/desktop/binaries/agentgate: for this
// machine, or with --universal for both Mac architectures joined by lipo.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const out = resolve(root, "apps/desktop/binaries/agentgate");
mkdirSync(resolve(out, ".."), { recursive: true });

async function run(cmd: string[]) {
  const child = Bun.spawn(cmd, { cwd: root, stdio: ["inherit", "inherit", "inherit"] });
  if ((await child.exited) !== 0) process.exit(1);
}
const compile = (target: string, outfile: string) =>
  run([process.execPath, "build", resolve(root, "apps/agentgate/src/cli.ts"), "--compile", "--minify", `--target=bun-${target}`, "--outfile", outfile]);

const os = { darwin: "darwin", linux: "linux" }[process.platform as string];
if (!os) throw new Error(`Unsupported Agentgate daemon platform: ${process.platform}`);
if (!process.argv.includes("--universal")) await compile(`${os}-${process.arch}`, out);
else {
  const slices = ["darwin-arm64", "darwin-x64"];
  for (const slice of slices) await compile(slice, `${out}-${slice}`);
  await run(["lipo", "-create", ...slices.map((s) => `${out}-${s}`), "-output", out]);
}
