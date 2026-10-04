# Relay

The relay lets nodes sync without sharing a tailnet. Each node makes outbound HTTPS calls to a
Cloudflare Worker ([`apps/relay`](../../apps/relay/src/group.ts)) that stores only ciphertext. The
client is [`relay.ts`](../../apps/agentgate/src/relay.ts); the wire format is in
[`packages/protocol/src/relay.ts`](../../packages/protocol/src/relay.ts). Trust model, limits,
deployment and crypto test vectors are in the [operations guide](../operations/relay.md).

## A mailbox, not a sync engine

The relay keeps the latest sealed blob per `(node, key)` and hands out entries after a cursor. That is
enough only because of the store properties in the [overview](overview.md#records-and-convergence):
idempotent last-writer-wins merges, a new local `seq` for every merged record, and tombstones that are
never purged. Do not add sync logic to the Worker.

Echo is deliberate. A node uploads records it merged from others under its own name; A → B → A stops
because the echoed record is not newer. The echo is also how records from Tailscale-only peers reach
the relay group. Do not remove it without tagging where records came from.

## Trust the ciphertext, not the relay

- The AAD binds `[1, groupId, generation, node, key, pusherSeq]`, so a blob cannot be moved to another
  slot. The relay's `seq` and its `seen` heartbeats are not authenticated; treat them as hints.
- Replay protection is a counter per key, not per node. `relay_counters` holds the highest
  authenticated `pusherSeq`, updated in the same transaction as the merge and the cursor.
- The upload chunk (`relay_pending`, one per group) is saved before sending and resent byte for byte
  until acknowledged, so a crash never reuses a counter for different ciphertext.

## Resets and restores

- Cursors are `(generation, seq)`. A recreated group gets a new generation, so a reset is detected even
  after the new head has passed an old cursor. A stale generation returns 409 `resetRequired`, and the
  client resets both its upload and download checkpoints.
- Full reconciliation runs on every process start, not only when something looks wrong. A restored
  database also restores its own upload checkpoints, so nothing inside the database can detect the
  restore. `syncTarget` forces it through `r.started`.

## Concurrency

- The CLI and daemon share the store, so every relay mutation goes through `withRelay`: serialized in
  the process and under the cross-process `relay-lease`. Completion handlers re-check `identity()`
  before committing, because a rotation may have happened meanwhile.
- Pulling continues while uploads are blocked (quota, an oversized record), so newer credentials still
  arrive. A record over the relay's 1 MiB limit (stricter than the store's 4 MiB) blocks uploads and is
  named in the error; it is never silently skipped.
- Rotation records the new invite before anything else, seeds the new group, then swaps the
  `relay:rot:*` keys into `relay:*` in one transaction. Deleting the old group is cleanup, not
  revocation: old members could recreate it.

## Worker traps

- Durable Object input gates do not stop interleaving across `await`s such as
  `admission.reserve()`, so `GroupCore.handle` queues requests itself.
- Group creation stores the record with an alarm before reserving admission, so a crash at any point
  is cleaned up by the alarm.
- `group.ts` takes its storage and admission as dependencies so the Bun tests run it on bun:sqlite.
  Anything that depends on transaction or lifecycle behavior also needs
  `bun run --filter @agentgate/relay test:workers`, which runs real Durable Objects in workerd.
