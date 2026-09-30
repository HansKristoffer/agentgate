import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plist, rotateLogs, unit } from "../src/service.ts";
import { agentEnvironment, codexConfig, primary, setup } from "../src/setup.ts";

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
  await primary(false, dir); const restored = JSON.parse(readFileSync(file, "utf8")); expect(restored.env.ANTHROPIC_BASE_URL).toBe("https://original"); expect(restored.theme).toBe("new");
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
