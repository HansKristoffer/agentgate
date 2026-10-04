# Agentgate

Agentgate is one daemon per machine. It pools several Claude and Codex subscriptions and moves to the next account when one hits its limit, hosts MCP servers and skills per GitHub repo, and shares all of it between the user's machines over Tailscale or an end-to-end encrypted relay. T3 Code, Claude Code, Codex and Claude Desktop run the sessions; agentgate sits underneath them.

## What we never compromise on

### 1. The daemon is the product

The CLI and daemon must work on their own, including on a headless Linux server with no app. The Tauri desktop app is an optional client of the daemon's control API. Anything a user can do in the app must also be possible from the CLI, and the app must never hold state or logic the daemon does not.

### 2. Every machine stands alone

Paired machines keep working while the others are offline, and catch up when they come back. There is no leader and no consensus. Records converge by last-writer-wins and deletions are kept as tombstones, so an offline machine can never bring old configuration back.

### 3. Credentials are the user's crown jewels

The store holds working logins for real subscriptions and MCP servers. Secrets leave a machine only to a paired machine or encrypted for the relay; the relay only ever sees ciphertext. Status, logs and errors never contain tokens, header values, command environments or URL credentials. A relay invite is a master key.

### 4. Quiet and dependable

Users stop noticing agentgate when it works, and that is the goal. A model request must not fail because of us when another account has room. Never replay a tool call whose outcome is uncertain, and never surprise the user by changing their Claude, Codex or Claude Desktop setup without being asked.

## A note from the maintainer

Prefer the smallest model that makes the correct behavior unsurprising. Do not preserve complexity because it exists, and do not add machinery because it looks architecturally impressive. Measure twice, cut once, and YAGNI. Honor the intent of the request in a minimal and realistic way, and push back on scope creep.

Treat this document as good defaults, not hard rules. The developer's instructions override anything here. If a rule fights the task in front of you, say so loudly and get a human sign-off before breaking it.

Most agentgate work is done by agents running inside T3 Code worktrees on the developer's own machine, next to their live agentgate install. Be careful with anything that touches running processes or real state.

## Glossary

- **you** means the agent reading this file and changing agentgate.
- **we** and **maintainer** mean the people building agentgate, who you are talking to now.
- **user** means the person who installs agentgate on their machines.
- **node** means one machine running the daemon, with its own store and name.
- **store** means a node's SQLite database in its agentgate home (`AGENTGATE_HOME`, normally `~/.config/agentgate`).

Domain terms (account, pool, holder, record, peer, relay group, project, virtual project and more) are defined in [docs/internals/glossary.md](docs/internals/glossary.md).

## The ways to hurt yourself

1. **Touching the live install.** `~/.config/agentgate` is the developer's real store, with working logins for their subscriptions. Some providers rotate refresh tokens, so a dev daemon that refreshes a copied token logs the real install out. Running from a source checkout uses the checkout's gitignored `.agentgate` and a port derived from its path (`store.ts`), so leave `AGENTGATE_HOME` and `AGENTGATE_PORT` unset. Reading the live store is fine; use `bun run seed-dev-store` to copy it (see Test data). Never point a daemon at it, open it read-write, or clean it up.
2. **Changing the machine's real setup.** The developer's live daemon runs as the `dev.agentgate` launchd/systemd service on port `7878`, and their own `~/.claude`, `~/.codex` and Claude Desktop may route through it. Checkout code refuses `service install|start|stop`, `setup --primary|--mcp` and Claude Desktop switching (`liveOnly` in `store.ts`). Do not work around that guard, and never run an installed `agentgate` binary to test a change.
3. **Killing by pattern.** Never `pkill -f agentgate`, `pkill bun` or kill a PID found by matching a name or path. The live service and other worktrees' dev servers match the same patterns. Kill only a PID you captured when you started the process.
4. **Leaking secrets.** Keep tokens, the admin token, pairing codes, relay invites and remote endpoint secrets out of logs, test fixtures, commits, screenshots and replies. Never run `relay rotate`, `unpair` or `relay leave` against a real install.

## Hit every surface

The most common defect is a change that works on the path you tested and is missing everywhere else. Before calling work done, walk this list and say which entries applied:

- **Entry points.** CLI (`apps/agentgate/src/cli.ts`), the control API (`api.ts`) and the desktop views. A capability reachable from one is usually expected from the others, and from the MCP gateway when an agent should reach it.
- **Providers.** Claude and Codex each have an adapter in `apps/agentgate/src/llm/`. Provider-shaped features need a decision for each, even if the decision is "not supported".
- **Sync.** A new record kind or field must sync over peers and the relay, survive a tombstone, and merge with a peer on the previous version. Ask whether `SYNC_PROTOCOL` (`sync.ts`), `RELAY_PROTOCOL` or `API_VERSION` (`packages/protocol`) must change, and whether backups export and restore it, including `export --no-secrets`.
- **Contracts.** Anything the app and daemon exchange is typed in `packages/protocol`. Change the schema and both sides follow.
- **Remote management.** The app can manage a remote node over Tailscale. Local-only actions (service, coding-tool setup, backups, Claude Desktop) must stay refused for remote connections.
- **Platforms.** macOS launchd and Linux systemd, with and without the app, and the compiled binary as well as source.
- **Reverse states.** If you added a way in, add the way out and the way to see it: enable needs disable, setup needs undo, pin needs unpin.
- **Docs.** Check whether the change makes the README or a doc inaccurate. Apply the [documentation rules](#documentation) before adding anything.

## Running it

- `bun install` installs. T3 worktrees get this from the `t3.json` setup script.
- `bun run dev` runs this checkout's daemon from source plus the desktop app (Tauri, needs Rust and Xcode tools) pointed at it. It prints the port and state folder. `bun start` runs only the daemon.
- `bun run cli -- <command>` runs the CLI against the checkout's state.
- Stop what you started, by the PID or terminal session you kept. See rule 3.

## Test data

An empty store is a bad test. With your dev daemon stopped, run `bun run seed-dev-store` (add `--force` to replace an existing one). It copies a read-only snapshot of the live store into the checkout, and keeps accounts, usage, MCP servers, projects, skills, other nodes and activity. It drops credentials, MCP secrets, peers, relay membership, registered checkouts and node-local state, and names the node `dev`. Accounts therefore show as needing login, and the dev daemon cannot refresh a real token, sync with a real machine, or link skills into a real repository. Copy in, never symlink: data flows into the checkout, never back.

## Verifying

- Use the smallest proof that the change works: `bun test apps/agentgate/test/<file>.test.ts` for the tests you touched, and `bun run --filter <workspace> typecheck` for the workspace you changed.
- **Do not run repo-wide checks** (`bun test` for everything, `bun run typecheck`, `bun run build`, `build:desktop`) unless asked. CI owns the full suite.
- Daemon behavior changes ship with focused tests for that behavior. Test meaningful logic and observable behavior, not wiring or a mirror of the implementation.
- Fake time through `store.now`, and stub processes and files through the seams modules already export (`host`, `files`). Prefer awaiting the event that marks a milestone over sleeping; a new test that needs a generous timeout to pass is usually wrong.
- Rust changes: `cargo check` in `apps/desktop/src-tauri` (`bun run check:native` runs clippy). The build needs a sidecar file in `apps/desktop/src-tauri/binaries/`; an empty placeholder named for your target is enough for a check.
- Live provider traffic, real logins, two physical machines and installed services are outside CI. Say when a change needs one of those checks rather than claiming it works.
- Do not verify in the desktop app or a browser unless the developer asks for it.

## Pull requests

- Never open a PR unless the developer explicitly asks.
- Conventional commit titles in plain language: `fix(proxy): exhausted accounts no longer get retried`. CI enforces the format, and Release Please builds the changelog from it.
- Body: the problem in a sentence or two, then how you fixed it, then how you verified it. End with the model and harness that did the work. Follow `.github/pull_request_template.md`.
- UI changes need before and after images. Upload them to GitHub; never commit PR-only assets.
- One request is one PR. Split it only when the maintainer asks.

## Documentation

Most code changes do not need a documentation change. Agents can read the code.

- `README.md` is the user guide: what agentgate does, how to start, and anything unintuitive. Keep it in the product's voice, without implementation details. Update the section for a feature when how to use it changes.
- `docs/user/` holds guides too long for the README.
- `docs/internals/` is for architectural decisions and their reasons, constraints that span components, and traps that are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the code answers the question, leave it out.
- `docs/operations/` holds maintainer procedures: releasing, the relay, upgrades and live checks.
- Do not document every feature, enumerate fields or narrate control flow. Keep a local explanation in a code comment next to the code. Link to source instead of copying it.
- When a documented decision changes, rewrite or remove the affected text. Do not append a second account of the new behavior.

## Plans and work artifacts

- Do not commit implementation plans, research notes or agent scratch files. Keep them outside the worktree; `.plans/` is gitignored as a safety net.
- Track open work in a GitHub issue. A merged PR is the implementation record; do not keep a second checklist in the repository.

## How it works

The daemon (`daemon.ts`) serves three kinds of traffic on loopback: the provider proxies that Claude Code and Codex send model requests to (`llm/`), the MCP gateway that per-session shims connect to (`mcp/`), and the JSON control API used by the CLI and app (`api.ts`). The proxy picks an account from the pool by quota, policy and pin, and moves to another when one is exhausted. Everything a user configures is a typed record in the store (`store.ts`) with a revision; nodes exchange record changes directly over Tailscale (`sync.ts`) or as encrypted entries through the Cloudflare relay (`relay.ts`, `apps/relay`), and merge them by last-writer-wins. Token refreshes are coordinated through a holder per credential plus a local lease, so paired machines do not race each other for a rotating token.

Architecture and its constraints: [docs/internals/overview.md](docs/internals/overview.md).

## Where code lives

- `apps/agentgate` (`@agentgate/daemon`) is the daemon and CLI. `llm/` is the provider proxies and pool, `mcp/` the gateway and shims, `operations.ts` the shared operations the CLI and API both call.
- `apps/desktop` is the Tauri app. React views in `src/views`, shared UI in `src/components/ui.tsx`, Rust commands in `src-tauri/src/lib.rs`. All HTTP goes through Rust.
- `apps/relay` is the Cloudflare Worker and Durable Object relay. It stores ciphertext and has no sync logic.
- `apps/site` is the static Astro landing page.
- `packages/protocol` holds the zod schemas and types shared by the daemon, app and relay. No runtime logic beyond small helpers.

## Taste

- Complexity belongs at the provider and platform boundary. The pool, records and sync stay simple.
- Transports stay thin. A CLI command, API route or MCP tool parses input, calls one shared function, and maps errors. Put the logic where the other entry points can reach it.
- Use the existing `components/ui.tsx` pieces in the app before adding styles or new components.
- Inferred types over annotations, zod at trust boundaries, no `any`.
- Comments explain why and how a thing is used, and move when the code moves. Do not narrate each line.
- Bun and the standard library first. A new dependency needs a reason a few lines of code cannot meet.
