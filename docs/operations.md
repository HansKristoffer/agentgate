# Agentgate operations

The daemon owns the local SQLite store, subscription pool, MCP gateway and peer sync. Tauri is an optional client of the JSON control API. Every paired machine can continue independently; Tailscale or the encrypted relay carries peer traffic.

Account and MCP OAuth refreshes use holder coordination and a local cross-process lease. During a network partition, separate machines can still compete for a rotating provider token. Reconnect peers and sync the newer credential first; sign in again if the provider invalidated it. This is not a consensus protocol.

Back up before upgrading and upgrade paired nodes together. Management API 2 and sync protocol 4 reject incompatible app/daemon and peer versions. New backups use format 3; current Agentgate can also restore formats 1 and 2. Re-run setup and reinstall the user service after changing the home, port or binary location. The service executable is kept outside the desktop bundle so closing or updating the app does not remove the daemon.

A backup exported without secrets is a configuration inventory, not a working credential backup. Restore transports and logins separately; use a private full backup to restore working credentials. Deleted-record history is kept for safe offline peer catch-up.

Skill sync uses byte-bounded pages so initial pairing and offline catch-up can exceed 16 MiB. Each page commits independently; an interrupted pull resumes at the last committed cursor. Skill records and project assignments remain subject to the store's existing last-writer-wins replica policy.

Local skill reconciliation runs independently every 30 seconds, with event-driven retries for worktree creation. Publication failures restore the previous disk copy; interrupted swaps are recovered on restart. The two-rename directory swap has a brief availability gap during successful updates. Skills → **Skills need attention** reports filesystem/watch errors and case-variant project IDs that require consolidation. Managed skill links are kept out of Git status, and mirroring repository-owned skills is an explicit local opt-in.

The app/API restore limit is 16 MiB of serialized JSON. For larger inventories, restore on the daemon's machine with `agentgate import /absolute/path/backup.json`; the CLI validates the full backup before committing it. Exported backups can exceed the app restore limit. Protect skill sources and script contents as part of the backup.

Only pool accounts you own and use them within the provider's applicable terms. Automated fixture checks do not establish provider permission or support for every live CLI version.

## Distribution checks

CI covers fake provider traffic, OAuth state validation, replica/store invariants, MCP reconnects, frontend builds and standalone binary smoke tests on macOS/Linux, plus native Rust checks and app packaging on macOS. Before relying on a new provider or service-install change, also check real provider login/traffic, T3 sessions, two physical machines over Tailscale, and installed launchd/systemd behavior after logout/reboot.

## Relay

The relay (`apps/relay`) is a Cloudflare Worker with one SQLite-backed Durable Object per group. It is a mailbox: each machine uploads the latest encrypted version of each record it holds, and downloads everyone else's entries since a cursor. The design is in [relay-plan.md](relay-plan.md).

### Trust model

- **The invite string is the master key.** Every key is derived from it with HKDF-SHA256: the group id, the bearer token, the AES-GCM key and the HMAC key for entry names. Anyone who has the invite can read and write every account and MCP login, the same as a paired machine. It never expires.
- **What the relay sees:** node names, entry counts and sizes, and timing. It does not see credentials, record kinds or ids, or the encryption key.
- **What the relay can still do:** delete or withhold data, and replay older entries to a machine that has no newer history: a freshly joined machine, or a database restored from backup. Machines keep working from their local copy if the relay is down.
- **No forward secrecy.** The relay can keep old ciphertext. After a suspected leak, run `agentgate relay rotate` and also log in to the affected accounts again.
- **Removing a machine** means rotating the secret (`agentgate unpair <node>` does this for relay machines), rejoining every machine you keep with the new command, and removing the removed machine's Tailscale pairing on each of them. A rotation cannot revoke those links, and it doesn't erase credentials already copied to the removed machine.

### Reconciliation and restores

On every daemon start, on `join`, after a group reset and on `agentgate relay reconcile`, a machine re-reads the whole group, its own entries included, and then uploads its complete store. This is how a database restored from a backup recovers newer records and its own upload counters: a restore also restores the checkpoints stored inside the database, so it can't be detected by comparing them.

- If the relay was wiped or expired, the next sync recreates the group and every surviving machine uploads everything again, deletions included.
- If an entry can't be decrypted or validated, it is skipped and counted under "skipped" in `agentgate relay status` and the app. A full reconcile retries those entries.
- "Relay counter conflict" means the relay holds a newer upload from this machine than this machine knows about. Reconciliation recovers it automatically unless the relay's copy was also lost or tampered with. In that case, rotate.

### Limits and errors

- One record can be at most 1 MiB once encrypted. That is stricter than the local store's 4 MiB, so a larger record blocks uploads and is named in the upload error until it shrinks. Downloads keep working.
- Each group holds at most 64 machines and 50 MiB. A full group returns "out of storage"; downloads keep working while uploads are rejected.
- Upload and download errors are reported separately. Uploads are retried with exponential backoff (and `Retry-After`), and every unacknowledged chunk is resent byte for byte.

### Deploying and self-hosting

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

### Crypto test vectors

Secret bytes `00 01 … 1f`, HKDF-SHA256, salt `agentgate-relay-v1`, info `agentgate-relay-v1/<label>`:

| Value | Result |
|---|---|
| `groupId` (`group`, 16 bytes, hex) | `8f6ba714a69c73f1fbdcd8efe342493a` |
| `authToken` (`auth`, 32 bytes, base64url) | `ZxB1Uo3DlItacW62HpLUewhYoxYs8G2M_1fl8d29AnE` |
| entry key for `account` / `acc` (HMAC with `mac`) | `NNCRaladXbAr90_nFfOrCIEaQCc_oJCok1Y_XxZsqY0` |
| `{"x":1}` sealed with a zero nonce, generation `0`×32, node `a`, counter 1 | `AAAAAAAAAAAAAAAAKBuJeHcyQw_EGr_uWJywDTfraf7zwOQ` |

The AAD is the UTF-8 JSON array `[1, groupId, generation, node, key, pusherSeq]`.

