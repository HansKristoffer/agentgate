import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plist, rotateLogs, service, stampLogs, unit, waitForService } from "../src/service.ts";
import {
  agentEnvironment,
  codexConfig,
  cursorMcp,
  cursorMcpEnabled,
  keepMcp,
  MCP_RESTORED,
  mcp,
  mcpHere,
  primary,
  primaryCodex,
  routeByDefault,
  routeHere,
  setup,
  stableBinary,
} from "../src/setup.ts";
import { CONFIG_DIR, DEV, devPort, PORT, Store } from "../src/store.ts";

test("setup preserves unrelated Codex/Claude configuration and is repeatable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-setup-"));
  const paths = { claude: join(dir, "claude"), codex: join(dir, "codex") };
  mkdirSync(paths.codex);
  mkdirSync(paths.claude);
  writeFileSync(
    join(paths.codex, "config.toml"),
    'model = "gpt-5"\nmodel_provider = "old"\n[features]\nfoo = true\n[mcp_servers.other]\ncommand = "other"\n',
  );
  writeFileSync(join(paths.claude, "settings.json"), '{"theme":"dark","env":{"OTHER":"keep"}}');
  await setup(paths);
  await setup(paths);
  const config = Bun.TOML.parse(readFileSync(join(paths.codex, "config.toml"), "utf8")) as any;
  expect(config.model).toBe("gpt-5");
  expect(config.features.foo).toBe(true);
  expect(config.mcp_servers.other.command).toBe("other");
  expect(config.mcp_servers.agentgate.env).toEqual(agentEnvironment());
  expect(JSON.parse(readFileSync(join(paths.claude, "settings.json"), "utf8")).env.OTHER).toBe("keep");
  expect(statSync(join(paths.codex, "config.toml")).mode & 0o777).toBe(0o600);
  rmSync(dir, { recursive: true });
});

test("primary undo restores the previous URL without reverting subsequent settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-primary-")),
    file = join(dir, "settings.json");
  writeFileSync(file, '{"env":{"ANTHROPIC_BASE_URL":"https://original"}}');
  await primary(true, dir);
  await primary(true, dir);
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.theme = "new";
  writeFileSync(file, JSON.stringify(config));
  expect(JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")).mcpServers.agentgate.args.at(-1)).toBe("mcp");
  await primary(false, dir);
  expect(JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")).mcpServers.agentgate).toBeUndefined();
  const restored = JSON.parse(readFileSync(file, "utf8"));
  expect(restored.env.ANTHROPIC_BASE_URL).toBe("https://original");
  expect(restored.theme).toBe("new");
  rmSync(dir, { recursive: true });
});

test("primary gives Claude Code a placeholder login only where it has none of its own, and undo removes it", async () => {
  const fresh = mkdtempSync(join(tmpdir(), "agentgate-primary-")),
    signedIn = mkdtempSync(join(tmpdir(), "agentgate-primary-"));
  writeFileSync(join(signedIn, ".claude.json"), '{"oauthAccount":{"emailAddress":"me@example.com"}}');
  const env = (dir: string) => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).env;
  await primary(true, fresh);
  await primary(true, signedIn);
  expect(env(fresh).ANTHROPIC_AUTH_TOKEN).toBe("agentgate");
  expect(env(signedIn).ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  await primary(false, fresh);
  expect(env(fresh)).toBeUndefined();
  rmSync(fresh, { recursive: true });
  rmSync(signedIn, { recursive: true });
});

test("generated service definitions propagate custom configuration and quote executable arguments", () => {
  expect(plist()).toContain("AGENTGATE_HOME");
  expect(plist()).toContain("AGENTGATE_PORT");
  expect(unit()).toContain("AGENTGATE_HOME=");
  expect(unit()).toContain("AGENTGATE_PORT=");
  const config = Bun.TOML.parse(
    codexConfig("", ["/path with space/bun", "/code/main.ts"], {
      AGENTGATE_HOME: "/custom home",
      AGENTGATE_PORT: "9876",
    }),
  ) as any;
  expect(config.mcp_servers.agentgate.command).toBe("/path with space/bun");
  expect(config.mcp_servers.agentgate.env.AGENTGATE_PORT).toBe("9876");
});

test("launchd logs are rotated with bounded archives without replacing the open inode", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-log-")),
    file = join(dir, "agentgate.log");
  writeFileSync(file, "12345");
  const inode = statSync(file).ino;
  rotateLogs(dir, 1);
  expect(readFileSync(`${file}.1`, "utf8")).toBe("12345");
  expect(statSync(file).size).toBe(0);
  expect(statSync(file).ino).toBe(inode);
  rmSync(dir, { recursive: true });
});

test("service readiness retries startup and reports an unhealthy daemon", async () => {
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("", { status: ++requests === 1 ? 503 : 200 }),
  });
  try {
    await waitForService(`http://127.0.0.1:${server.port}`, 2000);
    expect(requests).toBe(2);
    server.reload({ fetch: () => new Response("", { status: 503 }) });
    await expect(waitForService(`http://127.0.0.1:${server.port}`, 50)).rejects.toThrow("did not become ready");
  } finally {
    server.stop(true);
  }
});

test("service readiness reports a refused connection with recovery instructions", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const url = `http://127.0.0.1:${server.port}`;
  server.stop(true);
  await expect(waitForService(url, 50)).rejects.toThrow("cannot connect until the daemon is running");
});

test("setup preserves multiline values and quoted/array tables outside managed configuration", () => {
  const source =
    'description = """\n[mcp_servers.agentgate]\nordinary text\n"""\n[model_providers."agentgate"]\nname = "replace me"\n[[plugins]]\nname = "keep me"\n';
  const before = Bun.TOML.parse(source) as any,
    after = Bun.TOML.parse(codexConfig(source)) as any;
  expect(after.description).toBe(before.description);
  expect(after.plugins).toEqual(before.plugins);
  expect(after.model_providers.agentgate.name).toBe("agentgate");
});

test("setup ignores triple quotes in comments and single-line strings", () => {
  const source = '# A comment mentioning """\nexample = \'"""\'\n[mcp_servers.agentgate]\ncommand = "old"\n';
  expect((Bun.TOML.parse(codexConfig(source)) as any).example).toBe('"""');
});

test("systemd escapes executable dollar/percent signs while preserving literal environment dollars", () => {
  const definition = unit(["/path$literal/%binary"], {
    PATH: "/bin",
    AGENTGATE_HOME: "/home/$literal",
    AGENTGATE_PORT: "9876",
  });
  expect(definition).toContain('ExecStart="/path$$literal/%%binary"');
  expect(definition).toContain('Environment="AGENTGATE_HOME=/home/$literal"');
});

test("binaries run from an npx/dlx/bunx cache are copied to a stable path", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-stable-")),
    cached = join(dir, "_npx", "abc", "agentgate");
  mkdirSync(join(dir, "_npx", "abc"), { recursive: true });
  writeFileSync(cached, "binary");
  expect(stableBinary(join(dir, "agentgate"), join(dir, "bin"))).toBe(join(dir, "agentgate"));
  const stable = stableBinary(cached, join(dir, "bin"));
  expect(stable).toBe(join(dir, "bin", "agentgate"));
  expect(readFileSync(stable, "utf8")).toBe("binary");
  expect(statSync(stable).mode & 0o111).toBeTruthy();
  rmSync(dir, { recursive: true, force: true });
});

test("primary Codex keeps a real Codex login untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-primary-codex-")),
    auth = join(dir, "auth.json");
  writeFileSync(auth, '{"tokens":{}}');
  await primaryCodex(true, dir);
  await primaryCodex(false, dir);
  expect(readFileSync(auth, "utf8")).toBe('{"tokens":{}}');
  rmSync(dir, { recursive: true, force: true });
});

test("primary Codex sends its own login through agentgate and undoes cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-primary-codex-")),
    file = join(dir, "config.toml");
  writeFileSync(file, 'model = "gpt-5"\nmodel_provider = "openai"\n[mcp_servers.mine]\ncommand = "mine"\n');
  await primaryCodex(true, dir);
  await primaryCodex(true, dir);
  const on = Bun.TOML.parse(readFileSync(file, "utf8")) as any;
  expect(on.model_provider).toBe("agentgate");
  expect(on.model_providers.agentgate.requires_openai_auth).toBe(true);
  expect(on.mcp_servers.agentgate.args.at(-1)).toBe("mcp");
  expect(on.mcp_servers.mine.command).toBe("mine");
  expect(on.model).toBe("gpt-5");
  // No login of its own: a placeholder key keeps `codex login status` happy, and goes away with the setup.
  expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))).toEqual({ OPENAI_API_KEY: "agentgate" });
  await primaryCodex(false, dir);
  expect(existsSync(join(dir, "auth.json"))).toBe(false);
  const off = Bun.TOML.parse(readFileSync(file, "utf8")) as any;
  expect(off.model_provider).toBe("openai");
  expect(off.model_providers).toBeUndefined();
  expect(off.mcp_servers.mine.command).toBe("mine");
  rmSync(dir, { recursive: true, force: true });
});

test("setup --mcp adds only the MCP server; claudeStatus reports routing and MCP separately", async () => {
  const { mcp, claudeStatus } = await import("../src/setup.ts");
  const dir = mkdtempSync(join(tmpdir(), "agentgate-mcp-"));
  writeFileSync(join(dir, ".claude.json"), '{"mcpServers":{"other":{"command":"x"}},"keep":1}');
  expect(claudeStatus(dir)).toEqual({ routing: false, mcp: false });
  await mcp(true, dir);
  const cfg = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
  expect(Object.keys(cfg.mcpServers)).toEqual(["other", "agentgate"]);
  expect(cfg.keep).toBe(1);
  expect(claudeStatus(dir)).toEqual({ routing: false, mcp: true });
  await primary(true, dir);
  expect(claudeStatus(dir)).toEqual({ routing: true, mcp: true });
  await mcp(false, dir);
  expect(claudeStatus(dir)).toEqual({ routing: true, mcp: false });
  expect(await mcp(false, dir)).toContain("No agentgate MCP server");
  rmSync(dir, { recursive: true });
});

test.skipIf(!!process.env.AGENTGATE_HOME)(
  "a checkout keeps its own state and refuses to change the machine's real setup",
  async () => {
    expect(DEV).toBe(true);
    expect(CONFIG_DIR).toBe(join(import.meta.dir, "../../../.agentgate"));
    expect(PORT).toBe(devPort(join(import.meta.dir, "../../..")));
    expect(PORT).toBeGreaterThanOrEqual(17000);
    expect(PORT).toBeLessThan(18000);
    await expect(service("install")).rejects.toThrow("real setup");
    await expect(mcp(true)).rejects.toThrow("real setup");
    await expect(cursorMcp(true)).rejects.toThrow("real setup");
    await expect(primaryCodex(true)).rejects.toThrow("real setup");
  },
);

test("Cursor MCP setup keeps the other servers in mcp.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-cursor-mcp-")),
    file = join(dir, "mcp.json");
  writeFileSync(file, '{"keep":true,"mcpServers":{"grafana":{"command":"grafana"}}}\n');
  expect(cursorMcpEnabled(file)).toBe(false);
  expect(await cursorMcp(true, file)).toContain("Cursor");
  const on = JSON.parse(readFileSync(file, "utf8"));
  expect(on.keep).toBe(true);
  expect(on.mcpServers.grafana.command).toBe("grafana");
  expect(on.mcpServers.agentgate.args.at(-1)).toBe("mcp");
  expect(on.mcpServers.agentgate.env).toEqual(agentEnvironment());
  expect(on.mcpServers.agentgate.type).toBeUndefined();
  expect(cursorMcpEnabled(file)).toBe(true);
  await cursorMcp(true, file);
  expect(await cursorMcp(false, file)).toContain("Removed");
  const off = JSON.parse(readFileSync(file, "utf8"));
  expect(off.mcpServers.grafana.command).toBe("grafana");
  expect(off.mcpServers.agentgate).toBeUndefined();
  expect(await cursorMcp(false, file)).toContain("No agentgate MCP server");
  expect(cursorMcpEnabled(join(dir, "missing.json"))).toBe(false);
  writeFileSync(file, '{"mcpServers":[]}\n');
  await expect(cursorMcp(true, file)).rejects.toThrow("mcpServers must be an object");
  rmSync(dir, { recursive: true, force: true });
});

test("daemon log lines start with an ISO 8601 timestamp", () => {
  const lines: unknown[][] = [];
  const out = {
    log: (...a: unknown[]) => lines.push(a),
    info: (...a: unknown[]) => lines.push(a),
    warn: (...a: unknown[]) => lines.push(a),
    error: (...a: unknown[]) => lines.push(a),
  };
  stampLogs(out, () => new Date("2026-10-16T08:30:00.000Z"));
  out.log("agentgate 0.21.1 n: http://127.0.0.1:7878");
  out.error("request failed:", "x");
  expect(lines).toEqual([
    ["2026-10-16T08:30:00.000Z", "agentgate 0.21.1 n: http://127.0.0.1:7878"],
    ["2026-10-16T08:30:00.000Z", "request failed:", "x"],
  ]);
});

/** Temporary stand-ins for ~/.claude, ~/.codex and ~/.cursor/mcp.json; Codex and Cursor exist only when asked. */
function ownTools(installed: { codex?: boolean; cursor?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-own-")),
    dirs = { claude: join(dir, "claude"), codex: join(dir, "codex"), cursor: join(dir, "cursor", "mcp.json") };
  mkdirSync(dirs.claude);
  if (installed.codex) mkdirSync(dirs.codex);
  if (installed.cursor) mkdirSync(join(dir, "cursor"));
  const read = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined);
  return {
    dir,
    dirs,
    baseUrl: () => read(join(dirs.claude, "settings.json"))?.env?.ANTHROPIC_BASE_URL,
    claudeMcp: () => read(join(dirs.claude, ".claude.json"))?.mcpServers?.agentgate,
  };
}

test("a new store's first service install routes the own tools once, skipping the ones not installed", async () => {
  const s = new Store(":memory:"),
    tools = ownTools({ codex: true });
  s.setLocal("setup:routing", "pending");
  const message = await routeByDefault(s, true, tools.dirs);
  expect(message).toContain("skipped Cursor");
  expect(tools.baseUrl()).toBe(`http://127.0.0.1:${PORT}/anthropic`);
  expect(tools.claudeMcp().args.at(-1)).toBe("mcp");
  expect((Bun.TOML.parse(readFileSync(join(tools.dirs.codex, "config.toml"), "utf8")) as any).model_provider).toBe(
    "agentgate",
  );
  expect(existsSync(join(tools.dir, "cursor"))).toBe(false);
  expect(s.local("setup:routing")).toBe("on");
  // Reinstalling the service, as an app update does, never routes again: here after the user turned it off.
  await routeHere(s, false, tools.dirs);
  expect(await routeByDefault(s, true, tools.dirs)).toBeUndefined();
  expect(tools.baseUrl()).toBeUndefined();
  rmSync(tools.dir, { recursive: true });
});

test("service install --no-routing, and stores from before the default, leave the own tools alone", async () => {
  const s = new Store(":memory:"),
    tools = ownTools({ codex: true, cursor: true });
  expect(await routeByDefault(s, true, tools.dirs)).toBeUndefined();
  s.setLocal("setup:routing", "pending");
  expect(await routeByDefault(s, false, tools.dirs)).toContain("agentgate setup --primary");
  expect(await routeByDefault(s, true, tools.dirs)).toBeUndefined();
  expect(s.local("setup:routing")).toBe("off");
  expect(tools.baseUrl()).toBeUndefined();
  expect(existsSync(tools.dirs.cursor)).toBe(false);
  rmSync(tools.dir, { recursive: true });
});

test("the daemon puts back an MCP server Claude Code dropped, unless the user turned it off", async () => {
  const s = new Store(":memory:"),
    tools = ownTools({ cursor: true }),
    file = join(tools.dirs.claude, ".claude.json");
  const drop = () => {
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    delete cfg.mcpServers.agentgate;
    writeFileSync(file, JSON.stringify({ ...cfg, projects: { "/code": {} } }));
  };
  await routeHere(s, true, tools.dirs);
  expect(await keepMcp(s, tools.dirs)).toEqual([]);
  drop();
  expect(await keepMcp(s, tools.dirs)).toEqual([`Put back agentgate's MCP server in ${file}`]);
  expect(tools.claudeMcp().args.at(-1)).toBe("mcp");
  expect(JSON.parse(readFileSync(file, "utf8")).projects).toEqual({ "/code": {} });
  expect(s.local(MCP_RESTORED)).toBeDefined();
  await mcpHere(s, false, tools.dirs);
  expect(s.local(MCP_RESTORED)).toBeUndefined();
  expect(cursorMcpEnabled(tools.dirs.cursor)).toBe(false);
  expect(await keepMcp(s, tools.dirs)).toEqual([]);
  expect(tools.claudeMcp()).toBeUndefined();
  // Before the choice was recorded, routing being on is what counts.
  await mcpHere(s, true, tools.dirs);
  drop();
  s.setLocal("setup:mcp", undefined);
  expect(await keepMcp(s, tools.dirs)).toHaveLength(1);
  await primary(false, tools.dirs.claude);
  s.setLocal("setup:mcp", undefined);
  expect(await keepMcp(s, tools.dirs)).toEqual([]);
  rmSync(file);
  s.setLocal("setup:mcp", "on");
  expect(await keepMcp(s, tools.dirs)).toEqual([]);
  expect(existsSync(file)).toBe(false);
  rmSync(tools.dir, { recursive: true });
});

test("after the binary or port moved, the daemon points this install's MCP entries at the current ones", async () => {
  const s = new Store(":memory:"),
    tools = ownTools({ codex: true, cursor: true }),
    codexFile = join(tools.dirs.codex, "config.toml");
  await routeHere(s, true, tools.dirs);
  const move = (entry: any) => Object.assign(entry, { command: "/old/agentgate", args: ["mcp"] });
  const claudeJson = join(tools.dirs.claude, ".claude.json");
  const claude = JSON.parse(readFileSync(claudeJson, "utf8"));
  move(claude.mcpServers.agentgate);
  writeFileSync(claudeJson, JSON.stringify(claude));
  writeFileSync(codexFile, readFileSync(codexFile, "utf8").replace(/^command = .*$/m, 'command = "/old/agentgate"'));
  const cursor = JSON.parse(readFileSync(tools.dirs.cursor, "utf8"));
  cursor.mcpServers.agentgate.env.AGENTGATE_PORT = "1";
  // Another install's entry (another AGENTGATE_HOME) is left as it is.
  cursor.mcpServers.other = { command: "/other", args: ["mcp"], env: { AGENTGATE_HOME: "/elsewhere" } };
  writeFileSync(tools.dirs.cursor, JSON.stringify(cursor));

  expect(await keepMcp(s, tools.dirs)).toHaveLength(3);
  expect(tools.claudeMcp().command).not.toBe("/old/agentgate");
  const codex = Bun.TOML.parse(readFileSync(codexFile, "utf8")) as any;
  expect(codex.mcp_servers.agentgate.command).not.toBe("/old/agentgate");
  expect(codex.model_providers.agentgate.requires_openai_auth).toBe(true);
  const after = JSON.parse(readFileSync(tools.dirs.cursor, "utf8"));
  expect(after.mcpServers.agentgate.env).toEqual(agentEnvironment());
  expect(after.mcpServers.other.command).toBe("/other");
  expect(s.local(MCP_RESTORED)).toBeUndefined();
  expect(await keepMcp(s, tools.dirs)).toEqual([]);

  // Codex switched to another provider by hand is not taken back, even with an outdated entry.
  writeFileSync(
    codexFile,
    readFileSync(codexFile, "utf8")
      .replace('model_provider = "agentgate"', 'model_provider = "openai"')
      .replace(/^command = .*$/m, 'command = "/old/agentgate"'),
  );
  expect(await keepMcp(s, tools.dirs)).toEqual([]);
  rmSync(tools.dir, { recursive: true });
});
