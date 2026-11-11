# Architecture

Each machine runs one daemon that owns a SQLite store, the provider proxies, the MCP gateway and peer
sync. The CLI and the Tauri app are clients of its control API (`apps/agentgate/src/api/`). Each control operation is
registered once ([`ops/registry.ts`](../../apps/agentgate/src/ops/registry.ts)), and its CLI words, the app's typed
call and the CLI's call through the daemon all come from that entry. The CLI sends a registered operation through the
running daemon, so the daemon's memory and the app see the change at once. With no daemon running, an operation that
needs only the store runs in the CLI's own process. Other CLI commands open the store directly, so anything that must
be exclusive across processes takes a lease. Terms are defined in the [glossary](glossary.md).

## Change feed

The app waits on `/api/changes`, which answers when one of five topics changes: `status`, `desktop`, `factory`,
`threads` and `activity` ([changes.ts](../../apps/agentgate/src/changes.ts)). State the app shows must mark its topic
changed, or the app never sees it. A record write does this through `topicsOf` (`store.ts`), a node-local key does it
when its `defineLocal` family has a `topic` ([local-state.ts](../../apps/agentgate/src/local-state.ts)), and anything
else calls `Store.bump`. The CLI writes from its own process, so the daemon learns of those writes from
`PRAGMA data_version` and bumps the written records' topics plus `status` and `factory`. Node-local state the CLI writes
under any other topic stays unseen until something else bumps it. Paired machines follow each other's `factory` and
`threads` topics over `/peer/topics` while an app waits.

## MCP gateway

Each shim session reaches the daemon at `/mcp`, and the daemon holds one shared connection per upstream server
([gateway.ts](../../apps/agentgate/src/mcp/gateway.ts)).

- Shared upstream connections keep their tool list, listed once when they connect and dropped when the server sends
  `notifications/tools/list_changed`, reconnects or its configuration changes. Asking every upstream on each
  tools/list cost a session 650–800 ms, bound by the slowest server. Local sources (the shim's daemon, per-session
  children, the built-in tools) are asked every time: their lists can change without a notice, and a listing is how
  a shim notices a restarted daemon.
- One listing runs at a time per session, so parallel first calls share it. A call for a tool the kept lists don't
  have asks once more before answering that the tool is unavailable.
- Each forwarded `tools/call` names the client that made it, from the session's `initialize`, under `_meta`
  `dev.agentgate/client` (`{ name, title, version }`), so a server behind agentgate can tell Claude Code from Codex.
  A name the shim already set stays; the shim never names itself.
- To give a repo's sessions fewer tools, map that project to only the servers it needs (project mappings,
  `aliasesFor`); its sessions then list and load only those.

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
- Deletions are tombstones and are never purged. An offline
  node can return after any amount of time without resurrecting deleted configuration.
- Revision checks (`configuration.ts`, `skillRevision`) protect concurrent edits on one node. They do
  not serialize changes across disconnected replicas; the merge decides those.

## Replicated and node-local state

Records sync, including secrets, to every paired node. The `local` table and the `peers`,
`request_log`, `proxy_*` and `relay_*` tables never sync and are not in backups. Keep a value local
when it describes this machine or this daemon's runtime: the node name, admin token, peer tokens,
registered checkouts, Claude Desktop logins, cooldowns, session affinity, Codex continuation owners,
model snapshots and telemetry. Account policies and quota observations are replicated, and so are token
totals: each node publishes its own as `tokens` records, one per day, and folds its days older than 90 into one record per month ([`token-history.ts`](../../apps/agentgate/src/llm/token-history.ts)).

## Versions and old nodes

Nodes upgrade independently, so a new field or kind must not break a node on the previous version.

- An unknown record kind fails `recordSchema`, and a Tailscale pull parses a whole page before it
  commits its cursor. One such record stalls sync on old nodes. Prefer new fields on an existing kind.
- Old nodes drop fields they do not know when they edit a record, and when they merge one, so they also
  pass the stripped copy on to other nodes. If losing a field matters, gate
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
waking briefly from sleep (macOS dark wakes), or one whose relay pulls are failing, otherwise sees the holder as
long gone and refreshes with a token the holder already rotated, which gets the login revoked everywhere. Only a
pull that got an answer counts as syncing. The holder itself pulls before refreshing when it has not been syncing (back
from sleep, it may have been taken over and its refresh token rotated), and waits while nobody answers during its first
two minutes awake (`awakeFor`). A refused refresh token is never sent again, and marks the login as needing a sign-in
only once every machine answered or this one has been awake two minutes, since another may hold the newer copy. A local lease stops the CLI and daemon on one machine from
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
rejects foreign `Host` headers (DNS rebinding), and the control API and `/mcp` refuse any request with `Origin` or
Fetch Metadata headers, so a web page cannot use them. The provider proxies do not check those headers yet. On the tailnet listener the control API requires the admin bearer token
and peer sync (`/peer`) its peer tokens; the proxy and MCP endpoints are never served there. The one exception is the machine dashboard (`/health`, [health.ts](../../apps/agentgate/src/health.ts)): it needs no token and is read-only, so the tailnet listener answers it only for an address or this node's own name, since any other `Host` is a page on another site reaching it by DNS rebinding. Code that is reachable from the relay, such as remote MCP endpoints, must be called
directly and never through a loopback listener, so it cannot borrow loopback trust.

## More

- [Relay](relay.md): sync through an encrypted Cloudflare mailbox.
- [Remote MCP endpoints](remote-mcp.md): virtual projects served at a public relay URL.
- [Skills](skills.md): synced skill bundles and the links each node maintains.
- [Checkout files](checkout-files.md): gitignored files between machines through buncargo's file store.
- [Claude Desktop](claude-desktop.md): switching Desktop's login and gateway mode.
