# agentgate

One daemon per machine that:

- pools several **Claude** and **Codex** subscriptions and moves to the next account when one hits its limit;
- hosts **MCP servers** and gives each GitHub repo its own set (e.g. a separate PostHog project per repo), plus general ones for every repo;
- **shares** all of it between your machines over Tailscale, and keeps working when the other machines are offline.

T3 Code (or plain Claude Code / Codex) runs the sessions; agentgate sits underneath. The optional **Tauri macOS app** controls your local or remote setup. The daemon and CLI work independently, including on headless Linux servers. There is no web UI. See [operations and distribution checks](docs/operations.md).

## Using the Claude Desktop app

Agentgate works with Claude Desktop without any terminal: open the Agentgate app, choose **Set up this machine**, then **Accounts**, which has a **Claude Desktop** panel. Choose one of two ways:

- **Switch accounts**: Claude Desktop stays signed in to your full Claude account (Chat, Cowork, Code). Agentgate keeps a saved login per account on this Mac and switches with one click, from the app or the menu bar. Desktop restarts when you switch.
- **Share automatically**: Claude Desktop's Code tab uses whichever subscription has room and moves on by itself. Desktop runs a separate local profile without Chat.

Agentgate's MCP servers also work in Desktop's Code tab. See [Using Agentgate with Claude Desktop](docs/claude-desktop.md).

## Install

Requirements: Linux or macOS, [Tailscale](https://tailscale.com) on every machine, `claude` and/or `codex` CLIs for logging in, and Node (`npx`) or uv (`uvx`) for any stdio MCP servers you add.

```sh
npm install -g @hanskristoffer/agentpool   # installs the `agentgate` command (and an `agentpool` alias)
```

Without npm:

```sh
curl -fsSL https://raw.githubusercontent.com/HansKristoffer/agentgate/main/install.sh | AGENTGATE_REPO=HansKristoffer/agentgate sh
```

Or from source: `bun install && bun run build` (binaries land in `dist/`), or run `bun run cli -- …` directly.

## First machine

```sh
agentgate init                      # names the node after the host; add --always-on on a server
agentgate login claude --label work # official login in a temp dir, imported, then deleted
agentgate login codex --label personal
agentgate setup                     # writes Claude Code / Codex config, prints the T3 settings
agentgate service install           # launchd (macOS) or systemd --user (Linux)
```

You can do every setup step with the CLI. To use the native app, build it with `bun run build:desktop` and open **Agentgate.app**. It connects to `http://127.0.0.1:7878` by default. On a fresh machine, **Set up this machine** installs the bundled CLI in `~/.config/agentgate/bin`, initializes the store, and starts a launchd service. Add that folder to your shell PATH to use the CLI. Closing or removing the app leaves that service and its CLI running.

The app has Accounts, MCP servers, Projects, Machines, and Settings screens. **Settings → Configure coding tools** generates the Claude/Codex folders and T3 settings. The app's service and coding-tool controls apply only to its configured local daemon; remote setup and services use the CLI on that machine.

## A second machine (e.g. an always-on server)

On the first machine: `agentgate pair`. It prints a command, valid for 10 minutes. On the server:

```sh
agentgate init --name srv --always-on
agentgate join http://mac.<tailnet>.ts.net:7878 <code>
agentgate setup
agentgate service install           # also runs `loginctl enable-linger` so it survives logout/reboot
```

The server now has every account, MCP instance and repo mapping, and takes over token refreshes. To control the server from the native app, open the connection settings at the bottom of the sidebar, enter `http://srv.<tailnet>.ts.net:7878`, and paste the token printed by `agentgate admin-token` on the server. Remote management uses bearer authentication over Tailscale.

## T3 Code

`agentgate setup` writes a Claude config dir (whose `settings.json` points Claude Code at the daemon) and a Codex home. In T3 Code, add one provider instance per provider:

| Provider | T3 setting |
|---|---|
| Claude | `CLAUDE_CONFIG_DIR path` = `~/.config/agentgate/claude` |
| Codex | `CODEX_HOME path` = `~/.config/agentgate/codex` |

One instance per provider covers every account; the daemon switches accounts, so a thread never breaks when an account runs out. To prefer one account, pin it (`agentgate accounts pin <id>` or the app).

### Or: your normal Claude login

`agentgate setup --primary` adds `ANTHROPIC_BASE_URL` to `~/.claude/settings.json` and the agentgate MCP server to `~/.claude.json`, so the Claude Code you already use (and T3's default Claude instance) goes through agentgate while keeping its own login. Claude Desktop is not affected: it sets its own API address; see [Claude Desktop](docs/claude-desktop.md). For only the MCP servers, use `agentgate setup --mcp`. Model requests use the pool; other requests keep your login, and your login is also the last resort when every pooled account is exhausted. Undo with `agentgate setup --primary off` (the previous base URL is restored, and later settings edits are preserved). It does the same for `~/.codex/config.toml` (or `$CODEX_HOME`): an `agentgate` model provider with `requires_openai_auth = true`, so Codex, the Codex app and T3's default Codex instance send their own ChatGPT login along as the last resort. Only do this with `agentgate service install`, or Claude Code and Codex can't reach their providers while the daemon is down.

## MCP servers per repo

In the native app (MCP servers), paste a server's URL and a name and click **Connect**. If the server uses MCP OAuth, click **Sign in** to open the browser; its callback completes in the daemon and the app updates automatically; agentgate keeps the login, refreshes it, and syncs it to your other machines. Presets cover common hosted servers (PostHog, Linear, Sentry, Notion, Supabase, Stripe, Vercel, Cloudflare, Neon, Railway, Context7) and a per-worktree filesystem server. Servers that take an API key instead get it under **Extra headers** (`Authorization: Bearer …`); the same field pins a server to one project (`x-posthog-project-id: 12345`).

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
- **Terms of service.** Pool only your own accounts and keep a person driving the sessions; follow the providers’ applicable terms.

## Development

```sh
bun install
bun run cli -- init                   # initialize the daemon
bun start                            # foreground daemon, no app required
bun dev                              # Tauri app with Vite hot reload (Rust + Xcode tools required)
bun test
bun run typecheck
AGENTGATE_HOME=/tmp/ag AGENTGATE_PORT=7979 bun run cli -- init   # a throwaway node
```

## Monorepo

| Workspace | Role |
|---|---|
| `apps/agentgate` (`@agentgate/daemon`) | Bun daemon, standalone CLI, provider proxies, SQLite, sync, and MCP gateway |
| `apps/desktop` (`@agentgate/desktop`) | Tauri 2 shell with React/Vite, system appearance, translucent sidebar, and remembered window state |
| `apps/site` (`@agentgate/site`) | Static Astro landing page for Cloudflare Pages |
| `packages/protocol` (`@agentgate/protocol`) | Shared control API types and configuration schemas |

The app uses Tauri commands to send HTTP requests from Rust. It has no browser HTTP fallback, server-rendered pages, cookies, or CORS management access. The daemon's `/api/*` management endpoints reject browser Origin/Fetch Metadata headers; remote requests require the node's admin bearer token. Status omits credentials, header values, command environments, and URL credentials/query strings. `/oauth/callback` is a small text response for MCP sign-in, including CLI sign-in. Provider and MCP traffic remains loopback-only. Backup export/restore and login-directory import require a local connection.

`bun run build` builds the four standalone CLI binaries. `bun run build:desktop` builds a macOS `.app` and `.dmg` and bundles a compiled daemon for the requested Tauri target. Use `bun run --filter @agentgate/desktop tauri build --target universal-apple-darwin` for the universal build releases ship, after `rustup target add x86_64-apple-darwin aarch64-apple-darwin`. The service executable is copied outside the app bundle before installing it or generating coding-tool settings.

## Landing page

`apps/site` is a static Astro page. It reads the latest GitHub release at build time to link the DMG, so rebuild it after a release. In Cloudflare Pages, keep the repository root as the root directory, set the build command to `bun run build:site` and the output directory to `apps/site/dist`. Set `GITHUB_TOKEN` in the build environment if the release lookup hits GitHub's rate limit. To upload from your machine instead: `bun run --filter @agentgate/site deploy`.

## Reliability

See [operations](docs/operations.md) for backup, upgrade, and live distribution checks. Account and MCP OAuth refreshes share holder coordination and a local cross-process lease. Running MCP shims reconnect after daemon restarts and update per-session mappings; tool calls with uncertain outcomes are never automatically replayed.

Nodes use **sync protocol 2** and the app checks **management API version 1** when connecting. Deletion history is retained so offline machines cannot resurrect old configuration.

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
bun run build:frontend
bun scripts/desktop-prepare.ts         # prepares the bundled daemon for Rust checks
bun run check:native
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
bun run build:desktop
bun scripts/smoke.ts dist/agentgate-darwin-arm64 # use your host target
bun scripts/codex-smoke.ts                    # optional: installed Codex CLI, fake upstream
```

Builds produce four macOS/Linux binaries and `dist/SHA256SUMS`. Releases use [release-please](https://github.com/googleapis/release-please): conventional commits on `main` (`feat:`, `fix:`) keep a release PR open with the next version and changelog, and merging it publishes the binaries to npm (`@hanskristoffer/agentpool` plus one `agentpool-<os>-<cpu>` package per binary, via `scripts/npm.ts`; npm trusted publishing is configured for each generated package) and to a GitHub release. The installer verifies the checksum from the same resolved release before replacing an installed binary. CI runs tests, typechecking, frontend builds, and compiled CLI checks on macOS and Linux, plus Rust checks and app packaging on macOS. Releases also attach a universal macOS DMG, signed with a Developer ID certificate and notarized (`.github/workflows/build-macos.yml`; run it by hand with a tag to rebuild one). It needs these repository secrets:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the Developer ID Application `.p12`, including the G2 intermediate |
| `APPLE_CERTIFICATE_PASSWORD` | its password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Name (TEAMID)` |
| `APPLE_TEAM_ID` | ten-character team id |
| `APPLE_API_KEY` | App Store Connect API key id |
| `APPLE_API_ISSUER` | its issuer id |
| `APPLE_API_KEY_CONTENT` | contents of the `.p8` |
| `TAURI_SIGNING_PRIVATE_KEY` | contents of the updater key from `bun run --filter @agentgate/desktop tauri signer generate` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password |

The release also carries a signed app archive and `latest.json`. Installed apps check that on launch and every four hours and offer a restart to update; the public key in `tauri.conf.json` rejects anything not signed with the updater key. Keep that key: without it, installed copies can never update again. On launch, an updated app also replaces the daemon copy the service runs when it differs from the bundled one, then restarts the service.

The bundled daemon is signed with the app's `Entitlements.plist`. It holds only `allow-jit`: under the hardened runtime, a compiled Bun binary without it falls back to the JavaScript interpreter and runs about 50 times slower. The standalone CLI binaries are not signed.

See [release and recovery instructions](docs/releasing.md).
