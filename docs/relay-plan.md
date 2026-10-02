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
- **Entry**: `(node, key) → (seq, blob)`.
  - `node` is the pushing node's id, in clear text.
  - `key` is `HMAC(macKey, kind + "\0" + id)`, so the relay never sees kinds or ids.
  - `blob` is the AES-GCM sealed `Rec` JSON.
  - `seq` is a counter per group, assigned by the Durable Object on every upsert.
- **Upsert** replaces the entry with the same `(node, key)`. Storage is bounded at roughly nodes × records and never needs compaction.
- **Pull** returns entries with `seq > cursor` from every node except the caller, plus the group's current `seq`. Each client keeps one cursor for the whole relay.

## Crypto (all in the daemon, WebCrypto; no new dependency)

The user holds one value, an invite string: `agr1.<base64url(relayUrl)>.<base64url(32 random bytes)>`. Every key is derived from it with HKDF-SHA256, each with its own `info` label:

| Derived value | Use |
|---|---|
| `groupId` (hex, 16 bytes) | Durable Object name, in the URL path |
| `authToken` | `Authorization: Bearer` on every relay request |
| `encKey` (AES-GCM 256) | Sealing records |
| `macKey` (HMAC-SHA256) | Entry keys |

- Seal each record as a random 12-byte nonce followed by the ciphertext. The AAD is `groupId | node | key | pusherSeq`, so the relay can't move a blob to another node or key.
- Track the highest `pusherSeq` seen from each node. Drop any blob whose `pusherSeq` is not above that, which stops the relay from replaying old blobs.
- `pusherSeq` is not the store `seq`. It is `max(last + 1, Date.now() * 1000)`, so it keeps moving forward even if the database file is restored from an old copy.
- Ordering within a node holds because pushes go out in order and an upsert moves its entry to a new, higher group `seq`.
- After decrypting, the record goes through the existing `s.merge` → `parseRecord` validation. A record that is malformed or fails to decrypt is skipped, and the error goes to `relay:error`.
- The Durable Object stores `sha256(authToken)` on the first write and rejects requests that don't match afterwards. Anyone who doesn't have the secret can't read or write the group.
- What the relay can see: node names, record counts and sizes, and timing. It can't see kinds, ids, credentials or config.

## Threat model

Even someone with full access to the relay can't read tokens. That covers the Worker's owner, Cloudflare, anyone who can read the Worker's logs, and anyone who dumps the Durable Object's storage. The relay only ever receives `authToken`, which is HKDF-derived and one-way, so it doesn't reveal `encKey`. A brute-force attack on a 32-byte secret is infeasible.

What the relay **can** do:

- **See metadata:** node names, record counts and sizes, and timing.
- **Take the group down:** drop data or stop answering. Nodes then keep working from their local copy, the same as when a peer is offline.
- **Replay old blobs:** serve an older, genuinely sealed version of a record. Nodes that already hold a newer version reject it through last-writer-wins. A freshly joined node could start with a stale record, such as a token that has since been rotated. That shows up as a refresh failure, not a leak. Putting the pusher's `seq` in the AAD and checking that it only moves forward stops replays to nodes that are already synced. It does not stop the relay from hiding the newest version from a fresh joiner. Closing that gap needs a sealed manifest of hashes per node, which is out of scope.
- **Keep old ciphertext indefinitely.** There is no forward secrecy. If the invite leaks later, everything the relay ever stored can be decrypted. After a suspected leak, run `relay rotate` and also re-login to the affected accounts.

What this design does **not** protect against:

- **Whoever ships the daemon binary.** An update could send the secret anywhere. This is trust in the release pipeline, not in the relay.
- **The invite string itself.** It is the master key. Keep it out of chat logs, issue trackers and hosted web forms. The app must never send it to a server, and `POST /nodes/pair {method:"relay"}` is loopback-only.
- **Any member node.** All members are equally trusted. Any of them can read and write everything, the same as with pairing today.

## Relay API (`apps/relay`, Hono on Workers + a SQLite-backed Durable Object)

| Route | Body / response |
|---|---|
| `POST /g/:group/push` | `{ protocol, node, entries: [{ key, blob }] }` (at most 500 entries, at most 1 MiB per blob) → `{ seq }` |
| `GET /g/:group/changes?since=N&node=X` | `{ protocol, seq, entries: [{ node, key, seq, blob }], seen: { [node]: ms } }` |
| `GET /g/:group/nodes` | `{ nodes: [{ node, lastSeen }] }`, used by `join` to detect a name clash |
| `DELETE /g/:group` | Wipes the group. Used by `relay rotate` / `relay leave --wipe` |

- `seen` records the last push or pull time of each node. The daemon feeds it into the existing `seen:<node>` local keys, so `lastSeen` / `online` in status work unchanged.
- Limits: paginate `changes` (at most 1000 entries per response, with `more: true`), and cap each group at about 50 MB.
- Optional `RELAY_KEY` Worker secret: when it's set, requests must also send `x-relay-key`, so a stranger can't create groups on your Worker.
- **Our hosted relay:** deploy it with `bun run --filter @agentgate/relay deploy` (wrangler), on the same Cloudflare account as the site. Its URL is baked into the binary as `DEFAULT_RELAY_URL` (e.g. `https://relay.agentgate.dev`).
  - `RELAY_KEY` stays unset for the hosted relay. Abuse is bounded by the per-group size cap and Cloudflare rate limiting on `/g/*/push`.
- **Self-hosting:** use `--relay-url <url>` or `AGENTGATE_RELAY_URL` for the same Worker on your own account.
- Either way, the invite string carries the URL, so a joining machine doesn't need to know which relay is used.

## Daemon changes

New file `apps/agentgate/src/relay.ts`, about 100 lines:

- `parseInvite`, `deriveKeys`, `seal`, `open`.
- `relayPush(s)`:
  1. Read `relay:pushed`. If it is greater than `s.seq()` (the database was restored from a backup), reset it to 0.
  2. `s.changes(pushed)`, then seal each record, then POST in chunks.
  3. Set `relay:pushed` only after each chunk succeeds.
- `relayPull(s)`:
  1. GET `changes?since=relay:cursor`, open the blobs, and merge them in one `s.transaction`.
  2. Store the new cursor. If the server `seq` is below the cursor (the group was wiped), reset the cursor to 0, mirroring `doPull`.
  3. Write the `seen:<node>` entries and clear `relay:error`.
- All state lives in the node-local `local` table, which is never synced: `relay:invite`, `relay:pushed`, `relay:cursor`, `relay:error`. Every node joins explicitly, and the secret is never replicated as a record.

Wiring in `daemon.ts`:

- In the existing 1 s change watcher, call `relayPush` next to `poke(s)`. Wrap it in `serialTask` so pushes never overlap.
- `schedule(() => relaySync(s), PULL_INTERVAL)`, where `relaySync` is push followed by pull, so a failed push is retried every 15 s.
- Only do this when `relay:invite` is set.

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
agentgate join agr1.…               # relay: checks /nodes for a name clash, stores the invite, pushes, pulls once

# Relay maintenance:
agentgate relay status              # url, cursor, pushed, last error, nodes seen through the relay
agentgate relay leave [--wipe]      # stop using the relay on this node; --wipe deletes the group
agentgate relay rotate              # new secret; wipes the old group; the other relay nodes must join again
```

- If `pair` runs without a terminal and without a flag, it uses `--tailnet` when Tailscale is up and `--relay` otherwise.
- `pair --relay` gives the same invite every time until you rotate. The invite does not expire, unlike the 10-minute code. `pair` says so, and recommends `relay rotate` once every machine has joined if the invite was shared somewhere other people can see.
- `init` no longer requires Tailscale. `node.url` is already optional, so a relay-only node simply has no tailnet URL.

### API (`api.ts`)

- `POST /nodes/pair` takes `{ method: "tailnet" | "relay", relayUrl? }` and returns `{ command, expiresIn? }`.
  - `relay` returns the secret, so it is **loopback-only**, like backup export. A remote app gets a 403 with "Run this on that machine".
- `POST /nodes/join` takes `{ command }`: the pasted `agentgate join …` line, parsed on the server into `{ url, code }` or `{ invite }`.
  - The old `{ url, code }` body keeps working.
  - Joining with an invite is allowed with the admin token, the same as a Tailscale join today.
- `DELETE /nodes/:id`: unpairing a node that is connected through the relay requires a rotate. See the app section below.
- `/status` gets `relay?: { url, hosted: boolean, cursor, pushed, error? }`, and each node gets `via: ("tailnet" | "relay")[]`.
  - `tailnet` means a row in `peers`.
  - `relay` means a `relaySeen:<node>` key, written from the relay's `seen` map.

### App (`apps/desktop/src/views/Nodes.tsx`)

- **Pair a machine** opens a modal with two choices before it shows a command:
  - **Same network (Tailscale):** "Both machines are on your tailnet. The code expires in 10 minutes."
  - **Agentgate relay:** "Works on any network. End-to-end encrypted: the relay can't read your credentials."
  - When the app manages a remote daemon, the relay choice is disabled and its hint says to run it on that machine.
  - Then it shows the matching `agentgate join …` command with Copy, as it does today. The relay variant also notes that the invite doesn't expire.
- **Join another machine:** the two fields (address and code) become one field, "Pairing command", where you paste the whole `agentgate join …` line. The same field works for both methods.
- **Machine rows:**
  - show a `Tailscale` and/or `Relay` badge from `via`, instead of only "Tailscale address not available";
  - show the relay error in place of `syncError` when the relay is the failing path.
- **Unpair a relay node:** the confirm dialog explains that removing it rotates the relay secret and that the other relay machines must join again. On confirm it runs `relay rotate` and shows the new join command.

## Tests (`apps/agentgate/test/relay.test.ts`)

Run the relay's Hono app in-process, with an in-memory implementation of the Durable Object storage behind the same interface, and two or three `Store(":memory:")` nodes:

1. A writes an account and MCP credential, then pushes. B pulls, and `B.get(...)` deep-equals what A wrote.
2. A deletion on B reaches A, and the tombstone wins.
3. Nothing in relay storage contains the plaintext token, the account id or the kind name.
4. A wrong secret gets 401. A blob swapped to another key or node fails to decrypt and is skipped.
5. Restoring a backup onto A (`seq` goes backwards) re-pushes everything. Wiping the group resets B's cursor.
6. Echo terminates: after A → B → A, a further push/pull round moves no `seq`.

Add a small Workers test (vitest-pool-workers or `wrangler dev` smoke test in CI) for the real Durable Object SQLite path.

Two more test cases:

7. A mixed group, where A–B pair over Tailscale and B–C sync over the relay, converges. A change on A reaches C through B.
8. `POST /nodes/join` parses both command forms. `POST /nodes/pair {method:"relay"}` returns 403 on the tailnet listener.

## Docs

- README: "A second machine" shows both options side by side: Tailscale (`pair --tailnet`) and the relay (`pair --relay`), with one sentence on when to pick which.
- `docs/operations.md`: the trust model. Holding the invite gives full credential access, the same as pairing. Removing a node means `relay rotate` plus rejoining the others.

## Order of work

1. `apps/relay` Worker, Durable Object and route tests.
2. `relay.ts` crypto, push and pull, plus `relay.test.ts`.
3. Daemon wiring. `pair` with the method choice, `join` auto-detecting the method, and the `relay` subcommands.
4. API: `/nodes/pair` method, `/nodes/join` command parsing, and the status fields.
5. App: the method chooser, the single-field join, the `via` badges and the relay unpair flow.
6. Deploy the hosted relay and set `DEFAULT_RELAY_URL`.
7. README and operations docs. Live check: Mac on Wi-Fi plus a server, with Tailscale off on both. Then a mixed group with Tailscale on one pair.

## Out of scope for now

- Instant propagation through a Durable Object WebSocket (hibernation API). The 15 s pull is the same latency as today. Add it if waiting 15 s for a token refresh to arrive becomes a problem.
- Remote management through the relay. The app keeps using Tailscale or loopback.
- Per-node keys or revoking a single node without rotating. That needs per-recipient encryption.
