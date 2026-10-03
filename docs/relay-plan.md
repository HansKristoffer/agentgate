# Plan: sync through a Cloudflare relay

Goal: two agentgate nodes sync without being on the same tailnet. Each node makes outbound HTTPS calls to a Cloudflare Worker, and the nodes authenticate with a shared secret. The Worker only stores ciphertext.

When you connect a new computer, you choose how it connects:

- **Same network (Tailscale):** today's `pair` / `join` with a 10-minute code. Unchanged.
- **Agentgate relay:** works across any network. It uses the relay we host by default, or a self-hosted Worker.

Both are always available, in the CLI and in the app. A node can use both at once: it syncs with some machines over Tailscale and with others over the relay, and the records still converge.

## Why a mailbox fits the existing sync

- Records are last-writer-wins by `(rev, updated_at, node)` (`store.ts` `newer`), and `merge` is idempotent. Receiving a record twice, or out of order, is harmless.
- Each node has a monotonic change feed, `s.changes(since)`. Records merged in from other nodes get a new local `seq`, so a node's feed also carries what it learned from others.
- Deletions are kept as tombstones and never purged. The set of `(kind, id)` keys only grows, so "latest version per key" never loses anything.

So the relay doesn't need sync logic. It only needs to hold the latest encrypted version of each record that each node has pushed, and to hand out everything newer than a cursor.

## Shape

```
node A ──push sealed records──▶ Worker ──▶ Durable Object (one per group, SQLite)
node B ◀──pull since cursor───            entries(node, key, seq, blob)
```

- **Group**: the set of nodes that share one secret. One Durable Object per group.
- **Generation**: a random 128-bit identifier, encoded as lowercase hex, created with the group and replaced whenever its storage is recreated. Cursors are `(generation, seq)`, so a reset is detectable even if the new counter has already passed an old cursor.
- **Entry**: `(node, key) → (seq, pusherSeq, blob)`.
  - `node` is the pushing node's id, in clear text.
  - `key` is `HMAC(macKey, kind + "\0" + id)`, so the relay never sees kinds or ids.
  - `pusherSeq` is a client-assigned counter for this `(node, key)` within the generation, authenticated with the blob.
  - `blob` is the AES-GCM sealed `Rec` JSON.
  - `seq` is a counter per group, assigned by the Durable Object on every upsert.
- **Upsert** replaces the entry with the same `(node, key)`. Within a generation, a lower `pusherSeq` is rejected; an identical retry with the same counter and blob is a no-op. Reusing a counter with different ciphertext is a conflict. Accept a push batch atomically.
- **Storage** grows at roughly nodes × records, including tombstones. Replacing entries avoids an append-only log, but group quotas and inactive-group retention still bound growth.
- **Pull** returns entries in ascending relay `seq`, normally excluding the caller. Each response has `nextCursor`, `headSeq`, and `more`; only `nextCursor` advances the client's cursor. Reconciliation can include the caller's entries.
- **Pagination** reads each page from one SQLite snapshot. When `more` is true, `nextCursor` is the last returned entry's `seq`; when false, it is that page's `headSeq`, including sequences belonging only to the caller. Concurrent upserts move entries forward, so an entry replaced between pages is either already read or appears on a later page. No cross-page frozen snapshot is required.

## Crypto (all in the daemon, WebCrypto; no new dependency)

The user holds one value, an invite string: `agr1.<base64url(relayUrl)>.<base64url(32 random bytes)>`. Derive keys from the decoded 32-byte secret with HKDF-SHA256, a fixed protocol salt `agentgate-relay-v1`, and distinct `info` labels prefixed with `agentgate-relay-v1/`. Specify output lengths and publish deterministic test vectors. The URL selects the endpoint; it is not key material. Require HTTPS, reject credentials/query/fragment in the URL, and reject redirects for authenticated requests. Allow HTTP only through an explicit local-development option.

| Derived value | Use |
|---|---|
| `groupId` (hex, 16 bytes) | Durable Object name, in the URL path |
| `authToken` (base64url, 32 bytes) | `Authorization: Bearer` on every relay request |
| `encKey` (AES-GCM 256) | Sealing records |
| `macKey` (HMAC-SHA256) | Entry keys |

- The wire envelope is `{ key, pusherSeq, blob }`; pulls also supply `node` and relay `seq`. `blob` is base64url of a random 12-byte nonce followed by AES-GCM ciphertext and its 16-byte tag. AAD is UTF-8 JSON of the fixed array `[1, groupId, generation, node, key, pusherSeq]`, avoiding ambiguous string concatenation. Relay `seq` is routing metadata and is not authenticated by the client.
- Track the highest authenticated `pusherSeq` per `(generation, node, key)`, rather than one high-water mark per node. Entries for different keys can be processed independently. Ignore equal or lower counters; update replay state only after successful decryption and record validation, in the same transaction as merges and the pull cursor.
- `pusherSeq` is a positive safe integer, independent of the store `seq` and wall clock. Allocate `max(local counter, authenticated counter recovered from the relay) + 1` per key. Persist the allocated counter and exact pending envelope before sending it; retries reuse those bytes. A crash must not reuse a counter for different ciphertext.
- On startup or database restore, reconcile the full relay contents, including this node's entries, before allocating new counters or uploading a snapshot. This recovers counters and newer records that are absent from a restored database. Wall-clock arithmetic cannot guarantee monotonicity after a restore or clock rollback. If local replay history and the relay's copy are both lost or hidden, freshness cannot be proven; report unrecoverable counter conflicts and require rotation if necessary.
- After decrypting, run `parseRecord`, verify that recomputing the HMAC of `(kind, id)` matches the envelope key, then call `s.merge`. A malformed or undecryptable entry is skipped with a persistent diagnostic; valid entries still merge and the page cursor advances. A page with skipped entries must not clear that diagnostic. `relay reconcile` retries a full read after repair or upgrade.
- Group creation stores `sha256(authToken)` atomically. Subsequent reads, writes, and deletion must match it. Unknown groups return 404 on reads; reads do not create groups. Reject protocol and envelope-shape errors before mutation.
- What the relay can see: node names, record counts and sizes, and timing. It can't see kinds, ids, credentials or config.

## Threat model

Even someone with full access to the relay can't read tokens. That covers the Worker's owner, Cloudflare, anyone who can read the Worker's logs, and anyone who dumps the Durable Object's storage. The relay only ever receives `authToken`, which is HKDF-derived and one-way, so it doesn't reveal `encKey`. A brute-force attack on a 32-byte secret is infeasible.

What the relay **can** do:

- **See metadata:** node names, record counts and sizes, and timing.
- **Take the group down:** drop data or stop answering. Nodes then keep working from their local copy, the same as when a peer is offline.
- **Replay old blobs:** serve an older, genuinely sealed version of a record. Persisted per-entry counters reject versions already observed, and last-writer-wins protects records already newer locally. A fresh joiner or a restored database can lack both histories and accept stale credentials or config. The relay can also hide newer records, tombstones, or recovered counters. Generation identifiers detect honest storage resets; they do not prove freshness against a malicious relay. Stronger freshness guarantees need an authenticated checkpoint obtained from a trusted member, which is out of scope.
- **Forge status metadata:** `seen`, group generations, and relay sequence numbers are supplied by the relay. Heartbeats are availability hints, not proof of membership or successful sync. False heartbeats can delay credential-holder failover; this is part of the relay's ability to disrupt availability.
- **Keep old ciphertext indefinitely.** There is no forward secrecy. If the invite leaks later, everything the relay ever stored can be decrypted. After a suspected leak, run `relay rotate` and also re-login to the affected accounts.

What this design does **not** protect against:

- **Whoever ships the daemon binary.** An update could send the secret anywhere. This is trust in the release pipeline, not in the relay.
- **The invite string itself.** It is the master key. Keep it out of chat logs, issue trackers and hosted web forms. The app sends it only to the explicitly selected, trusted daemon when joining; it must never send it to the hosted relay or telemetry. `POST /nodes/pair {method:"relay"}` is loopback-only.
- **Any member node.** All members are equally trusted. Any of them can read and write everything, the same as with pairing today.
- **Access through another transport.** Rotating the relay secret does not revoke Tailscale pairing, indirect access through another member, or credentials already copied to a removed machine. For revocation, remove every Tailscale path from the removed machine to retained members before rejoining them to the new relay group. After compromise, also revoke or rotate the affected provider credentials.

## Relay API (`apps/relay`, Hono on Workers + a SQLite-backed Durable Object)

| Route | Body / response |
|---|---|
| `POST /g/:group` | `{ protocol }` → `{ protocol, generation, headSeq }`; creates the group or returns its existing generation, subject to creation quotas |
| `POST /g/:group/push` | `{ protocol, generation, node, entries: [{ key, pusherSeq, blob }] }` → `{ protocol, generation, headSeq }` |
| `GET /g/:group/changes?generation=G&since=N&node=X&includeSelf=0` | `{ protocol, generation, nextCursor, headSeq, more, entries: [{ node, key, seq, pusherSeq, blob }], seen: { [node]: ms } }`; `includeSelf=1` is used for full reconciliation |
| `GET /g/:group/nodes` | `{ protocol, generation, nodes: [{ node, lastSeen }] }`, used by `join` to detect a name clash |
| `DELETE /g/:group` | Wipes the group. Used by `relay rotate` / `relay leave --wipe` |

- A stale generation or a cursor above the current head returns 409 with the current generation and `resetRequired: true`, without entries or mutations. An initial full read may omit `generation` only with `since=0`. A group missing after deletion or retention returns 404. Clients create it explicitly and reconcile both directions; they do not just reset the pull cursor.
- Within each page, `0 <= nextCursor <= headSeq`; entries have strictly increasing `seq`, above the requested cursor and at most `nextCursor`. A page with `more: true` must make progress. Bound the number of pages per sync turn and resume from the committed cursor so a continuously changing group cannot monopolize the daemon.
- `seen` records the last authenticated push or pull time of each node. The daemon stores separate `relaySeen:<node>` hints and feeds clamped, non-future timestamps into existing `seen:<node>` keys, so `lastSeen` / `online` continue to work. Bound the group to 64 node identities, including heartbeat-only identities. A name-clash check is advisory; identical names and cloned databases are unsupported concurrent publishers and must get an actionable conflict error.
- **Byte limits:** at most 500 entries per push, 1000 per pull, 1 MiB decoded sealed blob per entry, and 8 MiB of serialized JSON per request or response, including base64 expansion and metadata. Clients chunk by both count and actual serialized bytes; servers enforce body bounds while reading. An oversized local record blocks its upload checkpoint and reports its kind/id locally; it is never silently skipped. This is stricter than the existing store's record limit and must be documented.
- **Storage limits:** account for replacement size changes atomically and cap entries plus bounded metadata at 50 MiB per group. Reject a batch that exceeds quota without partial writes. Return 413 for byte limits, 409 for generation/counter conflicts, 429 with `Retry-After` for rate limits, and 507 for storage quota exhaustion. Pull remains available when uploads are rejected.
- Optional `RELAY_KEY` Worker secret: when set, every route must also check `x-relay-key` before group lookup or creation. Clients configure it with `AGENTGATE_RELAY_KEY` or a loopback-only configuration field, stored locally and redacted from status/logs. It is deliberately absent from the invite; each joining machine configures it separately.
- **Our hosted relay:** deploy it with `bun run --filter @agentgate/relay deploy` (wrangler), on the same Cloudflare account as the site. Its URL is baked into the binary as `DEFAULT_RELAY_URL` (e.g. `https://relay.agentgate.dev`).
  - `RELAY_KEY` stays unset. Before public deployment, implement a shared admission counter with a hard configurable maximum of 1000 active groups; reserve a slot atomically before initializing a group and release it after deletion. Combined with the per-group cap, this bounds retained group storage to roughly 50 GiB plus admission metadata.
  - Apply configurable rate limits to creation, reads, writes, deletion, and failed authentication, rather than just pushes. Initial defaults: 5 new groups per source IP per day and 600 requests per group per minute. Validate route identifiers, protocol, and body bounds before creating group storage. Configure aggregate request throttling, usage alerts, and an operator switch to disable new groups; the storage cap alone does not bound request costs.
  - Expire groups after 180 days without a successful authenticated request. Document this retention limit, make it configurable for self-hosting, and release admission slots only once deletion completes. Returning nodes recreate an expired group and fully reconcile. Local records and tombstones remain retained.
- **Self-hosting:** use `--relay-url <url>` or `AGENTGATE_RELAY_URL` for the same Worker on your own account.
- Either way, the invite string carries the URL, so a joining machine doesn't need to know which relay is used.

## Daemon changes

New file `apps/agentgate/src/relay.ts`, with separate helpers for crypto, transport, and persisted sync state:

- `parseInvite`, `deriveKeys`, `seal`, `open`.
- `relayPush(s)`:
  1. For incremental upload, require completed reconciliation for the current invite and generation. The reconciliation upload phase uses the same chunk/pending-envelope machinery. Read `s.changes(relay:pushed)` from its existing snapshot; a defensive `pushed > s.seq()` check schedules full reconciliation, but is not restore detection.
  2. Allocate counters and persist pending envelopes and their exact source-store checkpoint in a transaction. POST chunks bounded by count and serialized bytes. A lost response is retried with the identical envelopes.
  3. After each acknowledged chunk, commit its source checkpoint and remove its pending envelopes atomically, only if the active invite/generation still matches. Advance to the snapshot head only once all its records are acknowledged; never use a later `s.seq()` that includes writes made during upload.
- `relayPull(s)`:
  1. GET a page for `relay:generation` and `relay:cursor`, enforce response byte bounds, validate the protocol and pagination fields, and decrypt/validate its entries outside the store transaction.
  2. In one `s.transaction`, check that the active invite/generation still matches, merge valid records, persist their replay counters, and save `nextCursor`. Do not save `headSeq` in place of a continuation cursor.
  3. Update bounded heartbeat hints and retain any skipped-entry diagnostic. Track push and pull errors separately; a successful pull must not hide a failed upload. Continue while `more` is true up to the per-turn work budget.
  4. A 404 or reset response schedules reconciliation and clears both upload and download checkpoints for that generation, not just the download cursor.
- `relayReconcile(s)` runs on every daemon startup, first join, explicit `relay reconcile`, and group reset. A whole-database rollback also restores the saved upload checkpoint, so it cannot be detected by comparing two values in that database. Startup reconciliation is required even when those values look consistent.
  1. Authenticate/create the group and read all pages from zero with `includeSelf=1`. Merge newer records and recover authenticated counters, including this node's own entries. In-process retries resume persisted progress. On process startup, restart the full read even if the saved phase says uploading: that phase may itself have been restored from a backup. Preserve pending envelopes until the recovered counters determine whether they can be reused. If the generation changes, restart reconciliation.
  2. Discard superseded pending envelopes, reset `relay:pushed` to zero, and upload the complete current store, including tombstones, with fresh counters. Reuse valid pending envelopes only when their generation and recovered counters still allow it.
  3. Mark reconciliation complete after the snapshot is acknowledged, then resume incremental sync. Local writes during reconciliation remain in the feed and are uploaded afterwards. Healthy peers' existing last-writer-wins state protects their newer records; a restore cannot reconstruct deletion history absent from every surviving copy.
- All state is node-local and never synced: `relay:invite`, optional service key, generation, pushed/cursor checkpoints, reconciliation phase, per-entry send/receive counters, pending envelopes, separate push/pull errors, and pending rotation/cleanup state. Use the `local` table or dedicated local tables for per-entry state; never put the invite or service key in records, backups intended for sharing, status, or errors.

Wiring in `daemon.ts`:

- In the existing 1 s change watcher, request `relayPush` next to `poke(s)`. The 15 s timer requests `relaySync`, which attempts push and pull independently; a failed upload must not suppress downloads.
- Use one shared coordinator per store for watcher, timer, credential recovery, and API operations. Serialize relay mutation and reconciliation through it; separate `serialTask` wrappers on each caller are insufficient. All daemon, API, and CLI relay operations acquire the same renewable cross-process store lease. Leave/rotate drain or cancel in-flight work before switching state, and completion handlers verify the active configuration before committing checkpoints.
- Introduce a transport-neutral `syncAll(s)` for Tailscale pulls and relay sync, with independent errors. Use it in `makeCtx`'s `Credentials` callback and `refreshMcp`'s recovery callback, which currently call only `pullAll`. Deliver refresh requests and newer credentials over the relay as well as over Tailscale.
- Apply finite request/body timeouts, bounded retries with jitter and `Retry-After`, and daemon shutdown cancellation. Drain relay jobs before closing the store. Run relay work only when configured, and block incremental uploads until startup reconciliation completes. Continue pulls while reconciliation's upload phase is quota-blocked or retrying, so newer credentials remain available.

**Echo.** When B merges a record from A, B's `seq` moves, so B pushes the record again under B. A's merge then rejects it as not newer, and the loop stops. The cost is one extra upload per node per change. This also makes the relay carry records from nodes that only reach the group through a Tailscale peer.
`// ponytail: re-pushes merged records; tag relay-origin records if upload volume matters.`

## Connecting a new computer

One entry point on each side. The method is chosen on the machine that is already set up, and `join` works out the method from what it is given.

### CLI

```sh
# On the machine that is already set up:
agentgate pair                      # in a terminal, asks: [1] Same network (Tailscale)  [2] Agentgate relay
agentgate pair --tailnet            # today's behaviour: prints `agentgate join <url> <code>` (10 min)
agentgate pair --relay [--relay-url <url>]
                                    # creates the relay group on first use (or reuses it), prints `agentgate join agr1.…`

# On the new machine, the same command for both methods:
agentgate join <url> <code>         # Tailscale
agentgate join agr1.…               # relay: checks /nodes for a name clash, stores the invite, fully reconciles

# Relay maintenance:
agentgate relay status              # url, generation, cursor, pushed, reconciliation/rotation state, errors, nodes seen
agentgate relay reconcile           # full read (including own entries), then full upload; also retries skipped entries
agentgate relay leave [--wipe]      # stop locally; --wipe also attempts group cleanup, without revoking other members
agentgate relay rotate              # seed and switch to a new group, then attempt old-group cleanup; others rejoin
```

- If `pair` runs without a terminal and without a flag, it uses `--tailnet` when Tailscale is up and `--relay` otherwise.
- `pair --relay` gives the same invite every time until you rotate. The invite does not expire, unlike the 10-minute code. `pair` says so. If it was exposed, rotate and redistribute the new invite privately; every retained relay node must rejoin.
- `init` already tolerates missing Tailscale and `node.url` is optional. Preserve that behavior, update setup wording for relay-only use, and extend the node-rename guard to configured relay membership as well as Tailscale peers and credential holders.
- Self-hosted machines with `RELAY_KEY` set must configure `AGENTGATE_RELAY_KEY` before pairing or joining. Do not print that key with the pairing command.

### Rotation and leave recovery

Rotation changes the active group on this node. Old-group deletion is cleanup, not the mechanism that revokes the old secret; old members can recreate their old group.

1. Under the shared coordinator and cross-process lease, pause old-group uploads and persist a pending rotation containing the old configuration, new invite, and phase. A repeated command or restart resumes this operation rather than generating another invite.
2. Create the new group and upload the full local snapshot with its new keys. Persist upload progress so a timeout or crash can resume. On restart, reconcile the pending group's own entries and counters before resuming uploads; startup resumes pending rotation before ordinary active-group reconciliation. While preparing, local clients keep working and subsequent local writes remain pending for the new group. Do not publish the new invite as active before seeding succeeds.
3. Atomically install the new invite, generation, acknowledged checkpoint, and send counters used during seeding; initialize its pull/replay state and mark old-group cleanup pending. Resume sync against the new group. A crash before this switch resumes preparation; a crash after it never switches back.
4. Attempt deletion of the old group with its old auth/service configuration. On failure, keep the new group active, return the new join command to the local caller, and show a separate `cleanupPending` warning. Retry cleanup with bounded backoff; retain old credentials only locally until cleanup succeeds or the operator explicitly abandons it.

For `leave`, drain/cancel current sync work and clear active membership and its heartbeat hints. `--wipe` persists a cleanup job before clearing the active configuration; a deletion failure does not silently re-enable sync. Other old-group members may recreate and repopulate the group. Neither leave nor rotation erases their local credentials.

For unpairing a machine that has both paths, remove its direct Tailscale peer as well as rotating. The dialog and operations guide must also tell the operator to remove that machine's Tailscale links to every retained member before those members rejoin; this node cannot revoke peer tokens stored on other machines.

### API (`api.ts`)

- `POST /nodes/pair` takes `{ method: "tailnet" | "relay", relayUrl? }` and returns `{ command, expiresIn? }`.
  - An omitted `method` preserves the existing API's Tailscale behavior for older clients.
  - `relay` returns the secret, so it is **loopback-only**, like backup export. A remote app gets a 403 with "Run this on that machine".
- `POST /nodes/join` takes `{ command }`: the pasted `agentgate join …` line, parsed on the server into `{ url, code }` or `{ invite }`.
  - The old `{ url, code }` body keeps working.
  - Joining with an invite is allowed with the admin token, the same as a Tailscale join today.
  - Parse accepted command tokens directly, with length bounds; never execute the pasted line through a shell. Reject unexpected flags, extra commands, and malformed invites without echoing secrets in errors.
- Add `POST /relay/reconcile`, `POST /relay/rotate`, and `POST /relay/leave { wipe? }` using the same coordinator as the CLI. Rotation returns the new join command and cleanup state and is loopback-only. Leave/reconcile require the existing management authorization. Service-key configuration is loopback-only.
- `DELETE /nodes/:id`: a direct Tailscale removal keeps its existing behavior. A relay-connected removal is loopback-only, removes a direct peer if present, and starts the recoverable rotation, returning `{ command, cleanupPending }` after the switch. Report preparation failures and partial progress explicitly; never claim revocation while rotation is pending.
- `/status` gets `relay?: { url, hosted: boolean, generation, cursor, pushed, reconciling, rotating, cleanupPending, pushError?, pullError? }`, and each node gets `via: ("tailnet" | "relay")[]`. Update shared types in `packages/protocol` and preserve existing status fields for older clients. Expose sanitized error summaries, never raw response bodies, invites, or service keys.
  - `tailnet` means a row in `peers`.
  - `relay` means a `relaySeen:<node>` key, written from the relay's `seen` map.
  - `via` describes observed paths, not authenticated membership or proof that an indirect Tailscale path has been revoked.

### App (`apps/desktop/src/views/Nodes.tsx`)

- **Pair a machine** opens a modal with two choices before it shows a command:
  - **Same network (Tailscale):** "Both machines are on your tailnet. The code expires in 10 minutes."
  - **Agentgate relay:** "Works on any network. End-to-end encrypted: the relay can't read your credentials."
  - When the app manages a remote daemon, the relay choice is disabled and its hint says to run it on that machine.
  - Then it shows the matching `agentgate join …` command with Copy, as it does today. The relay variant also notes that the invite doesn't expire.
- **Join another machine:** the two fields (address and code) become one field, "Pairing command", where you paste the whole `agentgate join …` line. The same field works for both methods.
- **Machine rows:**
  - show a `Tailscale` and/or `Relay` badge from `via`, instead of only "Tailscale address not available";
  - distinguish relay upload/download failures from Tailscale `syncError`; show reconciliation, pending rotation, and cleanup state without hiding a working path or another path's failure.
- **Unpair a relay node:** disable this action for a remotely managed daemon with a hint to run it locally. The local confirm dialog explains rotation, rejoining retained machines, and removal of Tailscale links on those machines. On confirm, call the removal endpoint, display progress, and show the new join command once the switch succeeds. A cleanup failure remains visible while the new group keeps working.

## Tests (`apps/agentgate/test/relay.test.ts`)

Run the relay's Hono app in-process, with an in-memory implementation of the Durable Object storage behind the same interface, and two or three `Store(":memory:")` nodes:

1. A writes an account and MCP credential, then pushes. B pulls, and `B.get(...)` deep-equals what A wrote.
2. A deletion on B reaches A, and the tombstone wins.
3. Nothing in relay storage contains the plaintext token, the account id or the kind name.
4. A wrong auth token against a known group gets 401; a different invite derives a different group and cannot read the original group. Swapping a blob to another key, node, generation, or counter fails authentication and is skipped without advancing its replay high-water mark or clearing the diagnostic.
5. Restoring the whole SQLite database rolls back both store `seq` and `relay:pushed`. Startup reconciliation recovers newer relay records and this node's counters before re-uploading; include clock rollback. Wiping/expiring a group triggers full repopulation from surviving nodes, including tombstones. Detect a changed generation even when its new head has already surpassed the saved cursor.
6. Echo terminates: after A → B → A, a further push/pull round moves no `seq`.
7. A mixed group, where A–B pair over Tailscale and B–C sync over the relay, converges. A change on A reaches C through B.
8. `POST /nodes/join` parses both command forms. `POST /nodes/pair {method:"relay"}` returns 403 on the tailnet listener.
9. More than 1000 pending entries and byte-limited pages converge without omissions. Exercise caller-only sequences, concurrent upserts between pages, and a continuously changing group with a bounded per-turn page budget.
10. An accepted push whose response is lost retries the identical envelopes without advancing relay `seq`. Crash between envelope persistence and acknowledgement, and between page decryption and the atomic merge/cursor commit. Writes made during upload are not skipped by its checkpoint.
11. Interrupt rotation before seeding, during upload, before switching, and after switching. Each restart resumes the same new invite. Old-group deletion failure leaves the new group usable and cleanup visible. A failed `leave --wipe` does not restore active membership.
12. Rotate a mixed group's secret while the removed machine still has a Tailscale path; demonstrate that it retains access until all such links are removed. Verify direct peer removal and the loopback restrictions on rotation and relay unpairing.
13. Relay-only LLM and MCP refresh recovery fetch newer credentials through `syncAll`. A quota-rejected push still permits pull. Separate errors survive successes on the other path, and shutdown cancels/drains relay work before closing the store.
14. Enforce serialized byte limits, oversized-record checkpoint behavior, atomic quota rejection, bounded node/heartbeat metadata, group admission under concurrent creation, and retention/admission-slot release. Rate limits apply to reads and creation as well as pushes. A self-hosted service key is required on every route and remains absent from invites, status, logs, and shared backups.
15. Watcher, timer, CLI, and API work share serialization and cross-process leases. An in-flight completion cannot mutate checkpoints after leave/rotate changes the active configuration. Deterministic crypto vectors pin derivation, envelope encoding, and AAD; independent keys do not interfere with each other's replay tracking.

Run Workers tests against real Durable Object SQLite for atomic pushes, idempotent retries, pagination, admission, and storage recreation. The in-memory adapter alone cannot validate those transaction and lifecycle behaviors. Keep a deployed smoke test for the hosted endpoint's authentication, limits, and retention configuration.

## Docs

- README: "A second machine" shows both options side by side: Tailscale (`pair --tailnet`) and the relay (`pair --relay`), with one sentence on when to pick which.
- `docs/operations.md`: the trust model, freshness limits after restore, startup/manual reconciliation, oversized-record and quota errors, hosted retention, and self-hosted service-key setup. Holding the invite gives full credential access, the same as pairing. Removing a node means rotation, removing all its Tailscale paths, and rejoining retained machines; compromise also requires provider credential revocation. Describe interrupted rotation/leave recovery and cleanup warnings.

## Order of work

1. Pin protocol schemas, crypto vectors, pagination/reset invariants, and admission/retention defaults. Build `apps/relay` Worker, Durable Objects, and route/SQLite tests.
2. `relay.ts` crypto, push and pull, plus `relay.test.ts`.
3. Daemon wiring and shared `syncAll` credential recovery. Add startup reconciliation, shared coordination/leases, cancellation, and recoverable rotation/leave. `pair` with the method choice, `join` auto-detecting the method, and the `relay` subcommands.
4. API and shared protocol types: `/nodes/pair` method, `/nodes/join` command parsing, relay maintenance/removal endpoints, and sanitized status fields.
5. App: the method chooser, the single-field join, the `via` badges and the relay unpair flow.
6. Validate admission, request limits, retention, usage alerts, and the operator creation switch; deploy the hosted relay and set `DEFAULT_RELAY_URL` only after these checks pass.
7. README and operations docs. Live check: Mac on Wi-Fi plus a server, with Tailscale off on both. Then a mixed group with Tailscale on one pair.

## Out of scope for now

- Instant propagation through a Durable Object WebSocket (hibernation API). The 15 s pull is the same latency as today. Add it if waiting 15 s for a token refresh to arrive becomes a problem.
- Remote management through the relay. The app keeps using Tailscale or loopback.
- Per-node keys or revoking a single node without rotating. That needs per-recipient encryption.
