// `bun run build:desktop [--universal]`: apps/desktop/dist/Agentgate.app with the compiled daemon
// inside. Signed with the hardened runtime as APPLE_SIGNING_IDENTITY when that is set, ad hoc otherwise.
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";

if (process.platform !== "darwin") throw new Error("The desktop app is built on macOS");
const root = resolve(import.meta.dir, "..");
const desktop = resolve(root, "apps/desktop");
const universal = process.argv.includes("--universal") ? ["--universal"] : [];
const identity = process.env.APPLE_SIGNING_IDENTITY;

async function run(cmd: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(cmd, { cwd: desktop, env: { ...process.env, ...env }, stdio: ["inherit", "inherit", "inherit"] });
  if ((await child.exited) !== 0) process.exit(1);
}

await run([process.execPath, resolve(root, "scripts/desktop-prepare.ts"), ...universal]);
await run(["tinyjs", "build", ...universal], identity ? { TINYJS_SIGN_IDENTITY: identity } : {});

// tinyjs knows nothing of the daemon: put it beside the launcher, where the backend looks for
// it, then reseal the bundle around it. The daemon is a compiled Bun binary: under the hardened
// runtime JavaScriptCore gets no executable memory without allow-jit and falls back to its
// interpreter, measured 50 times slower.
const app = resolve(desktop, "dist/Agentgate.app");
const daemon = `${app}/Contents/MacOS/agentgate`;
copyFileSync(resolve(desktop, "binaries/agentgate"), daemon);
// tinyjs writes neither key. Its runtime needs macOS 15: without the minimum an older Mac would
// start the app and crash rather than say it cannot open it.
const plist = `${app}/Contents/Info.plist`;
const { version } = await Bun.file(resolve(desktop, "tinyjs.json")).json();
await run(["plutil", "-replace", "LSMinimumSystemVersion", "-string", "15.0", plist]);
await run(["plutil", "-replace", "CFBundleShortVersionString", "-string", version, plist]);
const sign = identity ? ["--options", "runtime", "--timestamp", "--sign", identity] : ["--sign", "-"];
await run(["codesign", "--force", "--identifier", "agentgate", "--entitlements", "Entitlements.plist", ...sign, daemon]);
await run(["codesign", "--force", ...sign, app]);
await run(["codesign", "--verify", "--strict", "--deep", app]);
console.log(`Built ${app}`);
