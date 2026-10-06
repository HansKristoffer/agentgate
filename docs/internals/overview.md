# Architecture

Each machine runs one daemon that owns a SQLite store, the provider proxies, the MCP gateway and peer
sync. The CLI and the Tauri app are clients of its control API (`apps/agentgate/src/api.ts`); the CLI
also opens the same store directly, so anything that must be exclusive across processes takes a lease.
Terms are defined in the [glossary](glossary.md).

## Records and convergence

Everything a user configures is a record in `records`, typed by the zod schemas in
[`store.ts`](../../apps/agentgate/src/store.ts) and `packages/protocol`. There is no leader and no
consensus: every node accepts writes and records converge by last-writer-wins.

- `newer` compares `rev` first, then `updated_at`, then node name. The replica with more edits beats
  a later single edit, so do not "fix" it to compare time first.
- Merging is idempotent. Receiving a record twice or out of order is harmless, which is what lets
  both Tailscale sync and the relay stay simple.
- Every local write or merge gets a new local `seq`. A node's change feed therefore also carries what
  it learned from others, and peers pull everything after their cursor.
- Deletions are tombstones and are never purged (`purgeTombstones` is a deliberate no-op). An offline
  node can return after any amount of time without resurrecting deleted configuration.
- Revision checks (`configuration.ts`, `skillRevision`) protect concurrent edits on one node. They do
  not serialize changes across disconnected replicas; the merge decides those.

## Replicated and node-local state

Records sync, including secrets, to every paired node. The `local` table and the `peers`,
`request_log`, `proxy_*` and `relay_*` tables never sync and are not in backups. Keep a value local
when it describes this machine or this daemon's runtime: the node name, admin token, peer tokens,
registered checkouts, Claude Desktop logins, cooldowns, session affinity, Codex continuation owners,
model snapshots and telemetry. Account policies and quota observations are replicated, and so are token
totals: each node publishes its own as `tokens` records ([`token-history.ts`](../../apps/agentgate/src/llm/token-history.ts)).

## Versions and old nodes

Nodes upgrade independently, so a new field or kind must not break a node on the previous version.

- An unknown record kind fails `recordSchema`, and a Tailscale pull parses a whole page before it
  commits its cursor. One such record stalls sync on old nodes. Prefer new fields on an existing kind.
- Old nodes drop fields they do not know when they edit a record. If losing a field matters, gate
  the feature: each daemon writes `protocol: NODE_PROTOCOL` into its own `node` record
  (`daemon.ts`), and the feature refuses to enable until every node has it (`enableRemote` in
  `remote.ts` is the example).
- `SYNC_PROTOCOL` (`sync.ts`) rejects incompatible Tailscale peers, `API_VERSION`
  (`packages/protocol`) incompatible app and daemon pairs, and `RELAY_PROTOCOL` incompatible relay
  payloads. The sync version also travels inside the encrypted relay payload, so older nodes skip
  newer entries instead of stripping their fields.
- A store migration that changes the record payload format must clear `relay:*pushed` keys and
  `relay_pending` so the relay copy is republished (migration 2 in `store.ts`).

## Credential refresh

Some providers rotate refresh tokens, so two nodes refreshing the same credential log each other out.
Each credential has a holder node that refreshes it (`credentials.ts` `canRefresh`). Other nodes ask
through a synced refresh request, and take over only when the holder has been unseen for more than two
minutes and the token is close to expiry, and only after syncing for two minutes themselves: a laptop
waking briefly from sleep (macOS dark wakes) otherwise sees the holder as long gone and refreshes with a token
the holder already rotated, which gets the login revoked everywhere. A local lease stops the CLI and daemon on one machine from
refreshing at once. During a network partition two nodes can still race; that is accepted, not solved.

## Proxy

The proxy picks an account by quota, policy and pin (`llm/routing.ts`, `llm/pool.ts`) and moves on when
one is exhausted. A failure before response headers is treated as an uncertain outcome and is never
replayed on another account, and neither is an interrupted stream. Codex continuations must reach the
account that served the original response; the owner is recorded on the serving node only, and an
unknown owner returns 409 so the client starts over. User-facing controls are in the
[proxy guide](../user/proxy.md).

## Loopback trust

Provider and MCP traffic, and the control API without a token, are served on loopback only. The daemon
rejects foreign `Host` headers (DNS rebinding) and any request with `Origin` or Fetch Metadata headers,
so a web page cannot reach it. On the tailnet listener the control API requires the admin bearer token
and peer sync (`/peer`) its peer tokens; the proxy and MCP endpoints are never served there. Code that is reachable from the relay, such as remote MCP endpoints, must be called
directly and never through a loopback listener, so it cannot borrow loopback trust.

## More

- [Relay](relay.md): sync through an encrypted Cloudflare mailbox.
- [Remote MCP endpoints](remote-mcp.md): virtual projects served at a public relay URL.
- [Skills](skills.md): synced skill bundles and the links each node maintains.
- [Claude Desktop](claude-desktop.md): switching Desktop's login and gateway mode.
