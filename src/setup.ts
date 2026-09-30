import { copyFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./files.ts";
import { CONFIG_DIR, LOCAL_URL, PORT } from "./store.ts";

export const CLAUDE_DIR = join(CONFIG_DIR, "claude");
export const CODEX_DIR = join(CONFIG_DIR, "codex");
export const PRIMARY_CLAUDE_DIR = join(homedir(), ".claude");
export function selfCommand(): string[] {
  return Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main];
}
export function agentEnvironment() { return { AGENTGATE_HOME: CONFIG_DIR, AGENTGATE_PORT: String(PORT) }; }
const quote = (s: string) => JSON.stringify(s);

function multilineState(line: string, state: string): string {
  let single = "";
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (state) {
      if (line.startsWith(state, i)) { state = ""; i += 2; }
      else if (state === '"""' && char === "\\") i++;
    } else if (single) {
      if (single === '"' && char === "\\") i++;
      else if (char === single) single = "";
    } else {
      if (char === "#") break;
      if (char === '"' || char === "'") {
        const triple = char.repeat(3);
        if (line.startsWith(triple, i)) { state = triple; i += 2; }
        else single = char;
      }
    }
  }
  return state;
}

/** Own just the agentgate tables and provider choice; preserve other TOML sections verbatim. */
export function codexConfig(existing = "", command = selfCommand(), env = agentEnvironment()): string {
  Bun.TOML.parse(existing);
  const lines = existing.split("\n");
  const kept: string[] = []; let table = "", multiline = "";
  for (const line of lines) {
    if (!multiline) {
      const header = line.match(/^\s*(\[\[?[^\]]+\]\]?)\s*(?:#.*)?$/);
      if (header) {
        // Parse quoted table names with the same parser that will read the resulting config.
        const shape = Bun.TOML.parse(`${header[1]}\n__agentgate_probe = 1`) as Record<string, unknown>;
        table = Object.hasOwn(shape, "model_providers") && Object.hasOwn(shape.model_providers as object, "agentgate") ? "model_providers.agentgate" : Object.hasOwn(shape, "mcp_servers") && Object.hasOwn(shape.mcp_servers as object, "agentgate") ? "mcp_servers.agentgate" : "other";
      }
    }
    const wasMultiline = !!multiline;
    // A section-looking line inside a multiline value is ordinary content.
    multiline = multilineState(line, multiline);
    if (/^(model_providers\.agentgate|mcp_servers\.agentgate)(\.|$)/.test(table)) continue;
    if (!table && !wasMultiline && /^\s*model_provider\s*=/.test(line)) continue;
    kept.push(line);
  }
  const [executable, ...args] = [...command, "mcp"];
  const text = `model_provider = "agentgate"\n${kept.join("\n").trim()}\n\n[model_providers.agentgate]\nname = "agentgate"\nbase_url = ${quote(`${LOCAL_URL}/codex/backend-api/codex`)}\nwire_api = "responses"\n\n[mcp_servers.agentgate]\ncommand = ${quote(executable!)}\nargs = [${args.map(quote).join(", ")}]\nenv = { ${Object.entries(env).map(([k, v]) => `${k} = ${quote(v)}`).join(", ")} }\n`;
  Bun.TOML.parse(text); return text;
}
const json = (file: string) => {
  const value = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${file}: expected a configuration object`);
  return value;
};
const backup = (file: string) => { if (existsSync(file) && !existsSync(`${file}.before-agentgate`)) copyFileSync(file, `${file}.before-agentgate`); };

export async function setup(paths = { claude: CLAUDE_DIR, codex: CODEX_DIR }): Promise<string> {
  const codexFile = join(paths.codex, "config.toml");
  const claudeFile = join(paths.claude, ".claude.json");
  const settingsFile = join(paths.claude, "settings.json");
  // Read and validate all files before changing any of them.
  const toml = codexConfig(existsSync(codexFile) ? readFileSync(codexFile, "utf8") : "");
  const cfg = json(claudeFile), settings = json(settingsFile);
  const [command, ...args] = [...selfCommand(), "mcp"];
  cfg.mcpServers = { ...cfg.mcpServers, agentgate: { type: "stdio", command, args, env: agentEnvironment() } };
  cfg.hasCompletedOnboarding = true;
  settings.env = { ...settings.env, ANTHROPIC_BASE_URL: `${LOCAL_URL}/anthropic`, ANTHROPIC_AUTH_TOKEN: "agentgate" };
  for (const file of [codexFile, claudeFile, settingsFile]) backup(file);
  atomicWrite(codexFile, toml); atomicWrite(claudeFile, JSON.stringify(cfg, null, 2)); atomicWrite(settingsFile, JSON.stringify(settings, null, 2));
  return `Wrote Claude and Codex configuration. Existing settings and first-run backups are preserved.\n\nIn T3 Code → Settings → Providers:\n  Claude: CLAUDE_CONFIG_DIR = ${paths.claude}\n  Codex: CODEX_HOME = ${paths.codex}\n\nKeep the daemon running (agentgate service install). Use the UI's pin to prefer an account.`;
}

export async function primary(on: boolean, dir = PRIMARY_CLAUDE_DIR): Promise<string> {
  const file = join(dir, "settings.json"), undo = `${file}.agentgate-undo`;
  const settings = json(file); const env = { ...settings.env }; const url = `${LOCAL_URL}/anthropic`;
  if (on) {
    if (!existsSync(undo)) atomicWrite(undo, JSON.stringify({ hadValue: Object.hasOwn(env, "ANTHROPIC_BASE_URL"), value: env.ANTHROPIC_BASE_URL }));
    backup(file); env.ANTHROPIC_BASE_URL = url;
  } else {
    if (!existsSync(undo) && env.ANTHROPIC_BASE_URL !== url) return `No agentgate setup change to undo in ${file}.`;
    const original = existsSync(`${file}.before-agentgate`) ? json(`${file}.before-agentgate`).env ?? {} : {};
    const previous = existsSync(undo) ? json(undo) : { hadValue: Object.hasOwn(original, "ANTHROPIC_BASE_URL"), value: original.ANTHROPIC_BASE_URL };
    if (env.ANTHROPIC_BASE_URL === url) { if (previous.hadValue) env.ANTHROPIC_BASE_URL = previous.value; else delete env.ANTHROPIC_BASE_URL; }
  }
  settings.env = env; if (!Object.keys(env).length) delete settings.env;
  atomicWrite(file, JSON.stringify(settings, null, 2) + "\n"); if (!on && existsSync(undo)) unlinkSync(undo);
  return on ? `New Claude sessions in ${dir} use agentgate. Undo: agentgate setup --primary off.\nKeep the daemon running.` : `Restored the previous base URL in ${file}; other settings are preserved.`;
}
