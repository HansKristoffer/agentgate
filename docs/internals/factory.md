# Software factory

An opt-in module of the daemon ([`apps/agentgate/src/factory/`](../../apps/agentgate/src/factory/)) that works
issues in T3 Code threads up to a PR ready for a person. Each feature file registers its operations, loops, run
kinds, sources, board parts and preflight checks on the runtime in its own `setup` ([`runtime.ts`](../../apps/agentgate/src/factory/runtime.ts)),
listed once in [`features.ts`](../../apps/agentgate/src/factory/features.ts), so features never edit shared files. The
controller never calls a feature to tell it something happened: every transition emits an event
([`events.ts`](../../apps/agentgate/src/factory/events.ts)), and whoever cares subscribes.
[`records.ts`](../../apps/agentgate/src/factory/records.ts) reads a run's tokens on `run.ended` and an item's again as
it moves to `shipped` or `closed`, `notify.ts` tells the person, and the MCP gateway asks
`threadScope` again when a run starts, resumes or ends. The controller imports what it drives (the folder, T3 Code,
the outbox), never a feature that reacts to it.
What a feature keeps only in memory it keeps with `f.memory(name, init)`, so those calls are the list of what a
restart forgets. Everything the factory can be asked to do is one operation, registered once: a
name (the words after `agentgate factory`), a zod schema for its input, and a `run` that returns JSON. The CLI, the
control API and the app (`POST /api/factory/op/<name>`), the agents' MCP tools and a virtual project's endpoint are
made from that list, so `api.ts` and `cli.ts` name no operation, and a capability is never written a second time for
another way in. What depends on who asks reads the `caller` that comes with every call: an agent's `factory_add` is
held, a person's `add` is not. The inputs and results the app exchanges are typed in `FactoryOps`
([`packages/protocol/src/factory.ts`](../../packages/protocol/src/factory.ts)), and registering an operation that
differs from its entry there does not compile. The user guide is [docs/user/factory.md](../user/factory.md); the
folder format is `factoryConfigSchema` in the same protocol file.

## Decisions

- The factory lives inside the daemon and is off until `agentgate factory init` or `use`. This bends "quiet and dependable":
  the maintainer accepted it on the condition that factory work runs only in `schedule()` loops and never on a model
  request's path. Keep it that way; a proxy request must never wait on the factory.
- The folder is a public contract. `factory.schema.json` is generated from the zod schema
  (`bun run --filter @agentgate/protocol factory-schema` after changing it), and a breaking change needs a new
  `version`.
- Each commit of the folder is fetched into its own directory (`<home>/factory/<commit>`). An item records the commit
  it started under and finishes under it, and a commit that fails to load never replaces the last good one.
- Prompts judge; code moves items. Every transition, limit and write-back is in the controller, and a stage only
  reports through `factory_report`, which the controller validates against GitHub before it moves the item. What every
  stage shares (the run it starts, its branch and model, the result its `done` needs, the PR phases) is one table,
  `PHASES` in [`controller.ts`](../../apps/agentgate/src/factory/controller.ts); a stage file keeps its brief, its own
  checks and what its result does. An implement report names a draft PR on the expected branch at the reported head,
  and a review report is discarded
  when the PR moved past the reviewed commit. Some rules are only prompts, because a thread runs at full access with
  the maintainer's login: not merging or marking its PR ready, not pushing elsewhere, and asking the spec card before
  reporting a spec approved. The PR follower notices a PR merged or closed by anyone, and the docs never call these
  guarantees.
- Review rounds stay between the factory's threads: findings go to the implement thread, never to GitHub, and the
  person reads one summary that `toReady` writes into the PR body (`readySummary` in [`pr.ts`](../../apps/agentgate/src/factory/pr.ts)).
  It is written only at ready on purpose. The reviewer is blind to the implementer's claims and decisions (`factory_item`
  hides them), but only a prompt keeps it from reading the PR description, so either in the body before review would
  reach it.
- A folder lives in a git repository or as the one synced `factoryFolder` record
  ([`stored.ts`](../../apps/agentgate/src/factory/stored.ts)), which `init` writes; the pointer's `store` says which.
  The stored folder's commit is the SHA-256 of its files, written to `<home>/factory/<commit>` like a fetched commit,
  so items and pruning treat both the same. Unlike a push, every write checks that the folder loads and refuses one
  that does not: other machines only ever see the newest record, so a broken one would leave a new factory machine
  nothing to run. Two saves at once keep the later, like any record.
- Code outside [`folder-store.ts`](../../apps/agentgate/src/factory/folder-store.ts) does not ask which kind it has:
  the folder loop reads through it, and `source add` and `repo add|remove` `propose` a change that the stored folder
  applies at once and a folder in git turns into a PR. A git folder never takes a direct push from agentgate, because
  whatever reaches its branch changes every later brief; the person merges.
- `settings.factory` (the pointer to the folder and the machine that runs it), the `secret` and the `factoryFolder`
  record kinds are gated on every node advertising node protocol 8 (`FACTORY_PROTOCOL` in `store.ts`), because older nodes drop the settings
  field when they save and stall on an unknown kind. `SYNC_PROTOCOL` did not change. Only `use`, `move` and `off`
  write the pointer; the generic settings patch has no `factory`.
- One machine runs the factory. An operation asked for on another machine is sent there through
  `/peer/factory/op` ([`follow.ts`](../../apps/agentgate/src/factory/follow.ts)) as its name, its input and its
  caller, whichever way it was asked. The machine that was asked checks the input first and words the result: a
  terminal's words are parsed, and the answer printed, where they were typed, so only typed input and JSON cross
  machines. An operation marked `local` runs where it is asked: one that writes the pointer or another synced record,
  or opens a PR with this machine's `gh` login, and `status` and `doctor`, which ask the factory machine themselves
  and say so when it does not answer. `repo remove` is not local: only the factory machine knows the repository's
  open items. A machine that does not run the factory answers `/peer/factory/op` with a 409, so two machines that
  disagree on where it runs never forward to each other in a loop.
- The terminal's route (`POST /api/factory/terminal`) is loopback only as a whole, and an operation marked
  `loopbackOnly` is loopback only on every route: a remote-management connection never sets or lists a secret (the
  notify URL is one), reads or writes this machine's disk, or adds an item as `deliver` would. The CLI sends its
  working directory with the words, since the daemon's is not the person's, so a relative directory means what they
  typed.

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

When an item waits for the maintainer, it keeps its phase and gets `needsYou`, set only by `ask` in
[`controller.ts`](../../apps/agentgate/src/factory/controller.ts) and answered only through `answer` in
[`actions.ts`](../../apps/agentgate/src/factory/actions.ts). Its cause (a
question, a silent end, a stall, its token budget, an uncertain launch, or nothing moving it for four times
`stalledAfter`: no active run, no working PR thread, and no run, push, nudge or person's act in that window; a running
run whose thread sat idle that long ended a turn the watcher missed, such as across a restart, and is reminded
instead) maps to one
of three kinds, and the kind decides whether the issue hears it (`POSTS` in
[`needs-you.ts`](../../apps/agentgate/src/factory/needs-you.ts)): a start does not, an answer and a stop do. The daemon
builds each item's actions with their effects, so no client keys buttons or text by cause. A thread's question card is
asked once per T3 request id, and the run records the id it answered, since T3 can show a request again after it was
answered and two cards can read the same. Waits that need nobody (a thread slot, quota, CI, PR checks) live in the
controller's memory and show as the board item's `waiting`, never as a run's `error`. While an item waits for the
maintainer, it starts no thread, gets no nudge and is not measured; a merge or a close of its PR still ends it. `notify.ts` is the one place that tells the person: `item.needs-you` and a move to `ready` go to every
outlet (the notify URL, each factory endpoint's webhook, and the asking thread marked unread in T3 Code), since GitHub
never notifies the login the factory comments as (D42). An answer given on a GitHub issue goes through `act`, like the
CLI's, and the id of the last comment read is kept in local state, so an answer is never used twice even when it was
refused. There is no `failed` phase, so `retry` knows where to resume, and an item with a PR resumes with it.

The item owns its PR (`item.pr`): the URL, the head the follower last saw, its nudges and replies, and the implement
run whose thread owns the PR. That thread is the only one nudged, and it is never settled while the item is open.
When T3 Code deletes it (the mirror's removal, or the stuck loop for a deletion nobody watched), the item waits as
`deleted`, and `retry` moves it back to `implement` with a run that checks the PR out and reports the same PR, which
may no longer be a draft. The new run then owns the PR and keeps the replies already posted; until it reports, the
follower only watches for the PR's merge or close.

## Items are tables; markers are the shared truth

Items, runs, events and write-backs are node-local SQLite tables
([`db.ts`](../../apps/agentgate/src/factory/db.ts)), not synced records. They change every few seconds, and an item
must have exactly one machine driving its threads, which last-writer-wins records cannot promise. So only the factory
machine drives items: every loop that moves one, or talks to T3 Code, GitHub or Linear for one, runs only on the
machine the pointer names (`where: "factory-node"`). A machine that has open items in its tables and does not run the
factory leaves them frozen, exactly as `factory off` does, and signs out of T3 Code's MCP like any other machine.

Moving the factory therefore drains first ([`config.ts`](../../apps/agentgate/src/factory/config.ts)). `move` is
decided on the factory machine, the only one that knows what it has open: any other machine checks the machine's name
and sends it the same operation. With open items it writes `moveTo` into the pointer. While that is set, intake is off, the open items go on as usual, and the `factory-move` loop moves the pointer
once none is open and the outbox has sent what it owed: no other machine can post those comments, and an issue whose
`closed` comment never arrived looks open to the next machine's intake. The loop decides from the pointer and the
tables on every pass, so a restart, or a settings write from another machine that wins over the loop's, costs one more
pass. `move --now` writes the pointer on the machine it is typed on, for a factory machine that is gone or whose items
are not worth the wait.

- What `--now` leaves on the old machine stays frozen in its tables. That machine's board lists it apart from the
  factory machine's items (`frozen`), and an item operation that names a frozen item by its id is the one thing a
  machine that does not run the factory answers itself (`here` on the operation). Only by id: the new machine may have
  taken the issue in again under the same key, and a key must name that item. `drop` closes a frozen item without a
  comment, because a `finished` marker from the old machine would keep the new one's intake away from the issue, and
  without a call to T3 Code, which the machine is signed out of.
  A report from a frozen thread is forwarded to the factory machine, which has no such run and refuses it. Moving the
  factory back resumes the items the way a restart does: the mirror starts again, and a thread whose turn ended
  meanwhile is reminded to report.
- Nothing fences two machines that both believe they run the factory. That lasts only until the pointer syncs, and
  needs `--now` typed while the old machine is cut off but still working: until it hears, it keeps driving its items,
  and the new machine takes their issues in again.
- A move waits for items only. A scout run in flight when the pointer moves cannot report, so its findings are lost,
  and the new machine runs the scout by its own schedule.

Each factory comment ends with a marker, `<!-- agentgate-factory:1 {...} -->`
([`markers.ts`](../../apps/agentgate/src/factory/markers.ts)), naming the item, the machine that wrote it, the last
stage reached and whether the item is open or finished. Linear drops HTML comments, so there the marker is a visible
last line in a code span. Intake posts the first marker, the `taken` comment, in the step that adds the item.

- Intake reads one thing from a marker: it skips an issue whose newest one says `finished`, on whichever machine the
  factory finished it. An `open` marker keeps nothing away. By the rule above it can only belong to an item that is
  frozen on a machine the factory left, or that was lost with its tables, so the issue is taken in again from triage.
  That is also why the tables are a cache that can be lost: a machine that loses them takes its open issues in again at
  the next poll, and only what it had done on them is gone.
- An issue can therefore be taken in again while the branch of its earlier item is still on origin. An implement run
  takes the first of `factory/<key>`, `-2`, `-3`… that origin does not have (`branchFor` in
  [`implement.ts`](../../apps/agentgate/src/factory/implement.ts)), decided at its launch and kept on the run, and its
  report is checked against that branch. Origin is all it asks. Nothing stops a frozen thread, which finishes its turn,
  so one that pushes `factory/<key>` only after the new run was given that name has its push refused by git, or the
  other way round.
- `retry` takes a finished item in again only on the machine whose tables still have it. An issue the factory finished
  on another machine, or longer ago than the tables keep items, stays out until its `finished` comment is deleted.
- Webhook, scout and manual items have no source to hold a marker. They live only in their machine's tables, so after
  `move --now` nothing takes them in again, and they wait there for the factory to move back or for `drop`.
- Markers are read only from comments the factory's own account wrote: the `gh` login on GitHub, and the API key's
  user on Linear. Anyone else who can comment on an issue could otherwise forge one and keep intake away from it.
- Keys are `<repository name>-<number>`, or `<owner>-<name>-<number>` when two of the folder's repositories share a
  name, made unique with a suffix. Intake dedupes on the issue (`external_id`) across sources, so two labels on one
  issue make one item.
- Every write whose outcome can be uncertain (a comment for a moment, a reply in a review conversation, a notification) goes through
  one outbox ([`outbox.ts`](../../apps/agentgate/src/factory/outbox.ts)): claimed with its body in
  `factory_writebacks` in the step that decides it, so it is posted at most once. What happens to a
  claim next depends on whether the request can have arrived, which the `gh` boundary
  ([`ask` in `gh.ts`](../../apps/agentgate/src/factory/gh.ts)) and the Linear adapter decide from the HTTP status,
  `gh`'s exit code and the kind of network error, never from the wording of a message. One that certainly never
  reached the service (`gh` is not installed or logged out, no connection opened) is `unreachable`: the loop sends it
  again every pass until it goes through, and fails it once its claim is a day old. One the service refused with a
  4xx, which wrote nothing, is tried up to three times. Anything else, a 5xx and a send that a restart or `gh`'s
  deadline cut off included, is `uncertain` and never sent blind, because a second send could post it twice. A
  comment's marker names its moment and `ref`, so a pass later the outbox reads the issue's comments back with the
  source's `check`: one that landed is `posted`, and one that did not is sent again. A reply or an issue stays
  uncertain. A notification is safe to repeat, so a failed one is sent again like a refusal. A claim
  a restart left unsent is sent by the next daemon. That table, not the event log, holds the claim, because the event
  log is trimmed while items stay open. Writes that are safe to repeat, such as resolving a conversation or the ready
  summary in the PR body, need no claim; the summary is written before the item moves to `ready`.
- Work the factory turns up and leaves alone (a review's findings in code the PR did not change, a spec's later
  slices) is filed as new issues through the same outbox
  ([`fileIssue`](../../apps/agentgate/src/factory/outbox.ts)), without a source's label. Labelling one is the
  maintainer's approval, so the label stays the only gate (D40), and none of it counts toward `waitingForYou`, which
  held items would and so pause intake.

## T3 Code coupling

The factory depends on T3 Code interfaces that are not a stable public API, in two channels:

- **T3 Code's MCP server** (`/mcp`), driven by [`t3-mcp.ts`](../../apps/agentgate/src/factory/t3-mcp.ts) for
  launching threads, sending, interrupting, settling and answering pending requests. `REQUIRED_T3_INPUTS` names each tool and the inputs the factory sends, and a
  sign-in checks them against `tools/list`, so a renamed input fails with "update T3 Code" instead of a launch that
  does something else. The sign-in is OAuth with PKCE and `resource: <url>/mcp`, approved with a pairing code from the
  local `t3 pair` at full-access scopes. That `t3` is the running server's own binary, found through `activeVersion`
  in T3's `runtime/service-state.json` (`activeT3` in [`handoff/t3.ts`](../../apps/agentgate/src/handoff/t3.ts)),
  because a `t3` on PATH can be an older launcher whose codes the server refuses and which has no `--scope`. T3 issues
  no refresh token, so the factory signs in again three days before
  the 30 days end. The token is node-local, and only the factory machine holds one.
- **T3 Code's WebSocket RPC**, through the handoff's T3 client: the `orchestration.subscribeShell` stream feeds the
  mirror ([`mirror.ts`](../../apps/agentgate/src/factory/mirror.ts)), which falls back to polling the shell; thread
  projections give each run's provider sessions ([`records.ts`](../../apps/agentgate/src/factory/records.ts)).
- A run's thread is always on the factory machine. A stage thread a person hands to another machine leaves
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
- **`interrupted` means a person stopped the thread.** T3 continues a turn its own restart cut
  (`RestartContinuation`), so the factory treats `interrupted` as a person's stop: the run ends and the item waits as
  `stopped`, where a reminder or a nudge would start the turn they stopped. The factory settles every thread it stops
  itself, which is how the PR follower tells a budget stop from a person's; a nudge after `retry` goes through.
- **T3 refuses to settle a running thread, and an interrupt lands a moment after T3 answers it.** A report always
  comes from a turn still running, and a thread the factory interrupts is still running when the call returns, so both
  settle when the mirror sees the turn end (`settleFinished`).
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
to. This guards against misrouted reports, such as a subagent or another thread reporting the wrong run id. It is not
a security boundary. Any process on the machine can reach the loopback `/mcp` and set
`_meta`, and a full-access thread can already do anything the maintainer's login can.

The shim also names its thread when it connects (`/mcp?thread=` and `/api/shim?thread=`), and the gateway narrows
the session by it (`threadScope` in [`controller.ts`](../../apps/agentgate/src/factory/controller.ts)). A stage
run's thread, and the T3 subagent threads under it, are listed agentgate's tools and the servers their stage file
names in `mcp`, none by default; a scout's thread gets the servers its file names. `factory_report`, `factory_item`
and `factory_pr_threads` are listed only to run threads. The gateway checks the scope again on every call,
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
  text of its choosing. A virtual project's endpoint with `factoryTools` on is the deliberate exception
  ([remote MCP endpoints](remote-mcp.md));
- comments and issues the factory writes defuse mentions and HTML comments, so an agent's summary cannot notify anyone or fake a
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
- Whether a URL can receive is the relay's answer to a `GET` on it (`405` from a relay that routes `/hook`, `404` from
  one deployed before it; the router answers without waking the endpoint) plus this machine's socket for it. A
  connected socket alone proves nothing: an older relay accepts the endpoint and the socket, and still 404s every
  delivery.
- `factory deliver` takes the same path as a delivery after its signature check, without one, so it is loopback only.
  `source test` uses the same rendering and `admit`'s decision (`admission`) without writing.

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

## Preflight

- `agentgate factory doctor` and the board's `checks` are one list that each feature adds its checks to (`f.checks`,
  run by [`preflight.ts`](../../apps/agentgate/src/factory/preflight.ts)). A check that asks gh, T3 Code or another
  process is `slow`: the board shows its last answer, which a factory-machine loop refreshes every 5 minutes and
  `doctor` asks again, so a board never waits on `gh`.
- Checks are the factory machine's: other machines' gh and T3 Code do no factory work, and their board and `doctor`
  are the factory machine's. A machine that cannot reach it shows that as a failing check, since its own board would
  look empty and healthy.
- Two checks read T3 Code beyond the channels above: the running version (`serverVersion` of
  `/.well-known/t3/environment`) against the `runtime/versions/<version>/t3` path of the `t3` agentgate runs, and the
  worktree cleanup in `server.getConfig` (`worktreeCleanup`, else `storageCleanup`). Either missing reads `unknown`.
  The `mcp` check only sees whether the provider homes T3 Code names have an `agentgate` entry, so it passes for one
  that points at another daemon and never sees a repository's `.mcp.json`. The canary is the check that proves the
  route.
- The canary is a run kind of its own with no item, so nothing posts. It is queued as its last attempt, so a turn that
  ends without a report ends it with no reminder and no second thread, and it runs only where `doctor` is asked on the
  factory machine: a forwarded call ends after 60 seconds, before most threads report.

## Known limits in v1

- Reports are routed by thread id, not authenticated, and MCP scoping rests on the same label (D35, above).
- Untrusted text after the label gate reaches threads, fenced (D40, above).
- The folder loads whatever is pushed to its ref, and a full-access thread can push there or edit the loaded folder
  on disk (`<home>/factory/<commit>/`). Branch protection is the remedy where the GitHub plan allows it, so `use`
  warns when the branch is unprotected and could be protected; a check inside the factory would also refuse the maintainer's own pushes. A
  stored folder has no such remedy: a thread can write it through the control API with the admin token on disk.
- Token budgets count what this machine's proxy saw for the provider sessions T3 Code names for a run's threads. A
  session that goes to the provider directly, or through another daemon's proxy, counts 0, and the budget never
  stops its item; the `proxy` check warns about it. The board shows tokens as unknown only when T3 Code names no
  session for a run, or measuring keeps failing, for 10 minutes.
- The factory acts as the maintainer's GitHub login (D42): its comments and PRs carry the `gh` login of the
  factory machine. GitHub refuses a review request to a PR's author, so `reviewers` leaves that login
  out.
