# agentgate

One daemon per machine that:

- pools several **Claude** and **Codex** subscriptions and moves to the next account when one hits its limit;
- hosts **MCP servers** and gives each GitHub repo its own set (e.g. a separate PostHog project per repo), plus general ones for every repo;
- **shares** all of it between your machines over Tailscale, and keeps working when the other machines are offline.

T3 Code (or plain Claude Code / Codex) runs the sessions; agentgate sits underneath. See [PLAN.md](PLAN.md) for the design and [STABILITY_PLAN.md](STABILITY_PLAN.md) for the code review, reliability fixes, and refactoring order.

## Install

Requirements: Linux or macOS, [Tailscale](https://tailscale.com) on every machine, `claude` and/or `codex` CLIs for logging in, and Node (`npx`) or uv (`uvx`) for any stdio MCP servers you add.

```sh
npm install -g @hanskristoffer/agentpool   # installs the `agentgate` command (and an `agentpool` alias)
```

Without npm:

```sh
curl -fsSL https://raw.githubusercontent.com/HansKristoffer/agentgate/main/install.sh | AGENTGATE_REPO=HansKristoffer/agentgate sh
```

Or from source: `bun install && bun run build` (binaries land in `dist/`), or run `bun src/cli.ts …` directly.

## First machine

```sh
agentgate init                      # names the node after the host; add --always-on on a server
agentgate login claude --label work # official login in a temp dir, imported, then deleted
agentgate login codex --label personal
agentgate setup                     # writes Claude Code / Codex config, prints the T3 settings
agentgate service install           # launchd (macOS) or systemd --user (Linux)
```

Open http://127.0.0.1:7878 for the web UI. Everything below can also be done there.

## A second machine (e.g. an always-on server)

On the first machine: `agentgate pair`. It prints a command, valid for 10 minutes. On the server:

```sh
agentgate init --name srv --always-on
agentgate join http://mac.<tailnet>.ts.net:7878 <code>
agentgate setup
agentgate service install           # also runs `loginctl enable-linger` so it survives logout/reboot
```

The server now has every account, MCP instance and repo mapping, and takes over token refreshes. The UI is reachable at `http://srv.<tailnet>.ts.net:7878` after logging in with `agentgate admin-token`.

## T3 Code

`agentgate setup` writes a Claude config dir (whose `settings.json` points Claude Code at the daemon) and a Codex home. In T3 Code, add one provider instance per provider:

| Provider | T3 setting |
|---|---|
| Claude | `CLAUDE_CONFIG_DIR path` = `~/.config/agentgate/claude` |
| Codex | `CODEX_HOME path` = `~/.config/agentgate/codex` |

One instance per provider covers every account; the daemon switches accounts, so a thread never breaks when an account runs out. To prefer one account, pin it (`agentgate accounts pin <id>` or the UI).

### Or: your normal Claude login

`agentgate setup --primary` adds only `ANTHROPIC_BASE_URL` to `~/.claude/settings.json`, so the Claude Code you already use (and T3's default Claude instance) goes through agentgate while keeping its own login. Model requests use the pool; other requests keep your login, and your login is also the last resort when every pooled account is exhausted. Undo with `agentgate setup --primary off` (the previous base URL is restored, and later settings edits are preserved). It does the same for `~/.codex/config.toml` (or `$CODEX_HOME`): an `agentgate` model provider with `requires_openai_auth = true`, so Codex, the Codex app and T3's default Codex instance send their own ChatGPT login along as the last resort. Only do this with `agentgate service install`, or Claude Code and Codex can't reach their providers while the daemon is down.

## MCP servers per repo

In the UI (MCP servers page), paste a server's URL and a name and click **Connect**. If the server uses MCP OAuth, you are sent to its login page and back; agentgate keeps the login, refreshes it, and syncs it to your other machines. One-click buttons cover common hosted servers (PostHog, Linear, Sentry, Notion, Supabase, Stripe, Vercel, Cloudflare, Neon, Railway, Context7) and a per-worktree filesystem server. Servers that take an API key instead get it under **Extra headers** (`Authorization: Bearer …`); the same field pins a server to one project (`x-posthog-project-id: 12345`).

From the CLI:

```sh
agentgate mcp add geysier https://app.geysier.com/api/mcp
agentgate mcp login geysier                   # opens the login page; the daemon receives the callback
agentgate mcp add posthog-lullu posthog --header "x-posthog-project-id: 12345"
agentgate mcp add fs filesystem               # presets: agentgate mcp presets
agentgate mcp add mytool --command "npx -y @some/mcp-server" [--per-session]

agentgate project set '*' fs=fs
agentgate project set Lullu-ai/lullu posthog=posthog-lullu
agentgate mcp test posthog-lullu
```

The name is the tool prefix: in every repo mapped to `posthog-lullu` under the alias `posthog`, the agent sees `posthog__…` tools that reach that repo's PostHog project. The repo is taken from `git remote get-url origin` in the session's working directory (override with `AGENTGATE_PROJECT=owner/repo`). Mapping changes reach running sessions without a restart.

## Commands

Run `agentgate --help`. Useful ones: `status`, `accounts`, `accounts exhaust <id> [min]` (pretend an account hit its limit, for testing), `nodes`, `unpair <node>`, `export [--no-secrets]`, `import-backup <file>`, `service logs`.

## Things to know

- **Once imported, a login belongs to agentgate.** Don't keep using the original `~/.claude` or `~/.codex` login: its CLI would refresh the token and log agentgate out. `agentgate login` avoids this by using a throwaway directory.
- **Secrets are stored in plain text** in `~/.config/agentgate/agentgate.db` (mode 0600) and copied to every paired node. Pair only machines you control.
- **Terms of service.** Pool only your own accounts and keep a person driving the sessions; see PLAN.md §16.

## Development

```sh
bun install
bun test
bun run typecheck
AGENTGATE_HOME=/tmp/ag AGENTGATE_PORT=7979 bun src/cli.ts init   # a throwaway node
```

## Reliability and upgrades

The reliability refactor is implemented; [STABILITY_PLAN.md](STABILITY_PLAN.md#implementation-and-verification--2026-09-30) records the changes, checks, and remaining live release gates. Account and MCP OAuth refreshes share holder coordination and a local cross-process lease. Running MCP shims reconnect after daemon restarts and update per-session mappings; tool calls with uncertain outcomes are never automatically replayed.

Upgrade paired nodes together. This version uses **sync protocol 2**, and older peers are rejected. Existing MCP OAuth credentials migrate automatically into a separate record when the database opens. Deletion history is retained so offline machines cannot resurrect old configuration. Keep a full backup before upgrading.

`export --no-secrets` / **Without secrets** produces an inventory: it omits logins, OAuth client secrets, and arbitrary MCP URLs, headers, commands/arguments, environment, fields, and secrets. Restored inventory transports need configuration again. Full exports contain working credentials and transport configuration.

`setup` preserves unrelated Claude/Codex settings and first-run backups. Generated shims/services include `AGENTGATE_HOME` and `AGENTGATE_PORT`; rerun setup and reinstall the service if you change either value or move the binary. An unsuccessful temporary CLI login/import keeps its folder for recovery instead of deleting the only credential copy.

The proxy bounds request bodies to 16 MiB, waits at most 30 seconds for upstream headers, and cancels a response stream after five minutes without data. MCP tool calls allow five minutes without progress, with a 30-minute total limit. Status reports expired logins, refresh failures, sync errors, and quota headers that could not be recognized.

Network partitions can still cause separate machines to compete for a rotating upstream token. Reconnect and sync the newer credential first; if the provider revoked it, log in again. Live subscription traffic, T3 provider sessions, physical Tailscale failover, and installed service reboot/logout behavior remain release checks.

## Development checks

Use Bun 1.4.2 and the committed lockfile:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun scripts/smoke.ts dist/agentgate-darwin-arm64 # use your host target
bun scripts/codex-smoke.ts                    # optional: installed Codex CLI, fake upstream
```

Builds produce four macOS/Linux binaries and `dist/SHA256SUMS`. Releases use [release-please](https://github.com/googleapis/release-please): conventional commits on `main` (`feat:`, `fix:`) keep a release PR open with the next version and changelog, and merging it publishes the binaries to npm (`@hanskristoffer/agentpool` plus one `agentpool-<os>-<cpu>` package per binary, via `scripts/npm.ts`; needs the `NPM_TOKEN` secret) and to a GitHub release. The installer verifies the checksum from the same resolved release before replacing an installed binary. CI runs tests, typechecking, and compiled CLI checks on macOS and Linux.
