import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const target =
  process.env.TAURI_ENV_TARGET_TRIPLE ??
  Bun.spawnSync(["rustc", "-vV"])
    .stdout.toString()
    .match(/^host: (.+)$/m)?.[1];

// `tauri_build::build()` requires the sidecar path declared in tauri.conf.json to exist on disk.
// On a fresh checkout that has not built the sidecar yet, create a temporary empty placeholder for clippy.
let placeholder: string | undefined;
if (target) {
  const dir = resolve(root, "apps/desktop/src-tauri/binaries");
  const file = resolve(dir, `agentgate-${target}`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "");
    placeholder = file;
  }
}

try {
  const child = Bun.spawn(
    [
      "cargo",
      "clippy",
      "--manifest-path",
      "apps/desktop/src-tauri/Cargo.toml",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ],
    { cwd: root, stdio: ["inherit", "inherit", "inherit"] },
  );
  process.exit(await child.exited);
} finally {
  if (placeholder) rmSync(placeholder, { force: true });
}
