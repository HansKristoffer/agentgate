#!/usr/bin/env bun
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { getErrorMessage } from "hanzio";
import packageInfo from "../../../package.json";
import * as accounts from "./cli/accounts.ts";
import { die, ShowHelp, type Run } from "./cli/common.ts";
import * as desktop from "./cli/desktop.ts";
import * as nodes from "./cli/nodes.ts";
import { runOp } from "./cli/ops.ts";
import * as projects from "./cli/projects.ts";
import * as servers from "./cli/servers.ts";
import * as skills from "./cli/skills.ts";
import * as system from "./cli/system.ts";
import * as t3 from "./cli/t3.ts";
import { controlOps, terminalOpFor } from "./ops/index.ts";
import { store } from "./store.ts";

export { attentionLines } from "./cli/system.ts";

const HELP = `agentgate — pooled Claude, Codex and Cursor subscriptions and per-repo MCP servers, shared over Tailscale or a relay

  init [--always-on] [--name srv]             create the store, name this node
  serve                                       run the daemon in the foreground
  status                                      quota bars, active accounts, nodes
  login claude|codex|cursor [--label work]    log in in a temporary dir and import it (cursor: browser sign-in)
  import claude|codex|cursor --from <dir>     take over an existing login [--label]
  accounts [enable|disable|pin|unpin|rm|exhaust] <id> [minutes]
  accounts priority <id> <n>                 higher is tried first (default 0)
  accounts quota|verify|models|refresh|reset-cooldown <id> [...] (daemon operations)
  accounts verify <id> --probe --model <model>  quota-consuming inference check
  accounts policy <id> --file policy.json    revision-safe account policy edit
  settings show | set --file patch.json      revision-safe partial settings edit
  proxy route <claude|codex|cursor> [--model <id>]   explain selection without sending traffic
  proxy capabilities                         daemon version and provider features
  requests [<request-id>|export] [--provider|--account|--model|--outcome|--failure|--search]
                                             structured local request diagnostics
  tokens [today|7d|30d|all]                  tokens used per model on this machine (default: today)
  mcp                                         (the stdio shim, started by Claude Code, Codex, or Cursor)
  mcp add <name> <url|preset> [--header "Name: value" ...]   any name; its slug is the id and tool prefix
  mcp add <name> --command "npx -y …" [--per-session]
  mcp label <id> <name>                                      change the name shown in the app
  mcp login <name> | rename <name> <new> | ls | presets | test <name> | rm <name>
  mcp projects <name> [<owner/repo|*> ...]   the projects that use the server (* = Global defaults)
  mcp tools <name> [<tool> ...]               offer agents only these tools (none listed: every tool)
  mcp instructions <name> [<text>] [--hide]   replace the server's instructions to agents (no text: its own)
  mcp limit <name> <chars|off|default> [--tool <tool>]   cut longer results (default 20000 characters)
  mcp defaults <name> <tool> [<json>]         arguments a call gets unless the agent passes them (no json: none)
  skills find <query>                         search skills.sh
  skills add <owner/repo|url|folder> [--skill <name>] [--project <owner/repo|*> ...]
  skills new|edit <name> --file SKILL.md      write a skill by hand
  skills [ls] | show <name> | update [name] | rm <name>
  skills projects <name> [<owner/repo|*> ...] where the skill is linked (* = every session)
  skills repo add <github-url> --project <owner/repo|*> ...  keep a public repo's .claude/skills and .agents/skills in sync
  skills repo ls | sync [url] | projects <url> <owner/repo|*> ... | rm <url>
  skills prepare [checkout] [--project <owner/repo>] register and apply links before launch
  skills conflicts                            skill folders that clash with Agentgate's copy, and the ones you kept
  skills resolve <path> agentgate|keep        link Agentgate's copy there (the old one moves to a backup), or keep it
  project set <owner/repo|*> <alias>=<instance> [...]   (alias= removes)
  project ls | show <owner/repo> | defaults <owner/repo> on|off | rm <owner/repo>
  project files add|rm <path> [...] | ls     in a checkout: sync gitignored files (.env.local) to every machine
  project files cat <path> | set <path> [--if-sha <sha256>] < new-contents
                                             print or replace a synced file's contents; --if-sha refuses to
                                             replace a newer version than the one cat printed (cat | shasum -a 256)
  remote enable @name [--node srv]            public MCP endpoint for a virtual project (e.g. for Grok)
  remote show|secret|regenerate|disable @name | remote ls
  remote factory @name on|off                 let the endpoint see and steer the software factory: the board, items,
                                             adding tasks, approve/reject/retry/drop, pause and resume
  remote webhook @name <https-url>|off        post the factory's updates (items added, moved, waiting for you) there
  nodes                                       paired machines, how each connects, and pending updates
  relay [status]                              relay sync state and errors
  t3 connect [<pairing link> | --url <url> --token <token>] [--node <node>]   connect a machine's agentgate to its T3 Code; with no link, its T3 Code creates one
  t3 pair [--tailscale] [--node <node>]   create a pairing link to connect a T3 Code client to a machine's T3 Code
  t3 [status] | disconnect [--node <node>]
  t3 sync [on|off]                            add the GitHub projects one machine's T3 Code has to every other machine's
  t3 history [on|off]                         show a returning thread's messages from other machines in T3 Code (writes T3's database)
  threads [--node <node>]                     active T3 Code threads on every machine
  handoff <thread> [--to server|here|<node>] [--no-wait]   move a thread with its Claude session and code
  handoffs                                    recent handoffs and their state
  handoffs cancel <id> [--node <node>]        give up a handoff stuck waiting for its destination
  factory [help]                              the software factory that works GitHub issues and other sources in T3 Code
  logins                                      GitHub (gh) and Infisical CLI logins shared with every machine
  logins share [github|infisical]             share this machine's logins; every machine signs in with them
  logins signin infisical                     sign the Infisical CLI here in again (browser, or paste its token), then share it
  logins forget github|infisical              stop sharing (machines stay signed in)
  logins identity --client-id <id> [--site <url>]   an Infisical machine identity for every machine (asks for the secret; the site defaults to the Infisical CLI's)
  logins forget infisical-identity            remove it from every machine
  setup --primary [off] [--node <node>]       route your normal ~/.claude and ~/.codex (and Cursor's MCP) through agentgate,
                                              here or on a paired node; the first service install does this for you
  setup --mcp [off]                           only agentgate's MCP servers, in Claude Code, Claude Desktop's Code tab, and Cursor
  setup                                       separate Claude/Codex folders for T3 Code instead, and print their T3 settings
  desktop                                     Claude Desktop: mode, account in use, saved logins (macOS)
  desktop add [email] | use <account> | capture | forget <account>
  desktop gateway on|off                      Desktop's Code tab uses the pool (no Chat, separate profile)
  service install [--no-routing] | start | restart | stop | logs   the first install also routes your own tools
  update [node]                               install the latest release and restart the service, here or on a paired node
  export [--no-secrets] > backup.json | import-backup backup.json
  admin-token                                 print the token for native app control over the tailnet
${[...controlOps.values()]
  .flatMap((op) => (op.terminal ? [`  ${op.terminal.usage.padEnd(43)} ${op.summary}`] : []))
  .join("\n")}`;

const OPTIONS = {
  name: { type: "string" },
  model: { type: "string" },
  provider: { type: "string" },
  account: { type: "string" },
  outcome: { type: "string" },
  failure: { type: "string" },
  search: { type: "string" },
  since: { type: "string" },
  until: { type: "string" },
  limit: { type: "string" },
  cursor: { type: "string" },
  probe: { type: "boolean" },
  "always-on": { type: "boolean" },
  node: { type: "string" },
  label: { type: "string" },
  from: { type: "string" },
  header: { type: "string", multiple: true },
  command: { type: "string" },
  "per-session": { type: "boolean" },
  tool: { type: "string" },
  hide: { type: "boolean" },
  "no-secrets": { type: "boolean" },
  primary: { type: "boolean" },
  mcp: { type: "boolean" },
  skill: { type: "string" },
  project: { type: "string", multiple: true },
  file: { type: "string" },
  "if-sha": { type: "string" },
  tailscale: { type: "boolean" },
  "client-id": { type: "string" },
  site: { type: "string" },
  to: { type: "string" },
  url: { type: "string" },
  token: { type: "string" },
  "no-wait": { type: "boolean" },
  "no-routing": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} satisfies ParseArgsOptionsConfig;

/** The options each command reads; `--help` works everywhere. */
const COMMAND_OPTIONS: Record<string, (keyof typeof OPTIONS)[]> = {
  init: ["name", "always-on"],
  login: ["label"],
  import: ["from", "label"],
  accounts: ["probe", "model", "file"],
  settings: ["file"],
  proxy: ["model"],
  requests: ["provider", "account", "model", "outcome", "failure", "search", "since", "until", "limit", "cursor"],
  mcp: ["header", "command", "per-session", "hide", "tool"],
  skills: ["skill", "project", "file"],
  project: ["if-sha"],
  remote: ["node"],
  logins: ["client-id", "site"],
  t3: ["node", "url", "token", "tailscale"],
  threads: ["node"],
  handoff: ["to", "no-wait"],
  handoffs: ["node"],
  setup: ["primary", "mcp", "node"],
  service: ["no-routing"],
  export: ["no-secrets"],
};

/**
 * Parses argv against only the options its command reads, so a misspelt flag fails instead of being ignored
 * (`export --no-secret` once exported secrets). Throws the message to show; `factory` parses its own words.
 */
export function parseFor(argv: string[]) {
  const command = argv.find((a) => !a.startsWith("-"));
  if (command === "factory") return { values: {}, positionals: [command] };
  const options: ParseArgsOptionsConfig = { help: OPTIONS.help };
  for (const key of COMMAND_OPTIONS[command ?? ""] ?? []) options[key] = OPTIONS[key];
  // Not strict, so the tokens can be checked here with messages that name the command.
  const { values, positionals, tokens } = parseArgs({
    args: argv,
    options,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const usage = command ? `"agentgate ${command}"` : '"agentgate"';
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    const type = options[token.name]?.type;
    if (!type) throw new Error(`Unknown option ${token.rawName} for ${usage}`);
    // Non-strict parsing takes the next word as the value even when it is a flag: `init --name --always-on`.
    const flagAsValue = !token.inlineValue && token.value?.startsWith("-");
    if (type === "string" && (token.value === undefined || flagAsValue))
      throw new Error(`${token.rawName} needs a value for ${usage}`);
    if (type === "boolean" && token.value !== undefined)
      throw new Error(`${token.rawName} takes no value for ${usage}`);
  }
  return { values, positionals };
}

/** Which family runs each command (cli/). */
const FAMILIES: Record<string, Run> = {
  login: accounts.run,
  import: accounts.run,
  accounts: accounts.run,
  proxy: accounts.run,
  tokens: accounts.run,
  requests: accounts.run,
  logins: accounts.run,
  mcp: servers.run,
  skills: skills.run,
  project: projects.run,
  remote: projects.run,
  nodes: nodes.run,
  relay: nodes.run,
  desktop: desktop.run,
  t3: t3.run,
  threads: t3.run,
  handoff: t3.run,
  handoffs: t3.run,
  init: system.run,
  serve: system.run,
  status: system.run,
  settings: system.run,
  factory: system.run,
  setup: system.run,
  service: system.run,
  update: system.run,
  export: system.run,
  "import-backup": system.run,
  "admin-token": system.run,
};

async function main() {
  const argv = Bun.argv.slice(2);
  // A registered operation parses its own words (ops/).
  const op = terminalOpFor(argv);
  if (op) return runOp(op, argv);
  let parsed;
  try {
    parsed = parseFor(argv);
  } catch (e) {
    console.error(getErrorMessage(e));
    process.exit(2);
  }
  const { values: opts, positionals: pos } = parsed;
  const [cmd, sub] = pos;
  if (!cmd || opts.help) return console.log(HELP);

  // The shim must never block or print to stdout: it speaks MCP there.
  if (cmd === "mcp" && !sub) return (await import("./mcp/shim.ts")).runShim();

  const s = store();
  // The daemon writes its version on its node record when it starts.
  const daemon = s.get("node", s.nodeId)?.version;
  if (daemon && daemon !== packageInfo.version && !["serve", "init", "update"].includes(cmd))
    console.error((await import("./update.ts")).versionNotice(daemon));
  const family = Object.hasOwn(FAMILIES, cmd) ? FAMILIES[cmd]! : die(HELP);
  try {
    await family(cmd, pos.slice(1), opts);
  } catch (e) {
    if (e instanceof ShowHelp) die(HELP);
    throw e;
  }
}

if (import.meta.main) main().catch((e) => die(String(e?.message ?? e)));
