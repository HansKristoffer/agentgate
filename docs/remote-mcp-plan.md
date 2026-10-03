# Plan: remote MCP endpoints for Grok (and other URL-only clients)

Goal: a user creates a **virtual project** in Projects, picks MCP servers and skills for it, and gets:

- a URL on the relay: `https://agentgate-relay.hanskristoffer.dk/mcp/<key>`
- a secret, sent as `Authorization: Bearer <secret>`

They paste both into Grok. The relay forwards each request over a WebSocket that the **serving machine** keeps open (an always-on server by default, the Mac otherwise). That machine answers from its MCP gateway. Grok also gets built-in tools to list and read the project's skills, because skills can't be synced to Grok.

Reviewed by a second model (GPT-6.1-Sol, high); its accepted findings are folded in. See "Review changes" at the end.

**Status: implemented** (steps 1–7). Verified end to end against `wrangler dev`: initialize, notifications, tools/list, tool calls, skill reads, secret rotation and the offline case. Still open: step 0 against real Grok. Differences from the text below:

- The serving daemon, not the relay, rewrites `Accept`: it always answers JSON, so a client that only accepts JSON works.
- Remote calls are logged to `request_log` and appear in the app's recent activity (`/status.activity`), not in the Activity screen's request list.
- Deleting a virtual project also queues deletion of its relay endpoint.

## Constraints that shape the design

- **Nodes only poll the relay today** (`relay.ts`: push on change, pull every 15 s). The relay can't reach a node, so the serving node opens a persistent outbound WebSocket to a Durable Object (Hibernation API: an idle socket costs nothing, pings are answered without waking the object).
- **The relay can read this traffic.** Grok's TLS ends at Cloudflare. The relay sees tool arguments, results **and the bearer secret**, so a malicious relay operator could impersonate Grok or replay calls. Upstream logins and API keys never leave the serving node. This is a new, opt-in exception to the relay's end-to-end model and must be documented as such.
- **Only `shared` MCP instances can be served.** `perSession` instances start inside a worktree (`/api/shim`); a remote client has none.
- **An instance that works on one machine may not work on another.** Shared stdio servers inherit the node's PATH and environment; an HTTP server can point at `localhost`. So v1 has **one explicitly chosen serving node per endpoint** instead of automatic multi-node routing.
- **Older daemons can't safely sync new data.** An unknown record kind fails `recordSchema` (`store.ts:90`), and Tailscale pulls parse a whole page before committing its cursor (`sync.ts:89`), so one new-kind record would stall sync on an old node. Old nodes also strip unknown project fields when parsing, and an edit there would drop them under a newer revision. Hence: **no new record kind**, and an enforced version gate (step 1).

## Decisions

| Question | Decision | Why |
|---|---|---|
| Session handling | **Stateless** Streamable HTTP with JSON responses (`sessionIdGenerator: undefined`, `enableJsonResponse: true`), fresh server + transport per request, POST only | One request, one response: no sticky sessions, no SSE through the tunnel. Progress notifications are lost. |
| Virtual project model | Reuse the `project` record, id `@<slug>`, new optional field `remote` | MCP checklist, skill assignment (`project.skills`), `aliasesFor` and `PUT /projects` keep working. GitHub owners can't start with `@`. |
| Relay addressing | **One Durable Object per endpoint**, named by its random `key` (`getByName(key)`) | No group/tunnel singleton to provision or race over (two offline nodes creating different tunnels). Nothing to route between nodes. |
| Who serves | `remote.servedBy`: one node, defaulting to an always-on node, else the node that enabled it. Changeable in the UI | Readiness differs per machine; one socket per endpoint keeps the relay trivial. |
| Authoritative secret | The relay stores `sha256(secret)` and `sha256(token)` for the endpoint, set by the serving node | Rotation/disable take effect at the relay even if a stale node keeps advertising old values. |
| Revocation after unpairing | **Regenerate the endpoint**: new key, secret and token, new DO; delete the old DO. The URL changes | Every synced credential is known to the removed machine, so any "rotate with the old token" scheme can be raced. A fresh endpoint it never learned can't be. Same reasoning as `relay rotate`. |
| Skills | Built-in in-process source, alias `skills`: `skills__list`, `skills__read`, through `InMemoryTransport` | Plugs into `mergedServer` like any other source. |

## Shape

```
Grok ──POST /mcp/<key>, Bearer <secret>──▶ Worker ──▶ RemoteEndpoint DO (one per key)
                                                        │ checks sha256(secret)
                                                        │ hibernatable WebSocket (opened by the serving node)
                                                        ▼
                                            serving node: Gateway.handleRemote("@grok", request)
                                                          → shared MCP upstreams + skills source
```

## 0. Grok compatibility probe (before building anything else)

Build step 2 first, expose it temporarily with `cloudflared tunnel --url` or `tailscale funnel`, and point Grok at it. Record:

- the request sequence (`initialize` → `notifications/initialized` → `tools/list` → `tools/call`), and whether Grok ever sends GET or DELETE;
- the `Accept` header. The SDK's JSON mode still requires **both** `application/json` and `text/event-stream` (`webStandardStreamableHttp.js:465`). If Grok sends only JSON, the relay rewrites `Accept` before forwarding;
- that it accepts empty `202` responses to notifications (`webStandardStreamableHttp.js:573`), the `mcp-protocol-version` it uses, and its per-call timeout.

If Grok requires an SSE stream, the tunnel needs streaming frames (`head`/`chunk`/`end`) instead of a single `res`. Decide this before step 3.

## 1. Protocol and data (`packages/protocol`, `store.ts`, `operations.ts`)

- `PROJECT_ID`: also accept `^@[a-z0-9][a-z0-9-]{0,63}$`; add `isVirtual(id)`. Update the desktop repository-only input pattern.
- `projectSchema.remote` (optional): `{ key: base64url(16 B), secret: base64url(32 B), token: base64url(32 B), enabled: boolean, servedBy: nodeId }`.
- Virtual projects never inherit `*`: enforce in `aliasesFor` and `saveProject` (both currently default `inheritDefaults` to true, `operations.ts:100`, `api.ts:434`), not just in the UI.
- Reserve the alias `skills` on virtual projects (`saveProject`). At serve time a collision skips the built-in source and logs it, rather than throwing on a duplicate tool name (`gateway.ts:132`).
- Skip virtual ids in checkout registration (`/api/checkout`, `skills.register`) and the skill linker.
- **Version gate.** Each node writes `protocol: 2` into its own `node` record. Old nodes ignore the field and never rewrite other nodes' records. `POST /projects/remote` refuses while any non-deleted node record lacks it: "Update agentgate on `srv` first."
- **Secrets never leave through ordinary responses.** `/status` and `PUT /projects` return `remote` as `{ enabled, servedBy, url }`. `exportBackup(s, false)` strips `remote.secret`/`remote.token` like `publicMcp` does for MCP records (`store.ts:325`).
- `packages/protocol/src/remote.ts`: zod schemas for the WebSocket frames, shared by relay and daemon:
  - relay → node: `req { id, headers, body }`, `cancel { id }`
  - node → relay: `res { id, status, headers, body, retry? }`
- Limits, in one place: request body 256 KiB, response body 4 MiB, 4 in-flight requests per endpoint, 10 min per request, JSON-RPC batches rejected (the SDK otherwise accepts up to 100 messages per POST).

## 2. Gateway: stateless remote handler + skills source (`mcp/gateway.ts`, new `mcp/skills.ts`)

- `Gateway.handleRemote(project, req, signal)`: reject arrays (batches) and non-POST methods, then build a `mergedServer` and stateless transport for this request. Sources are `this.sources(project)` limited to `shared` instances, plus the skills source.
- **Cancellation must be wired by hand.** Aborting the `Request` does not stop SDK handlers (confirmed against SDK 1.31.0). Pass `signal` into `mergedServer` so `invoke` combines it with `extra.signal` for upstream `callTool`; race the response against `signal`; close the server, transport and skills client in `finally`, including when setup fails part-way.
- **Report missing sources.** `sources()` silently drops a source that fails to connect (`gateway.ts:241`). For remote endpoints, `tools/list` adds no fake tools; it records the failed aliases so the UI can show "linear: not reachable on srv".
- No route cache at first. Each `tools/call` re-lists upstream tools because the server is per-request; measure before caching.
- Skills source (`mcp/skills.ts`), reading **current** records on every call (an assignment removed mid-request stops working):
  - `skills__list { cursor? }` → up to 100 `{ id, description }` per page (description cut to 1 KiB), plus `nextCursor`.
  - `skills__read { id, path = "SKILL.md", offset = 0 }` → the file's text, at most 128 Ki characters per call with `nextOffset` (offsets count characters of the decoded UTF-8 text). The first read of `SKILL.md` also lists the bundle's file paths, capped at 500. Binary files return an error with the file type. Only ids assigned to the project are readable; paths go through `safePath`.
  - Server instructions: "Call skills__list, then skills__read a relevant skill's SKILL.md and follow it. Read the files it references with skills__read."
- Tests (`test/remote.test.ts`, with `test/fixtures/mcp.ts`): list and call; perSession excluded; batch and GET rejected; abort cancels the upstream call; skills paging, traversal, unassigned skill and mid-request unassignment.

## 3. Relay: `RemoteEndpoint` Durable Object (`apps/relay/src/remote.ts`, `index.ts`, `app.ts`, `wrangler.toml`)

Routes:

| Route | Auth | Purpose |
|---|---|---|
| `PUT /e/:key` | first call stores `sha256(token)`; later calls need `Bearer token` | Create, or update `{ secretHash, enabled }`. Creation takes an admission slot (reuse `AdmissionCore`, own `RELAY_MAX_ENDPOINTS` cap). |
| `GET /e/:key/connect` | `Bearer token` | WebSocket upgrade from the serving node. |
| `DELETE /e/:key` | `Bearer token` | Close sockets, wipe, release the slot. |
| `POST /mcp/:key` | `Bearer secret` | Public MCP endpoint. Other methods → 405. |

The key is 128 random bits, so "first `PUT` wins" is safe: nobody can claim a key they haven't been given.

Behaviour:

- Storage: `meta(tokenHash, secretHash, enabled, lastActive)`. The connected socket's attachment is `{ connId, node, since }` (well under the 2 KiB limit; no tags, since node names allow 512 characters and tags 256).
- **One socket per endpoint.** Accepting a new connection closes older ones; close handlers act only when their `connId` is still current, so a late close can't drop its replacement. The constructor rebuilds state from `ctx.getWebSockets()` after hibernation.
- Public request, in this order: method and key shape → IP limit → secret hash (constant time, failed attempts rate-limited per IP) → `enabled` → a connected socket (else 503 "serving machine offline") → in-flight cap → **then** read the body (256 KiB, with a read deadline) and reject arrays.
- Forward only `content-type`, `accept` (rewritten if step 0 requires it) and `mcp-protocol-version`. The relay already checked the secret, so it isn't forwarded. Return only `content-type`, plus the status and body; an empty body stays empty. Never log bodies or headers.
- Pending requests live in an in-memory map keyed by `id` **and** bound to the socket they were sent on; a `res` from another socket is ignored. While a request is pending the object stays awake (billed duration), which is expected. Timeout or socket close fails the pending request with 502 and **no replay**: a `tools/call` is not safe to repeat. `retry: true` (node at capacity) returns 503 with `Retry-After`.
- Bound socket traffic: nodes only ever send `res` frames, so anything else closes the socket; frames are size-capped and rate-limited per socket.
- `setWebSocketAutoResponse("ping" → "pong")`.
- Retention alarm: delete after `RELAY_RETENTION_DAYS` with neither a public request nor a connected socket. The alarm checks for a live socket before deleting.
- Migration `v2`: `new_sqlite_classes = ["RemoteEndpoint"]`, binding `ENDPOINTS`.
- Tests (vitest-pool-workers): wrong secret, disabled, no socket, cap; body never read before authentication; batch rejected; reconnect replaces the old socket and its late close is harmless; timeout and close → 502 without replay; hibernation round trip; DELETE closes sockets.

## 4. Daemon endpoint client (new `apps/agentgate/src/remote.ts`, wired in `daemon.ts`)

- For each project with `remote.enabled && remote.servedBy === s.nodeId`, keep one socket open to `wss://…/e/<key>/connect` (`Authorization: Bearer token`). Other nodes open nothing.
- Before connecting, and whenever `secret`, `enabled` or `token` changes in the record, `PUT /e/:key` so the relay's hashes match. Persist "pushed" per key in `s.local`, and retry with backoff until acknowledged. `/status` reports an endpoint as "updating" until then.
- Ping every 30 s; reconnect with jittered backoff (1 s → 60 s) after 60 s without a pong or on close.
- The 1 s change watcher starts and stops sockets as projects change (enable, disable, a new `servedBy`).
- On `req`: call `ctx.gateway.handleRemote(project, request, signal)` directly, never through the HTTP listeners, so loopback trust can't be borrowed. `cancel` and socket close abort `signal`. Over 4 in flight → `res { status: 503, retry: true }`. Cap the response at 4 MiB (413 beyond that).
- Keep `{ connected, error, failedAliases, lastCall }` per endpoint in memory for `/status`.
- `stop()` aborts in-flight requests and closes sockets before the store closes (next to `stopRelay`).
- Tests: a fake relay WebSocket server in `bun test`: requests answered, cancel aborts, cap → retry, reconnect, sockets follow `servedBy` and `enabled`, hashes re-`PUT` after a secret rotation.

## 5. API and CLI

API (`api.ts`). Every route that returns or changes a secret is loopback-only, like `pair --relay`:

- `PUT /projects` accepts `@` ids; mcp/skills editing is unchanged.
- `POST /projects/remote { id, servedBy? }` → enable (applies the version gate), returns `{ url, secret }`.
- `GET /projects/remote?id=` → `{ url, secret, enabled, servedBy }`.
- `POST /projects/remote/secret { id }` → new Grok secret; same URL.
- `POST /projects/remote/regenerate { id }` → new key, secret and token (new URL); the old DO is deleted best-effort.
- `DELETE /projects/remote?id=` → disable (relay `enabled: false`), project kept.
- `/status` gets per-endpoint `{ url, servedBy, connected, updating, error?, failedAliases }` from the serving node, or "served by `srv`" from the others.
- **Unpairing** (shared code used by `DELETE /nodes/:id` and `agentgate unpair`; today it only removes the peer row, `sync.ts:173`): regenerate every enabled endpoint, move endpoints served by the removed node to this node, and return the endpoints whose URL changed so the user updates Grok.

CLI (`cli.ts`):

```sh
agentgate project set @grok posthog=posthog-lullu linear=linear
agentgate skills projects release-notes @grok
agentgate remote enable @grok [--node srv]   # prints URL and Authorization header
agentgate remote show @grok
agentgate remote secret @grok                # new secret, same URL
agentgate remote regenerate @grok            # new URL and secret
agentgate remote disable @grok
agentgate remote status
```

## 6. Desktop app (`Projects.tsx`, `Skills.tsx`)

- Projects: a **Virtual projects** section with **New virtual project** (name → `@slug`). The edit form reuses the MCP checklist without `perSession` servers, and adds a skills checklist. No "inherit defaults" toggle.
- Under each virtual project's row on the Projects page (no dialog): URL and `Authorization` value with Copy, reveal/hide secret, **New secret**, **New URL**, **Disable**, a **Served by** picker (always-on nodes first), and status: "Connected", "srv is offline", "linear: not reachable on srv".
- Card warning: "Requests from Grok, including the secret, are encrypted in transit but readable by the relay. Your logins stay on your machines."
- Skills: virtual projects appear in the project picker automatically.
- Remote management: secret controls are disabled with "Run this on that machine".

## 7. Docs

- README: "Use your MCP servers in Grok" in three steps.
- `docs/relay-plan.md` threat model and `docs/operations.md`: the relay can read endpoint traffic and the secret (it can impersonate or replay); URL + secret is a capability for those tools; unpairing regenerates URLs; `relay rotate` does not affect endpoints; every node must run a version with `protocol: 2`.

## Order

0. Grok probe with step 2 behind a temporary tunnel
1. Protocol + data model + version gate + secret sanitizing
2. Gateway `handleRemote` + skills source + tests
3. Relay `RemoteEndpoint` + tests
4. Daemon endpoint client + tests
5. API + CLI (unpairing included)
6. Desktop UI
7. Docs; end-to-end check with Grok on the hosted relay

Steps 1–2 are needed for the probe; 3 and 4 can then run in parallel. Each step is its own PR.

## Skipped on purpose

- Automatic multi-node routing and failover: add when one serving node per endpoint isn't enough, together with per-node readiness reporting.
- Streaming and progress notifications: add frames if step 0 shows Grok needs them.
- Route caching: add after measuring per-call listing cost.
- Remote calls in the Activity screen: Activity reads proxy telemetry (`/requests`), not `request_log`. Add a remote source there when someone needs call history; until then the card shows the last call.
- Per-tool allowlists, MCP resources/prompts for skills.

## Review changes

Accepted from the review:

- Revocation by regenerating the endpoint instead of rotating with a shared token (a removed machine could race the rotation).
- Secrets removed from `/status`, `PUT /projects` responses and no-secret backups; every secret route loopback-only.
- Relay-side authoritative secret hash and enabled flag, so stale nodes can't keep an old secret alive.
- No new record kind, plus an enforced `protocol: 2` gate, because unknown kinds stall Tailscale sync on old nodes.
- Explicit cancellation wiring and cleanup (the SDK doesn't cancel handlers when the request aborts).
- Batches rejected, lower in-flight caps, authenticate before reading the body, bounded frames.
- Durable Object reconnect race and hibernation reconstruction handled by `connId`; retention checks live sockets.
- One explicit serving node instead of "any online node", since instances may only work on one machine.
- `inheritDefaults` and the `skills` alias enforced on every creation path; virtual ids skipped in checkout registration.
- Grok probe moved first, including the SDK's `Accept` requirement and empty 202 responses; route cache dropped.
- Skills listing paginated, current records read on each call.
- Warning text and threat model corrected; no promise of Activity integration.

Changed from the review's suggestion: it proposed separate admin and node credentials with generation-based revocation. Regenerating the endpoint gets the same result with less code, at the cost of a new URL after unpairing.
