import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("installer verifies checksums and preserves the installed binary after corrupt downloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-installer-")), commands = join(dir, "commands"), dest = join(dir, "bin"); mkdirSync(commands); mkdirSync(dest);
  const curl = join(commands, "curl");
  writeFileSync(curl, `#!${process.execPath}\nconst args=Bun.argv.slice(2);const url=args.at(-1);if(url.endsWith('/latest'))process.stdout.write('https://github.com/test/agentgate/releases/tag/v-test');else{const file=args[args.indexOf('-o')+1];if(url.endsWith('/SHA256SUMS')){const asset='agentgate-'+(process.platform==='darwin'?'darwin':'linux')+'-'+(process.arch==='arm64'?'arm64':'x64');const hash=process.env.CORRUPT?'0'.repeat(64):new Bun.CryptoHasher('sha256').update('new-binary').digest('hex');await Bun.write(file,hash+'  '+asset+'\\n');}else await Bun.write(file,'new-binary');}\n`); chmodSync(curl, 0o700);
  const run = (corrupt: boolean) => Bun.spawnSync(["sh", join(import.meta.dir, "..", "..", "..", "install.sh")], { env: { ...process.env, PATH: `${commands}:${process.env.PATH}`, AGENTGATE_REPO: "test/agentgate", AGENTGATE_BIN_DIR: dest, CORRUPT: corrupt ? "yes" : "" }, stdout: "pipe", stderr: "pipe" });
  try { expect(run(false).exitCode).toBe(0); expect(readFileSync(join(dest, "agentgate"), "utf8")).toBe("new-binary"); writeFileSync(join(dest, "agentgate"), "previous-binary"); expect(run(true).exitCode).not.toBe(0); expect(readFileSync(join(dest, "agentgate"), "utf8")).toBe("previous-binary"); expect(readdirSync(dest)).toEqual(["agentgate"]); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("installer with join arguments initializes, joins, starts the service, then routes the own tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-installer-")), commands = join(dir, "commands"), dest = join(dir, "bin"), log = join(dir, "calls"); mkdirSync(commands); mkdirSync(dest);
  const binary = `#!/bin/sh\necho "$*" >> ${log}\n`, asset = `agentgate-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
  writeFileSync(join(dir, "binary"), binary); writeFileSync(join(dir, "sums"), `${new Bun.CryptoHasher("sha256").update(binary).digest("hex")}  ${asset}\n`);
  const curl = join(commands, "curl");
  writeFileSync(curl, `#!${process.execPath}\nconst args=Bun.argv.slice(2);const url=args.at(-1);if(url.endsWith('/latest'))process.stdout.write('https://github.com/test/agentgate/releases/tag/v-test');else await Bun.write(args[args.indexOf('-o')+1],Bun.file(${JSON.stringify(dir)}+(url.endsWith('/SHA256SUMS')?'/sums':'/binary')));\n`); chmodSync(curl, 0o700);
  try {
    const install = (name?: string) => Bun.spawnSync(["sh", join(import.meta.dir, "..", "..", "..", "install.sh"), "join", "agr1.invite"], { env: { ...process.env, PATH: `${commands}:${process.env.PATH}`, AGENTGATE_BIN_DIR: dest, AGENTGATE_NAME: name ?? "" }, stdout: "pipe", stderr: "pipe" }).exitCode;
    expect(install()).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("init\njoin agr1.invite\nservice install\nsetup --primary\n");
    rmSync(log);
    expect(install("mac-mini")).toBe(0);
    expect(readFileSync(log, "utf8")).toStartWith("init --name mac-mini\njoin agr1.invite\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
