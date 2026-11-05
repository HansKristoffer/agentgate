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
