# agentgate — build plan

`agentgate` is a small Bun + TypeScript program for Linux and macOS. It is a CLI with a built-in web UI that:

1. Pools several **Claude** and **Codex** subscriptions. When one account reaches its usage limit, it moves on to the next account.
2. Hosts **MCP servers** and decides which ones each **GitHub repository** gets. Some servers are general and reach every repo. Others belong to one repo, for example a separate PostHog MCP per product.
3. **Shares** all of this between your machines over Tailscale. Every machine keeps working when the others are offline.

Coding sessions are run by **T3 Code**, which starts Claude Code and Codex. agentgate sits underneath them: the LLM traffic goes through agentgate's proxy, and the tools come from agentgate's MCP gateway.

Working name: `agentgate`. The binary, config directory, and service names below all use it.

Inspiration:
- [teamclaude](https://github.com/KarpelesLab/teamclaude): account pooling and quota detection
- [docker-mcp-gateway](https://github.com/hwdsl2/docker-mcp-gateway): one endpoint in front of many MCP servers
- [Bifrost](https://github.com/maximhq/bifrost): gateway with a UI, multiple keys, fallback

---

## 1. Requirements

| # | Requirement | How the design meets it |
|---|---|---|
| R1 | Multiple Claude and Codex subscriptions; switch automatically when one hits a limit | An LLM proxy with one account pool per provider (§6) |
| R2 | MCP servers set per GitHub repo, plus general ones | MCP instances, a mapping from repo to instances, and a stdio shim (§7) |
| R3 | Several instances of the same MCP (e.g. several PostHog projects), each linked to different repos | Instances are named copies of a template; each repo maps a short alias to an instance (§7.3) |
| R4 | Works on the primary machine and on a server | Every machine runs the full daemon (§3) |
| R5 | **The server keeps working while the primary machine is offline** | No request depends on another machine; state is copied to every machine; token refresh fails over to the machine that is online (§4, §5) |
| R6 | Bun + TypeScript, a simple CLI with a web interface | Bun, Hono, bun:sqlite, Hono JSX pages (§10, §12) |
| R7 | T3 Code manages the sessions | One Claude and one Codex provider instance per machine point at the local daemon, so account switching is invisible to T3 threads (§8) |
| R8 | Tailscale on all machines | Machines talk to each other only over the tailnet; the local API listens only on loopback (§11) |

## 2. Non-goals for v1

- A team or multi-user setup. Every machine belongs to one person.
- A general LLM gateway with arbitrary providers and virtual keys (Bifrost's territory). v1 supports only Claude subscriptions and Codex (ChatGPT) subscriptions.
- Docker. It ships as a single compiled binary.
- Forwarding MCP resources and prompts. v1 forwards tools and server instructions only.
- Encryption of stored data beyond file permissions (§11).

---

## 3. Architecture

Every machine (a **node**) runs the same daemon. There is no permanent hub. A node answers every request itself, so the server never waits on the primary machine, and the primary never waits on the server.

```
          Primary machine (node "mac")                    Server (node "srv", alwaysOn)
 ┌───────────────────────────────────────┐        ┌───────────────────────────────────────┐
 │ T3 Code                               │        │ T3 Code                               │
 │   Claude Code ── ANTHROPIC_BASE_URL ─┐│        │┌─ ANTHROPIC_BASE_URL ── Claude Code   │
 │   Codex ─────── model_provider ─────┐││        ││┌─ model_provider ──── Codex          │
 │   both ── MCP "agentgate" (shim) ─┐ │││        │││┌─ MCP "agentgate" (shim) ── both    │
 │                                   ▼ ▼▼▼        ▼▼▼▼                                    │
 │  agentgate daemon 127.0.0.1:7878      │        │      agentgate daemon 127.0.0.1:7878  │
 │   ├─ LLM proxy  → Anthropic / OpenAI  │        │  LLM proxy  → Anthropic / OpenAI ─┤   │
 │   ├─ MCP gateway → MCP servers        │        │  MCP gateway → MCP servers ───────┤   │
 │   ├─ Web UI                           │        │  Web UI ──────────────────────────┤   │
 │   └─ Store (bun:sqlite) ◄── peer sync over Tailscale (100.x:7878) ──► Store      ┘   │
 └───────────────────────────────────────┘        └───────────────────────────────────────┘
```

- **Local traffic:** LLM calls and MCP tool calls from a machine always go through **that machine's own daemon**, straight to the providers or MCP servers.
- **Traffic between nodes:** only the sync of stored state (accounts, credentials, quota observations, MCP instances, secrets, project mappings, settings).
- **Editing:** you can make changes in the web UI or CLI of **any** node. They reach the other nodes within seconds, or when a node comes back online.
- **Offline behaviour:** if the primary is offline for a week, the server keeps using every account, refreshes the tokens, and runs every MCP server. When the primary returns, it pulls the changes and continues.

---

## 4. Store and sync

### 4.1 Local store

Everything is stored in one `bun:sqlite` database: `~/.config/agentgate/agentgate.db` (mode 0600). SQLite comes with Bun, so there is no extra dependency. It also gives atomic writes and lets the CLI and the daemon use the store at the same time.

```sql
-- One table for everything that is copied between nodes.
create table records (
  kind       text not null,    -- 'account' | 'credential' | 'usage' | 'mcp' | 'project' | 'node' | 'setting'
  id         text not null,
  rev        integer not null, -- incremented on every write to this record
  node       text not null,    -- node that made the last write (tie-break)
  updated_at integer not null, -- ms timestamp
  deleted    integer not null default 0,
  data       text not null,    -- JSON, parsed with the zod schema for its kind
  seq        integer not null, -- local change-feed position (from local_seq)
  primary key (kind, id)
);
create table local_seq (value integer not null);                           -- one row
create table peers (node text primary key, url text, token text, cursor integer, last_seen integer);
create table request_log (at integer, provider text, account text, model text, status integer, ms integer, note text); -- this node only, trimmed to the last 5k rows
```

Every record kind has a zod schema in `store.ts`. `get(kind, id)` and `put(kind, id, data)` are the only way to read or write, so every write gets a new `rev` and `seq`.

### 4.2 Sync protocol (over the tailnet only)

- **Pairing:**
  1. `agentgate pair` on node A prints `agentgate join http://mac.tailnet.ts.net:7878 7-word-code`. The code is valid for 10 minutes.
  2. Running that command on node B calls `POST /peer/join` on A with the code and B's own URL.
  3. The two nodes exchange a random peer token, and each stores a row in `peers`.
- **Pull:** each node pulls from each peer with `GET /peer/changes?since=<cursor>`. The response contains the records with `seq > cursor` and the peer's current seq. A pull happens every 15 s, doubles as the heartbeat that sets `peers.last_seen`, and also happens right after a poke.
- **Poke:** after a local write, the node sends a fire-and-forget `POST /peer/poke` to each peer, which then pulls at once.
- **Merge rule:**
  - An incoming record wins if `(rev, updated_at, node)` is greater than the local copy. The winning record gets a new local `seq`, which passes it on to nodes that did not pair directly.
  - This is last-writer-wins per record. That is enough for a handful of nodes owned by one person.
- **New node:** it pulls from `since=0`.
- **Deletes:** tombstones (`deleted = 1`), removed after 30 days.

What is **not** synced: `peers`, `request_log`, the node's own port and bind settings.

---

## 5. Credential ownership and refresh

This is the hardest part of the build.

**The trap.** Claude and Codex subscription logins are OAuth. Each refresh returns a **new refresh token and invalidates the old one**. If two machines refresh the same account at the same time, the one that loses gets `invalid_grant`. Copying `~/.claude` or `~/.codex/auth.json` between machines therefore breaks sooner or later.

**The rules.**

1. **Holder:** each `credential` record carries `holder` (a node id). Only the holder refreshes, and it does so when the access token has less than 30 minutes left. Every other node uses the copied access token until it expires.
2. **Preferred holder:** during `init`, nodes are marked `alwaysOn` (the server: yes; a laptop: no). Once in sync, an `alwaysOn` node takes the `holder` role for every credential. Taking it over is a write to the record, not a refresh. So in normal operation the server refreshes, and the primary machine never has to.
3. **Failover:** a node that is not the holder takes over and refreshes when both of these are true:
   - the access token expires within 10 minutes;
   - the holder has not been seen for more than 2 minutes.

   It writes `holder = self` together with the new tokens in one record write. That is how the server keeps working when the primary holds a token and is offline. It is also how the primary keeps working when the server is down.
4. **Save before use:** new tokens are written to the local store **before** the request that needed them continues. Losing a rotated refresh token means logging in again.
5. **When a refresh fails:**
   - On `invalid_grant`, the node pulls from all reachable peers right away. If a peer has a newer credential, the node uses that.
   - If none is newer, the account is marked `needsLogin` and removed from the pool. The UI shows a "log in again" button.
6. **Split brain:** both nodes are online but can't reach each other, and both refresh the same account. One of them will end up `needsLogin` for that account. This is rare with Tailscale, and the damage is limited to logging in once more. It is documented, not engineered away.

**Importing an existing CLI login moves ownership.** Once agentgate has imported a login, **the original CLI login must not be used directly anymore**, because it would refresh and log agentgate out. For that reason:
- `agentgate login` runs the official login in a **temporary** config directory, imports it, and deletes the directory.
- `agentgate import` from your normal `~/.claude` prints a warning.

---

## 6. LLM proxy and account pool

### 6.1 Records

```ts
account    { id, provider: 'claude' | 'codex', label, email, plan, enabled, priority, pinned? }
credential { accountId, accessToken, refreshToken, expiresAt, accountUuid?/chatgptAccountId?, holder, needsLogin? }
usage      { accountId, observedAt, observedBy, windows: [{ name: '5h' | '7d' | '7d:<model>', usedPct, resetsAt }], status: 'ok' | 'limited' | 'exhausted' }
```

`usage` records are synced too. When the server exhausts account A, the primary immediately stops choosing A.

### 6.2 Claude

- **Client setup:** Claude Code is started with
  - `ANTHROPIC_BASE_URL=http://127.0.0.1:7878/anthropic`
  - `ANTHROPIC_AUTH_TOKEN=agentgate` (a placeholder so Claude Code does not ask for a login)
- **Proxy:** `ALL /anthropic/*` is forwarded to `https://api.anthropic.com/*`. On the way, the proxy:
  - replaces `Authorization` with the chosen account's OAuth access token;
  - adds the OAuth beta header that the Claude Code subscription flow sends;
  - rewrites `account_uuid` in the body metadata to the chosen account (this is what teamclaude does);
  - streams the response back unchanged (SSE passthrough with `fetch` and `Response(body)`).
- **Quota detection:** the proxy reads the `anthropic-ratelimit-unified-*` response headers: status, utilization and reset for the 5-hour and 7-day windows, and the per-model weekly caps. It saves them as `usage`. Phase 0 logs real responses so the exact header names can be fixed before this code is written.
- **Classifying a 429:**
  - *Quota used up* (a unified status of rejected or exhausted): mark the account exhausted until `resetsAt` and switch accounts.
  - *Per-minute rate limit:* keep the account and retry after `retry-after`, up to 3 times. Switching here would throw away the prompt cache for nothing.
- **Login:**
  - v1: `agentgate login claude` runs `claude` login with a temporary `CLAUDE_CONFIG_DIR`. It then imports from `.credentials.json` (Linux) or the macOS Keychain item `Claude Code-credentials*` (via `security find-generic-password -w`).
  - Phase 4: native OAuth PKCE in the web UI, using the client id and endpoints Claude Code uses. teamclaude keeps these up to date and is the reference.

### 6.3 Codex

- **Client setup:** Codex is started with `CODEX_HOME=~/.config/agentgate/codex`. agentgate writes this `config.toml`:
  ```toml
  model_provider = "agentgate"

  [model_providers.agentgate]
  name = "agentgate"
  base_url = "http://127.0.0.1:7878/codex/backend-api/codex"
  wire_api = "responses"

  [mcp_servers.agentgate]
  command = "agentgate"
  args = ["mcp"]
  ```
- **Proxy:** `ALL /codex/*` is forwarded to `https://chatgpt.com/*`. The proxy injects the account's ChatGPT access token and its account-id header.
- **Quota detection:** the proxy reads the `x-codex-*` families: used-percent, window-minutes and reset for each window, and named families for per-model limits. Windows are classified by `window-minutes`, never by where they appear.
- **Refresh:** against `auth.openai.com`, with the Codex CLI's client id.
- **Login:** `agentgate login codex` runs `codex login` with a temporary `CODEX_HOME` and imports `auth.json`.

### 6.4 Choosing an account (shared by both providers, `pool.ts`)

1. **Candidates:** accounts that are `enabled`, not `needsLogin`, and not exhausted for the requested model's windows.
2. **Pinned account:** if one account is pinned (from the UI), use it while it is a candidate.
3. **Sticky choice:** keep using the **current active account** until any window reaches the threshold (98% by default). One account for all traffic keeps the prompt cache warm.
4. **Switching:** choose the candidate whose tightest window resets soonest, so quota that would otherwise go unused gets spent first. Ties go to `priority`.
5. **Retry on another account:** the request body is held in memory. If the upstream returns a quota 429 **before the first response byte**, the proxy sends the same request to the next candidate. The session never sees the error.
6. **All accounts exhausted:** controlled by the `whenExhausted` setting.
   - `fail` (default): return 429 with `retry-after` set to the earliest reset. Claude Code and T3 already display this as "limit reached, resets in …".
   - `wait`: hold the request until the reset, for at most 10 minutes.
7. **Logging:** every switch goes to `request_log` with the reason, and shows up in the UI activity feed.

---

## 7. MCP gateway

### 7.1 Concepts

- **Template:** a known MCP server type with a form: PostHog, GitHub, Railway, Linear, Sentry, Context7, Filesystem, plus custom stdio and custom HTTP. Each template is a small object in `mcp/templates.ts` that lists the fields it needs (for example, API key and project id).
- **Instance:** a named, configured copy of a template, with its own secrets. You can have any number of instances of the same template.
- **Project:** a GitHub repo, `owner/repo`. Each project maps **aliases** to instances. The alias is the name the agent sees. The special project `*` holds the general servers that every repo gets.

```ts
mcp {
  id: 'posthog-lullu',
  template: 'posthog',
  transport: 'http',
  url: 'https://mcp.posthog.com/mcp',
  headers: { Authorization: 'Bearer {{secret.apiKey}}', 'x-posthog-project-id': '{{projectId}}' },
  secrets: { apiKey: '…' },
  fields: { projectId: '12345' },
  mode: 'shared' | 'perSession',   // §7.4
}
project { id: 'Lullu-ai/lullu', mcp: { posthog: 'posthog-lullu', railway: 'railway-main' }, inheritDefaults: true }
```

### 7.2 Example: several PostHog MCPs

PostHog's hosted MCP takes `Authorization: Bearer <personal API key>`. The key is created with the "MCP Server" preset and scoped to one project. PostHog also accepts `x-posthog-project-id`, which pins the session to that project and removes the switch-project tools. So every instance is limited to one project.

| Instance | Template | Pinned to |
|---|---|---|
| `posthog-lullu` | posthog | PostHog project 12345 (Lullu) |
| `posthog-geysier` | posthog | PostHog project 67890 (Geysier) |
| `posthog-serpier` | posthog | PostHog project 24680 (Serpier) |
| `github-main` | github | your GitHub token |
| `context7` | context7 | — |

| Project | Aliases the agent sees |
|---|---|
| `*` (all repos) | `github` → github-main, `docs` → context7 |
| `Lullu-ai/lullu` | `posthog` → posthog-lullu, `railway` → railway-main |
| `Geysier/gey-mono` | `posthog` → posthog-geysier |
| `Serpier/serpier-mono` | `posthog` → posthog-serpier |

In every repo the agent sees a tool called `posthog__…`, and it always reaches that repo's PostHog project. Prompts, skills and AGENTS.md files can simply say "use the posthog tools", with no per-repo names. A repo can also map two instances under different aliases, for example `posthog` and `posthog_legacy`.

### 7.3 How a session finds its project: the `agentgate mcp` shim

A single MCP server named `agentgate` is registered once, at **user scope**, in both clients. `agentgate setup` does this:
- Claude Code: `claude mcp add -s user agentgate -- agentgate mcp`
- Codex: `[mcp_servers.agentgate]` in the agentgate `CODEX_HOME` (§6.3)

When a session starts, the client launches `agentgate mcp` as a stdio process, and the shim:

1. Works out the project from its working directory:
   - `AGENTGATE_PROJECT` if that is set;
   - otherwise `git remote get-url origin`, normalised to `owner/repo` (handles ssh, https and `.git` forms);
   - otherwise only `*` applies.

   This works inside the git worktrees T3 creates, with **no files added to your repos**.
2. Connects to the local daemon at `http://127.0.0.1:7878/mcp?project=owner/repo` over streamable HTTP. The shim is an MCP client toward the daemon and an MCP server toward Claude or Codex.
3. Starts the project's `perSession` instances itself, as child processes in that working directory (§7.4).
4. Publishes the merged tool list:
   - Each tool is named `<alias>__<tool>`.
   - Names longer than 64 characters (Codex's limit) are shortened with a 4-character hash suffix.
   - Each upstream server's `instructions` are merged into the shim's `instructions`, under a `## <alias>` heading.
5. Forwards `notifications/tools/list_changed`. If you change a project's mapping in the UI, running sessions receive the new tools without a restart.
6. If the daemon is not reachable, the shim still starts. It returns no tools and instructions that say "agentgate daemon is not running on this machine (run `agentgate service start`)". The session is never blocked.

Phase 0 must confirm that Claude Code and Codex start stdio MCP servers with the session's working directory. Fallback if they don't: the shim reads the project root from the client's `roots/list`.

### 7.4 Where upstream MCP servers run

- **`shared` (default):**
  - HTTP instances, and stdio instances that don't depend on the working directory or keep state (github, context7, posthog).
  - The daemon keeps one upstream connection per instance on each node and multiplexes calls from every session through it. This saves launching `npx` once per T3 thread.
  - The connection opens on first use and closes after 10 idle minutes.
- **`perSession`:**
  - Stdio instances that need the repo's working directory or keep state per session (filesystem, git, browser, memory).
  - The shim starts them in the worktree, and they end when the session ends.

**Secrets:** the shim fetches the secrets for its `perSession` instances from the daemon over loopback. Secrets never go into Claude or Codex config files.

MCP servers that need an OAuth login (Linear, Notion and similar) come in Phase 6. You log in once in the UI, the token is stored as a `credential` record, and it syncs and refreshes like the LLM tokens (§5).

---

## 8. T3 Code and client setup

`agentgate setup` prints what to paste and writes what it can:

| Target | What happens |
|---|---|
| T3 Code, Claude provider instance | Printed: env `ANTHROPIC_BASE_URL=http://127.0.0.1:7878/anthropic`, `ANTHROPIC_AUTH_TOKEN=agentgate`, and a dedicated `CLAUDE_CONFIG_DIR=~/.config/agentgate/claude`, so it never mixes with a personal login |
| T3 Code, Codex provider instance | Printed: env `CODEX_HOME=~/.config/agentgate/codex` |
| Claude Code MCP | Written: user-scope `agentgate` MCP inside that `CLAUDE_CONFIG_DIR` |
| Codex config | Written: `~/.config/agentgate/codex/config.toml` (§6.3) |

**Why one provider instance is enough:** T3 threads can only switch between Claude instances that share a config directory. With agentgate, **one** instance per provider covers every account. The switching happens in the proxy, so a thread never breaks when an account runs out.

**Choosing between accounts:** use the UI's pin ("use the work account for now") instead of creating a second T3 instance.

**Phase 0 check:** Claude Code in placeholder-token mode (`ANTHROPIC_AUTH_TOKEN`) must behave normally under T3: model choice, streaming, tool use, `/compact`. If a feature depends on the client *seeing* a subscription login, the fallback is teamclaude's approach. The client keeps a real login in the dedicated config directory. agentgate replaces the token on the way out and intercepts the client's refresh calls, so the client never rotates the token itself.

---

## 9. Web UI

The daemon serves the web UI at `http://127.0.0.1:7878/`, and also at `http://<node>.<tailnet>.ts.net:7878/` after logging in with the admin token. The pages are rendered on the server with Hono JSX and use plain HTML forms. One inline script polls `/api/status` every 5 s for live quota bars. There is no SPA, no bundler and no CSS framework: one small stylesheet.

| Page | Contents |
|---|---|
| **Dashboard** | Each provider: the active account, a quota bar per window, reset countdowns. Nodes: online/offline, last sync, who holds which credentials. Activity feed: account switches, refreshes, failovers, MCP errors |
| **Accounts** | List per provider; add (log in / import), enable/disable, pin, priority, "log in again" for `needsLogin`, delete |
| **MCP servers** | Instances grouped by template. "Add from template" form (PostHog: API key + project id). Test button: connect and list the tools. Status: running / idle / error, with the last error |
| **Projects** | Repos, including ones discovered automatically from shim connections ("seen 3 min ago on srv"). Alias → instance mapping with a dropdown; `*` defaults with an "inherit defaults" toggle. Preview of the exact tool list the agent will see |
| **Nodes** | Paired nodes, the `alwaysOn` flag, URL, last seen, sync cursor. Pair / unpair. "Copy setup commands" for this node |
| **Settings** | Switch threshold, `whenExhausted`, retry limits, log retention, export/import backup |

Every write in the UI goes through the same `store.put`, so it syncs like a CLI change.

---

## 10. CLI

Arguments are parsed with `util.parseArgs` from the Node standard library, which Bun supports, so no CLI framework is needed.

```
agentgate init [--always-on] [--name srv]      create the store, pick the node name, find the Tailscale IP
agentgate serve                                run the daemon in the foreground (the service runs this)
agentgate status                               quota bars, active accounts, nodes, sync state
agentgate login claude|codex [--label work]    log in in a temporary dir, import, delete the dir
agentgate import claude|codex --from <dir>     take over an existing login (prints the ownership warning)
agentgate accounts [enable|disable|pin|unpin|rm] <id>
agentgate mcp                                  (the stdio shim; started by Claude Code / Codex)
agentgate mcp add <template> <id> [--field k=v ...] [--secret k=v ...]
agentgate mcp ls | test <id> | rm <id>
agentgate project set <owner/repo> <alias>=<instance> [...]   (use '*' for defaults)
agentgate project ls | show <owner/repo>
agentgate pair | join <url> <code> | nodes | unpair <node>
agentgate setup                                write the Claude/Codex config for this node, print the T3 settings
agentgate service install|start|stop|logs      launchd (macOS) / systemd --user (Linux)
agentgate export [--no-secrets] > backup.json | agentgate import-backup backup.json
```

---

## 11. Security

- **Two listeners** from two `Bun.serve` calls that share the Hono app, each with its own auth middleware:
  - `127.0.0.1:7878` (loopback): trusted. These are single-user machines, and it is the same trust level as `~/.claude/.credentials.json` on disk. The proxy, the shim endpoint, the UI and the API all need no token here.
  - `<tailscale ip>:7878` (tailnet): `/peer/*` needs the peer token, and the UI and API need the admin token (a session cookie). The LLM proxy and the MCP endpoint are **not** offered on the tailnet listener, because each node serves its own clients.

  The daemon finds the Tailscale IP with `tailscale ip -4` at startup, and retries if Tailscale isn't up yet. It never binds to `0.0.0.0`.
- **Storage:** the DB file and config directory are 0600/0700. Secrets are kept in plain text in the DB, which is the same position Claude Code and Codex take with their own credential files. OS-keychain storage is a later option.
- **Transport:** the tailnet provides encryption (WireGuard) between nodes. No TLS of our own in v1; `tailscale serve` can add HTTPS for the UI if wanted.
- **Hiding secrets:** API responses and the UI show secrets as `••••last4`. Only the shim's loopback endpoint and the peer sync return secret values. `export --no-secrets` gives a backup that is safe to share.
- **Pairing:** a one-time code, valid for 10 minutes. Peer tokens are 32 random bytes and can be revoked with `unpair`.
- **Later option:** check `tailscale whois` so that only devices of the same tailnet user can pair.

## 12. Code layout and dependencies

**Dependencies:** `hono`, `@modelcontextprotocol/sdk`, `zod`. Everything else comes with Bun: `bun:sqlite`, `Bun.serve`, `Bun.spawn`, `fetch`, `util.parseArgs`.

```
agentgate/
  src/
    cli.ts             entry point; command dispatch
    daemon.ts          the two listeners, Hono app, route mounting, startup (token refresh timer, sync timer)
    store.ts           sqlite schema, zod record schemas, get/put/list, change feed
    sync.ts            pair/join, pull/poke, merge rule, heartbeats
    credentials.ts     holder rules, refresh scheduling, failover, invalid_grant handling (§5)
    llm/pool.ts        account choice, usage bookkeeping, retry on another account, whenExhausted
    llm/claude.ts      proxy route, header rewrite, quota parsing, OAuth refresh, login/import
    llm/codex.ts       same for Codex
    mcp/gateway.ts     upstream clients (stdio/HTTP), shared connections, merged server per project
    mcp/shim.ts        stdio shim: project detection, perSession children, merged tool list
    mcp/templates.ts   template catalog (PostHog, GitHub, Railway, Linear, Sentry, Context7, FS, custom)
    setup.ts           Claude/Codex config writers, T3 instructions
    service.ts         launchd plist / systemd unit
    ui/pages.tsx       Hono JSX pages
    ui/style.css
  test/
    pool.test.ts  credentials.test.ts  sync.test.ts  shim.test.ts
  PLAN.md  README.md  package.json  tsconfig.json
```

The build uses `bun build --compile --target=bun-{darwin-arm64,darwin-x64,linux-x64,linux-arm64}`. The resulting binaries are attached to GitHub releases, and `install.sh` places the right one in `~/.local/bin`.

## 13. Install and services

- **macOS:** `~/Library/LaunchAgents/dev.agentgate.plist` with `KeepAlive` and `RunAtLoad`, writing logs to `~/.config/agentgate/logs/`.
- **Linux (server):**
  - A `~/.config/systemd/user/agentgate.service` unit with `Restart=always`.
  - `loginctl enable-linger $USER`, so it runs with no one logged in and survives reboots. That is essential for the server.
- **First install on a machine:**
  ```sh
  curl -fsSL https://…/install.sh | sh
  agentgate init --name srv --always-on   # --always-on only on the server
  agentgate join http://mac.tailnet.ts.net:7878 <code>   # or `pair` on the first machine
  agentgate setup
  agentgate service install
  ```
- **Installing the MCP servers' runtimes:** each node needs the runtimes its stdio MCP servers use (`npx`/`uvx`). `agentgate mcp test` reports a missing runtime clearly.

---

## 14. Build phases

Each phase ends with something you can use and a check that proves it.

| Phase | Scope | Done when |
|---|---|---|
| **0. Spikes (1–2 days)** | Throwaway scripts: (a) a proxy that swaps in a real Claude OAuth token under T3 with `ANTHROPIC_AUTH_TOKEN` placeholder mode; (b) Codex through the custom provider with an injected ChatGPT token; (c) log real rate-limit headers from both; (d) the working directory a stdio MCP server gets in both CLIs inside a T3 worktree; (e) whether refresh rotates the refresh token for both providers | All five answered and written into this plan; client auth mode chosen (§8) |
| **1. Store, daemon, Claude pool** | `store.ts`, `daemon.ts` (loopback only), `llm/claude.ts`, `llm/pool.ts`, `credentials.ts` (holder = self), `login`/`import`/`status`/`accounts` | Two Claude accounts; a forced quota 429 (via a test flag that marks A exhausted) moves the next turn to B with no error in T3; a restart keeps state; a refresh is saved before use |
| **2. Codex pool** | `llm/codex.ts`, Codex `config.toml` writer | Same test as Phase 1, with Codex under T3 |
| **3. MCP gateway and shim** | `mcp/*`, `project` and `mcp` commands, templates (PostHog, GitHub, Context7, filesystem, custom) | Two PostHog instances mapped to two repos: a session in repo A sees only project A's data, repo B only project B's; `*` servers appear in both; a `perSession` filesystem server runs in the worktree; a mapping change reaches a running session through `list_changed` |
| **4. Web UI** | `ui/*`, native OAuth PKCE login for Claude and Codex, admin token for tailnet access | Every setup step in Phase 1–3 works from the browser only |
| **5. Multi-node** | Tailnet listener, `sync.ts`, pairing, holder takeover and failover, synced usage | See the checklist below |
| **6. Install and ship** | `service.ts`, `setup.ts`, compiled binaries, `install.sh`, README | A clean Linux server and a clean Mac go from nothing to working T3 sessions using only the README |
| **7. Later, when needed** | MCP servers with OAuth login; forwarding resources and prompts; API-key fallback providers; `tailscale whois` pairing check; keychain storage; `onlyOn` restriction per instance; `agentgate upgrade` | — |

**Phase 5 checklist:**
- **Pairing:** after `pair`/`join`, the server has all accounts, instances and projects within 15 s.
- **Edits on either node:** a change in either node's UI shows up on the other.
- **Primary offline:** with the primary shut down for over 24 h, the server's T3 sessions keep working, and the server refreshes every account at least twice.
- **Catch-up:** when the primary returns, it catches up with no re-login.
- **Failover:** with the server holding every credential and then stopped, the primary takes over refresh once tokens get close to expiry.
- **Shared exhaustion:** an account exhausted on one node is avoided by the other node within one sync cycle.

## 15. Testing

The tests use `bun test`, with fake upstreams from `Bun.serve` on random ports. There are no mocks of our own modules. Each test file covers one piece of logic that must not break:

- **`pool.test.ts`:** the fake Anthropic upstream returns real quota headers and then a quota 429, and the test checks that the retry went to account B. A per-minute 429 does not switch. `whenExhausted: fail` returns the earliest reset as `retry-after`.
- **`credentials.test.ts`:** two stores in one process (two SQLite files), a fake OAuth endpoint that rotates refresh tokens, and a fake clock. Checks:
  - only the holder refreshes;
  - takeover when the holder goes silent;
  - the `alwaysOn` node reclaims the holder role;
  - `invalid_grant` → pull → recover;
  - with no newer copy, `needsLogin`.
- **`sync.test.ts`:** the merge order, tombstones, passing records on through a middle node, and a pull from `since=0`.
- **`shim.test.ts`:** parsing remote URLs into `owner/repo`; merging aliases with `*`; long tool names shortened under 64 characters; a daemon that is down gives an empty but valid server.

For the manual check at the end of each phase, run T3 Code on both machines against the real accounts.

## 16. Risks and open questions

- **Terms of service.** Using several subscriptions you own is the least risky case; Claude Code itself suggests switching to another account. Automated switching through a proxy has not been explicitly approved by Anthropic, and running it fully unattended is riskier still. To limit this:
  - pool only your own accounts;
  - keep a person driving the sessions;
  - let `whenExhausted: fail` be the default.

  OpenAI's terms carry similar risk for Codex. teamclaude's `docs/compliance.md` is a useful summary, and it is not legal advice.
- **Upstream changes.** Header names, OAuth endpoints and the Codex backend path are undocumented and may change. Keep them in one constant block per provider. Phase 0 logs real traffic, and `status` shows "unrecognised quota headers" when parsing fails.
- **Split-brain refresh.** A rare case that costs one re-login (§5.6).
- **Secrets on every node.** This follows from R5. Pair only machines you control, and use `unpair` to revoke one.
- **Open questions:**
  1. The final name.
  2. Its own GitHub repo (recommended) or a package in an existing monorepo.
  3. Whether loopback trust (no token for local clients) is acceptable on the server. It is, if the server is single-user.
  4. The client auth mode for Claude Code (placeholder token or real login), decided by Phase 0.

## 17. Sources

- teamclaude — https://github.com/KarpelesLab/teamclaude (see `docs/accounts.md` and `docs/compliance.md`)
- docker-mcp-gateway — https://github.com/hwdsl2/docker-mcp-gateway
- Bifrost — https://github.com/maximhq/bifrost
- T3 Code Claude provider docs — https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md
- T3 Code issue on MCP environment variables in desktop-launched profiles — https://github.com/pingdotgg/t3code/issues/9230
- Codex configuration reference — https://learn.chatgpt.com/docs/config-file/config-reference
- PostHog MCP (API key and project pinning) — https://posthog.com/docs/model-context-protocol/faq
