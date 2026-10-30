import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { getErrorMessage } from "hanzio";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWrite } from "./files.ts";
import { CONFIG_DIR, liveOnly, LOCAL_URL, PORT, type Store } from "./store.ts";

export const CLAUDE_DIR = join(CONFIG_DIR, "claude");
export const CODEX_DIR = join(CONFIG_DIR, "codex");
export const PRIMARY_CLAUDE_DIR = join(homedir(), ".claude");
export const PRIMARY_CODEX_DIR = process.env.CODEX_HOME ?? join(homedir(), ".codex");
/** Cursor, the Cursor CLI, and T3's Cursor all read MCP servers from this file. */
export const CURSOR_MCP_FILE = join(homedir(), ".cursor", "mcp.json");
export function selfCommand(): string[] {
  return Bun.main.startsWith("/$bunfs/") ? [stableBinary(process.execPath)] : [process.execPath, Bun.main];
}
/** npx, pnpm dlx and bunx run us from a cache they may prune, which would break every config and
 * service written from there. Copy the binary under AGENTGATE_HOME and point at that copy instead. */
export function stableBinary(path: string, dir = join(CONFIG_DIR, "bin")): string {
  if (!/\/(_npx|dlx)\/|\/bunx-/.test(path)) return path;
  const target = join(dir, "agentgate"),
    temp = `${target}.${crypto.randomUUID()}.tmp`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Rename rather than overwrite: the installed service may be running the current copy.
  try {
    copyFileSync(path, temp);
    chmodSync(temp, 0o755);
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
  return target;
}
export function agentEnvironment() {
  return { AGENTGATE_HOME: CONFIG_DIR, AGENTGATE_PORT: String(PORT) };
}
const quote = (s: string) => JSON.stringify(s);

function multilineState(line: string, state: string): string {
  let single = "";
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (state) {
      if (line.startsWith(state, i)) {
        state = "";
        i += 2;
      } else if (state === '"""' && char === "\\") i++;
    } else if (single) {
      if (single === '"' && char === "\\") i++;
      else if (char === single) single = "";
    } else {
      if (char === "#") break;
      if (char === '"' || char === "'") {
        const triple = char.repeat(3);
        if (line.startsWith(triple, i)) {
          state = triple;
          i += 2;
        } else single = char;
      }
    }
  }
  return state;
}

/** The config minus agentgate's tables and the top-level model_provider line. */
function withoutAgentgate(existing: string): string {
  Bun.TOML.parse(existing);
  const lines = existing.split("\n");
  const kept: string[] = [];
  let table = "",
    multiline = "";
  for (const line of lines) {
    if (!multiline) {
      const header = line.match(/^\s*(\[\[?[^\]]+\]\]?)\s*(?:#.*)?$/);
      if (header) {
        // Parse quoted table names with the same parser that will read the resulting config.
        const shape = Bun.TOML.parse(`${header[1]}\n__agentgate_probe = 1`) as Record<string, unknown>;
        table =
          Object.hasOwn(shape, "model_providers") && Object.hasOwn(shape.model_providers as object, "agentgate")
            ? "model_providers.agentgate"
            : Object.hasOwn(shape, "mcp_servers") && Object.hasOwn(shape.mcp_servers as object, "agentgate")
              ? "mcp_servers.agentgate"
              : "other";
      }
    }
    const wasMultiline = !!multiline;
    // A section-looking line inside a multiline value is ordinary content.
    multiline = multilineState(line, multiline);
    if (/^(model_providers\.agentgate|mcp_servers\.agentgate)(\.|$)/.test(table)) continue;
    if (!table && !wasMultiline && /^\s*model_provider\s*=/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/** Own just the agentgate tables and provider choice; preserve other TOML sections verbatim.
 * `primary` is the user's own ~/.codex: Codex sends its own login along, the proxy's last resort. */
export function codexConfig(existing = "", command = selfCommand(), env = agentEnvironment(), primary = false): string {
  const kept = withoutAgentgate(existing);
  const [executable, ...args] = [...command, "mcp"];
  const provider = `[model_providers.agentgate]\nname = "agentgate"\nbase_url = ${quote(`${LOCAL_URL}/codex/backend-api/codex`)}\nwire_api = "responses"\n${primary ? "requires_openai_auth = true\n" : ""}`;
  const mcp = `\n[mcp_servers.agentgate]\ncommand = ${quote(executable!)}\nargs = [${args.map(quote).join(", ")}]\nenv = { ${Object.entries(
    env,
  )
    .map(([k, v]) => `${k} = ${quote(v)}`)
    .join(", ")} }\n`;
  const text = `model_provider = "agentgate"\n${kept}\n\n${provider}${mcp}`;
  Bun.TOML.parse(text);
  return text;
}
const json = (file: string) => {
  const value = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${file}: expected a configuration object`);
  return value;
};
const backup = (file: string) => {
  if (existsSync(file) && !existsSync(`${file}.before-agentgate`)) copyFileSync(file, `${file}.before-agentgate`);
};

/** The token Claude Code sends when it has no login of its own; the proxy replaces it with a pool account's. */
const PLACEHOLDER_TOKEN = "agentgate";

export async function setup(paths = { claude: CLAUDE_DIR, codex: CODEX_DIR }): Promise<string> {
  const codexFile = join(paths.codex, "config.toml");
  const claudeFile = join(paths.claude, ".claude.json");
  const settingsFile = join(paths.claude, "settings.json");
  // Read and validate all files before changing any of them.
  const toml = codexConfig(existsSync(codexFile) ? readFileSync(codexFile, "utf8") : "");
  const cfg = json(claudeFile),
    settings = json(settingsFile);
  const [command, ...args] = [...selfCommand(), "mcp"];
  cfg.mcpServers = { ...cfg.mcpServers, agentgate: { type: "stdio", command, args, env: agentEnvironment() } };
  cfg.hasCompletedOnboarding = true;
  settings.env = {
    ...settings.env,
    ANTHROPIC_BASE_URL: `${LOCAL_URL}/anthropic`,
    ANTHROPIC_AUTH_TOKEN: PLACEHOLDER_TOKEN,
  };
  for (const file of [codexFile, claudeFile, settingsFile]) backup(file);
  atomicWrite(codexFile, toml);
  atomicWrite(claudeFile, JSON.stringify(cfg, null, 2));
  atomicWrite(settingsFile, JSON.stringify(settings, null, 2));
  return `Wrote Claude and Codex configuration. Existing settings and first-run backups are preserved.\n\nIn T3 Code → Settings → Providers:\n  Claude: CLAUDE_CONFIG_DIR = ${paths.claude}\n  Codex: CODEX_HOME = ${paths.codex}\n\nKeep the daemon running (agentgate service install). Pin an account in the native app or with agentgate accounts pin <id>.`;
}

/** This machine's own coding tools, which `setup --primary` routes. */
const OWN = { claude: PRIMARY_CLAUDE_DIR, codex: PRIMARY_CODEX_DIR, cursor: CURSOR_MCP_FILE };

/** `setup --primary [off]` on this machine: Claude Code, Codex and Cursor. Records the choice, so a later
 * `service install` or the daemon never undoes it, and the result on this node, so every machine's Machines view shows it. */
export async function routeHere(s: Store, on: boolean, dirs = OWN) {
  const message = [
    await primary(on, dirs.claude),
    await primaryCodex(on, dirs.codex),
    await cursorMcp(on, dirs.cursor),
  ].join("\n");
  s.setLocal("setup:routing", on ? "on" : "off");
  s.setLocal("setup:mcp", on ? "on" : "off");
  publishRouting(s);
  return { node: s.nodeId, message };
}

/** `setup --mcp [off]`: only the MCP server, in Claude Code and Cursor. Recorded for `keepMcp`. */
export async function mcpHere(s: Store, on: boolean, dirs = OWN) {
  const message = `${await mcp(on, dirs.claude)}\n${await cursorMcp(on, dirs.cursor)}`;
  s.setLocal("setup:mcp", on ? "on" : "off");
  return message;
}

/** `init` marks a new store "pending"; its first `service install` then routes this machine's own tools, once the
 * daemon answers, so Claude Code and Codex never point at a port nobody listens on. Stores from before, and users who
 * chose either way with `setup --primary [off]` or `--no-routing`, are left alone. */
export async function routeByDefault(s: Store, on = true, dirs = OWN): Promise<string | undefined> {
  if (s.local("setup:routing") !== "pending") return;
  if (!on) {
    s.setLocal("setup:routing", "off");
    return "Left Claude Code, Codex and Cursor as they were. Route them later with agentgate setup --primary.";
  }
  try {
    return (await routeHere(s, true, dirs)).message;
  } catch (e) {
    return `Could not route Claude Code and Codex through agentgate: ${getErrorMessage(e)}\nFix that, then run agentgate setup --primary.`;
  }
}

/** Claude Code can write ~/.claude.json back from a stale copy and drop agentgate's MCP server. Put it back while the
 * user wants it: they turned it on, or, on stores from before the choice was recorded, routing is on. */
export async function keepMcp(s: Store, dir = PRIMARY_CLAUDE_DIR): Promise<boolean> {
  const choice = s.local("setup:mcp"),
    { routing, mcp: present } = claudeStatus(dir);
  // A missing file is Claude Code mid-rewrite or not set up at all; writing one from scratch would lose its state.
  if (present || !existsSync(claudeJsonIn(dir)) || (choice ? choice !== "on" : !routing)) return false;
  await mcp(true, dir);
  return true;
}

/** Keep this node's record in step with its own config, which the CLI or a hand edit may change behind the daemon. */
export function publishRouting(s: Store) {
  const me = s.get("node", s.nodeId),
    routing = primaryState();
  if (me && (me.routing?.claude !== routing.claude || me.routing?.codex !== routing.codex))
    s.put("node", s.nodeId, { ...me, routing });
}

/** Whether `setup --primary` currently routes your own ~/.claude and ~/.codex through this daemon. */
export function primaryState(claudeDir = PRIMARY_CLAUDE_DIR, codexDir = PRIMARY_CODEX_DIR) {
  const read = <T>(fn: () => T) => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  return {
    claude: read(() => json(join(claudeDir, "settings.json")).env?.ANTHROPIC_BASE_URL) === `${LOCAL_URL}/anthropic`,
    codex:
      read(
        () =>
          (Bun.TOML.parse(readFileSync(join(codexDir, "config.toml"), "utf8")) as { model_provider?: string })
            .model_provider,
      ) === "agentgate",
  };
}

// Claude Code keeps MCP servers in ~/.claude.json by default, or inside CLAUDE_CONFIG_DIR when set.
const claudeJsonIn = (dir: string) =>
  dir === join(homedir(), ".claude") ? join(homedir(), ".claude.json") : join(dir, ".claude.json");

function mcpFile(file: string): { root: Record<string, unknown>; servers: Record<string, unknown> } {
  if (!existsSync(file)) return { root: {}, servers: {} };
  const root = json(file) as Record<string, unknown>;
  if (root.mcpServers === undefined) return { root, servers: {} };
  if (!root.mcpServers || typeof root.mcpServers !== "object" || Array.isArray(root.mcpServers))
    throw new Error(`${file}: mcpServers must be an object`);
  return { root, servers: { ...(root.mcpServers as Record<string, unknown>) } };
}

/** The stdio server Cursor stores in `mcp.json`: command, args, and env, with no Claude-only `type`. */
export function cursorServer(command = selfCommand(), env = agentEnvironment()) {
  const [executable, ...args] = [...command, "mcp"];
  return { command: executable, args, env };
}

/** The agentgate MCP shim in Cursor's user config. Other servers in the file stay put. */
export async function cursorMcp(on: boolean, file = CURSOR_MCP_FILE): Promise<string> {
  if (file === CURSOR_MCP_FILE) liveOnly("Changing your own Cursor config");
  if (on && !existsSync(dirname(file))) return `No Cursor at ${dirname(file)}; skipped Cursor.`;
  const { root, servers } = mcpFile(file);
  if (on) servers.agentgate = cursorServer();
  else if (servers.agentgate) delete servers.agentgate;
  else return `No agentgate MCP server in ${file}.`;
  if (existsSync(file)) backup(file);
  atomicWrite(file, JSON.stringify({ ...root, mcpServers: servers }, null, 2) + "\n");
  return on
    ? `New Cursor sessions get agentgate's MCP servers. Undo: agentgate setup --mcp off.`
    : `Removed the agentgate MCP server from ${file}.`;
}

export function cursorMcpEnabled(file = CURSOR_MCP_FILE): boolean {
  try {
    return !!mcpFile(file).servers.agentgate;
  } catch {
    return false;
  }
}

/** Just the agentgate MCP server in Claude Code's user config. Claude Desktop's Code tab loads the same file. */
export async function mcp(on: boolean, dir = PRIMARY_CLAUDE_DIR): Promise<string> {
  if (dir === PRIMARY_CLAUDE_DIR) liveOnly("Changing your own Claude Code config");
  const claudeJson = claudeJsonIn(dir);
  const cfg = json(claudeJson),
    [command, ...args] = [...selfCommand(), "mcp"];
  if (on) cfg.mcpServers = { ...cfg.mcpServers, agentgate: { type: "stdio", command, args, env: agentEnvironment() } };
  else if (cfg.mcpServers?.agentgate) delete cfg.mcpServers.agentgate;
  else return `No agentgate MCP server in ${claudeJson}.`;
  backup(claudeJson);
  atomicWrite(claudeJson, JSON.stringify(cfg, null, 2));
  return on
    ? `New Claude Code sessions, including Claude Desktop's Code tab, get agentgate's MCP servers. Undo: agentgate setup --mcp off.`
    : `Removed the agentgate MCP server from ${claudeJson}.`;
}

/** What `setup --primary` / `--mcp` left in the user's own Claude Code config; edits by hand or by older versions show up here. */
export function claudeStatus(dir = PRIMARY_CLAUDE_DIR): { routing: boolean; mcp: boolean } {
  const read = (file: string) => {
    try {
      return json(file);
    } catch {
      return {};
    }
  };
  return {
    routing: read(join(dir, "settings.json")).env?.ANTHROPIC_BASE_URL === `${LOCAL_URL}/anthropic`,
    mcp: !!read(claudeJsonIn(dir)).mcpServers?.agentgate,
  };
}

/** Whether Claude Code is signed in itself: it saves the account in .claude.json, and the token in .credentials.json or the Keychain. */
const ownClaudeLogin = (dir: string) => {
  try {
    return existsSync(join(dir, ".credentials.json")) || !!json(claudeJsonIn(dir)).oauthAccount;
  } catch {
    return false;
  }
};

export async function primary(on: boolean, dir = PRIMARY_CLAUDE_DIR): Promise<string> {
  const file = join(dir, "settings.json"),
    undo = `${file}.agentgate-undo`;
  await mcp(on, dir);
  const settings = json(file);
  const env = { ...settings.env };
  const url = `${LOCAL_URL}/anthropic`;
  if (on) {
    if (!existsSync(undo))
      atomicWrite(
        undo,
        JSON.stringify({ hadValue: Object.hasOwn(env, "ANTHROPIC_BASE_URL"), value: env.ANTHROPIC_BASE_URL }),
      );
    backup(file);
    env.ANTHROPIC_BASE_URL = url;
    // Claude Code will not start without a login, though the proxy never uses it. Keep the user's own where there is
    // one; a server set up from scratch has none and would answer every turn with "Not logged in".
    if (!ownClaudeLogin(dir) && !env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY)
      env.ANTHROPIC_AUTH_TOKEN = PLACEHOLDER_TOKEN;
  } else {
    if (!existsSync(undo) && env.ANTHROPIC_BASE_URL !== url) return `No agentgate setup change to undo in ${file}.`;
    const original = existsSync(`${file}.before-agentgate`) ? (json(`${file}.before-agentgate`).env ?? {}) : {};
    const previous = existsSync(undo)
      ? json(undo)
      : { hadValue: Object.hasOwn(original, "ANTHROPIC_BASE_URL"), value: original.ANTHROPIC_BASE_URL };
    if (env.ANTHROPIC_BASE_URL === url) {
      if (previous.hadValue) env.ANTHROPIC_BASE_URL = previous.value;
      else delete env.ANTHROPIC_BASE_URL;
    }
    if (env.ANTHROPIC_AUTH_TOKEN === PLACEHOLDER_TOKEN) delete env.ANTHROPIC_AUTH_TOKEN;
  }
  settings.env = env;
  if (!Object.keys(env).length) delete settings.env;
  atomicWrite(file, JSON.stringify(settings, null, 2) + "\n");
  if (!on && existsSync(undo)) unlinkSync(undo);
  return on
    ? `New Claude sessions in ${dir} use agentgate. Undo: agentgate setup --primary off.\nKeep the daemon running.`
    : `Restored the previous base URL in ${file}; other settings are preserved.`;
}

const PLACEHOLDER_AUTH = JSON.stringify({ OPENAI_API_KEY: PLACEHOLDER_TOKEN }) + "\n";

/** The Codex half of `setup --primary`: point the user's own ~/.codex at the daemon, keeping its login as last resort. */
export async function primaryCodex(on: boolean, dir = PRIMARY_CODEX_DIR): Promise<string> {
  if (dir === PRIMARY_CODEX_DIR) liveOnly("Changing your own Codex config");
  const file = join(dir, "config.toml"),
    undo = `${file}.agentgate-undo`,
    auth = join(dir, "auth.json");
  if (!existsSync(dir)) return `No Codex home at ${dir}; skipped Codex.`;
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const current = (Bun.TOML.parse(existing) as { model_provider?: string }).model_provider;
  if (on) {
    if (!existsSync(undo))
      atomicWrite(undo, JSON.stringify({ hadValue: current !== undefined && current !== "agentgate", value: current }));
    backup(file);
    atomicWrite(file, codexConfig(existing, undefined, undefined, true));
    // Like Claude above: a server set up from scratch has no Codex login, so `codex login status` (which T3 Code
    // checks before offering Codex) says "Not logged in". The proxy swaps this placeholder key for a pool account.
    if (!existsSync(auth) && !/^\s*cli_auth_credentials_store\s*=\s*"keyring"/m.test(existing))
      atomicWrite(auth, PLACEHOLDER_AUTH);
    return `New Codex sessions in ${dir} use agentgate. Undo: agentgate setup --primary off.`;
  }
  if (current !== "agentgate") {
    if (existsSync(undo)) unlinkSync(undo);
    return `No agentgate setup change to undo in ${file}.`;
  }
  const previous = existsSync(undo) ? json(undo) : { hadValue: false };
  const kept = withoutAgentgate(existing);
  if (existsSync(auth) && readFileSync(auth, "utf8") === PLACEHOLDER_AUTH) unlinkSync(auth);
  atomicWrite(file, `${previous.hadValue ? `model_provider = ${quote(previous.value)}\n` : ""}${kept}\n`);
  if (existsSync(undo)) unlinkSync(undo);
  return `Restored the previous Codex provider in ${file}; other settings are preserved.`;
}
