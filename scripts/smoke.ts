import { API_VERSION } from "../packages/protocol/src/index.ts";
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const binary = resolve(Bun.argv[2] ?? "dist/agentgate");
const home = mkdtempSync(join(tmpdir(), "agentgate-smoke-"));
let daemon: ReturnType<typeof Bun.spawn> | undefined;
try {
  for (const args of [
    ["--help"],
    ["init", "--name", "smoke"],
    ["setup"],
    ["export", "--no-secrets"],
  ]) {
    const child = Bun.spawnSync([binary, ...args], {
      env: { ...process.env, AGENTGATE_HOME: home, AGENTGATE_PORT: "19878" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (child.exitCode !== 0)
      throw new Error(`${args.join(" ")}: ${child.stderr}`);
  }
  const config = Bun.TOML.parse(
    await Bun.file(join(home, "codex", "config.toml")).text(),
  ) as {
    mcp_servers: {
      agentgate: {
        command: string;
        args: string[];
        env: { AGENTGATE_HOME: string; AGENTGATE_PORT: string };
      };
    };
  };
  if (
    realpathSync(config.mcp_servers.agentgate.command) !==
      realpathSync(binary) ||
    config.mcp_servers.agentgate.env.AGENTGATE_PORT !== "19878"
  )
    throw new Error("compiled shim command/config mismatch");
  daemon = Bun.spawn([binary, "serve"], {
    env: { ...process.env, AGENTGATE_HOME: home, AGENTGATE_PORT: "19878" },
    stdout: "ignore",
    stderr: "pipe",
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:19878/api/status", {
        signal: AbortSignal.timeout(500),
      });
      const status = (await response.json()) as {
        node: string;
        apiVersion: number;
        html?: string;
      };
      if (
        !response.ok ||
        status.node !== "smoke" ||
        status.apiVersion !== API_VERSION ||
        status.html !== undefined
      )
        throw new Error("invalid native status");
      ready = true;
      break;
    } catch {
      await Bun.sleep(50);
    }
  }
  if (!ready) throw new Error("compiled daemon did not become ready");
  if ((await fetch("http://127.0.0.1:19878/")).status !== 404)
    throw new Error("web UI is still present");
  if (
    (
      await fetch("http://127.0.0.1:19878/api/status", {
        headers: { origin: "https://example.com" },
      })
    ).status !== 403
  )
    throw new Error("browser control API access allowed");
  const checkout = join(home, "checkout");
  mkdirSync(checkout);
  if (Bun.spawnSync(["git", "init", checkout], { stdout: "pipe", stderr: "pipe" }).exitCode !== 0)
    throw new Error("could not initialize smoke checkout");
  const markdown = join(home, "SKILL.md");
  await Bun.write(markdown, "---\nname: smoke-skill\ndescription: Compiled CLI skill smoke test.\n---\n\nUse this skill for the smoke test.\n");
  for (const args of [
    ["skills", "new", "smoke-skill", "--file", markdown],
    ["skills", "projects", "smoke-skill", "smoke/repo"],
    ["skills", "prepare", checkout, "--project", "smoke/repo"],
  ]) {
    const child = Bun.spawnSync([binary, ...args], {
      env: { ...process.env, AGENTGATE_HOME: home, AGENTGATE_PORT: "19878" },
      stdout: "pipe", stderr: "pipe",
    });
    if (child.exitCode !== 0) throw new Error(`${args.join(" ")}: ${child.stderr}`);
  }
  for (const folder of [".agents", ".claude"]) {
    const link = join(checkout, folder, "skills", "smoke-skill");
    if (!readlinkSync(link) || !(await Bun.file(join(link, "SKILL.md")).text()).includes("Compiled CLI skill smoke test."))
      throw new Error("compiled skills prepare did not publish skill links");
  }
  daemon.kill("SIGTERM");
  await daemon.exited;
  daemon = undefined;
  console.log(
    "compiled CLI smoke passed (init, setup, exports, shim config, headless daemon, native API, skill creation/assignment/preparation, no web UI)",
  );
} finally {
  if (daemon) {
    daemon.kill();
    await daemon.exited;
  }
  rmSync(home, { recursive: true, force: true });
}
