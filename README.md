# agentgate

One daemon per machine that:

- pools several **Claude** and **Codex** subscriptions and moves to the next account when one hits its limit;
- hosts **MCP servers** and gives each GitHub repo its own set (e.g. a separate PostHog project per repo), plus general ones for every repo;
- **shares** all of it between your machines over Tailscale or an end-to-end encrypted relay, and keeps working when the other machines are offline.

T3 Code (or plain Claude Code / Codex) runs the sessions; agentgate sits underneath. The optional **Tauri macOS app** controls your local or remote setup. The daemon and CLI work independently, including on headless Linux servers. There is no web UI. See [running agentgate](docs/operations/running.md).

## Using the Claude Desktop app

Agentgate works with Claude Desktop without any terminal: open the Agentgate app, choose **Set up this machine**, then **Accounts**, which has a **Claude Desktop** panel. Choose one of two ways:

- **Switch accounts**: Claude Desktop stays signed in to your full Claude account (Chat, Cowork, Code). Agentgate keeps a saved login per account on this Mac and switches with one click, from the app or the menu bar. Desktop restarts when you switch.
- **Share automatically**: Claude Desktop's Code tab uses whichever subscription has room and moves on by itself. Desktop runs a separate local profile without Chat.

Agentgate's MCP servers also work in Desktop's Code tab. See [Using Agentgate with Claude Desktop](docs/user/claude-desktop.md).

## Install

Requirements: Linux or macOS, [Tailscale](https://tailscale.com) or a relay (see below) to connect machines, `claude` and/or `codex` CLIs for logging in, and Node (`npx`) or uv (`uvx`) for any stdio MCP servers you add.

```sh
npm install -g @hanskristoffer/agentpool   # installs the `agentgate` command (and an `agentpool` alias)
```

Without npm:

```sh
curl -fsSL https://raw.githubusercontent.com/HansKristoffer/agentgate/main/install.sh | sh
```

Update a machine installed this way with `agentgate update`: it installs the latest release and restarts the service. `agentgate update <node>` does the same on a paired machine, and the app lists machines on an older release on the overview with an **Update** button under Machines. With npm, run `npm install -g @hanskristoffer/agentpool@latest` and `agentgate service restart`; the Mac app updates itself and its daemon.

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

The app has Accounts, Activity, MCP servers, Skills, Projects, Machines, T3 Code, and Settings screens. **Settings → Configure coding tools** generates the Claude/Codex folders and T3 settings. The app's service and coding-tool controls apply only to its configured local daemon; remote setup and services use the CLI on that machine.

## A second machine (e.g. an always-on server)

There are two ways to connect machines, and a machine can use both:

- **Same network (Tailscale):** both machines are on your tailnet. Pairing uses a code that expires after 10 minutes.
- **Relay:** works across any network, without Tailscale. Every record is encrypted before it leaves the machine; the relay stores only ciphertext and can't read your credentials.

On the first machine, run `agentgate pair` or use **Pair a machine** in the app. In a terminal it asks which method to use and what to name the other machine; `--tailnet`, `--relay` and `--name` skip the questions, and an empty name uses the other machine's hostname. It prints one command to run on the server, which installs agentgate, joins, installs the service (on Linux this also runs `loginctl enable-linger` so it survives logout/reboot), and runs `agentgate setup --primary` so that machine's own Claude Code and Codex go through agentgate with no further setup (undo with `agentgate setup --primary off`):

```sh
curl -fsSL https://raw.githubusercontent.com/HansKristoffer/agentgate/main/install.sh | AGENTGATE_NAME=srv sh -s -- join agr1.…
```

If agentgate is already installed there, `agentgate join agr1.…` (relay) or `agentgate join http://mac.<tailnet>.ts.net:7878 <code>` (Tailscale) joins without reinstalling. Mark an always-on server with `agentgate init --always-on` or the **Always on** switch.

The server now has every account, MCP instance and repo mapping, and takes over token refreshes.

**The relay invite never expires and is a master key.** Anyone who has it can read every account and MCP login, so share it privately. If it leaks, run `agentgate relay rotate` and have every relay machine join again with the new command. Removing a relay machine (`agentgate unpair <node>` or **Remove** in the app) rotates the same way. A rotation can't revoke Tailscale links, so also unpair the removed machine on every machine you keep. By default it uses the hosted relay at `https://agentgate-relay.hanskristoffer.dk`. To use your own instead, deploy `apps/relay` to your Cloudflare account (see [the relay](docs/operations/relay.md#deploying-and-self-hosting)) and pass `--relay-url`, or set `AGENTGATE_RELAY_URL`. `agentgate relay status` shows sync state and errors.

To control the server from the native app over Tailscale, open the connection settings at the bottom of the sidebar, enter `http://srv.<tailnet>.ts.net:7878`, and paste the token printed by `agentgate admin-token` on the server. Remote management uses bearer authentication over Tailscale. The relay carries sync only, not remote management.

## T3 Code

`agentgate setup` writes a Claude config dir (whose `settings.json` points Claude Code at the daemon) and a Codex home. In T3 Code, add one provider instance per provider:

| Provider | T3 setting |
|---|---|
| Claude | `CLAUDE_CONFIG_DIR path` = `~/.config/agentgate/claude` |
| Codex | `CODEX_HOME path` = `~/.config/agentgate/codex` |

One instance per provider covers every account; the daemon switches eligible accounts when quota is exhausted. Account-specific continuations require their original account; if it is unavailable, the client receives an explicit restart error. In the app's **Accounts** screen, choose an **Active subscription** separately for Claude and Codex, or click **Use subscription** on an account. Your choice applies to the next request in every routed session and syncs to paired machines; if it is unavailable, the pool falls back to another account. Choose **Automatic** to clear the preference. The CLI equivalent is `agentgate accounts pin <id>` / `agentgate accounts unpin <id>`.

**Cursor** accounts can be added too (`agentgate login cursor`, or **Add account** in the app). Agentgate keeps their logins, shows each account's monthly plan usage, counts their tokens in the overview chart (read from Cursor's usage history every 15 minutes), and syncs the accounts to paired machines, but it does not route Cursor's own traffic. A machine on an older agentgate stops syncing once a Cursor account exists, until it is updated.

### Or: your normal Claude login

`agentgate setup --primary` adds `ANTHROPIC_BASE_URL` to `~/.claude/settings.json` and the agentgate MCP server to `~/.claude.json`, so the Claude Code you already use (and T3's default Claude instance) goes through agentgate while keeping its own login. Claude Desktop is not affected: it sets its own API address; see [Claude Desktop](docs/user/claude-desktop.md). For only the MCP servers, use `agentgate setup --mcp`. Model requests use the pool; other requests keep your login, and your login is also the last resort when every pooled account is exhausted. Undo with `agentgate setup --primary off` (the previous base URL is restored, and later settings edits are preserved). It does the same for `~/.codex/config.toml` (or `$CODEX_HOME`): an `agentgate` model provider with `requires_openai_auth = true`, so Codex, the Codex app and T3's default Codex instance send their own ChatGPT login along as the last resort. Only do this with `agentgate service install`, or Claude Code and Codex can't reach their providers while the daemon is down.

### Hand threads between machines

Start a thread on your laptop, hand it to an always-on server while you are away, and hand it back to test and push. A handed-off thread moves with its Claude session and its code: unpushed commits and uncommitted and untracked files (respecting `.gitignore`). Code travels directly between the two machines over Tailscale, or end-to-end encrypted through the relay; nothing is pushed to `origin`.

Connect agentgate to the T3 Code on each machine once. In T3 Code open **Settings → Connections**, turn on **Network access** (T3 Code only offers pairing links while it is on), then under **Authorized clients** choose **Create link** with **Standard** permissions. Run `agentgate t3 connect <link>` within five minutes, then turn Network access off again if you like; agentgate connects over this machine only (on a headless server, `t3 pair` prints a token: `agentgate t3 connect --url http://127.0.0.1:3773 --token <token>`). The T3 Code page in the app has the same form under **Machines**. You can set up another machine from the one you are on: create the link in that machine's T3 Code, then paste it into its row under **Machines**, or run `agentgate t3 connect <link> --node srv`. The link travels to it over your paired connection, and that machine redeems it with its own T3 Code. The machines must be paired over Tailscale or in the same relay group. A handoff moves the session between the Claude homes T3 Code's Claude provider uses on each machine, whether that is `~/.claude` or the agentgate home above.

```sh
agentgate threads                    # active threads on every machine
agentgate handoff <thread>           # to the first available always-on machine
agentgate handoff <thread> --to here # bring a thread to the machine you are on
agentgate handoffs                   # recent handoffs, with step timings
```

In the app, the **T3 Code** page shows every machine's threads with **To server** or **To here**. An agent can hand itself off with the `agentgate__handoff_thread` tool, which appears in sessions once T3 Code is connected.

What to expect:

- A working thread is stopped, moved, and continued on the other machine. On the source it is archived, and the uncommitted changes that were sent are kept in a `git stash` so the worktree is clean for the return trip. That stash is dropped when the thread comes back, because its changes come back with it.
- The other machine reuses a worktree already on the thread's branch, or creates one and runs the project's setup script. Later trips reuse it, so setup runs once per branch and machine.
- If the other machine's checkout has its own changes or commits, it keeps them and the handoff reports a warning. Your uncommitted changes then stay where they were.
- The first time a thread arrives on a machine, T3 Code fails the first message sent to it there. agentgate sends that message for you, asking the agent to reply "Ready", and sends it again when it fails, so your own first message works. A thread that was working then gets "Continue where you left off." Background tasks such as a command watching a PR are stopped on the machine the thread leaves, and the agent is told which ones were running so it can start them again. Later trips to the same machine reuse the thread and skip this.
- The first time a thread arrives on a machine, T3 Code's import also picks up other recent Claude sessions run in that project's main checkout, so threads that ran there can show up twice. Threads in worktrees are not affected, and later trips skip the import.
- Through the relay, a handoff can move up to 512 MiB of code and session; the relay sees only encrypted data, its size and timing. Pair over Tailscale for larger repositories.
- Claude Code threads only. Attachments, earlier turns' diffs and queued messages stay behind.
- agentgate's T3 Code token lasts 30 days. `agentgate t3` and the app show when to pair again.

The proxy now provides quota freshness and reset visibility, searchable **Activity** with request attempts and stream outcomes, bounded retries and local cooldowns, routing strategies and optional session affinity, model discovery/aliases/policies, batch verification, and revision-safe configuration previews. See [the proxy guide](docs/user/proxy.md) for controls, CLI examples, defaults, and upgrade requirements. Codex background usage polling is opt-in pending live endpoint validation.

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

A server can have any name, such as "PostHog Lullu"; its slug (`posthog-lullu`) becomes its id and the default tool prefix, and `agentgate mcp label <id> <name>` changes only the name shown in the app. The alias is the tool prefix: in every repo mapped to `posthog-lullu` under the alias `posthog`, the agent sees `posthog__…` tools that reach that repo's PostHog project. The repo is taken from `git remote get-url origin` in the session's working directory (override with `AGENTGATE_PROJECT=owner/repo`). Mapping changes reach running sessions without a restart.

## Skills per repo

Skills are installed once and synced to every machine like MCP servers; you choose which repos use each one. In the native app, **Skills → Add skills** offers each source as a tab: **skills.sh** searches the [skills.sh](https://skills.sh) directory, **Source** uses the pinned `skills@1.7.0` CLI and accepts (`owner/repo`, `owner/repo@skill`, a Git or GitHub URL, a folder), and **Write** writes a SKILL.md by hand. Then pick **Every session** or specific repos.

```sh
agentgate skills find postgres
agentgate skills add vercel-labs/agent-skills --skill web-design-guidelines --project Lullu-ai/lullu
agentgate skills add ./my-skill --project '*'
agentgate skills new release-notes --file SKILL.md
agentgate skills projects web-design-guidelines Lullu-ai/lullu other/repo
agentgate skills update                     # refetch every installed skill now (the daemon does it hourly)
agentgate skills prepare .                  # wait for checkout links before launching an agent
```

**Synced repo** keeps a public repository's skills in sync instead of copying them once: agentgate installs every skill in its `.claude/skills` and `.agents/skills` folders, asks whether they are for every session or specific repos, and checks for new commits every 10 minutes. New skills in the repository are used where it is connected, and skills removed from it are removed. To stop using one of its skills, unlink it from its projects; disconnecting removes them all.

```sh
agentgate skills repo add https://github.com/owner/team-skills --project '*'
agentgate skills repo projects owner/team-skills Lullu-ai/lullu   # where its skills are used
agentgate skills repo ls | sync | rm owner/team-skills
```

Fetching needs Node (`npx`) or Bun (`bunx`) on the daemon's machine, and connected repositories need `git`; other machines get the files through sync. Each node writes skills to `~/.config/agentgate/skills/<name>` and only creates symlinks to them:

- **Every session**: the Claude and Codex folders `agentgate setup` writes (`~/.config/agentgate/{claude,codex}/skills`), plus `~/.claude/skills` and `~/.codex/skills` while `setup --primary` is on.
- **One repo**: `.claude/skills/<name>` in the main checkout (Claude Code falls back to it from worktrees) and `.agents/skills/<name>` in the main checkout and every worktree (Codex). The entries are added to `.git/info/exclude`.

Claude Code and Codex read skills before a session's MCP servers start, so repo links must exist ahead of time. A repo is known on a machine after its first agentgate session there, or after a scan under Projects → **Add project** → **Find on this machine**; from then on its worktrees are watched and new ones are linked with bounded retries and independent periodic repair. Register or scan a checkout before launching its first session; watcher timing cannot guarantee first-session readiness. Changes apply to new sessions. Agentgate never replaces a folder it did not create: a name clash is listed under Skills → Skills need attention. Skills run with your agent's permissions and are copied to every paired machine, so install only sources you trust; the app shows the skills.sh audit before installing.

The app installs the exact files shown in a preview. Previews expire after ten minutes or cache eviction; preview again to continue. Skills installed from skills.sh, a source or a connected repository follow it and can't be edited; only hand-written skills can. Editing checks the saved revision and reports a conflict if another client or peer changed the skill. Skills → **Skills need attention** shows failed local materialization/link work, which the daemon retries automatically.

Bundles must contain a nonempty root `SKILL.md`, with unique portable paths and regular files. Symlinks and special files cannot be synced. Each bundle is limited to 3 MiB of base64 data (about 2.25 MiB of files) and 5,000 files; imports are limited to 100 skills and 24 MiB per pack. Large sources can be imported with `--skill` one skill at a time.

Repository-owned skills are mirrored only when you opt in with **Share repo skills between Claude and Codex** in a project's ⋯ menu in Projects. Mirroring creates relative links that can be reviewed and committed. Stopping mirroring stops future maintenance and leaves existing links in place; repository-owned links are preserved.

## Your MCP servers and skills in Grok

Assistants such as Grok only accept an MCP server URL and an `Authorization` header. A **virtual project** gives them one: in Projects, choose **New virtual project**, pick its MCP servers and skills, then **Connect to Grok** and copy the URL and `Authorization` value into Grok. One of your machines (an always-on server by default) answers through the relay. Grok also gets `skills__list` and `skills__read` tools, so it can find a skill and follow its SKILL.md.

```sh
agentgate project set @grok linear=linear posthog=posthog-lullu
agentgate skills projects release-notes @grok
agentgate remote enable @grok        # prints the URL and Authorization header
agentgate remote secret @grok        # new secret, same URL
```

Unlike sync, this traffic is readable by the relay (your logins stay on your machines), and anyone with the URL and secret can use those tools. See [remote MCP endpoints](docs/operations/relay.md#remote-mcp-endpoints).

## Commands

Run `agentgate --help`. Useful ones: `status`, `accounts`, `accounts exhaust <id> [min]` (pretend an account hit its limit, for testing), `nodes`, `unpair <node>`, `relay status|reconcile|rotate|leave`, `export [--no-secrets]`, `import-backup <file>`, `service logs`.

## Things to know

- **Once imported, a login belongs to agentgate.** Don't keep using the original `~/.claude` or `~/.codex` login: its CLI would refresh the token and log agentgate out. `agentgate login` avoids this by using a throwaway directory.
- **Secrets are stored in plain text** in `~/.config/agentgate/agentgate.db` (mode 0600) and copied to every paired node. Pair only machines you control. The relay only ever sees them encrypted.
- **Terms of service.** Pool only your own accounts and keep a person driving the sessions; follow the providers’ applicable terms.

## Development

```sh
bun install
bun run seed-dev-store               # optional: realistic data from your install, without its logins
bun run cli -- init                  # or an empty node
bun start                            # foreground daemon, no app required
bun run dev                          # daemon plus the Tauri app with Vite hot reload (Rust + Xcode tools required)
bun test
bun run typecheck
```

Running from a git checkout keeps its state in the checkout's gitignored `.agentgate` on a port derived from the checkout path, so it never touches your installed agentgate. It also refuses to install the service or change `~/.claude`, `~/.codex` and Claude Desktop. Set `AGENTGATE_HOME` and `AGENTGATE_PORT` to choose a state folder and port yourself. Contributors and coding agents should read [AGENTS.md](AGENTS.md).

## Monorepo

| Workspace | Role |
|---|---|
| `apps/agentgate` (`@agentgate/daemon`) | Bun daemon, standalone CLI, provider proxies, SQLite, sync, and MCP gateway |
| `apps/desktop` (`@agentgate/desktop`) | Tauri 2 shell with React/Vite, system appearance, translucent sidebar, and remembered window state |
| `apps/site` (`@agentgate/site`) | Static Astro landing page for Cloudflare Pages |
| `apps/relay` (`@agentgate/relay`) | Cloudflare Worker and Durable Objects for the encrypted sync relay |
| `packages/protocol` (`@agentgate/protocol`) | Shared control API types and configuration schemas |

The app uses Tauri commands to send HTTP requests from Rust. It has no browser HTTP fallback, server-rendered pages, cookies, or CORS management access. The daemon's `/api/*` management endpoints reject browser Origin/Fetch Metadata headers; remote requests require the node's admin bearer token. Status omits credentials, header values, command environments, and URL credentials/query strings. `/oauth/callback` is a small text response for MCP sign-in, including CLI sign-in. Provider and MCP traffic remains loopback-only. Backup export/restore and login-directory import require a local connection.

`bun run build` builds the four standalone CLI binaries. `bun run build:desktop` builds a macOS `.app` and `.dmg` and bundles a compiled daemon for the requested Tauri target. Use `bun run --filter @agentgate/desktop tauri build --target universal-apple-darwin` for the universal build releases ship, after `rustup target add x86_64-apple-darwin aarch64-apple-darwin`. The service executable is copied outside the app bundle before installing it or generating coding-tool settings.

## Landing page

`apps/site` is a static Astro page. It reads the latest GitHub release at build time to link the DMG, so rebuild it after a release. In Cloudflare Pages, keep the repository root as the root directory, set the build command to `bun run build:site` and the output directory to `apps/site/dist`. Set `GITHUB_TOKEN` in the build environment if the release lookup hits GitHub's rate limit. To upload from your machine instead: `bun run --filter @agentgate/site deploy`.

## Reliability

See [running agentgate](docs/operations/running.md) for backup, upgrade, and live distribution checks. Account and MCP OAuth refreshes share holder coordination and a local cross-process lease. Running MCP shims reconnect after daemon restarts and update per-session mappings; tool calls with uncertain outcomes are never automatically replayed.

Nodes use **sync protocol 5** (update every paired machine together) and the app checks **management API version 4** when connecting. Deletion history is retained so offline machines cannot resurrect old configuration.

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

See [release and recovery instructions](docs/operations/releasing.md).
