# Proxy improvements inspired by CLI Proxy API Management Center

Review date: 2026-10-03. Status: all eight recommendations implemented; live-provider and native-interaction release validation remains.

Reference: [router-for-me/Cli-Proxy-API-Management-Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center), reviewed at commit [`752e0ee`](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/tree/752e0ee772220ce49aae1221a3f39f23236590d7). Agentgate baseline: `27abd1e3dd38186b7cc117e996cd4dfcfa70214e`.

## Implementation status

- [x] Shared quota polling, scoped observations, freshness/source/node, reset countdowns, and shared Accounts/Overview presentation.
- [x] Node-local request/attempt history, stream finalization, filters, cursor pagination, Activity detail/export, and request aggregates.
- [x] Scoped local cooldowns, retry inheritance, account/startup budgets, cancellation, and refusal to replay uncertain outcomes.
- [x] Automatic, Priority, and Round robin selection, bounded session affinity, route explanations, in-flight counts, and continuation ownership.
- [x] Cached discovery, exact model policy, validated alias chains, and eligibility-filtered provider model lists.
- [x] Daemon-side read-only verification, explicit inference probes, bounded batch operations, needs-attention selection, and cancelled OAuth cleanup.
- [x] Draft preservation, before/after previews, partial patches, transactional revision checks, and inherited/zero retry policy.
- [x] Shared provider registry/capabilities, extracted feature modules, management API 3, sync 5, backup 4, and SQLite migration 2.

See [proxy operations](proxy-operations.md) for the delivered behavior and examples. The Codex read-only integrations remain isolated candidates, with background quota polling off by default until live validation. Features under **Ideas to defer or omit** remain outside this implementation.

Regression coverage is in `proxy-features.test.ts`, plus management, relay, existing provider/pool/runtime, credential, and store tests. Verified on 2026-10-03: 201 Bun tests, four Cloudflare worker tests, workspace typechecking, frontend build, four standalone binary builds, compiled CLI smoke, Clippy, three Rust tests, and a debug macOS app bundle. Native interaction and live-provider checks remain release validation. No reference source was copied; this implementation applies the reviewed concepts to Agentgate's own contracts and code.

The cleanup pass consolidates quota matching across daemon/UI, derives account status types from their schema, reuses routing assessments for selection/explanations/reset timing, aggregates metrics directly in SQLite, and returns the saved settings revision atomically. UI handlers and policy previews are easier to read. Cleanup validation: 202 Bun tests, workspace typechecking, frontend and standalone builds, and compiled CLI smoke.

## Recommendation

Adopt the reference project's operational visibility and explicit routing controls: fresh quota information, scoped cooldowns, searchable request history, bounded retry policies, model eligibility, and configuration previews. Implement these in our Bun daemon, CLI, and Tauri app.

The reference repository is a React management UI for the separate [CLIProxyAPI backend](https://github.com/router-for-me/CLIProxyAPI). Its source demonstrates UI behavior and backend contracts; it does not establish how the backend forwards traffic or whether its retry behavior is safe for our clients. This review inspected source, without running that UI/backend or making live subscription requests. Backend-dependent behavior below is a proposal for Agentgate and needs its own verification.

Scope is the Claude/Codex proxy and its management experience. Keep the existing credential coordination, per-machine inference, and encrypted configuration sync. Refactor along the boundaries below as implementation establishes useful interfaces.

## What we already have

| Area | Current behavior and code | Opportunity |
| --- | --- | --- |
| Account selection | [pool.ts](../apps/agentgate/src/llm/pool.ts): eligible pinned account, provider-wide active account below the threshold, then reset time and priority | Explain each selection; offer additional strategies and optional session affinity |
| Failure handling | `proxy()` refreshes once after a 401, switches after quota 429s, and retries short rate limits on the same account | Separate failure classification, cooldown state, and a request-wide retry budget |
| Quota | [claude.ts](../apps/agentgate/src/llm/claude.ts) and [codex.ts](../apps/agentgate/src/llm/codex.ts) parse response headers; Claude also polls stale accounts | Add Codex polling, explicit freshness, and structured model scopes |
| Diagnostics | [store.ts](../apps/agentgate/src/store.ts) stores `request_log`; [api.ts](../apps/agentgate/src/api.ts) returns the latest 50 entries; [Dashboard.tsx](../apps/desktop/src/views/Dashboard.tsx) displays eight | Queryable request/attempt history, stream outcomes, and useful aggregates |
| Configuration | [protocol/index.ts](../packages/protocol/src/index.ts) defines threshold, exhaustion behavior, retry count, and retention; [Settings.tsx](../apps/desktop/src/views/Settings.tsx) submits the complete settings object | Preserve drafts during polling, preview changes, and reject stale writes |
| Management boundary | [daemon.ts](../apps/agentgate/src/daemon.ts) guards management requests and keeps provider traffic loopback-only; [desktop/api.ts](../apps/desktop/src/api.ts) validates management API version **2** | Add typed optional capabilities and daemon-side verification operations |

The existing quota failover, pinning, model-specific limits, body bounds, stream cancellation, and coordinated token refresh are foundations to extend. They are already covered by focused tests in `pool.test.ts`, `codex.test.ts`, `runtime.test.ts`, and `credentials.test.ts`; those tests were inspected, not run for this document-only review.

## Priorities

P1 means the next proxy improvement cycle. P2 follows once the P1 contracts are stable. P3 is a separate, optional product extension.

| Priority | Idea | Value | Relative scope |
| --- | --- | --- | --- |
| P1 | Quota freshness and reset visibility | Know which subscriptions can serve the requested model and when capacity returns | Medium |
| P1 | Structured request diagnostics | Understand slow requests, account switches, and interrupted streams | Medium |
| P1 | Scoped cooldowns and bounded retry policy | Avoid repeatedly selecting unavailable accounts and excessive request waits | Large |
| P2 | Explicit routing strategies and session affinity | Control how simultaneous sessions share subscriptions | Medium |
| P2 | Model discovery, exclusions, and aliases | Avoid routing unsupported models to an account | Medium |
| P2 | Account verification and batch operations | Diagnose broken accounts and manage a larger pool efficiently | Medium |
| P2 | Configuration previews and inherited policy | Make routing changes deliberate and preserve concurrent edits | Medium |
| P1 foundation / P2 UI | Provider capabilities and feature boundaries | Give all the above one consistent contract across daemon, CLI, and app | Small initially |

### 1. Make quota freshness and reset times first-class — P1

**Inspiration:** The reference's [quota adapters][ref-quota], [Claude quota data][ref-claude-quota], [Codex quota data][ref-codex-quota], and [reset scheduling][ref-reset-schedule] separate provider parsing from presentation and expose multiple quota windows, plan details, and reset times.

**Adaptation:**

- Extend our `Provider` interface with an optional read-only quota fetch operation. Move the Claude-specific polling loop into a shared quota service and add a Codex adapter.
- Treat the reference's Codex `/backend-api/wham/usage` request as a candidate integration. Confirm account headers and response shapes with fixtures and a supported live client before enabling it. Keep undocumented endpoints and parsers isolated in provider modules.
- Represent windows with a stable ID, duration when known, reset time, and explicit scope: account-wide, model family, or exact model. Keep human labels separate from routing keys. Migrate existing `5h`, `7d`, and `7d:opus` names deliberately.
- Distinguish observed usage from inferred availability after a reset. A passed reset time permits reevaluation; the UI should not present an old observation as freshly measured zero usage.
- Expose observation time, observation source/node, last refresh result, and stale/unknown state. Retain last known values after a failed poll and show their age.
- Add **Refresh usage** for an account and provider. Use deduplicated work, bounded concurrency, timeouts, and daemon cancellation. Prefer the credential holder for background polling to reduce duplicate work across machines.
- Keep live-response observations authoritative over older polls. Preserve the existing rule that a late success cannot clear a still-active exhaustion mark, and do not resurrect deleted accounts after asynchronous work completes.
- Share one quota component between Accounts and Dashboard. Show the limiting window for a selected model, an absolute reset time, a countdown, and the next time an account becomes eligible after all relevant restrictions expire.

**Code:** `llm/pool.ts`, `llm/claude.ts`, `llm/codex.ts`, `daemon.ts`, store/protocol schemas, `Accounts.tsx`, and `Dashboard.tsx`.

**Acceptance:** Idle Codex accounts can report usage without inference traffic when the integration is supported. Missing or malformed data displays unknown/stale state. An exhausted Opus window leaves eligible Sonnet traffic available. Overlapping polls, deletion, shutdown, and live usage updates preserve the newer state. Reset displays and candidate selection agree for the same model.

### 2. Turn recent activity into useful request diagnostics — P1

**Inspiration:** The reference's [log stream][ref-log-stream], [bounded log buffer][ref-log-buffer], and [dashboard overview][ref-dashboard] provide searchable history, incremental loading, and traffic summaries.

**Current gap:** Our `ms` is measured before returning the response stream, so it describes time to response headers. A logged HTTP 200 does not establish that the stream completed. Free-form activity also mixes account-switch events with requests, making aggregate counts ambiguous.

**Adaptation:**

- Create a stable request ID and a child attempt ID for each account/retry. Store requested model, routed model, chosen account, selection reason, attempt number, HTTP status, sanitized failure category, and final request outcome.
- Record time to headers, time to first forwarded byte, and stream duration separately. Report these names accurately; first byte is not necessarily the first generated token.
- Add stream lifecycle callbacks around `streamBody()`: clean EOF, idle timeout, upstream error, and client cancellation. Provider adapters may identify completion/error events with a bounded incremental parser; preserve every forwarded byte and backpressure. Keep HTTP status and stream outcome separate.
- Emit one final request summary plus its attempts. A quota 429 on account A followed by success on B counts as one successful client request and two upstream attempts.
- Add management endpoints for filtered, cursor-paginated requests and request detail. Filter by time, provider, account, model, outcome, and failure reason. Define cursor behavior when retention removes older rows.
- Add an Activity view with follow/pause, search, and request detail. Keep the Dashboard preview compact. Reset caches when the managed daemon changes and ignore old in-flight responses.
- Derive success rate, fallback frequency, and latency summaries from completed request summaries. Retain raw history by both count and byte budget; define the aggregate window and any longer retention explicitly.
- Keep telemetry local to the serving node. Sanitize dynamic model/error strings, cap stored field lengths, and export only an allowlisted diagnostic record. Do not store prompts, full response bodies, tokens, arbitrary headers, or raw provider errors.

**Code:** `llm/pool.ts`, `runtime.ts`, `store.ts`, `api.ts`, protocol DTOs, `Dashboard.tsx`, and a proposed desktop Activity feature.

**Acceptance:** A successful fallback is traceable as one request. A stream that stalls after HTTP 200 ends with an interrupted outcome. Cancellation is distinct from provider failure. Pagination remains stable during concurrent writes and retention. Neither management responses nor diagnostic exports contain injected credential-like values or request bodies.

### 3. Separate failure classification, cooldown state, and retry budgets — P1

**Inspiration:** The reference exposes [credential/model cooldown snapshots][ref-cooldowns], [runtime policy inheritance][ref-runtime-policy], [request-scoped error actions][ref-error-rules], and [network retry controls][ref-network]. These are UI/API concepts; their backend execution was not reviewed.

**Adaptation:**

- Replace the narrow `classify429()` decision with provider-owned typed classification: quota exhaustion, short rate limit, invalid login, unsupported model, transient upstream failure, and permanent request failure.
- Represent cooldowns with account ID, scope/model, reason, retry time, and observation time. Share provider quota exhaustion through existing usage records; keep transport failures, local retry backoff, and circuit state node-local.
- Let all concurrent requests consult short rate-limit cooldowns so they do not repeatedly hit the same blocked account. Respect `Retry-After` as a minimum wait; if it exceeds the request budget, return an appropriate limit response instead of retrying early.
- Keep the existing defaults: quota 429 switches accounts, short rate limits retry the same account, and 401 permits one coordinated refresh before falling through. Add behavior for other failures only where a provider adapter establishes retry safety.
- Bound the complete pre-response operation: credential wait, header waits, rate-limit sleeps, authentication retry, and account changes. Separate same-account retry count, maximum accounts attempted, and total bootstrap wait. Keep stream idle limits separate from this pre-response budget.
- Define behavior for existing `whenExhausted: wait` installations during migration; preserve the documented bounded wait unless the user selects a different budget.
- Apply jittered backoff within the remaining budget and propagate client/daemon cancellation through every wait and attempt.
- Retry only provider-recognized rejection responses where replay is safe. A network timeout before response headers can still have an uncertain upstream outcome. Do not automatically replay it just because no bytes reached the client.
- Once downstream response bytes are committed, terminate/report interruptions without switching accounts. Optional SSE bootstrap buffering needs a separate provider-specific design with byte/time caps and compatibility fixtures; it is not required for the initial implementation.
- Display cooldown reason, scope, expiry, and data freshness. A local backoff reset must remain distinct from clearing provider quota or an invalid-login state.

**Code:** extract policy and cooldown responsibilities from `llm/pool.ts`; extend provider adapters, `runtime.ts`, status schemas, and Settings/Accounts.

**Acceptance:** Concurrent requests honor the same local rate cooldown. A model restriction leaves other models usable. Retry count, elapsed wait, and account attempts stay within one budget. Invalid requests are not retried. An upstream timeout with an uncertain outcome is not replayed. Stream interruption never produces output from two accounts in one response.

### 4. Offer explicit routing strategies and optional session affinity — P2

**Inspiration:** The reference's [network settings][ref-network] expose round-robin, weighted round-robin, fill-first, and session-affinity controls.

**Adaptation:**

- Name our existing behavior **Automatic** and retain its defaults. Initially add **Priority first** and **Round robin** behind the same eligibility checks. Defer weighting until actual pool usage demonstrates a need.
- Extract a deterministic selector that returns the chosen account and reasons for rejecting alternatives. Expose a read-only route explanation for a provider/model without sending inference traffic or changing selection state.
- Add optional session affinity using a stable session identifier extracted by each provider adapter. Bound mappings by TTL and count, keep them node-local, and use Automatic when no supported identifier is present.
- Preserve the documented pin behavior: an eligible manually selected subscription applies to the next request across routed sessions. A disabled, deleted, quota-blocked, or invalid-login account cannot be kept eligible by an affinity entry.
- Track in-flight counts for diagnostics and later strategy evaluation. Do not impose a new concurrency limit as part of adding strategies.
- Identify requests tied to upstream account-specific state, such as continuation IDs. Verify which requests can survive an account change and return an explicit failure when they cannot; affinity alone is not a safe failover mechanism.

**Code:** `choose()`, `candidates()`, provider session extraction, protocol settings, Settings, and Accounts.

**Acceptance:** Selection is reproducible with a fake clock. Eligible pins retain precedence. Separate sessions maintain affinity when enabled. Expiry/deletion releases mappings. Unsupported IDs use existing routing. Stateful continuation fixtures cover both supported failover and refusal to replay across accounts.

### 5. Add model discovery, exclusions, and validated aliases — P2

**Inspiration:** The reference has [provider model discovery][ref-model-discovery], [model mapping validation][ref-alias-validation], and [excluded-model rules][ref-exclusions].

**Adaptation:**

- Add optional model discovery to provider adapters, with cached results and freshness. Verify each provider's discovery path with the credentials and client dialect we actually support.
- Allow explicit account model exclusions and inspect discovered availability. Missing discovery data should preserve current behavior unless the user configured a restrictive allowlist.
- Resolve optional aliases before candidate selection. Apply the resolved upstream model to quota scopes and exclusions, while recording both requested and routed names.
- Validate duplicate aliases according to provider model-ID semantics, reject cycles and ambiguous targets, and preview the resolved mapping. Avoid assuming all provider model IDs are case-insensitive.
- Show **No eligible account for this model** separately from **All eligible accounts exhausted**. Derive the advertised model list from actual configured eligibility where the client supports discovery.
- Keep model-family matching inside providers instead of the shared selector's current substring convention. Add fixtures for overlapping names and newly introduced model IDs.
- Keep automatic model substitution opt-in and out of the first delivery. Account failover should continue requesting the same model by default.

**Code:** provider adapters, `modelOf()`/`relevant()` in `pool.ts`, account/protocol schemas, and an Accounts model-policy editor.

**Acceptance:** Unsupported/excluded models skip the affected account without exhausting it globally. Aliases resolve deterministically before eligibility and request preparation. Unknown discovery state does not disable working accounts. Invalid mappings are rejected before saving.

### 6. Add account verification and careful batch operations — P2

**Inspiration:** The reference's [connectivity testing][ref-connectivity], [credential policy editor][ref-credential-policy], and [OAuth attempt lifecycle][ref-oauth-attempts] make provider status and asynchronous operations explicit.

**Adaptation:**

- Add daemon-side **Verify account**: credential validity/refresh status, read-only quota, and supported model discovery. Return a separate result for each supported check, including unsupported/unknown.
- Offer an explicit tiny inference probe for testing the actual proxy route. Show that it uses quota and route it through the same request machinery as a real client. A read-only quota check is not proof that inference works.
- Run verification on the configured daemon, including a remote managed node, so network results describe the machine serving requests. Use fixed provider operations; do not expose a generic authenticated HTTP request endpoint.
- Add bounded batch usage refresh, verification, and enable/disable operations with per-account results. Show partial failures instead of one generic success notification.
- Reuse `Credentials` and its holder/lease coordination for manual token refresh. Bind asynchronous results to account credential revisions and connection generations; ignore obsolete results after relogin, deletion, connection changes, or shutdown.
- Show a compact **Needs attention** list: invalid login, refresh failure, stale/unknown quota, model restriction, or active cooldown. Keep healthy accounts easy to scan.

**Code:** `credentials.ts`, account operations, `api.ts`, CLI account commands, native Accounts/Login components, and provider capabilities.

**Acceptance:** Remote verification runs on the remote daemon. Batch results accurately identify each failure. Overlapping refresh actions cannot bypass token leases. Reauthentication invalidates old results. Repeated or cancelled OAuth/verification attempts leave no timers or active work behind.

### 7. Preview configuration changes and support explicit inheritance — P2

**Inspiration:** The reference's [configuration document flow][ref-config-document] and [patch/rebase logic][ref-config-patch] preserve drafts, preview differences, and reread before saving. Its runtime and credential policies distinguish inheritance from explicit overrides.

**Adaptation:**

- Keep our typed SQLite-backed settings. Add a readable before/after preview for routing changes, including their scope and effective values.
- Preserve edited fields during five-second status polling. The current Settings form is keyed by serialized server settings; incoming changes should produce a conflict indicator instead of replacing a dirty draft.
- Return an opaque revision token for edited configuration. Check it transactionally when saving; return 409 for a stale draft and offer reload/reapply. Client-side rereads alone do not close the write race.
- Start with global defaults and a small set of optional account overrides, such as same-account retry count and model exclusions. Show **Inherit** separately from an explicit zero/false value. Add provider-level defaults only if the two-provider experience needs them.
- Submit changed fields through shared operations used by the CLI and API. Preserve unrelated configuration and reuse the same schema/effective-policy calculation everywhere.
- Label synchronized policy and node-local diagnostics clearly. Retain replica last-writer-wins behavior; a local revision check does not guarantee serialization across disconnected peers.

**Code:** `settingsSchema`/`accountSchema`, `operations.ts`, `api.ts`, Store revision access, `Settings.tsx`, and account editors.

**Acceptance:** Polling preserves unsaved edits. Two clients editing the same local record receive a clear stale-write result. Unrelated fields survive a patch. Inherit/zero/false round-trip correctly. Peer changes and offline conflicts follow the documented replica model.

### 8. Use typed capabilities and small feature boundaries — foundation

**Inspiration:** The reference's [quota adapter contract][ref-quota-contract] keeps data handling outside React. Its management UI also gates optional features on backend support.

**Adaptation:**

- Create one provider registry for Claude and Codex with typed optional operations: quota fetch, model discovery, session identity, account verification, failure classification, and stream observation. Reuse it in daemon routes, background tasks, login operations, CLI, and management handlers.
- Advertise provider capabilities plus daemon version/build information in a validated status or capability response. A missing capability means unsupported, not a healthy empty result.
- Keep API version validation. Bump the management version when required response/request contracts change; capabilities should govern optional features within a compatible version.
- Coordinate synchronized schema changes with peer/relay protocol and backup readers. Older nodes must not silently strip new routing policy fields and sync the reduced record back.
- Split the desktop into small quota, activity, and policy features using the existing UI components. Use pure parsing/policy helpers that can be exercised with fixtures without native UI or live providers.

**Acceptance:** Daemon, CLI, and app agree on supported operations. Incompatible versions fail before rendering or writing. Unsupported optional features have clear states. Adding a fake provider for tests does not require changes throughout the management UI.

## Refactor shape

Use the existing shared `proxy()` as the starting point. The provider/request boundary already exists; strengthen it as the feature batches land.

| Responsibility | Proposed home | Boundary |
| --- | --- | --- |
| Provider registry and contracts | `apps/agentgate/src/llm/providers.ts`; existing `claude.ts`/`codex.ts` | Provider-specific protocols, parsing, and optional capabilities |
| Eligibility, strategy, and explanations | `apps/agentgate/src/llm/routing.ts` | Deterministic selection from an explicit snapshot |
| Quota observations and polling | `apps/agentgate/src/llm/quota.ts` | Freshness, safe merges, scheduling, and scoped quota |
| Failure policy and cooldowns | `apps/agentgate/src/llm/policy.ts` | Retry decisions and node-local cooldown state |
| Request orchestration | Retain `apps/agentgate/src/llm/pool.ts` initially | Body read, credential acquisition, attempt budget, forwarding |
| Stream deadlines and callbacks | Existing `apps/agentgate/src/runtime.ts` | Transport lifecycle and cancellation |
| Request/attempt history | `apps/agentgate/src/llm/telemetry.ts` with Store integration | Local SQLite writes, finalization, queries, and retention |
| Management DTOs and policy schemas | Existing `packages/protocol` | Validated contracts shared by all clients |
| Quota/Activity/policy UI | Small features under `apps/desktop/src` | Presentation and connection-aware asynchronous state |

These are proposed extraction points, not mandatory files for the first PR. Keep operations transactional and HTTP handlers thin. Extract a module when its caller contract and tests are clear; avoid building a generic plugin framework for two providers.

Keep replicated account/policy/quota records separate from node-local attempts, affinity, transport cooldowns, and diagnostic aggregates. Introduce a versioned SQLite migration for telemetry and exercise upgrade/backup behavior. Refactoring must retain client-login passthrough/fallback, Claude identity rewriting, Codex account headers, cancellation, body bounds, and refresh coordination.

## Delivery order

1. **Contracts and behavior-preserving extraction.** Establish the provider registry, typed capability response, selection explanation, and structured failure vocabulary. Preserve current routing defaults. Decide telemetry migration and replicated-schema compatibility before adding fields.
2. **Useful visibility.** Add request/attempt IDs and stream finalization, quota freshness, shared quota presentation, and optional Codex quota polling. Deliver Activity queries/view and basic aggregate metrics. This is the first useful release.
3. **Runtime reliability.** Add shared scoped cooldowns, request-wide attempt/time budgets, and explicit retry safety. Connect their reasons and timings to Activity and Accounts.
4. **Operator workflow.** Add daemon-side verification, bounded batch operations, configuration revision checks, and draft/diff presentation.
5. **Routing controls.** Add alternate strategies, optional affinity, model discovery/exclusions, and validated aliases. Enable account overrides through the policy editor once their semantics are stable.

The implementation completes batches 1–5 above. Broad provider support and protocol translation remain separate work.

## Validation for implementation

- Run focused Bun tests and workspace typechecking for each batch. Use fake providers, temporary databases, controlled clocks, and saved/synthetic response fixtures for repeatable coverage.
- Preserve existing proxy regressions and add tests for request-versus-attempt counts, stream finalization, quota races, model scopes, cooldown concurrency, retry budgets, uncertain outcomes, affinity expiry, stale writes, and schema migrations as those behaviors change.
- Build the frontend after UI/protocol changes. Run native checks when a Tauri bridge command or allowlist changes; retain remote-management authentication and browser-request rejection.
- Verify backup restore and mixed-version peer behavior before shipping synchronized policy fields. Confirm diagnostic rows and node-local cooldowns do not enter peer/relay records or backups intended as configuration inventory.
- Before release, exercise the native app and real supported Claude/Codex clients: normal streaming, quota-triggered account change, original-login fallback, cancellation, long responses, concurrent sessions, remote management, and reconnecting paired nodes.
- Test any undocumented quota/model/session integration live before claiming support. Source inspection and fixtures establish implementation behavior, not provider acceptance or compatibility with every client release.

For the original planning change, Markdown/link validation was sufficient. The implementation now requires the application checks listed above; live/native release checks are explicitly recorded separately.

## Ideas to defer or omit

- **P3: API-key/OpenAI-compatible upstreams and additional providers.** The registry can accommodate them, but auth types, billing/fallback rules, response formats, client compatibility, and quota semantics need a separate plan. Add them when there is a concrete usage need.
- **Protocol translation, WebSocket forwarding, and live-media features.** These require a focused backend/client investigation; management settings alone are insufficient evidence for adopting their implementations.
- **Automatic model downgrade or reset-credit consumption.** Both change user-visible behavior; reset-credit actions may consume an account entitlement. Keep them out of automatic routing and routine quota refresh.
- **Browser management deployment and raw YAML editing.** Our native app, guarded management API, and typed SQLite records fit the current product. Reconsider a web UI as a separate feature with its own authentication design.
- **Browser secret obfuscation, generic authenticated HTTP calls, arbitrary payload rewrites, and user regex error rules.** Use our existing secret boundary and narrowly typed provider operations. Keep error classification auditable and provider-owned initially.
- **Large plugin systems and visual restyling.** Adopt useful workflows through existing components; they do not require changing the application's design system.

## Reuse and attribution

The reviewed repository is [MIT licensed][ref-license], copyright 2026 Router-For.ME. Concepts can inform our design. If we copy or substantially adapt source, preserve the applicable copyright and license notice with the copied material and record its pinned upstream path in an attribution file. Prefer small parsing/validation utilities after removing UI dependencies; do not import its management API client or frontend application wholesale.

[ref-quota]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/tree/752e0ee772220ce49aae1221a3f39f23236590d7/src/features/quota/providers
[ref-quota-contract]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/752e0ee772220ce49aae1221a3f39f23236590d7/src/features/quota/providers/types.ts
[ref-claude-quota]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/752e0ee772220ce49aae1221a3f39f23236590d7/src/features/quota/providers/claude/data.ts
[ref-codex-quota]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/752e0ee772220ce49aae1221a3f39f23236590d7/src/features/quota/providers/codex/data.ts
[ref-reset-schedule]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/752e0ee772220ce49aae1221a3f39f23236590d7/src/features/quota/resetSchedule.ts
[ref-cooldowns]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/752e0ee772220ce49aae1221a3f39f23236590d7/src/services/api/authFileCooldowns.ts
[ref-runtime-policy]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/752e0ee772220ce49aae1221a3f39f23236590d7/src/features/providers/runtimePolicy.ts
[ref-error-rules]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/752e0ee772220ce49aae1221a3f39f23236590d7/src/features/providers/errorRules.ts
[ref-network]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/752e0ee772220ce49aae1221a3f39f23236590d7/src/features/config/components/sections/SectionNetwork.tsx
[ref-log-stream]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/752e0ee772220ce49aae1221a3f39f23236590d7/src/features/logs/hooks/useLogStream.ts
[ref-log-buffer]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/752e0ee772220ce49aae1221a3f39f23236590d7/src/features/logs/model/logBuffer.ts
[ref-dashboard]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/752e0ee772220ce49aae1221a3f39f23236590d7/src/features/dashboard/hooks/useDashboardOverview.ts
[ref-model-discovery]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/752e0ee772220ce49aae1221a3f39f23236590d7/src/features/providers/sheets/forms/useModelDiscovery.ts
[ref-alias-validation]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/752e0ee772220ce49aae1221a3f39f23236590d7/src/components/modelAlias/aliasValidation.ts
[ref-exclusions]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/752e0ee772220ce49aae1221a3f39f23236590d7/src/components/excludedModels/excludedModelRules.ts
[ref-connectivity]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/752e0ee772220ce49aae1221a3f39f23236590d7/src/features/providers/sheets/forms/useConnectivityTest.ts
[ref-credential-policy]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/752e0ee772220ce49aae1221a3f39f23236590d7/src/features/authFiles/credentialPolicy.ts
[ref-oauth-attempts]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/752e0ee772220ce49aae1221a3f39f23236590d7/src/pages/oauthAttempts.ts
[ref-config-document]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/752e0ee772220ce49aae1221a3f39f23236590d7/src/features/config/hooks/useConfigDocument.ts
[ref-config-patch]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/752e0ee772220ce49aae1221a3f39f23236590d7/src/services/api/configPatch.ts
[ref-license]: https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/752e0ee772220ce49aae1221a3f39f23236590d7/LICENSE
