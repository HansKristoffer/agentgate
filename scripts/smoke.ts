import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const binary = resolve(Bun.argv[2] ?? "dist/agentgate");
const home = mkdtempSync(join(tmpdir(), "agentgate-smoke-"));
try {
  for (const args of [["--help"], ["init", "--name", "smoke"], ["setup"], ["export", "--no-secrets"]]) {
    const child = Bun.spawnSync([binary, ...args], { env: { ...process.env, AGENTGATE_HOME: home, AGENTGATE_PORT: "19878" }, stdout: "pipe", stderr: "pipe" });
    if (child.exitCode !== 0) throw new Error(`${args.join(" ")}: ${child.stderr}`);
  }
  const config = Bun.TOML.parse(await Bun.file(join(home, "codex", "config.toml")).text()) as { mcp_servers: { agentgate: { command: string; args: string[]; env: { AGENTGATE_HOME: string; AGENTGATE_PORT: string } } } };
  if (realpathSync(config.mcp_servers.agentgate.command) !== realpathSync(binary) || config.mcp_servers.agentgate.env.AGENTGATE_PORT !== "19878") throw new Error("compiled shim command/config mismatch");
  console.log("compiled CLI smoke passed (help, init, setup, public export, generated shim)");
} finally { rmSync(home, { recursive: true, force: true }); }
