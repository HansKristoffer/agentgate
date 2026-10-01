import { mkdirSync } from "node:fs";
const targets = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
mkdirSync("dist", { recursive: true });
const checksums: string[] = [];
for (const target of targets) {
  const file = `agentgate-${target}`;
  const child = Bun.spawn([process.execPath, "build", "apps/agentgate/src/cli.ts", "--compile", "--minify", `--target=bun-${target}`, "--outfile", `dist/${file}`], { stdio: ["inherit", "inherit", "inherit"] });
  if (await child.exited !== 0) process.exit(1);
  checksums.push(`${new Bun.CryptoHasher("sha256").update(await Bun.file(`dist/${file}`).arrayBuffer()).digest("hex")}  ${file}`);
}
await Bun.write("dist/SHA256SUMS", checksums.join("\n") + "\n");
