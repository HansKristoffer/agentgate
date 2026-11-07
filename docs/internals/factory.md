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
- Prompts judge; code moves items. Every transition, limit and write-back is in the controller, and a stage only
  reports through `factory_report`, which the controller validates against GitHub before it moves the item. An
  implement report names a draft PR on the expected branch at the reported head, and a review report is discarded
  when the PR moved past the reviewed commit. Some rules are only prompts, because a thread runs at full access with
  the maintainer's login: not merging or marking its PR ready, not pushing elsewhere, and asking the spec card before
  reporting a spec approved. The PR follower notices a PR merged or closed by anyone, and the docs never call these
  guarantees.
- Review rounds stay between the factory's threads: findings go to the implement thread, never to GitHub, and the
  person reads one summary that `toReady` writes into the PR body (`readySummary` in [`pr.ts`](../../apps/agentgate/src/factory/pr.ts)).
  It is written only at ready on purpose. The reviewer is blind to the implementer's claims (`factory_item` hides
  them), but only a prompt keeps it from reading the PR description, so claims in the body before review would reach
  it.
- `settings.factory` (the pointer to the folder and the machine that runs it) and the `secret` record kind are gated
  on every node advertising node protocol 8 (`FACTORY_PROTOCOL`), because older nodes drop the settings field when
  they save and stall on an unknown kind. `SYNC_PROTOCOL` did not change.
- One machine runs the factory. Other machines forward commands and agent tools to it through
  `/peer/factory/op` ([`follow.ts`](../../apps/agentgate/src/factory/follow.ts)); `local` commands and tools
  (`use`, `off`, `status`, `secret`) run where they are called.

## One step at a time per item

Every change to an item runs as a step of that item (`withItem` in [`runtime.ts`](../../apps/agentgate/src/factory/runtime.ts)):
report acceptance, dispatch's decision to launch, item actions, silent ends, the PR follower's pass and budget
enforcement. Steps of one item never overlap; steps of different items do. Without this, dispatch closed an item
whose PR had just been merged, because "Fixes #n" had closed its issue, and a review report racing the PR loop was
taken twice.

- A step never awaits another step of its own item, which would wait forever. It queues one with `later`. Write-backs
  are claimed inside the step and posted in a later one, so `factory_report` answers once the item moved, before
  GitHub or Linear does.
- Launching a thread runs outside the step, since creating a worktree can take minutes. A drop meanwhile ends the
  run, and the thread T3 then starts is interrupted and settled.

When an item waits for the maintainer, it keeps its phase and gets `needsYou` with a reason: a question, a silent
end, a stall, its token budget, an uncertain launch (`stuck`), or nothing moving it for four times `stalledAfter`: no
active run, no working PR thread, and no run, push, nudge or person's act in that window. A running run whose
thread sat idle that long ended a turn the watcher missed, such as across a restart, and is reminded. While it waits, it starts no thread, gets no nudge and is not measured; a merge or a close of its PR
still ends it. There is no `failed` phase, so `retry` knows where to resume, and an item with a PR resumes with it.

## Items are tables; markers are the shared truth

Items, runs, events, scores and write-backs are node-local SQLite tables
([`db.ts`](../../apps/agentgate/src/factory/db.ts)), not synced records. They change every few seconds, and an item
must have exactly one machine driving its threads, which last-writer-wins records cannot promise. Every machine
drives the items in its own tables (dispatch, the PR follower, and the token and stuck loops run on every node) and no
others.

What other machines need to know travels on the item's source instead. Each factory comment ends with a marker, `<!-- agentgate-factory:1 {...} -->` ([`markers.ts`](../../apps/agentgate/src/factory/markers.ts)),
naming the item, the machine holding it, the last stage reached and whether it is open or finished. Linear drops HTML
comments, so there the marker is a visible last line in a code span. Intake posts the first marker, the `taken`
comment, in the step that adds the item, so an issue is marked before its triage starts. Intake skips an issue another
machine marked open, and the board shows it as that machine's (`orphaned` once the machine has not been seen for 30
minutes, past a laptop's sleep). `retry <owner/repo#n>` adopts an orphan, and refuses while its machine is online
([`move.ts`](../../apps/agentgate/src/factory/move.ts)): with the PR its marker names, the item waits for the
maintainer in `ready` and the follower ships or closes it; without one, it restarts at the marked stage on a branch
of its own. So the tables are a cache that can be lost. A machine that loses them leaves only its markers, and the
work resumes from those.

- A machine that wakes after its issue was taken over stands down: before every stage, and every 15 minutes while it
  follows the item's PR, it reads the issue (its state and newest factory marker, in one read), and closes the item
  without a comment when the marker names another machine. A comment from it would make its marker the newest again.

- Moving the factory moves no item. The old machine keeps driving the items it holds, and keeps its T3 MCP sign-in
  until the last one finishes. Nothing asks other machines what they hold, so an offline machine costs no polling.
- An item command (`show`, `approve`, `reject`, `retry`, `drop`) for an issue another machine holds goes from the
  factory machine to that machine (`viaHolder` in [`controller.ts`](../../apps/agentgate/src/factory/controller.ts)).
  `/peer/factory/op` answers for an item or run the machine still holds even when it no longer runs the factory;
  everything else there it refuses, so two machines that disagree on where the factory runs never forward to each
  other in a loop.
- `factory init` keeps its PR's number in the pointer (`init.pr`). The folder loop asks GitHub about that PR before
  it fetches, and while a failed fetch backs off, because GitHub usually deletes a merged PR's branch: once it merged,
  the pointer drops its ref and follows the default branch. Matching the number, not the branch name, keeps an old
  merged init PR from moving a new factory.
- A `taken` comment that fails leaves its issue unmarked, and after a move another machine's intake would take it
  too. The write-back shows as failed in `factory show`.
- Webhook, scout and manual items have no source to hold a marker, so they live only in their machine's tables and
  never move.
- Keys are `<repository name>-<number>`, or `<owner>-<name>-<number>` when two of the folder's repositories share a
  name, made unique with a suffix. Intake dedupes on the issue (`external_id`) across sources, so two labels on one
  issue make one item.
- Every write whose outcome can be uncertain (a comment for a moment, a reply in a review conversation, the note on
  a flawed learning PR) goes through one outbox ([`outbox.ts`](../../apps/agentgate/src/factory/outbox.ts)): claimed
  with its body in `factory_writebacks` in the step that decides it, so it is posted at most once. A claim a restart
  left unsent is sent by the next daemon; one cut off while sending is uncertain and never sent again; one the service
  refused, which wrote nothing, is tried up to three times. That table, not the event log, holds the claim, because
  the event log is trimmed while items stay open. Writes that are safe to repeat, such as resolving a conversation or
  the ready summary in the PR body, need no claim; the summary is written before the item moves to `ready`.
- Markers are read only from comments the factory's own account wrote: the `gh` login on GitHub, and the API key's
  user on Linear. Anyone else who can comment on an issue could otherwise forge one, keeping intake away from the
  issue or making `retry` adopt it at a later stage than it reached.

## T3 Code coupling

The factory depends on T3 Code interfaces that are not a stable public API, in two channels:

- **T3 Code's MCP server** (`/mcp`), driven by [`t3-mcp.ts`](../../apps/agentgate/src/factory/t3-mcp.ts) for
  launching threads, sending, interrupting, settling and answering pending requests. `REQUIRED_T3_INPUTS` names each tool and the inputs the factory sends, and a
  sign-in checks them against `tools/list`, so a renamed input fails with "update T3 Code" instead of a launch that
  does something else. The sign-in is OAuth with PKCE and `resource: <url>/mcp`, approved with a pairing code from the
  local `t3 pair` at full-access scopes. T3 issues no refresh token, so the factory signs in again three days before
  the 30 days end. The token is node-local: the factory machine holds one, and so does a machine still finishing items
  after the factory moved.
- **T3 Code's WebSocket RPC**, through the handoff's T3 client: the `orchestration.subscribeShell` stream feeds the
  mirror ([`mirror.ts`](../../apps/agentgate/src/factory/mirror.ts)), which falls back to polling the shell; thread
  projections give each run's provider sessions and transcript ([`records.ts`](../../apps/agentgate/src/factory/records.ts)).
- A run's thread is always on the machine that holds the run. A stage thread a person hands to another machine leaves
  the factory: its run ends, and the item waits as `handed-off` until the maintainer retries or drops it; a PR it owns
  is still followed to its merge. Following threads across machines (reports, reminders, tokens and spec cards there)
  cost more code and edge cases than it was worth.

Behaviors of T3 Code the factory relies on:

- **A launch is idempotent only within one MCP session.** T3 derives a launched thread's id from `clientRequestId`
  (the run id) and the request namespace, which for an outside client is `client:<sessionId>`. A run records the
  session it launched under (`launch_session`), and a launch whose answer was lost is sent again only under that
  session (`call(..., { session })`), so it finds its first thread. Once the sign-in changed, it is never sent again:
  the item waits as `stuck` for a person to look in T3 Code. The sign-in is not renewed while a launch's answer is out.
- **`t3_thread_launch` answers before the agent starts.** It creates the thread and its run, answers, then prepares
  the worktree and starts the agent in the background (`ThreadLaunchService.prepareInBackground`). So the run knows
  its thread before the agent's MCP shim connects, which the MCP scoping below relies on.
- **`waiting` is a working status.** A turn that waits on a command or a subagent shows `waiting` without a pending
  request; a thread that waits for a person has the pending request. The controller also counts a thread whose T3
  subagent thread works (`parentThreadId` in the shell's lineage) as working.

The test fakes are the record of what these interfaces look like: [`test/fixtures/t3-mcp.ts`](../../apps/agentgate/test/fixtures/t3-mcp.ts)
models the MCP sign-in and tools, and [`test/fixtures/t3.ts`](../../apps/agentgate/test/fixtures/t3.ts) the RPC and
shell stream. [`test/fixtures/t3-tools.json`](../../apps/agentgate/test/fixtures/t3-tools.json) holds the input names
of each tool the factory calls, as the nightly declares them, and the fake refuses any other input. To refresh it for a
new nightly, find each tool's `make("<tool>", { parameters })` in the server bundle inside the `t3` binary and copy its
fields; then update the fakes and the code. The mirror parses only the fields it reads, so fields T3 adds or drops
elsewhere do not break it.

## Trust

### Reports are tied to threads, not authenticated (D35)

The MCP shim adds the session's `T3CODE_THREAD_ID` to every call it forwards as `_meta["dev.agentgate/t3Thread"]`
(`T3_THREAD_META_KEY`). `factory_report` and `factory_item` accept a run only from the thread and machine it belongs
to, and `factory_run` answers only a judge run's own thread. This guards against misrouted reports, such as a subagent or another thread reporting
the wrong run id. It is not a security boundary. Any process on the machine can reach the loopback `/mcp` and set
`_meta`, and a full-access thread can already do anything the maintainer's login can.

The shim also names its thread when it connects (`/mcp?thread=` and `/api/shim?thread=`), and the gateway narrows
the session by it (`threadScope` in [`controller.ts`](../../apps/agentgate/src/factory/controller.ts)). A stage
run's thread, and the T3 subagent threads under it, are listed agentgate's tools and the servers their stage file
names in `mcp`, none by default; judge and learn threads get agentgate's tools only. `factory_report`,
`factory_item` and `factory_run` are listed only to run threads. The gateway checks the scope again on every call,
and tells a session its tools changed when its run starts or ends. This is defense in depth on the same label: it
keeps a destructive cloud tool away from a stage unless the folder grants it, but a thread can start a process that
names no thread.

### Untrusted text after the label gate (D40)

The label is the gate. Only someone who can label issues in the repository, or the Linear team, starts an item. Text
that arrives after it is an accepted, named risk. It covers:

- an issue body edited after labelling;
- reviews and review conversations from any bot. A bot is any GitHub App installed on the repository, and the
  maintainer chose to trust them all for now ([`pr.ts`](../../apps/agentgate/src/factory/pr.ts)).

The mitigations:

- stages read the intake snapshot through `factory_item`, not the live issue;
- briefs fence the item, and any other live text, as untrusted data ([`briefs.ts`](../../apps/agentgate/src/factory/briefs.ts));
- the PR follower is the thread's only waker. It quotes, fenced, only comments from the repository's owner,
  members and collaborators, and bots' reviews and review conversations, never a bot's plain PR comment;
- a thread never writes to GitHub: it tells the factory which review conversations it fixed or declined, and the
  factory replies and resolves them, after checking the reported commit is the PR's head;
- items an agent adds with `factory_add` wait in `held`, so an agent session cannot start a full-access thread with
  text of its choosing;
- comments the factory writes defuse mentions and HTML comments, so an agent's summary cannot notify anyone or fake a
  marker.

A webhook source's delivery is outside the label gate entirely, which is why webhook sources default to
`intake: hold`. A scout's findings are outside it too: a thread writes them from what its tools returned, such as logs
and dashboards. Scouts default to `intake: auto` all the same, because the maintainer chose what the scout watches and
wrote its prompt; `intake: hold` closes that path.

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

## Scouts and added sources

- A scout run has no item. Its source is in the run's `checked` data, and the schedule counts from that source's last
  run in this machine's tables ([`scouts.ts`](../../apps/agentgate/src/factory/scouts.ts)), so after a move an `every`
  scout runs once at the next chance.
- A finding is skipped by its key, which the thread chooses; the brief lists the keys of the scout's recent items so
  it can reuse them. Nothing stops a reworded key, and nothing caps a run's findings but the report's size limit.
- The board's `sources[].type` is a string, not an enum: other machines parse the factory machine's board with their
  own schema, and an enum makes every older machine show the factory as offline when a source type is added.
- `factory source add` edits `factory.yaml` as text and keeps the change only when parsing the result gives the old
  file plus the new source (and its secret name). No YAML writer at hand keeps comments, and the folder is the
  maintainer's file ([`source-add.ts`](../../apps/agentgate/src/factory/source-add.ts)).

## Known limits in v1

- Reports are routed by thread id, not authenticated, and MCP scoping rests on the same label (D35, above).
- Untrusted text after the label gate reaches threads, fenced (D40, above).
- The folder loads whatever is pushed to its ref, and a full-access thread can push there or edit the loaded folder
  on disk (`<home>/factory/<commit>/`). Branch protection is the remedy where the GitHub plan allows it, so `use`
  warns when the branch is unprotected; a check inside the factory would also refuse the maintainer's own pushes.
- Token budgets count what agentgate's proxy saw for a run's T3 sessions. A thread whose sessions bypass the proxy
  counts nothing, so the board shows its item's tokens as unknown after 10 minutes.
- The factory acts as the maintainer's GitHub login (D42): its comments and PRs carry the `gh` login of the
  machine that holds the item. GitHub refuses a review request to a PR's author, so `reviewers` leaves that login
  out, and the outcome metrics count comments without a factory marker as people's.
