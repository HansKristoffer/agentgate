# The software factory

The factory works issues in T3 Code threads until a pull request is ready for you to merge. The [README](../../README.md#software-factory) says what it does and how to start it. This guide covers the folder that defines a factory, its sources and secrets, what you do while it runs, and running it with several machines.

## Before you start

On the machine that runs the factory:

- **T3 Code** is running and connected to agentgate (`agentgate t3 connect`). The factory signs in to T3 Code's MCP server by itself with a pairing code from T3 Code's `t3` command, at full access, and shows up as "AgentGate factory" under T3 Code's **Settings → Connections**. The sign-in lasts 30 days and is renewed before it ends. `agentgate factory t3` shows it, and `agentgate factory t3 sign-in` tries again after a failure.
- **`gh`** is signed in to an account that can read the factory repository and push to its repositories. Everything the factory writes on GitHub carries that login.
- **`git`** is installed. The factory fetches its folder with it, through `gh`'s login, so a private factory repository works.
- **agentgate's MCP server** is in the Claude Code or Codex that T3 Code runs (`agentgate setup --primary`, or `setup --mcp`). Stage threads report through it, and tokens are only counted for sessions that go through agentgate.

Every paired machine must run a release that knows the factory before you turn it on or set a secret, since older releases drop the setting and stall on secret records. `agentgate factory use` names the machines to update.

## Turning it on and off

```sh
agentgate factory use acme/factory                      # factory.yaml at the repository's root
agentgate factory use acme/tools:factory --ref stable   # the factory folder in acme/tools, at a branch or tag
agentgate factory use acme/factory --node srv           # run it on srv instead of the always-on machine
agentgate factory reload                                # fetch and check the folder now
agentgate factory off
```

The factory checks the folder's branch every 2 minutes and loads a new commit when it moves. A commit with a mistake in it never replaces the last good one: `agentgate factory status` shows the error, naming the file and field, and the factory keeps running the commit before. Each item finishes under the commit it started with.

Whatever reaches that branch changes every later brief, and factory threads push with your `gh` login. Protect the branch on GitHub if your plan allows it (free private repositories cannot), so changes to the folder go through a pull request; `use` warns when it is not protected.

`off` stops the factory and signs it out of T3 Code's MCP. Its items stay in the machine's tables.

## The folder

```text
factory/                  any folder in a git repository
  factory.yaml            required
  rulings.md              your standing rulings, added to every brief
  stages/<stage>.md       replaces a stage's built-in brief: triage, spec, implement or review
  scorers/<name>.md       an AI judge that grades a sample of runs
  skills/<name>/SKILL.md  a skill installed into every repository the factory works in
```

Editors check `factory.yaml` against the JSON Schema in [`packages/protocol/factory.schema.json`](../../packages/protocol/factory.schema.json). With the YAML language server, put this on the first line:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/HansKristoffer/agentgate/main/packages/protocol/factory.schema.json
```

Durations are a number and `m`, `h` or `d`, such as `15m` or `7d`. Unknown keys are errors.

### factory.yaml

| Key                                | Default    | Meaning                                                                                                                                                                                                                                                           |
| ---------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                          | required   | Always `1`.                                                                                                                                                                                                                                                       |
| `name`                             | required   | Up to 40 lowercase letters, digits and dashes.                                                                                                                                                                                                                    |
| `description`                      |            | Up to 500 characters.                                                                                                                                                                                                                                             |
| `repositories`                     | required   | The repositories the factory works in, as `owner/repo` keys.                                                                                                                                                                                                      |
| `repositories.*.reviewers`         | `[]`       | Up to 10 GitHub logins or `org/team` names to request reviews from when a PR is ready. GitHub refuses to request a review from the PR's author, so that login is left out.                                                                                        |
| `repositories.*.watchPullRequests` | `false`    | Let T3 Code's PR watch wake the implement thread too. It passes on every comment on the PR, including those of people outside the repository; without it, the factory wakes the thread with what the repository's own people wrote.                               |
| `secrets`                          | `[]`       | The names of the secrets the file uses as `secret:NAME`. Every one used must be declared here. See [Secrets](#secrets).                                                                                                                                           |
| `limits.threads`                   | `3`        | Stage threads working at once (1 to 20). A thread waiting for you, or sitting idle on its PR, does not count.                                                                                                                                                     |
| `limits.waitForQuota`              | `true`     | Wait to start a thread while no account in the pool for its provider has room. Without accounts for that provider, T3 Code uses its own login and nothing waits.                                                                                                  |
| `limits.waitingForYou`             | `5`        | Intake pauses while this many items wait for you, PRs ready for your review included (1 to 100).                                                                                                                                                                  |
| `limits.itemTokens`                | `30000000` | The tokens one item may use across all its threads and their subagents, cache reads included. An item over it has its threads stopped and waits for you in its stage; raise the limit and run `retry` to go on. The current folder's value applies to every item. |
| `limits.reviewRounds`              | `3`        | Review rounds before the PR goes to you with the findings still open (0 to 5). `0` skips the review stage.                                                                                                                                                        |
| `limits.nudges`                    | `3`        | Times the factory reminds an implement thread of a PR problem it sits on (0 to 10) before the item waits for you.                                                                                                                                                 |
| `limits.stalledAfter`              | `15m`      | How long a thread may sit idle on a failing check, a conflict, a collaborator's comment or review findings before the factory nudges it, or sends the PR to you.                                                                                                  |
| `sources`                          | `[]`       | Where items come from, up to 50. See [Sources](#sources).                                                                                                                                                                                                         |
| `learning.every`                   | `7d`       | How often the learning thread runs, counted from the last one. It is skipped while no item finished since.                                                                                                                                                        |
| `scoring.sample`                   | `25`       | The percentage of finished stage runs each judge grades (0 to 100). While fewer than 20 runs were graded in the last 7 days, judges grade every run; `0` turns them off.                                                                                          |

Repository names are matched without regard to case, and a source names a repository listed under `repositories`.

### stages/\<stage\>.md

The file's body replaces the stage's built-in brief. Whatever the body says, the factory adds the item (fenced as untrusted data), `rulings.md` and how to report, so a stage file cannot leave them out. The frontmatter is optional:

| Key     | Default | Meaning                                                                                                                                                                                                                    |
| ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start` | `auto`  | `manual` holds each item before this stage until you run `agentgate factory approve <item>`. In `stages/triage.md` it holds every new item.                                                                                |
| `skill` |         | A skill name; the brief says "Use the \<skill\> skill."                                                                                                                                                                    |
| `model` |         | The model the stage's threads use, as T3 Code's thread launch takes it: `provider` (T3 Code's provider instance, such as `claudeAgent` or `codex`), `model`, and optional `options`. The default is T3 Code's own default. |
| `mcp`   | `[]`    | The MCP servers the stage's threads, and the T3 Code subagents they start, may use, by their name in the repository's mapping (up to 20). agentgate's own tools are always there. Others are neither listed nor callable.  |

`mcp` narrows what a factory thread sees by default, so a stage reaches a cloud or database server only when you name it. It is not a security boundary: the thread runs with your login at full access and could start a process of its own.

### scorers/\<name\>.md

A judge is a thread of its own that grades a sample of finished stage runs against the rubric in the file's body, and reports one label. A run whose judge score falls below `pass` counts as flawed, which the learning thread studies. Judges change nothing in the repositories. The name is up to 40 lowercase letters, digits and dashes.

| Key           | Meaning                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- |
| `description` | Required. What the judge checks, up to 300 characters.                                    |
| `stages`      | Required. The stages whose runs it grades: `triage`, `spec`, `implement`, `review`.       |
| `labels`      | Required. 2 to 10 labels, each with a `value`, a `description` and a `score` from 0 to 1. |
| `pass`        | Required. The lowest passing score, from 0 to 1, at most the best label's score.          |
| `sample`      | The percentage of runs to grade; overrides `scoring.sample`.                              |
| `model`       | The judge's model, as for stages.                                                         |

The sample is picked by run id, so asking again picks the same runs.

### rulings.md

Your standing decisions for the factory, added to every stage's brief. Only you change it. The learning thread may cite it, and a learning PR that changes it is marked flawed and gets a comment saying so.

### skills/\<name\>/SKILL.md

Each skill is installed like any agentgate skill, synced to your machines, and linked into every repository under `repositories`. They show with the source `factory:<owner/repo>`. They follow the folder. A skill removed from it, or turning the factory off, removes it, and `agentgate skills update` leaves them alone. A name another skill already has is skipped and named in the board's events.

### An example

`factory.yaml`:

```yaml
version: 1
name: acme
description: Works Acme's bug reports from GitHub, Linear and the support desk.
repositories:
  acme/api:
    reviewers: [octocat]
  acme/web: {}
secrets: [LINEAR_KEY, GITHUB_HOOK, DESK_SIGNING]
limits:
  threads: 2
  stalledAfter: 30m
sources:
  - id: bugs
    type: github
    repo: Acme/API
    label: factory
    webhook:
      secret: secret:GITHUB_HOOK
  - id: linear
    type: linear
    repo: acme/web
    team: WEB
    label: Factory
    apiKey: secret:LINEAR_KEY
  - id: desk
    type: webhook
    repo: acme/api
    title: "{{body.ticket.subject}}"
    signature:
      header: X-Desk-Signature
      encoding: hex
      prefix: "sha256="
      secret: secret:DESK_SIGNING
learning:
  every: 14d
```

`stages/triage.md`:

```text
---
model:
  provider: claudeAgent
  model: claude-sonnet-5-5
---

Reproduce the report with a failing test before you route it.
```

`stages/implement.md`:

```text
---
start: manual
skill: debug
---

Fix the cause, not the symptom, and keep the diff small.
```

`scorers/tests.md`:

```text
---
description: Whether the PR's tests fail without the fix
stages: [implement, review]
labels:
  - value: proves
    description: A new test fails without the fix and passes with it
    score: 1
  - value: partial
    description: Tests cover the change but would pass without the fix
    score: 0.5
  - value: none
    description: No test covers the change
    score: 0
pass: 0.5
sample: 50
---

Read the diff and the tests. Check out the base commit and run the new tests against it.
```

`rulings.md`:

```text
# Rulings

- Public API responses keep their field names; add fields, never rename them.
- A fix that changes stored data needs a migration that can run twice.
```

`skills/release-notes/SKILL.md`:

```text
---
name: release-notes
description: Write release notes for a merged factory PR.
---

Summarize the change for users in one sentence.
```

## Sources

Every source has an `id` (up to 40 lowercase letters, digits and dashes, unique in the file), a `type` and the `repo` its items are fixed in. `intake: hold` makes each new item wait for `agentgate factory approve <item>` before triage; `agentgate factory reject <item>` turns it away.

The factory polls every source every 2 minutes, and backs off while one fails. An issue the factory has finished does not come back by itself; `agentgate factory retry owner/repo#42` takes it in again.

### GitHub

```yaml
- id: bugs
  type: github
  repo: acme/api
  label: factory # open issues with this label become items
  intake: auto # default
  webhook: # optional: a delivery makes the factory look now
    secret: secret:GITHUB_HOOK
```

Items are named after the repository and the issue, such as `api-42`, or `acme-api-42` when two of the folder's repositories share a name; the branch is `factory/api-42`. The PR says `Fixes #<number>`, so merging it closes the issue. An issue that carries the labels of two sources is one item.

When the factory takes an issue in, it comments "The factory took this." with the marker that keeps your other machines' intake away from it. If that comment fails, the issue stays unmarked, and `agentgate factory show <item>` lists the comment as failed.

### Linear

```yaml
- id: linear
  type: linear
  repo: acme/web
  team: WEB # the team's key
  label: Factory # open issues in the team with this label become items
  apiKey: secret:LINEAR_KEY
  intake: auto # default
  webhook: # optional
    secret: secret:LINEAR_HOOK
```

Create a personal API key in Linear's settings and store it with `agentgate factory secret set LINEAR_KEY`. Items are named after the Linear issue, such as `web-42`, and the PR's title starts with the issue's key so Linear links it. Linear drops hidden HTML comments, so the factory's comments end with a visible line, `agentgate-factory:1 {...}`, that tells your machines which one holds the issue. Leave it in place. Only the first 1,000 open labelled issues are read per poll; the board's source row says so when a team has more.

### Webhooks

A `webhook` source turns each delivery into an item:

```yaml
- id: desk
  type: webhook
  repo: acme/api
  intake: hold # default: anyone with the URL can add items, so you approve each one
  title: "{{body.ticket.subject}}" # required
  body: "{{body}}" # default: the whole delivery
  dedupe: "{{body.ticket.id}}" # optional: one item per key
  dedupeWindow: 1h # default
  signature: # optional, but without it the URL is the only check
    header: X-Desk-Signature
    encoding: hex # or base64
    prefix: "sha256=" # default ""
    secret: secret:DESK_SIGNING
```

Templates fill in `{{body}}` (the delivery as sent), `{{body.a.b}}` (a value from a JSON body), `{{headers.name}}` and `{{query.name}}`; a missing value is empty. A title that comes out empty refuses the delivery. A delivery whose `dedupe` key matches an item from the same source within `dedupeWindow` is answered as a duplicate and adds nothing. The signature is an HMAC-SHA256 of the exact body with the secret.

Each webhook source, and each GitHub or Linear source with `webhook`, gets a URL on the relay, `https://<relay>/hook/<key>`. `agentgate factory status` prints it once the factory machine has made it, within a minute of loading the folder; the `/factory` page and agents never see it. Give that URL to the sender:

- **GitHub**: the repository's **Settings → Webhooks**, content type `application/json`, the `GITHUB_HOOK` secret's value as the secret, and the **Issues** event.
- **Linear**: a webhook in Linear's API settings for **Issues**; store the signing secret Linear shows with `agentgate factory secret set LINEAR_HOOK`.

A GitHub or Linear delivery only makes the factory poll that source now, so a forged one costs one poll. A webhook source's delivery carries the item itself, which is why it waits for your approval by default.

What to expect:

- The relay answers for the factory machine, and nothing is queued. While that machine is offline a delivery gets `503`, and the sender must try again. GitHub and Linear sources catch up at their next poll anyway.
- Answers: `202` accepted, `200` a duplicate, `401` a bad signature, `422` an empty title, `429` while 20 of the source's items wait for your approval, `503` when the machine is offline or the signing secret is not set yet.
- Deliveries are limited to 1 MiB of UTF-8 text. The relay reads them, unlike sync traffic; see [webhook endpoints](../operations/relay.md#remote-mcp-endpoints).
- The URL stays when the factory moves to another machine. Removing the source from `factory.yaml` deletes it.

### By hand

```sh
agentgate factory add acme/api "Exports time out for large accounts" --body "Seen on accounts with over 10,000 rows."
```

Agents can do the same with the `agentgate__factory_add` tool, but their items wait for `approve` before triage starts a full-access thread on them. Items added by hand are named `m-<6 characters>`; they have no issue to comment on, so the board and the PR are where you follow them.

## Secrets

Values that `factory.yaml` names as `secret:NAME`, such as the Linear API key and webhook signing secrets. Names are capital letters, digits and `_`, starting with a letter.

```sh
printf %s "$LINEAR_KEY" | agentgate factory secret set LINEAR_KEY   # the value comes from stdin, never an argument
agentgate factory secret list                                       # names only, and the declared ones not set yet
agentgate factory secret delete LINEAR_KEY
```

Secrets are copied to every paired machine, so whichever machine runs the factory has them, and they travel end-to-end encrypted through the relay. Like other agentgate secrets, they are stored unencrypted in each machine's `agentgate.db`. `agentgate export --no-secrets` leaves them out. A deleted secret stays deleted on a machine that was offline. Nothing the factory prints, logs or shows on the board contains a value.

## While it runs

Watch the board with `agentgate factory status`, or turn on the page with `agentgate dashboard on` (add `--node` for another machine) and open `/factory` on that machine's address. The page needs no sign-in, like the [machine dashboard](../../README.md#machine-dashboard), so anyone on your tailnet can read item titles and questions while it is on. It shows the items by stage with their PRs, review rounds and open findings, what waits for you, capacity, sources, every machine's T3 Code threads, recent events, and the last 7 days' numbers: PRs merged, merge rate, reverts within 14 days, median hours to merge, how often a person stepped in per item, tokens per merged PR, and each judge's pass rate by folder commit. Agents read the same board through the `agentgate__factory_status` tool.

An item is in one of these stages: `held`, `triage`, `spec`, `implement`, `pr` (a draft PR exists and its checks run), `review`, `ready`, and when it ends, `shipped` (the PR was merged) or `closed`. Items are named by their key, such as `api-42`, or their id; a bare number works while only one item has it.

`agentgate factory show <item>` tells what happened to one: its runs with their state, thread and last error, the comments the factory posted or failed to post, and its events. `agentgate factory pause` stops intake, new threads and nudges, and keeps everything else as it is; running threads finish their turn. `agentgate factory resume` starts them again.

When an item waits for you, it stays in its stage and the board says why:

| Reason     | What happened                                                                                                                                                             | What to do                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `held`     | A new item from a source with `intake: hold`, or an item before a stage with `start: manual`.                                                                             | `approve` starts the stage; `reject` closes it with a comment.                                  |
| `approval` | The thread asks you something in T3 Code, such as the spec's Approve or Change.                                                                                           | Answer in T3 Code. For the spec card, `approve` or `reject --reason "<changes>"` also answers.  |
| `decision` | A stage reported a question with its recommendation.                                                                                                                      | `approve` takes the recommendation, or `approve --reason "<your answer>"`; `reject` refuses it. |
| `blocked`  | A stage reported what it is missing.                                                                                                                                      | Provide it, then `approve --reason "<what changed>"`.                                           |
| `stalled`  | The implement thread sat on a PR problem after every nudge.                                                                                                               | Look at the thread and fix it there, or `drop` the item.                                        |
| `budget`   | The item went over `limits.itemTokens` and its threads were stopped.                                                                                                      | Raise the limit, then `retry`, or `drop`.                                                       |
| `failed`   | A stage ended twice without reporting, or you asked for spec changes twice.                                                                                               | Read the thread, then `retry` or `drop`.                                                        |
| `stuck`    | Nothing moved the item for four times `limits.stalledAfter`, such as a launch that keeps failing; or a launch may have started a thread before T3 Code's sign-in changed. | Read `show <item>`, look for the thread in T3 Code, then `retry` or `drop`.                     |
| `orphaned` | The machine that held the issue is unreachable.                                                                                                                           | `retry owner/repo#42` (or the Linear key) takes it over here.                                   |

- `reject` on a spec card answers **Change** with your reason as the feedback, and the spec gets another round.
- `retry` takes an item that waits as `failed`, `budget`, `stalled` or `stuck` back to work: an item with a PR goes on with that PR, and any other starts its stage again in a new thread. A `closed` item starts again at triage, and a triage that had closed it counts as a wrong call for learning.
- `drop` stops the item's threads and closes it with a comment. Its PR, if it has one, stays open for you to close.

A stage thread whose turn ends without a report is reminded once, then the stage starts again in a new thread; a second silent end makes the item wait for you as `failed`. A turn that waits on a command or a subagent is still working. The factory comments on the item's issue at most once for each moment, even when GitHub or Linear did not confirm the comment.

On the PR, the factory wakes the implement thread itself when the thread sits idle on a problem: a failing check or a conflict at the PR's head, or comments from the repository's owner, members and collaborators since the thread's last push, which it quotes. It wakes the thread once for each new problem, and again after `limits.stalledAfter`; after `limits.nudges` times the item waits for you as `stalled`. Nobody else's comments reach the thread, unless the repository sets `watchPullRequests`. A PR without checks counts as passing once its head is 10 minutes old. If you merge a PR before the factory calls it ready, the item ships and the event list says so.

## Learning and judges

- **Learning**: every `learning.every`, or now with `agentgate factory learn`, a thread in a worktree of the factory repository studies the finished runs, judge scores, review comments, reverts and the repositories' own merged PRs, and opens one PR against the folder with the sections Targets, Runs addressed, Evidence and Expected effect. It never merges and never changes `rulings.md`; you review its PR like any other, and the factory loads the change once it is merged.
- **Judges**: the files in `scorers/`, described above.

## Several machines

One machine runs the factory. It polls the sources, starts the threads in its T3 Code, and holds the items. On your other machines, `agentgate factory` commands and the agents' factory tools reach it over Tailscale or the relay, and `status` shows its board.

- **Handing off a stage thread** works like any thread (`agentgate handoff`). The run goes with it: the thread reports from the other machine, and the factory reaches it there. A moved thread is not reminded when its turn ends without a report, and its spec card must be answered in T3 Code on that machine.
- **Moving the factory**: `agentgate factory use <the same folder> --node <machine>`. Each machine finishes the items it already holds, and keeps its T3 Code sign-in until the last one is done. The new machine's intake leaves alone every issue another machine marked as taken, and its board shows them with the machine that holds them. One whose machine has not been seen for a minute shows as `orphaned`, and `agentgate factory retry owner/repo#42` (or its key) takes it over, starting again at the stage it reached; `retry` refuses while that machine is online. Webhook and hand-added items have no issue to mark, so they stay with their machine.
- Dropping an item while its thread is being handed off leaves the thread running on the machine it arrives on. Stop it there in T3 Code.

## Commands

| Command                                                                      | What it does                                                   |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `factory use <owner/repo>[:<path>] [--ref <branch\|tag>] [--node <machine>]` | Turn the factory on, or point it at another folder or machine. |
| `factory off`                                                                | Turn it off.                                                   |
| `factory reload`                                                             | Fetch and check the folder now.                                |
| `factory status [--json]`                                                    | The board, with the webhook URLs.                              |
| `factory add <owner/repo> <title> [--body <text>]`                           | Add an item by hand.                                           |
| `factory approve\|reject\|retry\|drop <item> [--reason <text>]`              | Answer, restart or stop an item.                               |
| `factory show <item> [--json]`                                               | An item's runs, comments and events.                           |
| `factory pause` / `resume`                                                   | Stop intake, new threads and nudges, and start them again.     |
| `factory secret set <NAME>` / `list` / `delete <NAME>`                       | Manage secrets; `set` reads the value from stdin.              |
| `factory t3 [sign-in]`                                                       | The factory's sign-in to T3 Code's MCP.                        |
| `factory learn`                                                              | Start the learning thread now.                                 |

The control API has the same operations under `/api/factory`.
