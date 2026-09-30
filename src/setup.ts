import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR, LOCAL_URL } from "./store.ts";

export const CLAUDE_DIR = join(CONFIG_DIR, "claude");
export const CODEX_DIR = join(CONFIG_DIR, "codex");

/** How to start this program again: the compiled binary itself, or `bun src/cli.ts` in development. */
export function selfCommand(): string[] {
  return Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main];
}

const toml = (s: string) => JSON.stringify(s);

export function codexConfig(): string {
  const [command, ...args] = [...selfCommand(), "mcp"];
  return `# Written by \`agentgate setup\`; rerunning it overwrites this file.
model_provider = "agentgate"

[model_providers.agentgate]
name = "agentgate"
base_url = "${LOCAL_URL}/codex/backend-api/codex"
wire_api = "responses"

[mcp_servers.agentgate]
command = ${toml(command!)}
args = [${args.map(toml).join(", ")}]
`;
}

/** `agentgate setup`: writes the Claude Code and Codex config for this node, returns what to paste into T3. */
export async function setup(): Promise<string> {
  mkdirSync(CODEX_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(CODEX_DIR, "config.toml"), codexConfig());

  mkdirSync(CLAUDE_DIR, { recursive: true, mode: 0o700 });
  const file = join(CLAUDE_DIR, ".claude.json");
  const cfg = existsSync(file) ? await Bun.file(file).json() : {};
  const [command, ...args] = [...selfCommand(), "mcp"];
  cfg.mcpServers = { ...cfg.mcpServers, agentgate: { type: "stdio", command, args, env: {} } };
  cfg.hasCompletedOnboarding = true;
  writeFileSync(file, JSON.stringify(cfg, null, 2));

  // T3's Claude instance only sets CLAUDE_CONFIG_DIR, so the proxy env goes in that dir's settings.json.
  const settingsFile = join(CLAUDE_DIR, "settings.json");
  const settings = existsSync(settingsFile) ? await Bun.file(settingsFile).json() : {};
  settings.env = { ...settings.env, ANTHROPIC_BASE_URL: `${LOCAL_URL}/anthropic`, ANTHROPIC_AUTH_TOKEN: "agentgate" };
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

  return `Wrote ${join(CODEX_DIR, "config.toml")}
Wrote the user-scope "agentgate" MCP server into ${file}
Wrote ANTHROPIC_BASE_URL=${LOCAL_URL}/anthropic and ANTHROPIC_AUTH_TOKEN=agentgate into ${settingsFile}

In T3 Code (Settings → Providers), add one instance per provider:

  Claude instance:  CLAUDE_CONFIG_DIR path = ${CLAUDE_DIR}
  Codex instance:   CODEX_HOME path       = ${CODEX_DIR}

Without T3, start the CLIs with CLAUDE_CONFIG_DIR / CODEX_HOME set to those paths.

Account switching happens in the daemon; use the UI's pin to prefer one account.`;
}

export const PRIMARY_CLAUDE_DIR = join(homedir(), ".claude");

/**
 * `agentgate setup --primary [off]`: route the normal ~/.claude login through the daemon. Only the base URL
 * is set; the login stays, so the proxy swaps tokens on model requests and falls back to that login.
 */
export async function primary(on: boolean): Promise<string> {
  const file = join(PRIMARY_CLAUDE_DIR, "settings.json");
  const settings = existsSync(file) ? await Bun.file(file).json() : {};
  if (existsSync(file) && !existsSync(`${file}.before-agentgate`)) copyFileSync(file, `${file}.before-agentgate`);
  const env = { ...settings.env };
  if (on) env.ANTHROPIC_BASE_URL = `${LOCAL_URL}/anthropic`;
  else delete env.ANTHROPIC_BASE_URL;
  settings.env = env;
  if (!Object.keys(env).length) delete settings.env;
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  const warn = env.ANTHROPIC_AUTH_TOKEN ? `\nNote: ${file} also sets ANTHROPIC_AUTH_TOKEN, which replaces your login.` : "";
  return on
    ? `Claude Code sessions using ${PRIMARY_CLAUDE_DIR} now go through agentgate (new sessions). Undo: agentgate setup --primary off${warn}
Keep the daemon running (agentgate service install), or those sessions cannot reach Anthropic.`
    : `Removed ANTHROPIC_BASE_URL from ${file}; new sessions talk to Anthropic directly again.`;
}
