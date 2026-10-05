# Proxy controls and diagnostics

The daemon serves Claude and Codex traffic on loopback. Management operations run on the daemon selected in the native app; a remote account check describes that remote machine. Provider capabilities and daemon version/build are shown in Settings and `agentgate proxy capabilities`.

## Accounts and quota

Accounts and Overview share measured quota windows, reset countdowns, and local cooldowns. A reset that has passed enables routing reevaluation while retaining the last measured percentage; it does not create a fresh zero observation. The account can become eligible only after all relevant blockers expire.

The app offers **Refresh usage** in an account's ⋯ menu. The other checks run from the CLI below, on one account or a batch: up to 100 accounts run with four concurrent workers and per-account results. Verification checks coordinated credentials, read-only quota, and model discovery. `--probe` sends a small request through the proxy using the selected account and consumes quota. It requires an explicit model and never silently switches to another account.

Claude background usage checks prefer the credential holder. Codex background polling defaults off: `/backend-api/wham/usage` and `/backend-api/codex/models?client_version=0.149.1` are isolated candidate integrations covered by fixtures, awaiting live-client validation. Manual checks are available. Failed polls retain previous observations and expose sanitized health. Live observations received during a poll take precedence; relogin and deletion invalidate old results.

```sh
agentgate accounts quota account-a account-b
agentgate accounts verify account-a
agentgate accounts models account-a
agentgate accounts refresh account-a
agentgate accounts verify account-a --probe --model claude-sonnet-4-5
agentgate accounts reset-cooldown account-a
```

Resetting local backoff clears transport/model cooldowns, while provider quota and login state remain authoritative.

## Routing and policy

Settings provides Automatic, Priority, and Round robin strategies. Eligible pinned accounts take precedence. Automatic retains the active account below the threshold, then uses reset time and priority. Optional session affinity prefers an eligible account for recognized Claude/Codex session identifiers. Affinity has a TTL and a 2,000-entry bound on each node. In-flight counts are diagnostic; they impose no additional concurrency limit.

Quota exhaustion switches accounts; a short rate-limit rejection can retry the same account. A 401 permits one coordinated refresh. `Retry-After` is a minimum: requests return a limit response when its wait exceeds the budget. Credential acquisition, header waits, backoff, authentication retry, and account changes share one startup deadline. The defaults allow three rate retries, 100 accounts, and 660 seconds for startup, retaining the existing exhaustion wait of at most ten minutes. The normal header timeout remains 30 seconds and stream idle timeout five minutes.

Uncertain network outcomes and interrupted streams are never replayed across accounts. Codex continuations stay with the recorded response owner; unknown, expired, or unavailable ownership returns 409, asking the client to start a new response. Response ownership is node-local and expires after one hour or a daemon restart. Requests with an original client login retain passthrough/fallback behavior.

Account policy supports optional retry overrides, exact model allowlists and exclusions. **Inherit** differs from zero retries. Discovery snapshots inform eligibility for ten minutes; absent or stale discovery does not block otherwise allowed models. Provider-specific model-list paths retain upstream metadata while filtering unavailable/excluded models and exposing eligible aliases. Original-login passthrough retains the upstream list.

Model aliases resolve before selection, scope checks, and upstream preparation. They preserve requested and routed names in diagnostics. Provider IDs are case-sensitive; duplicate mappings, cycles, arbitrary text, and URL targets are rejected. Family scopes match whole identifier segments, preventing names such as `notopus` from matching `opus`.

Settings and account editors preserve drafts, show before/after previews, and save using opaque record revisions. A settings save returns the applied settings and their new `revision` from the same transaction, so the editor can save again without rereading status. Stale saves return 409. Reload current settings and reapply the intended edits. Account overrides and pool policy sync; cooldowns, model snapshots, affinity, and request diagnostics stay local. Revision checks serialize changes to one local record; disconnected replicas still resolve using existing last-writer-wins rules.

```sh
agentgate proxy route claude --model claude-sonnet-4-5
agentgate settings show
agentgate settings set --file /absolute/path/patch.json
agentgate accounts policy account-a --file /absolute/path/policy.json
```

Example settings patch:

```json
{
  "strategy": "round-robin",
  "sessionAffinity": true,
  "bootstrapTimeoutMs": 60000,
  "maxAccounts": 3,
  "aliases": [{ "provider": "claude", "alias": "work-model", "target": "claude-sonnet-4-5" }]
}
```

## Activity

Activity filters requests by provider, account, model, outcome, failure, time, and ID/model/account search. Follow refreshes the latest page every five seconds. Pause preserves the current page and enables loading older results; the app keeps at most 1,000 loaded rows. Request detail shows every account attempt and retry. **Copy loaded diagnostics** exports those rows and attempts as NDJSON to the clipboard. Use the CLI for a larger file export:

```sh
agentgate requests --provider claude --outcome failed
agentgate requests <request-id>
agentgate requests export --provider codex > proxy-diagnostics.ndjson
```

The filter timestamps `since` and `until` are Unix milliseconds. List cursors are exclusive sequence numbers: concurrent new inserts do not duplicate older pages. `cursorReset` signals that retention removed the requested range. CLI export is bounded to 1,000 pages of 100 requests. Retention during a detail export can remove a listed request; refresh the list and export again.

One request with multiple attempts counts once in totals. Account fallback counts distinct accounts, excluding same-account retries. The aggregate window is completed requests retained from the last 24 hours. Headers latency, first forwarded byte, and total duration are separate; first byte is not necessarily a generated token. HTTP 200 can still have an interrupted or provider-error stream. Clean EOF and provider-declared completion are recorded separately.

Default retention is 5,000 requests and 16 MiB including attempts. Completed requests exceeding either budget are deleted together with their attempts; active requests remain until finalized. A terminated daemon can leave pending diagnostics from unfinished streams. Model fields are bounded and sanitized; telemetry excludes prompts, response bodies, credentials, arbitrary headers, and raw upstream errors. Diagnostics are absent from configuration backups and sync.

## Management contracts and upgrades

Management API **3**, tailnet sync **5**, and backup format **4** accompany this change. SQLite migration **2** adds local telemetry tables and invalidates obsolete pending relay uploads. Upgrade the app and all paired nodes together. The encrypted relay payload contains the sync version; incompatible entries are skipped and reported, never merged with silently stripped policy. After all nodes have upgraded, run `agentgate relay reconcile` if skipped entries remain. Current backup imports accept formats 1–4; older readers reject format 4.

New endpoints retain bearer authentication on tailnet and browser-origin rejection:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/requests`, `/api/requests/:id` | Filtered history and attempts |
| `GET /api/proxy/metrics` | Completed-request aggregates |
| `GET /api/proxy/route?provider=claude&model=…` | Read-only selection explanation |
| `POST /api/accounts/batch` | `{ids, action}` operations |
| `POST /api/accounts/:id/verify` | Optional `{probe: true, model}` |
| `PATCH /api/settings` | `{revision, patch}` |
| `PATCH /api/accounts/:id` | Policy/label/priority require `revision`; enabled/pinned intent operations remain supported |
| `DELETE /api/accounts/login/:state` | Cancel a pending native OAuth attempt |

Before release, validate native interaction and current live Claude/Codex clients, quota failover, long streaming, cancellation, concurrent sessions, and remote management. The automated checks exercise implementation behavior using fake upstreams, not provider acceptance.
