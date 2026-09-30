agentgate stability and simplification plan — 2026-09-30

Keep the current Bun, Hono, SQLite, and server-rendered UI foundation. The program is small enough for this stack, and the boundaries between providers, storage, sync, and MCP are useful. The first improvements should make failures recover predictably and protect stored state. Refactoring should make those rules easier to enforce from both the CLI and the UI.

The product has three core responsibilities: pooling Claude/Codex accounts without interrupting sessions, selecting MCP tools by repository, and copying state between machines that can operate independently. Preserve all three. Distributed refresh-token ownership is the most difficult part and needs stronger checks before relying on the multi-machine workflow.

Verification performed in this review:

- `bun test`: **26 passed, 0 failed** across five files.
- `bun run typecheck`: passed.
- Compiled a minified macOS ARM64 binary and ran `--help`, `init`, and `setup` in a temporary configuration directory. The generated MCP command resolves to the compiled binary.
- Ran the installed **codex-cli 0.159.0** against agentgate and a fake upstream. It sent `POST /backend-api/codex/responses`, agentgate injected the dummy account token, and Codex completed the streamed response successfully.
- Confirmed the ten issues below using temporary scripts, in-memory databases, temporary database files, and fake upstreams. The change-feed race used an instrumented interleaving between two SQLite connections. No real credentials were used.

This establishes a useful local baseline. This review did not verify live Claude/Codex subscription traffic, T3 workflows, two physical machines, system service installation, or the other compiled targets. `PLAN.md` records an earlier Claude terminal check and still lists live Codex/T3 questions. Treat those as release gates.

The existing tests exercise successful requests, ordinary quota switching, basic holder failover, pairing, and MCP routing. They do not currently cover Codex pooling, failed account recovery, active MCP connection expiry, backup redaction, malformed sync data, or concurrent change-feed reads.

P0 below means fix before trusting secrets or replicated state. P1 means fix before relying on uninterrupted daily sessions.

| Priority | Confirmed issue | Consequence | Source |
|---|---|---|---|
| P0 | “Without secrets” exports remove LLM credentials and `mcp.secrets`, but retain MCP OAuth access/refresh tokens, OAuth client secrets, header values, and environment values. | A backup advertised as safe to share can contain usable credentials. | [store.ts](src/store.ts#L225), `exportBackup` |
| P0 | `changes()` reads records and the feed sequence in separate queries. A CLI write can occur between them. | The returned cursor can advance past a record that was never sent; subsequent pulls skip it until it changes again. | [store.ts](src/store.ts#L181), `changes` |
| P0 | `merge()` stores incoming JSON without validating its record schema. | An invalid settings record is accepted, then settings reads throw. Replicated bad data can break requests and pages. | [store.ts](src/store.ts#L187), `merge` |
| P0 | The proxy's 401 path calls `Credentials.refresh()` directly, which does not enforce holder eligibility. | A node refreshes and takes ownership even while the holder is healthy, creating avoidable rotation races. | [pool.ts](src/llm/pool.ts#L210), [credentials.ts](src/credentials.ts#L48) |
| P1 | After refresh fails with `InvalidGrant`, the proxy retries the old token and returns its second 401. | A request fails even though another pooled account is usable. | [pool.ts](src/llm/pool.ts#L210) |
| P1 | MCP tool calls use cached `Client` objects and do not update the upstream's `lastUsed`. The idle timer closes those clients. | After expiry, the next call follows the cached route and fails with `Not connected`. Continued tool activity does not prevent expiry. | [gateway.ts](src/mcp/gateway.ts#L109), `mergedServer`, `closeIdle` |
| P1 | A quota rejection always sets account-wide `exhaustedUntil`, including a model-specific rejection. | An Opus-only rejection excludes the account from Sonnet requests even when general usage is only 10%. | [pool.ts](src/llm/pool.ts#L33), [pool.ts](src/llm/pool.ts#L195) |
| P1 | Deleted records are purged after 30 days without checking offline peers. | A returning peer with the old live record resurrects deleted configuration. | [store.ts](src/store.ts#L199), `purgeTombstones` |
| P1 | Backup import writes each record immediately and validates later records afterward. | A restore reports failure after already applying part of the backup. | [store.ts](src/store.ts#L237), `importBackup` |
| P1 | `mcp add <name> <preset> --header ...` takes the preset branch without applying headers. | The README's PostHog project-pinning command silently drops `x-posthog-project-id`. | [cli.ts](src/cli.ts#L179) |

Implement the work in this order, with focused regression tests accompanying each behavior change:

1. **Fix the immediate configuration and account-switching failures.**

   Make secret-free export use an explicit public configuration representation. Remove OAuth tokens/client secrets and redact arbitrary header and environment values, including credentials embedded in URLs or command arguments. Cover both the CLI export and the UI download through the same serializer.

   Apply user-supplied headers after constructing a preset. When an account becomes unusable during a 401 recovery, exclude it from that request and select the next account before returning an error. Keep model-specific quota exhaustion scoped to its window/model; use an account-wide cooldown only when the evidence describes an account-wide limit.

   **Done when:** dummy secrets are absent from both export paths; the documented preset command retains its project header; a dead account falls through to a healthy account; Opus exhaustion leaves Sonnet usable. Add pull-request CI for tests and typechecking now; the current workflow runs only on release tags.

2. **Make storage and replication safe to build on.**

   Return change-feed records and the high-water sequence from one consistent SQLite read snapshot. Validate the entire incoming envelope and live record data before applying it: known record kinds, IDs consistent with payload IDs, integer revisions/cursors, timestamps, tombstones, and schema-valid JSON. Bound settings such as threshold, retry count, and log retention in their schemas rather than only in HTML forms.

   Prevalidate a backup's format/version and all records, then import them in one transaction. Use transactions for account-plus-credential saves, account deletion, pin changes, and MCP rename/delete plus their project mappings. Preserve tombstones indefinitely for this small personal store; that is a straightforward way to prevent offline resurrection. Add a schema version and an explicit migration path before changing credential storage.

   Coalesce overlapping pulls per peer and advance the cursor only after a validated batch is committed. Report a bad batch without storing data that makes later reads fail. Separate malformed-data errors from temporary peer unavailability.

   **Done when:** an interleaved CLI write cannot disappear from replication; malformed batches leave existing state readable; failed imports apply nothing; deletes survive a peer returning after 31 days; multi-record operations survive interruption atomically.

3. **Enforce one credential recovery policy for LLM and MCP OAuth.**

   Make scheduled refresh, request-time expiry handling, and 401 recovery enter the same ownership check. A nonholder should pull newer tokens and coordinate refresh with the healthy holder. Takeover should require the defined holder-unavailable conditions. Keep one refresh in flight per credential, and guard writes so a delayed refresh cannot overwrite a newer login, newer peer credentials, or a deletion. Return an old token after a network failure only while it remains valid.

   MCP OAuth currently stores tokens inside the editable `mcp` record and has no holder rules or refresh coordination ([oauth.ts](src/mcp/oauth.ts#L5)). UI “Test”, CLI “Test”, and gateway connections can all initiate independent refreshes, even on the same machine. Move MCP credentials into their own record and reuse the ownership policy. Keep server configuration edits separate from rotating tokens, with a migration for existing instances.

   Persist successfully issued tokens before optional profile lookups or credential-file/Keychain cleanup. Use the official CLI login/import path as the verified baseline, and test native web login separately. Validate OAuth state and expiry when finishing a login; MCP state currently has no expiry, and LLM pending-state expiry is checked only when another login starts. Exercise the tailnet callback with the actual admin-cookie policy.

   **Done when:** simultaneous requests rotate once; a 401 on a nonholder cannot independently rotate a healthy holder's token; MCP “Test” and normal traffic cannot race refresh; stale completion cannot overwrite a new login; expired tokens fail over cleanly. True network partitions still need a documented re-login recovery policy because independently operating machines can compete for one rotating token.

4. **Make MCP routes survive connection and daemon lifecycle changes.**

   Store stable route information such as instance ID and original tool name, and obtain the current client when a call starts. Check the current project mapping, update activity on every call, and keep an upstream open while a call is in progress. A closed client should invalidate cached routes and reconnect before a new call is sent. Resolve configuration changes without leaving an old pending connection alive.

   Close transports on failed setup, close test clients in `finally`, and expire abandoned shim sessions as well as idle upstreams. Add a bounded shim reconnect path after daemon startup/restart, followed by a tool-list notification. Forward cancellation and progress through both gateway layers; the SDK currently supplies a default 60-second request timeout, so define the intended timeout for long tools explicitly. Preserve the rule that a tool with possible side effects is not automatically replayed after an uncertain failure.

   Shared mapping changes already notify sessions. Per-session mappings are read only at shim startup ([shim.ts](src/mcp/shim.ts#L28)); either reconcile them during changes or clearly show that those changes require a new session. Surface useful bounded stderr from stdio servers for diagnosis.

   **Done when:** tool use over 10 minutes keeps working; a connection can be renewed before the next call; a daemon restart restores tools to a running shim; removed mappings stop routing new calls; cancelled calls and closed sessions release their resources.

5. **Bound requests and background work.**

   The LLM proxy currently buffers the request body, waits with ordinary `setTimeout`, and uses only the client's signal for its upstream fetch ([pool.ts](src/llm/pool.ts#L128)). Set an explicit body limit, a deadline for connection/response headers, and a suitable stream-idle policy. Make rate-limit sleeps and quota waits abortable, validate `Retry-After`, and stop attempting work after client cancellation. Preserve streaming passthrough and retry only before a response has started.

   Make credential passes and peer pulls run without overlapping timer invocations. Have daemon startup return a lifecycle handle that stops listeners, timers, gateway clients, and the database on shutdown. Monitor Tailscale availability/address changes after the first successful bind. Include degraded sync, refresh errors, expired credentials, and unrecognized quota headers in status output. Distinguish “no configured accounts” and “login required” from quota exhaustion.

   **Done when:** an upstream that never sends headers cannot hold a request forever; cancellation interrupts retries/waits; long streams remain usable; slow background jobs do not multiply; shutdown leaves no owned stdio children or timers behind.

6. **Remove duplicated mutation rules and make setup reproducible.**

   Extract small shared operations for accounts, MCP instances, and project mappings. Both CLI commands and UI routes should invoke those operations, with identical validation, cleanup, and transactions. For example, UI MCP deletion removes project mappings, while CLI deletion currently does not. Keep provider-specific protocol details in their existing provider modules.

   Split route handling from presentation in the 968-line `ui/pages.tsx`, keeping plain JSX and HTML forms. Replace broad `any` form/context casts with validated inputs and consistent error responses. Accept command and arguments as structured values or parse quoting correctly; splitting on whitespace currently breaks commands containing paths or arguments with spaces.

   Preserve `AGENTGATE_HOME` and `AGENTGATE_PORT` in generated MCP/service environments. Currently setup writes an empty shim environment and the services retain only `PATH`, so custom configuration does not propagate. Make configuration writes atomic and preserve unrelated user settings. Make `setup --primary off` restore the prior base-URL value it replaced. Fail closed when an admin token is absent. Check service-command failures, including Linux linger setup, and rotate the macOS log file.

   **Done when:** equivalent UI/CLI actions leave equivalent state; a custom home/port works through the generated service and shims; rerunning setup preserves user settings; enabling/disabling primary setup restores the previous configuration; malformed forms produce useful errors.

7. **Verify the real workflows and then ship.**

   Keep tests focused on the failure modes above. Use controlled clocks, fake upstreams, and injected waits/fetches so timeouts, expiry, and cancellation can be checked without long sleeps. Clean up stores, clients, temporary directories, and mutable provider settings after tests. Add Codex-specific quota, refresh, 401, and streaming cases; the existing pool tests exercise Claude only.

   Run the following release checks in order:

   | Check | Pass condition |
   |---|---|
   | One machine, real Claude and Codex | Official login, streaming, tool calls, account switch, and restart succeed for each supported CLI version. |
   | T3 with two repos/worktrees | Each repo reaches its configured MCP instance; defaults and per-session working directories are correct; provider switching preserves the thread. |
   | Two machines | Pairing and edits converge; the second machine keeps working while the holder is offline, refreshes through at least two token cycles, and catches up without re-login. |
   | Failure recovery | Holder shutdown, delayed sync, simultaneous refresh attempts, daemon restart during MCP use, and upstream timeouts recover as defined. |
   | Fresh installations | Supported macOS/Linux targets build; binary setup and user services work after logout/reboot; the README commands work unchanged. |

   OpenAI documents [custom Responses providers](https://learn.chatgpt.com/docs/config-file/config-advanced). The local Codex smoke check validates the client-to-agentgate path with a fake backend; it does not establish that the private ChatGPT backend accepts every real request or account transition. Record live results and supported CLI versions in `PLAN.md` before making that guarantee. Current OpenAI documentation also describes an [authorized ChatGPT-plan app-server integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server); assess its applicability separately before considering any backend migration, since its authorization flow may differ from imported CLI credentials.

   Pin the Bun version used for CI/releases, keep frozen lockfile installs, typecheck before release builds, and smoke-test the actual compiled artifacts. Add release checksums and verify them in the installer.

Start with steps 1 and 2, then the shared credential policy and MCP lifecycle. Those changes address demonstrated failures while creating useful boundaries for later cleanup. Keep additions such as more providers, more MCP presets, resources/prompts, and alternative storage behind the completed release checks above.

## Implementation and verification — 2026-09-30

The implementation above is now built in this checkout. Final local checks: **71 tests passed**, typecheck passed, four binaries built with verified checksums, macOS ARM64 compiled smoke passed, and Codex 0.159.0 completed the fake-backend stream. The issue table describes the original code, before these changes.

| Step | Implemented behavior | Verification |
|---|---|---|
| 1 | Public inventories omit all credential records and arbitrary MCP transport values; preset headers apply consistently; failed 401 recovery selects another account; model windows stay scoped. | Backup, shared operations, Claude and Codex proxy regressions. |
| 2 | Schema validation before writes; one read snapshot for feed records/cursor; atomic peer batches/restores/mutations; database version 1 migration; persistent tombstones. | Two SQLite connections with an interleaved write, malformed batch rollback, legacy migration, restore failure, stale deleted records. |
| 3 | LLM/MCP share holder checks, refresh requests, in-process coalescing, a renewable SQLite lease, and guarded completion. MCP credentials live in `mcpCredential`. Login state is single-use and expires. Tokens save before optional profile lookup or successful-login cleanup. | Independent database handles and two Bun processes rotate once; healthy holder coordination; delayed completion after deletion/re-login; transient failures; MCP rotation; native/MCP expiry; tailnet callback without the Strict cookie. |
| 4 | Calls resolve current connections/mappings; activity counts protect long tools; abandoned sessions expire; failed transports close; shims reconnect and reconcile per-session children; progress and cancellation pass through both layers. | Controlled idle sweeps, daemon late startup/restart, removed routes, worktree execution, real stdio children, progress/cancellation through both gateways. |
| 5 | 16 MiB request limit, 30-second header/body deadlines, five-minute stream inactivity deadline, bounded retry waits, non-overlapping maintenance, lifecycle shutdown, repeated Tailscale discovery, health fields. | Oversized/aborted bodies, silent upstreams/streams, coalesced work, listener shutdown, loopback/tailnet boundaries. |
| 6 | Shared CLI/UI operations; separate JSX components/views from mutation routes; validated forms; quoted command parser; atomic setup preserving other settings; primary URL undo; home/port propagation; checked service commands and launchd log rotation. | Setup/undo/TOML preservation, generated service/shim environment, log rotation, operation regressions, browser pin/settings workflows. |
| 7 | Bun 1.4.2 pinned; macOS/Linux CI runs typecheck/tests/compiled smoke; releases build four targets and publish SHA256SUMS; installer verifies one resolved release before replacing a binary. | All four targets compiled locally; macOS ARM64 compiled smoke passed; installed Codex 0.159.0 completed a fake-backend Responses stream. CI execution awaits a push. |

Run `bun run typecheck`, `bun test`, `bun run build`, then `bun scripts/smoke.ts dist/agentgate-<host-target>`. The optional `bun scripts/codex-smoke.ts` uses the installed Codex CLI with fake tokens and a temporary CODEX_HOME. No real login is required for these checks.

Browser verification used the T3 collaborative preview with an isolated in-memory node: dashboard, accounts, projects, settings, pinning, and settings submission rendered/operated successfully. This checks the web UI inside T3's browser; it does not verify T3 provider switching or live authenticated sessions.

Remaining live release gates: real Claude/Codex subscription traffic and native provider login, T3 provider/worktree sessions, two physical machines over Tailscale, and installed launchd/systemd behavior after logout/reboot. Linux binaries were cross-compiled here; Linux execution belongs to CI or a Linux host. All checks in this implementation used fake credentials or configuration inventories.

Upgrade all paired nodes together: sync protocol 2 rejects older peers explicitly. Existing MCP OAuth records migrate automatically on database open; keep a full backup before upgrading. Re-run setup and reinstall the user service when changing the home, port, or binary location so generated commands keep the same configuration.

“Without secrets” now means a configuration inventory: MCP URLs, headers, command/arguments, environment, fields, secrets, and OAuth registration/tokens are omitted or replaced with placeholders. Reconfigure those transports after restoring an inventory. A full backup remains the restore path for working logins and transport configuration.

Holder ownership reduces rotation races; independent nodes in a true network partition can still compete for an upstream rotating refresh token. When that happens, reconnect peers and pull the newer credential first. If the upstream invalidated the remaining refresh token, log that account/server in again. There is no claim of consensus or partition-safe exactly-once rotation. Deletion history remains indefinitely; database growth from tombstones is the deliberate tradeoff for safe offline catch-up.
