# Remote MCP endpoints

A virtual project can be served at a public relay URL for assistants that only accept a server URL and
an `Authorization` header. The relay's endpoint Durable Object
([`apps/relay/src/remote.ts`](../../apps/relay/src/remote.ts)) forwards each request over a WebSocket
held by the serving node ([`remote.ts`](../../apps/agentgate/src/remote.ts), `handleRemote` in
`mcp/gateway.ts`). User-facing trust and limits are in the
[operations guide](../operations/relay.md#remote-mcp-endpoints).

## Decisions

- Virtual projects reuse the `project` kind with an `@slug` id instead of a new kind, because old nodes
  stall on unknown kinds. Enabling an endpoint is gated on every node advertising node protocol 2 (`REMOTE_PROTOCOL`),
  because old nodes would drop the `remote` field when they edit the project.
- One explicitly chosen node serves each endpoint (`remote.servedBy`, always-on nodes by default), not
  automatic routing: shared stdio servers depend on that machine's PATH and environment, and an HTTP
  server may point at `localhost`. Only `shared` instances can be served; a `perSession` instance needs
  a worktree that a remote client does not have.
- `saveProject` (not just the UI) forces `inheritDefaults: false` and reserves the `skills` alias for
  virtual projects, so `*` defaults never leak into a public endpoint.
- The relay holds the authoritative hashes of the secret and token, set by the serving node with
  `PUT /e/:key`, so a stale node cannot keep an old secret alive.
- Unpairing a node gives every endpoint a new key, URL and Durable Object instead of rotating the
  secret: the removed node knows every synced credential and could race a rotation. `relay rotate`
  does not touch endpoints.
- The public `/mcp/:key` route does not require `RELAY_KEY`, because clients like Grok only send a bearer
  token. Creating, connecting and deleting endpoints do.
- `export --no-secrets` drops the whole `remote` field.
- A virtual project's `factoryTools` adds the factory's tools under the reserved `factory` prefix
  ([`factory/remote-tools.ts`](../../apps/agentgate/src/factory/remote-tools.ts)). They call the factory's typed
  operations, which reach the factory machine or an item's holder, so any node can serve the endpoint. Turning it on
  is gated on node protocol 9, since older nodes drop the field when they save the project. Unlike the agent tool
  `factory_add`, whose items wait in `held`, the endpoint adds at triage and may approve: the maintainer chose full
  control for Grok, accepting that the URL and secret, which the relay reads, can start full-access threads.
- The endpoint's `factoryWebhook` gets factory updates from every machine, each posting what its own event log holds
  ([`factory/notify.ts`](../../apps/agentgate/src/factory/notify.ts)), since items live in the node-local tables of
  the machine that runs the factory. Each machine keeps a cursor per URL; a new URL starts at the newest event and a removed one's
  cursor is forgotten, so setting one never replays history. Delivery is at least once. The URL is a capability, so
  the API shows its origin only, logs show a status or an error's name, and backups without secrets and the seeded dev
  store drop it.
- The factory's webhook URLs reuse this machinery as endpoints of kind `hook`, served at `POST /hook/:key`
  ([factory](factory.md#hook-endpoints-hookkey)). Like `/mcp/:key`, the route needs neither a bearer token nor
  `RELAY_KEY`, because senders such as GitHub cannot send them. The serving machine checks the sender's signature
  instead, so the relay forwards every header except cookies, hop-by-hop headers (including those `Connection`
  names) and its own `x-agentgate-*`, and the body as exact UTF-8 bytes. Bodies may be up to 1 MiB
  (`REMOTE_LIMITS.hookRequestBytes`), more than MCP requests, since a GitHub push event can be large.
- An endpoint's kind is fixed when the relay first admits it. A `PUT /e/:key` with another kind is refused, and a
  public request reaches only an endpoint of its own kind, so a hook key never opens an MCP endpoint. MCP updates
  leave `kind` out, which relays from before webhooks expect.

## Traps

- `handleRemote` is called directly, never through an HTTP listener, so remote requests cannot borrow
  loopback trust.
- The relay never replays a request after a timeout or a dropped socket, because the tool call may
  already have run. A new connection closes older sockets, and responses are matched to the socket that carried the request, so a late close or reply from an old socket cannot affect the current one.
- The MCP SDK does not cancel handlers when a request aborts; `mergedServer` combines the caller's signal
  by hand. The daemon also rewrites `Accept`, because the SDK demands both content types.
