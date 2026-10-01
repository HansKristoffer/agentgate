// Packs the compiled binaries in dist/ as npm packages: one per platform plus an `agentpool`
// package that depends on all of them optionally and runs the one npm installed (esbuild-style).
// Usage: bun scripts/npm.ts <version> [--publish]
import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
const version = Bun.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new Error("usage: bun scripts/npm.ts <version> [--publish]");
const publish = Bun.argv.includes("--publish");
if (version !== (await Bun.file("package.json").json()).version) throw new Error("Release tag must match package.json");
const repository = { type: "git", url: "git+https://github.com/HansKristoffer/agentgate.git" };
const homepage = "https://github.com/HansKristoffer/agentgate#readme";
const bugs = { url: "https://github.com/HansKristoffer/agentgate/issues" };
const targets = [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"], ["linux", "arm64"]];
rmSync("dist/npm", { recursive: true, force: true });
const artifacts = resolve("dist/npm/artifacts");
mkdirSync(artifacts, { recursive: true });

const dirs: string[] = [];
for (const [os, cpu] of targets) {
  const name = `agentpool-${os}-${cpu}`, dir = `dist/npm/${name}`;
  mkdirSync(`${dir}/bin`, { recursive: true });
  copyFileSync(`dist/agentgate-${os}-${cpu}`, `${dir}/bin/agentgate`);
  chmodSync(`${dir}/bin/agentgate`, 0o755);
  await Bun.write(`${dir}/package.json`, JSON.stringify({ name, version, description: `agentgate binary for ${os}-${cpu}`, license: "UNLICENSED", repository, homepage, bugs, files: ["bin"], os: [os], cpu: [cpu], preferUnplugged: true }, null, 2));
  await Bun.write(`${dir}/README.md`, `# ${name}\n\nPlatform binary for [Agentgate](${homepage}). Install \`@hanskristoffer/agentpool\` to select the right binary automatically.\n`);
  dirs.push(dir);
}

const main = "dist/npm/agentpool";
mkdirSync(`${main}/bin`, { recursive: true });
await Bun.write(`${main}/bin/agentpool.js`, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const pkg = \`agentpool-\${process.platform}-\${process.arch}\`;
let binary;
try { binary = require.resolve(\`\${pkg}/bin/agentgate\`); }
catch { console.error(\`agentpool: \${pkg} is not installed; this platform may be unsupported (macOS/Linux, x64/arm64), or optional dependencies were skipped.\`); process.exit(1); }
const child = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (child.error) throw child.error;
if (child.signal) process.kill(process.pid, child.signal);
process.exit(child.status ?? 1);
`);
chmodSync(`${main}/bin/agentpool.js`, 0o755);
await Bun.write(`${main}/package.json`, JSON.stringify({
  name: "@hanskristoffer/agentpool", version, license: "UNLICENSED", repository, homepage, bugs, files: ["bin"], engines: { node: ">=20" },
  description: "Pools Claude and Codex subscriptions, hosts MCP servers per repo, and shares them between machines.",
  bin: { agentpool: "bin/agentpool.js", agentgate: "bin/agentpool.js" },
  optionalDependencies: Object.fromEntries(targets.map(([os, cpu]) => [`agentpool-${os}-${cpu}`, version])),
}, null, 2));
copyFileSync("README.md", `${main}/README.md`);
dirs.push(main); // platform packages first, so the main package never points at missing versions

for (const dir of dirs) {
  const { name } = await Bun.file(`${dir}/package.json`).json();
  const packed = Bun.spawnSync(["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", artifacts], { cwd: dir });
  if (packed.exitCode !== 0) throw new Error(`Cannot pack ${name}`);
  const [artifact] = JSON.parse(packed.stdout.toString());
  if (!artifact.files.some((file: { path: string }) => file.path.startsWith("bin/")) || !artifact.files.some((file: { path: string }) => file.path === "README.md")) throw new Error(`Invalid ${name} artifact`);
  console.log(`Packed ${name}@${version}`);
  if (!publish) continue;
  // Skip versions already on npm so a failed release can be rerun.
  const existing = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, { signal: AbortSignal.timeout(15_000) });
  if (existing.ok) { console.log(`skip ${name}@${version}`); continue; }
  if (existing.status !== 404) throw new Error(`Cannot check ${name}: registry HTTP ${existing.status}`);
  const child = Bun.spawn(["npm", "publish", `${artifacts}/${artifact.filename}`, "--ignore-scripts", "--access", "public", "--provenance"], { cwd: dir, stdio: ["inherit", "inherit", "inherit"] });
  if (await child.exited !== 0) process.exit(1);
}
