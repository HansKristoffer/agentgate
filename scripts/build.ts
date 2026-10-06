import { mkdirSync } from "node:fs";
const targets = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
// Releases sign the macOS binaries with the Developer ID. An ad-hoc signed binary is a new app to macOS after every
// update, so it asks again for privacy grants such as access to ~/Documents, which a headless server cannot answer.
const identity = process.env.APPLE_SIGNING_IDENTITY;
mkdirSync("dist", { recursive: true });
const checksums: string[] = [];
async function run(cmd: string[]) {
  const child = Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"] });
  if (await child.exited !== 0) process.exit(1);
}
for (const target of targets) {
  const file = `agentgate-${target}`;
  await run([process.execPath, "build", "apps/agentgate/src/cli.ts", "--compile", "--minify", `--target=bun-${target}`, "--outfile", `dist/${file}`]);
  if (identity && target.startsWith("darwin-")) await run(["codesign", "--force", "--timestamp", "--identifier", "agentgate", "--sign", identity, `dist/${file}`]);
  checksums.push(`${new Bun.CryptoHasher("sha256").update(await Bun.file(`dist/${file}`).arrayBuffer()).digest("hex")}  ${file}`);
}
await Bun.write("dist/SHA256SUMS", checksums.join("\n") + "\n");
