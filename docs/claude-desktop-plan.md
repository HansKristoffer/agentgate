# Plan: Claude Desktop support

Status: implemented (2 Oct 2026); see `apps/agentgate/src/desktop.ts`, `apps/desktop/src/views/ClaudeDesktop.tsx`, `apps/desktop/src/desktopTray.ts` and the user guide `docs/claude-desktop.md`. Open items are at the end. macOS only. One machine only: nothing in this plan syncs to other nodes.

## Goal

Make the Claude Desktop app (`/Applications/Claude.app`) use the pooled subscriptions, and show in the native app what each way covers:

| | **A. Pool routing** (exists: `setup --primary`) | **B. Desktop login switching** (new) | **C. Desktop gateway mode** (new) |
|---|---|---|---|
| Terminal Claude Code, T3, Codex | Yes | No | No |
| Desktop **Code tab** | **No** (verified): Desktop forces `ANTHROPIC_BASE_URL=https://api.anthropic.com` on the CLI it starts | Yes: uses Desktop's signed-in account | **Yes, through the pool** (verified) |
| Desktop **Chat** | No: claude.ai backend | Yes: Desktop is signed in to the chosen account | No: gateway mode has no Chat tab |
| Desktop **Cowork** | No | Yes: same as Chat | Unverified: needs its VM image downloaded in the gateway profile |
| Your claude.ai account in Desktop (history, projects, connectors) | n/a | Yes | No: a separate local profile |
| Switches account | Per request, no restart | On request, quits and reopens Desktop | Per request (the pool), no restart |
| Needs | Daemon running, `--primary` on | One capture per account; the saved login can expire | Daemon running; turning it on or off restarts Desktop |
| Works across machines | Yes (pool is synced) | No (data is encrypted with this Mac's key) | No (local Desktop setting) |

A is always useful and independent. For Desktop, B and C are the two choices: **B** keeps your full claude.ai account (Chat, Cowork, Code) and switches accounts by restarting Desktop; **C** sends Desktop's coding through the pool with automatic account switching, but Desktop then runs as a separate local profile without Chat or your claude.ai data. The app shows this table so the user picks knowingly, and lets them flip between B and C.

## Desktop-first users

Many users only use the Claude Desktop app: no terminal, maybe no `claude` CLI, no T3. For them agentgate must be understandable and usable entirely from the native app.

### Principles

- **No terminal.** Every step in this plan has an app equivalent. Accounts are added with the existing browser login (`POST /accounts/login`), which needs no `claude` CLI.
- **Plain words.** Say "Claude Desktop", "account" and "subscription". Avoid "pool", "routing", "1p/3p", "gateway" in the main UI; the technical name can sit in help text ("also called gateway mode").
- **Always show the current state.** Which mode Desktop is in, which account it uses, how much of that account's limit is used.
- **Say what will happen before it happens.** Every action that restarts Desktop says so, and what is lost (running Cowork/Code sessions, unsent drafts).
- **Everything is reversible** from the same screen, and turning agentgate off leaves Desktop working as before.

### First run

After **Set up this machine**, one question: **"Where do you use Claude?"**: *Claude Desktop app* / *Terminal, T3 Code or Codex* / *Both*. The answer only picks which guide to show; everything stays reachable later.

The Claude Desktop guide has three steps:

1. **Add your subscriptions.** One browser sign-in per account, with a label ("Work", "Personal"). Explained as: "Agentgate keeps each subscription signed in so it can show their limits and switch between them."
2. **Choose how Claude Desktop uses them**, as two cards:
   - **Switch accounts in Claude Desktop** (B): "Keep your full Claude account in Desktop: Chat, Cowork, Code, history and projects. When one subscription runs low, switch Desktop to another with one click. Desktop restarts when you switch."
   - **Share them automatically in the Code tab** (C): "Desktop's Code tab uses whichever subscription has room and moves on by itself when one runs out. Desktop runs as a separate local profile: no Chat, and your claude.ai chats and projects are not shown there. Agentgate must keep running."

   Helper question above the cards: "Do you use Chat or Cowork in Claude Desktop?" Yes → B is marked recommended; No, only Code → C is recommended.
3. **Connect Claude Desktop.**
   - B: for each account, **Connect to Claude Desktop** runs the add flow: "Claude Desktop will restart. Sign in with *work@example.com*." The daemon watches `config.json` and saves the login automatically as soon as `lastKnownAccountUuid` changes, so there is no "Save" button to forget. If the user signs in with a different account than expected, say so and offer to keep it anyway. The account Desktop is already signed in to is captured first, without a restart.
   - C: one button, **Turn on**, with the restart notice.

The guide ends on the Accounts screen, with its Claude Desktop panel (originally a separate **Claude Desktop** screen, below).

### Usage without traffic

The Accounts screen today says "Quota appears after the first provider request". In B, Desktop talks to Anthropic directly, so no requests pass the daemon and no usage is ever seen. Desktop-only users need usage to decide when to switch, so:

- The daemon polls usage for each enabled Claude account that has had no request through the pool for 10 minutes. Source to verify in a spike: Claude Code's own usage endpoint (`/api/oauth/usage`, what `/usage` shows) with the account's OAuth token; fallback: a minimal `/v1/messages` request with `max_tokens: 1` on Haiku and read the rate-limit headers (costs a little quota, so at most every 30 minutes).
- Results go through `recordUsage`, so they sync and show like any other usage. Mark them "checked 4 min ago" in the UI.
- This also makes the switch suggestion and notifications below work.

### Claude Desktop screen

> **Changed after the build:** this screen was merged into **Accounts**. Accounts now has a compact *Claude Desktop* panel (what Desktop uses now, the two modes as buttons, the MCP switch), the alerts above it, and a **Use in Desktop** / **Connect to Desktop** button on each Claude account. The setup checklist and the mode cards were dropped; each row shows one action, and Edit, Pin, Disable, Forget and Delete are in its ⋯ menu. The rest of this section is the original design.

A new sidebar entry **Claude Desktop** (shown when Claude.app is installed and the connection is local), rather than a panel buried in Accounts. Desktop-first users land here.

- **Top card: what Desktop is doing now.** B: "Signed in as **Work** (work@example.com) · 62% of 5-hour limit, resets 15:40". C: "Code tab shares your subscriptions automatically · now using **Personal**".
- **Mode control**: the two cards from the guide, with the full comparison table behind "Compare".
- **B: account list.** Each account with its usage bars, **Use in Desktop**, and its Desktop status: *In Desktop now*, *Ready*, *Not connected* (**Connect**), *Login expires in 3 days*, *Login expired* (**Connect again**).
- **Suggestion banner** when Desktop's account is at or above the pool threshold and another connected account has room: "Work is at 96%. Switch Claude Desktop to Personal?" (**Switch**).
- **Help** link to the explainer (below).

### Menu bar

Desktop-first users switch often and shouldn't need to open the agentgate window. Add a menu bar item to the Tauri app (tray):

- Title: the account Desktop uses and its tightest window ("Work 62%"), or "Pool" in mode C.
- Menu: each connected account with its usage → click switches Desktop (with the restart confirmation the first time, then a "don't ask again" option); **Open Agentgate**.

### Notifications

- B: when Desktop's account reaches its limit (from polling): "Work has reached its limit until 15:40. Switch Claude Desktop to Personal?" with a **Switch** action.
- B: a saved login expires within 3 days and has not been used: "Open Claude Desktop with Personal once to keep it connected."
- C: agentgate is not running while Desktop is in gateway mode: "Claude Desktop's Code tab can't reach your subscriptions. Start Agentgate or switch Desktop back to your account."

### Problems the app detects and explains

| Situation | Shown as |
|---|---|
| Desktop is signed in to an account agentgate doesn't know | "Claude Desktop is signed in as other@example.com. **Save this account** to switch back to it later." |
| A saved login stopped working (expired, or signed out in Desktop) | "Personal needs to be connected again" + **Connect** |
| Desktop update changed its storage format (schema check fails) | Switching disabled: "This version of Claude Desktop isn't supported for switching yet. Your current login is untouched." |
| Login saved by another major Desktop version (e.g. 2.x → 3.x) | That login shows "Saved with Claude Desktop 2.x; connect this account again"; refused before Desktop is quit. Minor updates keep working. |
| Desktop has a sign-in agentgate can't read (e.g. still being written to disk) | Switch and Connect refuse instead of erasing it: "wait half a minute and try again". |
| Connect was for work@…, user signed in as home@… | The home login is saved; a notice says work@… is still not connected, with **Connect work@…** and **Dismiss**. |
| Gateway mode on, daemon down | Red top card + notification (above) |
| User pressed Log out in Desktop | Detected as the current login disappearing; explain once: "Signing out in Claude Desktop ends the saved login. Use **Add account** in Agentgate instead." |

### Help content

- An in-app explainer **"How Agentgate works with Claude Desktop"**: the two modes in plain words, the comparison table, and short answers: Why does Desktop restart? Why is there no Chat in shared mode? What happens to my chats? (they stay in your claude.ai account; shared mode has its own local history) What if I uninstall Agentgate? (Desktop keeps the account it was last switched to; shared mode is turned off on uninstall) Which rules apply? (agentgate only uses accounts you sign in to yourself and only sends Claude Code requests with subscription logins; the terms of each plan still apply).
- The same text as `docs/claude-desktop.md` and a "Using Claude Desktop" section near the top of the README, before the CLI-centric parts.

## MCP servers in Claude Desktop

What the spike showed: Desktop's Code tab starts the CLI with `--setting-sources=user,project,local`, and in both modes (signed-in and gateway) the session loaded the user-level MCP servers from `~/.claude.json` (`codebase-memory-mcp`, `notion`, `railway`) and the user's plugins. So the agentgate MCP entry that `setup --primary` writes into `~/.claude.json` reaches the Code tab; per-repo servers work as usual because the shim picks the project from the session folder's `git remote` (Desktop worktrees keep the same remote).

| Surface | Agentgate MCP | How |
|---|---|---|
| Code tab, signed-in mode (B) | Yes | `~/.claude.json` user `mcpServers.agentgate` (written by `setup --primary`) |
| Code tab, gateway mode (C) | Yes | Same file; the gateway profile's CLI reads the same `~/.claude.json` |
| Chat (B) | Not today | Possible: Desktop's own `claude_desktop_config.json` `mcpServers` (stdio). Chat has no repo, so only the `*` default servers would apply |
| Cowork | No | Runs in a VM with its own connectors; cannot start a host stdio command |

Changes:

- **Split MCP from model routing.** Desktop-only users want agentgate's MCP servers in the Code tab but `--primary`'s base URL does nothing for Desktop. Add `agentgate setup --mcp [off]` (and an app switch **Use Agentgate's MCP servers in Claude Code and Claude Desktop's Code tab**) that only writes the `~/.claude.json` entry. `--primary` keeps doing both.
- **Chat (optional, later):** `setup --desktop-chat-mcp` adds `agentgate` to `~/Library/Application Support/Claude/claude_desktop_config.json` `mcpServers`, serving the `*` defaults. Desktop must restart to pick it up.
- **Detect drift.** `DesktopStatus` (and the Settings screen) reports whether `~/.claude.json` still has the agentgate entry, with a **Fix** button. Found on this machine: `--primary` had been run before it wrote the MCP entry, so the base URL was set but MCP was missing; re-running `setup --primary` fixed it.
- The shim must not depend on the caller's `PATH` for `git`: Desktop starts MCP servers with a reduced environment. Use `/usr/bin/git` when `git` is not on `PATH` (verify in the Code-tab test).

## What we know about Desktop's login (verified on Desktop 2.19675.0)

- Chat and Cowork use the claude.ai web session: cookies in `~/Library/Application Support/Claude/Cookies` (Chromium SQLite), mainly `sessionKey`, `sessionKeyLC`, `lastActiveOrg`, `routingHint`.
- The Code tab uses Desktop's own OAuth token: `oauth:tokenCache` / `oauth:tokenCacheV2` in `config.json`, plus `lastKnownAccountUuid`. Desktop passes it to the CLI as `CLAUDE_CODE_OAUTH_TOKEN` and refreshes it itself.
- Cookie values and `oauth:*` values are encrypted with Electron safeStorage (prefix `v10`), key in the Keychain as "Claude Safe Storage". **On the same Mac, the encrypted values can be copied as they are; we never decrypt them.**
- Pool OAuth tokens cannot create a claude.ai `sessionKey`, so B needs its own one-time capture per account.
- The Code tab spawns the CLI with user settings, but Desktop sets `ANTHROPIC_BASE_URL=https://api.anthropic.com` and its own `CLAUDE_CODE_OAUTH_TOKEN` in the CLI's environment, and the CLI connects straight to Anthropic even with `--primary` on. **A does not cover the Code tab.**

## Phase 0: spike results (2 Oct 2026, Desktop 2.19675.0)

Run on the real Desktop with a throwaway prototype of `readLogin`/`signOutLocally`/`writeLogin`, two Max accounts (A and B):

| Check | Result |
|---|---|
| Clear the claude cookie rows + 3 `config.json` keys, open Desktop | **Pass**: sign-in screen ("Claude for Mac — Get started"); no request to Anthropic, so the server session stays valid |
| Restore the saved rows (encrypted values copied raw) | **Pass**: Desktop opens signed in to the saved account |
| Sign in to B after clearing A; B shows any of A's data? | **Pass**: B shows only its own chats, Cowork tasks, pins |
| Switch B → A → B (save outgoing, write incoming) | **Pass**: each side shows only its own data; B's saved login still worked after switching away and back |
| Unsent message-box draft survives a switch | **No**: A's draft was gone after the round trip. Warn in the UI before switching |
| Row count per account differs (A 25 cookies, B 15) | Confirms `writeLogin` must delete all matching host rows before inserting, not upsert by name |
| Code tab goes through the pool with `--primary` | **No**: the Desktop-started CLI (`--setting-sources=user,project,local`) had `ANTHROPIC_BASE_URL=https://api.anthropic.com` in its environment and its only TCP connections were to Anthropic (`160.79.104.10:443`); none to `127.0.0.1:7878`. Desktop overrides the base URL even when its own environment has ours |
| Launching Desktop from a shell | `open -a Claude` passes the caller's environment to Desktop (it inherited this agent's `CLAUDE_CODE_SESSION_ID`, `ANTHROPIC_BASE_URL`, …). `open()` must use a clean environment |
| Desktop's own Log out revokes the session | **Not tested** (would end a real session). The design assumes yes and never uses it |

Local Storage, IndexedDB and Session Storage did not need to be part of the saved login: Desktop reloads account data from the server.

Original checklist, kept for reference:

1. Copy the claude.ai/claude.com/anthropic.com rows from `Cookies` plus the `oauth:*` and `lastKnownAccountUuid` keys from `config.json` while Desktop is quit. Sign in to a second account. Restore the first set. Desktop opens signed in as account 1 → **core assumption holds**.
2. After restoring, check Chat, Cowork and the Code tab for stale state from the other account (sidebar, projects, org). If Local Storage/IndexedDB keeps account-specific state that breaks things, add those to the snapshot or clear them on switch.
3. Confirm that **signing out** in Desktop revokes the session server-side (the saved copy stops working). Expected yes, which is why the "add account" flow below never signs out.
4. Confirm the Code tab's requests reach the daemon with `--primary` on (temporarily log the user agent / `x-app` header in `pool.ts`, or watch `request_log` while a Code-tab session runs and T3 is idle).
5. Note how `sessionKey` expiry moves while in use (it is about 30 days today).

## B. Desktop login switching: design

All Desktop code lives in one new module, `apps/agentgate/src/desktop.ts`, and runs in the daemon (same user as the app, so it can read Desktop's files and quit/open it). The native app only calls the API.

### Storage

Saved logins go in the store's `local` table (never synced, not in backups; see `Store.local`/`setLocal` and `exportBackup`):

```
key:   desktop:login:<accountUuid>
value: {
  accountUuid, email?, capturedAt, desktopVersion,
  cookieSchema,            // Chromium `meta.version` of the Cookies db
  sessionExpiresAt,        // from the sessionKey row
  cookies: [ {...all columns, encrypted_value: base64} ],
  config:  { "oauth:tokenCache": "...", "oauth:tokenCacheV2": "...", "lastKnownAccountUuid": "..." }
}
key:   desktop:current      // accountUuid agentgate last switched to
```

No new record kind, so the protocol, sync and backup code do not change. The values are useless off this Mac.

`accountUuid` links a saved login to a pool account (`credential.accountUuid`). A saved login without a matching pool account is still allowed and shows as "Desktop only".

### `desktop.ts` (functions, no classes)

- `paths()`: `~/Library/Application Support/Claude/{Cookies,config.json}`; `available()` = macOS and `Claude.app` exists.
- `routing()`: whether `~/.claude/settings.json` has `ANTHROPIC_BASE_URL` = our URL (reuse the check in `setup.ts` `primary()`), plus whether the daemon is reachable. This drives the "Pool routing" column.
- `running()`: `pgrep -x Claude` matching `/Applications/Claude.app/Contents/MacOS/Claude`.
- `quit()`: `osascript -e 'quit app "Claude"'`, wait up to 15 s for the process to exit. **Never force-kill**: if it does not quit (unsaved state, a dialog), fail with "Quit Claude and try again".
- `open()`: `env -i HOME=… PATH=/usr/bin:/bin /usr/bin/open -a Claude`. A plain `open` hands the caller's environment to Desktop (seen in the spike), which would leak agent/session variables into Desktop's Code sessions.
- `readLogin()`: open `Cookies` read-only (`?immutable=1` while running), select rows where `host_key` ends with `claude.ai`, `claude.com` or `anthropic.com`; read the three `config.json` keys. Account uuid from `lastKnownAccountUuid`.
- `writeLogin(login)`: requires Desktop to be quit. Refuse if `cookieSchema` differs from the current db. In one SQLite transaction delete the matching host rows and insert the saved ones. Rewrite `config.json` with `atomicWrite` (`files.ts`), changing only those keys.
- `capture(s)`: `readLogin()` and save to `desktop:login:<uuid>`. Refreshing an existing entry replaces it.
- `use(s, uuid)`: the switch, below.
- `signOutLocally()`: for "add account": delete the matching cookie rows and the three config keys, without calling any sign-out endpoint, so the server session stays valid for the saved copy.

### Switching (`use`)

1. Look up `desktop:login:<uuid>`; fail if missing or `sessionExpiresAt` is past.
2. If Desktop is running: `quit()`.
3. `capture()` the current login first, so the account we leave is always saved with its latest (rolled) `sessionKey`. This also keeps saved logins fresh without user action.
4. On the first switch ever, copy `Cookies` and `config.json` to `~/.config/agentgate/desktop-backup/<timestamp>/` (0700), once.
5. `writeLogin(saved)`, set `desktop:current`.
6. `open()` if it was running before.
7. Log to `request_log` (`provider: "claude-desktop"`, note `switched to <label>`) so it shows in Activity.

`s.acquireLease("desktop:switch", …)` / `releaseLease` (`store.ts`) guards against two switches at once, including CLI and daemon running together.

### Adding an account

Desktop's own "Log out" revokes the session, so we provide the flow instead:

1. `desktop add`: quit Desktop, `capture()` the current login, `signOutLocally()`, open Desktop.
2. The user signs in to the next account in Desktop.
3. The daemon notices the new `lastKnownAccountUuid` in `config.json` (poll every 2 s while an add is pending, for up to 10 minutes) and captures it automatically. `desktop capture` stays as a manual fallback.

The app explains this once: "Don't use Log out in Claude Desktop; it ends the saved login."

### API (`api.ts`, loopback only)

Remote connections must not drive another Mac's Desktop. Mount these behind `loopbackOnly` (as in `daemon.ts`), so over Tailscale they 404 and the app hides the section.

- `GET /desktop` returns:
  ```ts
  interface DesktopStatus {
    available: boolean;          // macOS and Claude.app installed
    version?: string;
    running: boolean;
    routing: boolean;            // approach A active
    current?: string;            // accountUuid Desktop is signed in to now (lastKnownAccountUuid)
    logins: { accountUuid: string; accountId?: string; email?: string;
              capturedAt: number; sessionExpiresAt?: number; expired: boolean }[];
  }
  ```
- `POST /desktop/capture`, `POST /desktop/add`, `POST /desktop/use` `{ accountUuid }`, `DELETE /desktop/logins/:uuid`.

`DesktopStatus` goes in `packages/protocol`. It is a separate endpoint, not part of `/status`, so the remote status shape is unchanged and `API_VERSION` stays 1.

### CLI (`cli.ts`)

```
agentgate desktop                 # status: routing on/off, current account, saved logins and expiry
agentgate desktop capture         # save the login Desktop has now
agentgate desktop add             # save current, sign Desktop out locally, reopen for the next login
agentgate desktop use <account>   # pool account id, email, or uuid
agentgate desktop forget <account>
```

### Native app

These elements live on the **Claude Desktop** screen described under *Desktop-first users*; the Accounts screen only shows a small *In Desktop* badge on the account Desktop uses. Shown only when the connection is local and `available`:

- A small **Claude Desktop** panel above or below the account list with the comparison from the table at the top in two lines:
  - **Chat, Cowork and Code tab**: "Signed in as <label>" and a note that it switches by reopening Desktop.
  - **Terminal Claude Code / T3**: "Uses the pool" when `routing`, else a **Route** button (same `primary-on` local action as Settings), with the note "Does not apply to Claude Desktop's Code tab."
- On each Claude account row: a **Desktop** badge when that account has a saved login, plus **Use in Desktop** (disabled with a reason if expired, or "Save a login first"). The current one shows "In Desktop".
- Accounts with a saved login but no pool account appear in the Desktop panel as "Desktop only".
- Panel actions: **Save this login**, **Add another account** (with the Log out warning), **Forget**.
- **Use in Desktop** confirms first: "Claude Desktop will restart. Running Cowork/Code sessions stop and unsent drafts are lost."
- Expiry shown as "Saved login expires in 12 days"; warn under 5 days ("Use it once in Desktop to renew").
- Suggestion when the current Desktop account's tightest window is ≥ the pool threshold and another saved account has room: "Desktop's account is at 96% — switch to <label>?" (uses the usage the daemon already has; Chat and Code share subscription limits).

The Settings "Route existing CLI logins" item gets a one-line note: "Not used by Claude Desktop, including its Code tab."

## C. Desktop gateway mode

### Spike result (2 Oct 2026)

Desktop has a third-party ("3p") mode meant for company gateways. It keeps its own data folder, `~/Library/Application Support/Claude-3p` (logs in `~/Library/Logs/Claude-3p`), apart from the signed-in profile in `…/Claude`, so turning it on and off does not touch the claude.ai login, chats or saved logins from B.

Turned on by writing, with Desktop quit:

- `Claude-3p/configLibrary/<uuid>.json`:
  ```json
  { "inferenceProvider": "gateway", "inferenceGatewayBaseUrl": "http://127.0.0.1:7878/anthropic",
    "inferenceGatewayApiKey": "agentgate", "inferenceGatewayAuthScheme": "bearer" }
  ```
- `Claude-3p/configLibrary/_meta.json`: `{ "appliedId": "<uuid>", "entries": [{ "id": "<uuid>", "name": "agentgate", "provider": "gateway" }] }`
- `"deploymentMode": "3p"` added to `Claude-3p/claude_desktop_config.json` (`"1p"` or removing it turns it off).

Results:

| Check | Result |
|---|---|
| Desktop accepts a loopback `http` gateway URL | Yes (`allowLoopbackHttp` in its validator); shows "You're using Gateway" |
| Model list | Desktop fetched it through the daemon (`model-catalog: refresh … accepted`); requests without a model returned 200 |
| Code tab | **Works**: a session answered in ~4 s; 30+ `/v1/messages` requests (Sonnet 5.5, Haiku, Opus) all 200 on one pool account; Desktop's `claude` processes connected to `127.0.0.1:7878` |
| Chat | Not available: the gateway profile shows only Cowork and Code tabs |
| Cowork | Not run: the gateway profile had not downloaded the VM image (`rootfs.img missing`). Test again after the download; the VM may not reach `127.0.0.1`, in which case Desktop has to relay for it |
| Turning it off | Restoring `Claude-3p` and reopening Desktop brought back the signed-in profile unchanged |

Subscription logins are only accepted for Claude Code. The Code tab sends Claude Code requests, so it works through the pool. Agentgate must not dress up other request types (for example a future Chat surface in gateway mode) as Claude Code.

### Implementation

In `desktop.ts`:

- `gatewayStatus()`: whether `Claude-3p/claude_desktop_config.json` has `deploymentMode: "3p"` and the applied config points at `LOCAL_URL`.
- `gateway(on)`: quit Desktop (same `quit()` as B), then
  - on: write our config entry (fixed id stored in `local` as `desktop:gatewayEntry`, so repeated calls reuse it), set it as `appliedId`, set `deploymentMode: "3p"`. Leave any other entries the user has in `configLibrary` alone.
  - off: set `deploymentMode: "1p"`; keep our entry so turning it on again is instant.
  - first time only: back up `Claude-3p` next to the B backup.
  - reopen Desktop with the clean environment.
- `use()` (B) turns gateway mode off first, so "Use in Desktop" always ends in the signed-in profile.

CLI: `agentgate desktop gateway on|off`. API: `POST /desktop/gateway` `{ on: boolean }` (loopback only); `DesktopStatus` gains `gateway: boolean`.

App: in the Claude Desktop panel, a two-option control **Signed-in account** / **Through the pool (gateway mode)** with the table above as help text, and the restart confirmation. In gateway mode the per-account **Use in Desktop** buttons switch back to signed-in mode.

## Not in scope

- Automatic switching without the user asking. Switching restarts Desktop and interrupts running Cowork and Code sessions. Revisit once the manual version is used for a while; if added, only switch when Desktop has no running sessions.
- Syncing saved logins to other machines (needs decrypting with the Keychain key).
- Windows/Linux Desktop.
- Getting an email for "Desktop only" logins (would need undocumented claude.ai APIs); show the uuid and let the user label it.

## Risks

- **Undocumented storage.** A Desktop update can change the cookie schema or `config.json` keys. Mitigation: store `cookieSchema` and `desktopVersion`, refuse a login on a schema or major-version mismatch before changing anything, restore the old cookies if the config write fails, record each switch (`desktop:switching`) so one interrupted by a crash is finished by the next switch and never saved in its mixed state, read and save logins only under the switch lock, keep the one-time backup (cookies via `VACUUM INTO`, so the WAL is included), and keep all knowledge in `desktop.ts`.
- **Native multi-account.** Desktop has a `multiAccount` feature flag (currently unavailable). If it ships, B may become unnecessary; A is unaffected.
- **Saved logins expire** if not used for about 30 days. The UI shows expiry; switching to an account renews it.

## Tests (`apps/agentgate/test/desktop.test.ts`)

Point `paths()` at a temp dir (same pattern as `setup.test.ts`), with a fixture `Cookies` db built from the real Chromium schema (columns only, fake values) and a fixture `config.json`:

- capture → use round trip restores the exact rows and keys and leaves other cookies/keys untouched;
- `use` captures the outgoing login first;
- schema mismatch is refused without writing;
- expired login is refused;
- `signOutLocally` removes only the claude rows/keys;
- API routes 404 on the tailnet listener.

Quitting/opening the app is behind two small functions so tests replace them.

## Implementation order

1. ~~Phase 0 spikes~~ done (see results above).
2. ~~Usage source~~: Claude Code's `/api/oauth/usage` works with pool tokens and costs no quota (`fetchUsage`/`pollUsage` in `llm/claude.ts`).
3. ~~`desktop.ts` + tests~~ (B and C).
4. ~~Usage polling in the daemon~~ (every minute, per account at most every 10 minutes when idle).
5. ~~API (`/api/desktop…`, loopback only), `DesktopStatus`, CLI `agentgate desktop …`.~~
6. ~~App: Claude Desktop screen, mode cards, per-account connect/use, problem states.~~
7. ~~App: first-run question and setup checklist.~~
8. ~~Menu bar item and notifications~~ (`tauri-plugin-notification`, `tray-icon`).
9. ~~MCP: `setup --mcp`, status and switches; shim finds `git` without `PATH`.~~
10. ~~Help: in-app explainer, `docs/claude-desktop.md`, README section.~~

Open:

- Live end-to-end run of `use`/`add`/`gateway` through the new code on a real Desktop (the spike exercised the same steps with a prototype; the unit tests use a fixture cookie store).
- Menu bar item not yet seen on screen: on a notched MacBook with a full menu bar, new items can be hidden behind the notch.
- Cowork in gateway mode, once its VM image has downloaded.
- Chat MCP via `claude_desktop_config.json` (optional).
