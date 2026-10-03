import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plist, rotateLogs, unit, waitForService } from "../src/service.ts";
import { agentEnvironment, codexConfig, primary, primaryCodex, setup, stableBinary } from "../src/setup.ts";

test("setup preserves unrelated Codex/Claude configuration and is repeatable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-setup-")); const paths = { claude: join(dir, "claude"), codex: join(dir, "codex") };
  mkdirSync(paths.codex); mkdirSync(paths.claude);
  writeFileSync(join(paths.codex, "config.toml"), 'model = "gpt-5"\nmodel_provider = "old"\n[features]\nfoo = true\n[mcp_servers.other]\ncommand = "other"\n');
  writeFileSync(join(paths.claude, "settings.json"), '{"theme":"dark","env":{"OTHER":"keep"}}');
  await setup(paths); await setup(paths);
  const config = Bun.TOML.parse(readFileSync(join(paths.codex, "config.toml"), "utf8")) as any;
  expect(config.model).toBe("gpt-5"); expect(config.features.foo).toBe(true); expect(config.mcp_servers.other.command).toBe("other"); expect(config.mcp_servers.agentgate.env).toEqual(agentEnvironment());
  expect(JSON.parse(readFileSync(join(paths.claude, "settings.json"), "utf8")).env.OTHER).toBe("keep");
  expect(statSync(join(paths.codex, "config.toml")).mode & 0o777).toBe(0o600); rmSync(dir, { recursive: true });
});

test("primary undo restores the previous URL without reverting subsequent settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-primary-")), file = join(dir, "settings.json");
  writeFileSync(file, '{"env":{"ANTHROPIC_BASE_URL":"https://original"}}'); await primary(true, dir); await primary(true, dir);
  const config = JSON.parse(readFileSync(file, "utf8")); config.theme = "new"; writeFileSync(file, JSON.stringify(config));
  expect(JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")).mcpServers.agentgate.args.at(-1)).toBe("mcp");
  await primary(false, dir); expect(JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")).mcpServers.agentgate).toBeUndefined();
  const restored = JSON.parse(readFileSync(file, "utf8")); expect(restored.env.ANTHROPIC_BASE_URL).toBe("https://original"); expect(restored.theme).toBe("new");
  rmSync(dir, { recursive: true });
});

test("generated service definitions propagate custom configuration and quote executable arguments", () => {
  expect(plist()).toContain("AGENTGATE_HOME"); expect(plist()).toContain("AGENTGATE_PORT");
  expect(unit()).toContain("AGENTGATE_HOME="); expect(unit()).toContain("AGENTGATE_PORT=");
  const config = Bun.TOML.parse(codexConfig("", ["/path with space/bun", "/code/main.ts"], { AGENTGATE_HOME: "/custom home", AGENTGATE_PORT: "9876" })) as any;
  expect(config.mcp_servers.agentgate.command).toBe("/path with space/bun"); expect(config.mcp_servers.agentgate.env.AGENTGATE_PORT).toBe("9876");
});

test("launchd logs are rotated with bounded archives without replacing the open inode", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-log-")), file = join(dir, "agentgate.log"); writeFileSync(file, "12345"); const inode = statSync(file).ino;
  rotateLogs(dir, 1); expect(readFileSync(`${file}.1`, "utf8")).toBe("12345"); expect(statSync(file).size).toBe(0); expect(statSync(file).ino).toBe(inode); rmSync(dir, { recursive: true });
});

test("service readiness retries startup and reports an unhealthy daemon", async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("", { status: ++requests === 1 ? 503 : 200 }) });
  try {
    await waitForService(`http://127.0.0.1:${server.port}`, 2000);
    expect(requests).toBe(2);
    server.reload({ fetch: () => new Response("", { status: 503 }) });
    await expect(waitForService(`http://127.0.0.1:${server.port}`, 50)).rejects.toThrow("did not become ready");
  } finally { server.stop(true); }
});

test("service readiness reports a refused connection with recovery instructions", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const url = `http://127.0.0.1:${server.port}`;
  server.stop(true);
  await expect(waitForService(url, 50)).rejects.toThrow("cannot connect until the daemon is running");
});

test("setup preserves multiline values and quoted/array tables outside managed configuration", () => {
  const source = 'description = """\n[mcp_servers.agentgate]\nordinary text\n"""\n[model_providers."agentgate"]\nname = "replace me"\n[[plugins]]\nname = "keep me"\n';
  const before = Bun.TOML.parse(source) as any, after = Bun.TOML.parse(codexConfig(source)) as any;
  expect(after.description).toBe(before.description); expect(after.plugins).toEqual(before.plugins); expect(after.model_providers.agentgate.name).toBe("agentgate");
});

test("setup ignores triple quotes in comments and single-line strings", () => {
  const source = '# A comment mentioning """\nexample = \'"""\'\n[mcp_servers.agentgate]\ncommand = "old"\n';
  expect((Bun.TOML.parse(codexConfig(source)) as any).example).toBe('"""');
});

test("systemd escapes executable dollar/percent signs while preserving literal environment dollars", () => {
  const definition = unit(["/path$literal/%binary"], { PATH: "/bin", AGENTGATE_HOME: "/home/$literal", AGENTGATE_PORT: "9876" });
  expect(definition).toContain('ExecStart="/path$$literal/%%binary"'); expect(definition).toContain('Environment="AGENTGATE_HOME=/home/$literal"');
});

test("binaries run from an npx/dlx/bunx cache are copied to a stable path", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-stable-")), cached = join(dir, "_npx", "abc", "agentgate");
  mkdirSync(join(dir, "_npx", "abc"), { recursive: true }); writeFileSync(cached, "binary");
  expect(stableBinary(join(dir, "agentgate"), join(dir, "bin"))).toBe(join(dir, "agentgate"));
  const stable = stableBinary(cached, join(dir, "bin"));
  expect(stable).toBe(join(dir, "bin", "agentgate")); expect(readFileSync(stable, "utf8")).toBe("binary"); expect(statSync(stable).mode & 0o111).toBeTruthy();
  rmSync(dir, { recursive: true, force: true });
});

test("primary Codex sends its own login through agentgate and undoes cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-primary-codex-")), file = join(dir, "config.toml");
  writeFileSync(file, 'model = "gpt-5"\nmodel_provider = "openai"\n[mcp_servers.mine]\ncommand = "mine"\n');
  await primaryCodex(true, dir); await primaryCodex(true, dir);
  const on = Bun.TOML.parse(readFileSync(file, "utf8")) as any;
  expect(on.model_provider).toBe("agentgate"); expect(on.model_providers.agentgate.requires_openai_auth).toBe(true);
  expect(on.mcp_servers.agentgate.args.at(-1)).toBe("mcp"); expect(on.mcp_servers.mine.command).toBe("mine"); expect(on.model).toBe("gpt-5");
  await primaryCodex(false, dir);
  const off = Bun.TOML.parse(readFileSync(file, "utf8")) as any;
  expect(off.model_provider).toBe("openai"); expect(off.model_providers).toBeUndefined(); expect(off.mcp_servers.mine.command).toBe("mine");
  rmSync(dir, { recursive: true, force: true });
});

test("setup --mcp adds only the MCP server; claudeStatus reports routing and MCP separately", async () => {
  const { mcp, claudeStatus } = await import("../src/setup.ts");
  const dir = mkdtempSync(join(tmpdir(), "agentgate-mcp-"));
  writeFileSync(join(dir, ".claude.json"), '{"mcpServers":{"other":{"command":"x"}},"keep":1}');
  expect(claudeStatus(dir)).toEqual({ routing: false, mcp: false });
  await mcp(true, dir);
  const cfg = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
  expect(Object.keys(cfg.mcpServers)).toEqual(["other", "agentgate"]); expect(cfg.keep).toBe(1);
  expect(claudeStatus(dir)).toEqual({ routing: false, mcp: true });
  await primary(true, dir); expect(claudeStatus(dir)).toEqual({ routing: true, mcp: true });
  await mcp(false, dir); expect(claudeStatus(dir)).toEqual({ routing: true, mcp: false });
  expect(await mcp(false, dir)).toContain("No agentgate MCP server");
  rmSync(dir, { recursive: true });
});
