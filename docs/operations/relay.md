# The relay

The relay (`apps/relay`) is a Cloudflare Worker with one SQLite-backed Durable Object per group. It is a mailbox: each machine uploads the latest encrypted version of each record it holds, and downloads everyone else's entries since a cursor. The sync design and its constraints are in [internals/relay.md](../internals/relay.md).

## Trust model

- **The invite string is the master key.** Every key is derived from it with HKDF-SHA256: the group id, the bearer token, the AES-GCM key and the HMAC key for entry names. Anyone who has the invite can read and write every account and MCP login, the same as a paired machine. It never expires.
- **What the relay sees:** node names, entry counts and sizes, and timing. It does not see credentials, record kinds or ids, or the encryption key.
- **What the relay can still do:** delete or withhold data, and replay older entries to a machine that has no newer history: a freshly joined machine, or a database restored from backup. Machines keep working from their local copy if the relay is down.
- **No forward secrecy.** The relay can keep old ciphertext. After a suspected leak, run `agentgate relay rotate` and also log in to the affected accounts again.
- **Removing a machine** means rotating the secret (`agentgate unpair <node>` does this for relay machines), rejoining every machine you keep with the new command, and removing the removed machine's Tailscale pairing on each of them. A rotation cannot revoke those links, and it doesn't erase credentials already copied to the removed machine.

## Reconciliation and restores

On every daemon start, on `join`, after a group reset and on `agentgate relay reconcile`, a machine re-reads the whole group, its own entries included, and then uploads its complete store. This is how a database restored from a backup recovers newer records and its own upload counters: a restore also restores the checkpoints stored inside the database, so it can't be detected by comparing them.

- If the relay was wiped or expired, the next sync recreates the group and every surviving machine uploads everything again, deletions included.
- If an entry can't be decrypted or validated, it is skipped and counted under "skipped" in `agentgate relay status` and the app. A full reconcile retries those entries.
- "Relay counter conflict" means the relay holds a newer upload from this machine than this machine knows about. Reconciliation recovers it automatically unless the relay's copy was also lost or tampered with. In that case, rotate.

## Limits and errors

- One record can be at most 1 MiB once encrypted. That is stricter than the local store's 4 MiB, so a larger record blocks uploads and is named in the upload error until it shrinks. Downloads keep working.
- Each group holds at most 64 machines and 50 MiB. A full group returns "out of storage"; downloads keep working while uploads are rejected.
- Upload and download errors are reported separately. Uploads are retried with exponential backoff (and `Retry-After`), and every unacknowledged chunk is resent byte for byte.

## Deploying and self-hosting

`agentgate pair --relay` uses the hosted relay at `https://agentgate-relay.hanskristoffer.dk` unless `--relay-url` or `AGENTGATE_RELAY_URL` names another one. The invite carries the relay URL, so joining machines need no setting. To run your own:

```sh
bun run --filter @agentgate/relay deploy   # wrangler; needs a Cloudflare account
agentgate pair --relay --relay-url https://agentgate-relay.<account>.workers.dev
```

Settings are `[vars]` in `apps/relay/wrangler.toml`:

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_MAX_GROUPS` | 1000 | Live groups in total (reserved atomically on creation) |
| `RELAY_GROUP_MAX_BYTES` | 52428800 | Storage per group |
| `RELAY_RETENTION_DAYS` | 180 | Delete a group after this long without an authenticated request |
| `RELAY_GROUPS_PER_IP_PER_DAY` | 5 | New groups per source address per day |
| `RELAY_GROUP_REQUESTS_PER_MINUTE` | 600 | Requests per group |
| `RELAY_FAILED_AUTH_PER_MINUTE` | 20 | Failed authentications per group |
| `RELAY_DISABLE_NEW_GROUPS` | 0 | Operator switch: `1` refuses new groups; existing groups keep working |

- The `IP_LIMITER` rate-limit binding throttles each address to 1200 requests per minute.
- Set usage alerts on the Cloudflare account as well; the caps above bound storage, not every request cost.
- Machines that return after a group expired recreate it and reconcile; their local records and deletions are kept.
- **Restricting a self-hosted relay:** `wrangler secret put RELAY_KEY` makes every request carry that key. Configure it on each machine with `AGENTGATE_RELAY_KEY`, or with `agentgate relay key <value>` (stored locally, never synced or shown). It is not part of the invite.
- Plain-HTTP relays are refused unless `AGENTGATE_RELAY_ALLOW_HTTP=1` is set, which is meant for local development (`wrangler dev`).

`bun run --filter @agentgate/relay test:workers` runs the relay against real Durable Objects in workerd. The Bun tests cover the same logic on bun:sqlite.

## Remote MCP endpoints

Virtual projects (`@name`) can have a public endpoint at `<relay>/mcp/<key>` for assistants that only take a server URL and an `Authorization` header, like Grok. One `RemoteEndpoint` Durable Object per endpoint holds the WebSocket its serving machine keeps open, and forwards each POST over it. The design is in [internals/remote-mcp.md](../internals/remote-mcp.md).

- **This traffic is not end-to-end encrypted.** It is encrypted in transit, but the relay reads requests, tool results and the bearer secret, so a malicious relay operator could impersonate the client or replay calls. Upstream logins and API keys stay on the serving machine.
- **The URL and secret are a capability.** Anyone with both can call that project's tools. **New secret** keeps the URL; **New URL** replaces both and deletes the old endpoint.
- **Unpairing a machine** gives every endpoint a new URL and secret (the removed machine knows the current ones), and endpoints it served move to this machine. Update the URLs in Grok afterwards. `relay rotate` does not change endpoints.
- **Every machine must run a version that understands endpoints** before one can be enabled; older daemons would drop the endpoint when they edit the project.
- One machine serves each endpoint (always-on machines by default). Its MCP servers must work on that machine; servers that start per worktree are not offered.
- Limits: 256 KiB per request, 4 MiB per response, 4 requests in flight, 10 minutes per request, no JSON-RPC batches. An endpoint is deleted after `RELAY_RETENTION_DAYS` with neither a request nor a connected machine.

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_MAX_ENDPOINTS` | 5000 | Live endpoints in total |
| `RELAY_ENDPOINTS_PER_IP_PER_DAY` | 20 | New endpoints per source address per day |
| `RELAY_ENDPOINT_REQUESTS_PER_MINUTE` | 600 | Public requests per endpoint |

The public route does not require `RELAY_KEY` (Grok can't send it); creating, connecting and deleting endpoints does.

## Crypto test vectors

Secret bytes `00 01 … 1f`, HKDF-SHA256, salt `agentgate-relay-v1`, info `agentgate-relay-v1/<label>`:

| Value | Result |
|---|---|
| `groupId` (`group`, 16 bytes, hex) | `8f6ba714a69c73f1fbdcd8efe342493a` |
| `authToken` (`auth`, 32 bytes, base64url) | `ZxB1Uo3DlItacW62HpLUewhYoxYs8G2M_1fl8d29AnE` |
| entry key for `account` / `acc` (HMAC with `mac`) | `NNCRaladXbAr90_nFfOrCIEaQCc_oJCok1Y_XxZsqY0` |
| `{"x":1}` sealed with a zero nonce, generation `0`×32, node `a`, counter 1 | `AAAAAAAAAAAAAAAAKBuJeHcyQw_EGr_uWJywDTfraf7zwOQ` |

The AAD is the UTF-8 JSON array `[1, groupId, generation, node, key, pusherSeq]`.

