# Software factory

An opt-in module of the daemon ([`apps/agentgate/src/factory/`](../../apps/agentgate/src/factory/)) that works
issues in T3 Code threads up to a PR ready for a person. Each feature file registers its routes, commands, tools,
loops, run kinds, sources and board parts on the runtime in its own `setup` ([`runtime.ts`](../../apps/agentgate/src/factory/runtime.ts)),
so features never edit shared files. The user guide is [docs/user/factory.md](../user/factory.md); the folder format
is `factoryConfigSchema` in [`packages/protocol/src/factory.ts`](../../packages/protocol/src/factory.ts).

## Decisions

- The factory lives inside the daemon and is off until `agentgate factory use`. This bends "quiet and dependable":
  the maintainer accepted it on the condition that factory work runs only in `schedule()` loops and never on a model
  request's path. Keep it that way; a proxy request must never wait on the factory.
- The folder is a public contract. `factory.schema.json` is generated from the zod schema
  (`bun run --filter @agentgate/protocol factory-schema` after changing it), and a breaking change needs a new
  `version`.
- Each commit of the folder is fetched into its own directory (`<home>/factory/<commit>`). An item records the commit
  it started under and finishes under it, and a commit that fails to load never replaces the last good one.
- Prompts judge; fixed code guarantees. Every transition, limit and write-back is in the controller, and a stage
  only reports through `factory_report`, which the controller validates against GitHub before it moves the item. An
  implement report names a draft PR on the expected branch at the reported head, and a review report is discarded
  when the PR moved past the reviewed commit.
- `settings.factory` (the pointer to the folder and the machine that runs it) and the `secret` record kind are gated
  on every node advertising node protocol 8 (`FACTORY_PROTOCOL`), because older nodes drop the settings field when
  they save and stall on an unknown kind. `SYNC_PROTOCOL` did not change.
- One machine runs the factory. Other machines forward commands and agent tools to it through
  `/peer/factory/op` ([`follow.ts`](../../apps/agentgate/src/factory/follow.ts)); `local` commands and tools
  (`use`, `off`, `status`, `secret`) run where they are called.

## Items are tables; markers are the shared truth

Items, runs, events, scores and write-backs are node-local SQLite tables
([`db.ts`](../../apps/agentgate/src/factory/db.ts)), not synced records. They change every few seconds, and an item
must have exactly one machine driving its threads, which last-writer-wins records cannot promise. Every machine
drives the items in its own tables (the dispatch, PR, review and token loops run on every node) and no others.

What other machines need to know travels on the item's source instead. Each factory comment, and the PR body, ends
with a marker, `<!-- agentgate-factory:1 {...} -->` ([`markers.ts`](../../apps/agentgate/src/factory/markers.ts)),
naming the item, the machine holding it, the last stage reached and whether it is open or finished. Linear drops HTML
comments, so there the marker is a visible last line in a code span. Intake skips an issue another machine marked
open, a new factory machine shows another machine's issues from their markers, and `retry <owner/repo#n>` adopts an
orphan at the stage its marker names ([`move.ts`](../../apps/agentgate/src/factory/move.ts)). So the tables are a
cache that can be lost. A machine that loses them leaves only its markers, and the work resumes from those.

- Webhook and manual items have no source to hold a marker, so they live only in their machine's tables and never
  move.
- A write-back is claimed in `factory_writebacks` before it is posted, so each item and moment is posted at most
  once, and an uncertain post is never repeated. That table, not the event log, holds the claim, because the event
  log is trimmed while items stay open.
- Markers are read only from comments the factory's own account wrote: the `gh` login on GitHub, and the API key's
  user on Linear. Anyone else who can comment on an issue could otherwise forge one, keeping intake away from the
  issue or making `retry` adopt it at a later stage than it reached.

## T3 Code coupling

The factory depends on T3 Code interfaces that are not a stable public API, in two channels:

- **T3 Code's MCP server** (`/mcp`), driven by [`t3-mcp.ts`](../../apps/agentgate/src/factory/t3-mcp.ts) for
  launching threads (with `clientRequestId` set to the run id, so a retried launch finds the same thread), sending,
  interrupting, settling, answering pending requests, and watching PRs. `REQUIRED_T3_TOOLS` lists them, and a sign-in
  checks `tools/list` and reports any that are missing. The sign-in is OAuth with PKCE, approved with a pairing code
  from the local `t3 pair` at full-access scopes. T3 issues no refresh token, so the factory signs in again three days
  before the 30 days end. The token is node-local and exists only on the factory machine.
- **T3 Code's WebSocket RPC**, through the handoff's T3 client: the `orchestration.subscribeShell` stream feeds the
  mirror ([`mirror.ts`](../../apps/agentgate/src/factory/mirror.ts)), which falls back to polling the shell; thread
  projections give each run's provider sessions and transcript ([`records.ts`](../../apps/agentgate/src/factory/records.ts));
  and on a machine without the MCP sign-in, `message.dispatch`, `run.interrupt` and `thread.settle` act on a stage
  thread that was handed there (`/peer/factory/thread`).

The test fakes are the record of what these interfaces look like: [`test/fixtures/t3-mcp.ts`](../../apps/agentgate/test/fixtures/t3-mcp.ts)
models the MCP sign-in and tools as T3 Code nightly 0.1.7 serves them, and [`test/fixtures/t3.ts`](../../apps/agentgate/test/fixtures/t3.ts)
the RPC and shell stream. When T3 Code changes one, update the fake from the new nightly's source first, then the
code. The mirror parses only the fields it reads, so fields T3 adds or drops elsewhere do not break it.

## Trust

### Reports are tied to threads, not authenticated (D35)

The MCP shim adds the session's `T3CODE_THREAD_ID` to every call it forwards as `_meta["dev.agentgate/t3Thread"]`
(`T3_THREAD_META_KEY`). `factory_report` and `factory_item` accept a run only from the thread and machine it belongs
to, and `factory_run` answers only a judge run's own thread. This guards against misrouted reports, such as a subagent or another thread reporting
the wrong run id. It is not a security boundary. Any process on the machine can reach the loopback `/mcp` and set
`_meta`, and a full-access thread can already do anything the maintainer's login can.

### Untrusted text after the label gate (D40)

The label is the gate. Only someone who can label issues in the repository, or the Linear team, starts an item. Text
that arrives after it is an accepted, named risk. It covers an issue body edited after labelling, and PR comments from people
outside the repository, which T3's PR watch can wake the implement thread with. The mitigations:

- stages read the intake snapshot through `factory_item`, not the live issue;
- briefs fence the item, and any other live text, as untrusted data ([`briefs.ts`](../../apps/agentgate/src/factory/briefs.ts));
- nudges count only comments from the repository's owner, members and collaborators;
- comments the factory writes defuse mentions and HTML comments, so an agent's summary cannot notify anyone or fake a
  marker.

A webhook source's delivery is outside the label gate entirely, which is why webhook sources default to
`intake: hold`.

### The `/factory` page

`GET /factory` is read-only and token-less, so it follows `/health`. It is served only while the machine's
`healthDashboard` switch is on, and the tailnet listener accepts only an IP address or the machine's own tailnet name
as the `Host`, against DNS rebinding. It draws the board's JSON with the DOM, so text from issues and threads is
never parsed as HTML, and loads no external assets. It never shows webhook URLs, which carry a hook's key; those are
only in `GET /api/factory`, the CLI and `/peer/factory/board`, since paired machines already share every secret.
Every action goes through the control API.

### Hook endpoints (`/hook/:key`)

A webhook URL is a relay endpoint of kind `hook`, served over the factory machine's socket like a
[remote MCP endpoint](remote-mcp.md). The relay checks nothing but the key, because senders cannot send a bearer
token; the factory machine checks the sender's HMAC-SHA256 signature over the exact body
([`hooks.ts`](../../apps/agentgate/src/factory/hooks.ts)).

- A GitHub or Linear delivery carries no data into the factory. It only polls that source now, so a forged one costs
  a poll. A webhook source's delivery becomes an item, and without a `signature` the URL is the only check.
- `handleHook` is called directly, never through an HTTP listener, so a public sender cannot borrow loopback trust.
- The URL's relay credentials are the synced `~hook:<source>` secret, so the URL survives a move to another machine.
  `~hook:` ids are agentgate's own, so a folder cannot declare them and `secret list` hides them.
- The relay reads deliveries in clear, like remote MCP traffic, and queues nothing while the machine is offline.

## Known limits in v1

- Reports are routed by thread id, not authenticated (D35, above).
- Untrusted text after the label gate reaches threads, fenced (D40, above).
- The factory acts as the maintainer's GitHub login (D42): its comments, PRs and reviews carry the `gh` login of the
  machine that holds the item. GitHub refuses a review request to a PR's author, so `reviewers` leaves that login
  out, and the outcome metrics count comments without a factory marker as people's.
- A stage thread handed to another machine is not reminded when its turn ends without a report, because the controller's
  watcher sees only the threads in its own machine's mirror.
- Dropping an item while its thread is being handed off leaves the thread running on the destination.
- `approve` and `reject` cannot answer a spec card on a thread that moved to another machine, because only the
  factory machine signs in to T3's MCP and answering a pending request needs it. The card is answered in T3 Code
  there.
