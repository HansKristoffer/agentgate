# Glossary

Terms whose meaning matters across agentgate. Constraints belong in the [overview](overview.md).

## Machines and sync

| Term | Meaning |
|---|---|
| Node | One daemon installation with its own store and name. It has a synced `node` record (`url`, `alwaysOn`, `protocol`). |
| Agentgate home | The node's state folder (`AGENTGATE_HOME`): `~/.config/agentgate` for an install, the checkout's `.agentgate` when running from source. |
| Store | The node's SQLite database in its home. |
| Record | A `(kind, id, rev, node, updated_at, deleted, data)` row in `records`, merged by last-writer-wins. |
| Tombstone | A record with `deleted = 1`, kept forever so offline nodes catch up. |
| seq, change feed | The local counter every write or merge bumps; peers pull everything after a cursor. |
| Local state | The `local` table and other node-only tables. Never synced or backed up. |
| Peer | A direct Tailscale pairing: a row in `peers` with a bearer token and cursor. |
| Lease | A cross-process lock with an expiry, stored in `local` (`acquireLease`). |

## Relay

| Term | Meaning |
|---|---|
| Group | The relay nodes that share one invite secret; one Durable Object per group id. |
| Invite | `agr1.<url>.<secret>`. The master key every relay key is derived from. |
| Generation | A random id for the group's relay storage. It changes when the storage is recreated. |
| Entry | `(node, HMAC key) → (seq, pusherSeq, sealed blob)` on the relay. |
| pusherSeq | A per-key counter set by the pushing node and covered by the AAD; it provides replay protection. |
| Reconciliation | A full read of the group, this node's own entries included, followed by a full upload. |
| Rotation | Moving every member to a new invite and group. |

## Pool

| Term | Meaning |
|---|---|
| Provider | Claude or Codex. Each has an adapter in `llm/`. |
| Account | A pooled provider subscription: an `account` record plus its `credential`. |
| Pool | The enabled accounts the proxy routes each request among. |
| Pin | The user's preferred account for a provider; the pool falls back when it is unavailable. |
| Holder | The node responsible for refreshing a credential. |
| Refresh request | A synced record asking the holder to refresh a specific token. |
| Cooldown | A backoff for an account or model, kept on this node only. |
| Session affinity | An optional mapping from a session to an account, kept on this node only. |
| Continuation owner | The account that served a Codex response, kept on this node only. |

## MCP and projects

| Term | Meaning |
|---|---|
| MCP instance | A configured MCP server. `shared` runs once per daemon; `perSession` starts one per session worktree. |
| Shim | The stdio `agentgate mcp` process Claude Code or Codex starts; it connects the session to the gateway. |
| Project | A GitHub repository (`owner/repo`) or `*`, mapping aliases to MCP instances and listing skills. |
| Virtual project | A project with id `@slug`: no repository, no `*` defaults, and it can have a remote endpoint. |
| Remote endpoint | A public relay URL `/mcp/<key>` for a virtual project, answered by its serving node. |
| Checkout | A local repository path registered on this node and mapped to a project, used to link skills. |
| Skill | A synced bundle with a root `SKILL.md`, written to disk on each node and linked where it is assigned. |
