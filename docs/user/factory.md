# The software factory

The factory works issues in T3 Code threads until a pull request is ready for you to merge. The [README](../../README.md#software-factory) says what it does and how to start it. This guide covers the folder that defines a factory, its sources and secrets, what you do while it runs, and running it with several machines.

## Before you start

On the machine that runs the factory:

- **T3 Code** is running and connected to agentgate (`agentgate t3 connect`). The factory signs in to T3 Code's MCP server by itself with a pairing code from T3 Code's `t3` command, at full access, and shows up as "AgentGate factory" under T3 Code's **Settings → Connections**. The sign-in lasts 30 days and is renewed before it ends. `agentgate factory t3` shows it, and `agentgate factory t3 sign-in` tries again after a failure.
- **`gh`** is signed in to an account that can read the factory repository and push to its repositories. Everything the factory writes on GitHub carries that login.
- **`git`** is installed. The factory fetches its folder with it, through `gh`'s login, so a private factory repository works.
- **agentgate's MCP server** is in the Claude Code or Codex that T3 Code runs (`agentgate setup --primary`, or `setup --mcp`). Stage threads report through it, and tokens are only counted for sessions that go through agentgate.
- **Worktree cleanup** is on in T3 Code (**Settings → Worktree cleanup**) for the repositories the factory works. Every stage runs in a worktree of its own, set up like any T3 Code thread, and the factory settles a stage's thread when it finishes; T3 Code removes the worktree only when told to remove worktrees after their thread settles, or once their PR merged. Without it, a large repository's worktrees fill the disk.

Every paired machine must run a release that knows the factory before you turn it on or set a secret, since older releases drop the setting and stall on secret records. `agentgate factory use` names the machines to update.

`agentgate factory doctor` checks all of this, each with its fix, and `doctor --canary` starts one short thread that only reports back, which proves the whole chain; `init` and `use` print the checks once the factory is on, and `status` and the app lead with any that fail.

## Turning it on and off

The quickest start is `agentgate factory init acme/api`, or **Start a factory** in the app's Factory view (or a project's menu in Projects). It keeps a new folder in agentgate, with a `factory.yaml` for that repository (one GitHub source on the label `factory`, or the one `--label` names) and an empty `rulings.md`, creates the label, and turns the factory on. Nothing is pushed to the repository. The folder is copied to every paired machine and kept in backups, and `off` leaves it, so `agentgate factory use --store agentgate` turns it on again. Init refuses while a factory is on (add the repository to it with `repo add` instead) and while agentgate already keeps a folder. It creates the label with the `gh` login of the machine it runs on, which is the machine the app is connected to.

A folder in a git repository works too: `use` turns the factory on at one.

```sh
agentgate factory init acme/api                         # a folder kept in agentgate, and the factory on
agentgate factory use acme/factory                      # factory.yaml at the root of a repository
agentgate factory use acme/tools:factory --ref stable   # the factory folder in acme/tools, at a branch or tag
agentgate factory use --store agentgate                 # the folder agentgate keeps
agentgate factory use acme/factory --node srv           # run it on srv instead of the always-on machine
agentgate factory reload                                # read and check the folder now
agentgate factory off
```

The factory checks a folder in git every 2 minutes and loads a new commit when its branch moves. A commit with a mistake in it never replaces the last good one: `agentgate factory status` shows the error, naming the file and field, and the factory keeps running the commit before. Each item finishes under the commit it started with.

Whatever reaches that branch changes every later brief, and factory threads push with your `gh` login. Protect the branch on GitHub if your plan allows it (free private repositories cannot), so changes to the folder go through a pull request; `use` warns when it is not protected.

`off` stops the factory and signs it out of T3 Code's MCP. Its items stay in the machine's tables.

### Repositories

One factory works in every repository its `factory.yaml` lists. `repo add` lists one more, with a GitHub source for its issues labelled `factory` (or `--label`), and creates the label; `repo remove` takes a repository out with its sources and scouts, and is refused while it has open items. On the folder agentgate keeps, the change applies at once; on a folder in git, it opens a PR, and the repository joins or leaves once you merge it. Both keep the rest of `factory.yaml` as you wrote it, comments included. **Add to the factory** in a project's menu in Projects does what `repo add` does.

```sh
agentgate factory repo add acme/web                  # its issues labelled factory
agentgate factory repo add acme/docs --label agent
agentgate factory repo remove acme/docs
```

### The folder agentgate keeps

Edit it under **Stored folder** in the app's Factory settings, or from the CLI. Every save is checked like a new commit, and one that leaves a broken folder is refused with the file and field, so the stored folder always loads. Each change is a new folder commit, named by the SHA-256 of its files, and items finish under the commit they started with. When two machines save at the same moment, the later save wins.

```sh
agentgate factory folder ls                                   # its files and commit
agentgate factory folder cat stages/implement.md
agentgate factory folder put stages/implement.md < implement.md   # add or replace a file; the first put starts a folder
agentgate factory folder rm stages/implement.md
agentgate factory folder delete                               # only while the factory runs elsewhere or is off
```

`folder export <dir>` writes its files into a directory, to commit them to a repository and `use` it there; it refuses a directory with files in it unless you add `--force`. `folder import <dir>` replaces the folder with a directory's files, such as a checkout of a factory folder in git, then `use --store agentgate` turns the factory on at it. An import is checked as a whole, so a broken folder is refused and the current one stays; while the factory runs on the stored folder, it loads at once. Names that start with a dot, such as `.git`, are left out. Both run on the machine you type them on, never over remote management.

## The folder

```text
factory/                  any folder in a git repository, or the one agentgate keeps
  factory.yaml            required
  rulings.md              your standing rulings, added to every brief
  stages/<stage>.md       replaces a stage's built-in brief: triage, spec, implement or review
  scouts/<id>.md          a scout: its settings as frontmatter, and its prompt
  skills/<name>/SKILL.md  a skill installed into every repository the factory works in
```

Editors check `factory.yaml` against the JSON Schema in [`packages/protocol/factory.schema.json`](../../packages/protocol/factory.schema.json). With the YAML language server, put this on the first line:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/HansKristoffer/agentgate/main/packages/protocol/factory.schema.json
```

Durations are a number and `m`, `h` or `d`, such as `15m` or `7d`. Unknown keys are errors. Each key's default and
limits are in that schema, made from `factoryConfigSchema` in
[`packages/protocol/src/factory.ts`](../../packages/protocol/src/factory.ts), and a stage file's in `stageFileSchema`
beside it. [An example](#an-example) shows a whole folder.

### factory.yaml

| Key                        | Meaning                                                                                                                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                  | Required. Always `1`.                                                                                                                                                                                                                                             |
| `name`                     | Required. Up to 40 lowercase letters, digits and dashes.                                                                                                                                                                                                          |
| `description`              | Up to 500 characters.                                                                                                                                                                                                                                             |
| `repositories`             | Required. The repositories the factory works in, as `owner/repo` keys.                                                                                                                                                                                            |
| `repositories.*.reviewers` | Up to 10 GitHub logins or `org/team` names to request reviews from when a PR is ready. GitHub refuses to request a review from the PR's author, so that login is left out.                                                                                        |
| `limits.threads`           | Stage threads working at once. A thread waiting for you, or sitting idle on its PR, does not count.                                                                                                                                                               |
| `limits.waitForQuota`      | Wait to start a thread while no account in the pool for its provider has room. Without accounts for that provider, T3 Code uses its own login and nothing waits.                                                                                                  |
| `limits.waitingForYou`     | Intake pauses while this many items wait for you, PRs ready for your review included.                                                                                                                                                                             |
| `limits.itemTokens`        | The tokens one item may use across all its threads and their subagents, cache reads included. An item over it has its threads stopped and waits for you in its stage; raise the limit and run `retry` to go on. The current folder's value applies to every item. |
| `limits.reviewRounds`      | Review rounds before the PR goes to you with the findings still open. `0` skips the review stage.                                                                                                                                                                 |
| `limits.nudges`            | Times the factory reminds an implement thread of a PR problem it sits on before the item waits for you.                                                                                                                                                           |
| `limits.stalledAfter`      | How long a thread may sit idle on a failing check, a conflict, a review comment or review findings before the factory nudges it, or sends the PR to you.                                                                                                          |
| `sources`                  | GitHub, Linear and webhook sources, up to 50. Scouts are files in `scouts/`. See [Sources](#sources).                                                                                                                                                             |
| `stages.<stage>.note`      | A note for this project, added after that stage's brief (triage, spec, implement or review) under "For this project", up to 4,000 characters. It keeps the built-in brief and adds to it; see [stages/\<stage\>.md](#stagesstagemd).                              |

Repository names are matched without regard to case, and a source names a repository listed under `repositories`.

### stages/\<stage\>.md

The file's body replaces the stage's built-in brief. To add to the built-in brief instead, for example how to run this project's tests, write a note in `factory.yaml`:

```yaml
stages:
  triage:
    note: Start the API with `docker compose up` before you reproduce.
  implement:
    note: Never change files under migrations/.
```

A note follows the brief, built in or from this file, so a project keeps getting the built-in brief's improvements. Whatever the body says, the factory adds the item (fenced as untrusted data), `rulings.md` and how to report, so a stage file cannot leave them out. The frontmatter is optional:

| Key     | Meaning                                                                                                                                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start` | `manual` holds each item before this stage until you run `agentgate factory approve <item>`. In `stages/triage.md` it holds every new item.                                                                                |
| `model` | The model the stage's threads use, as T3 Code's thread launch takes it: `provider` (T3 Code's provider instance, such as `claudeAgent` or `codex`), `model`, and optional `options`. The default is T3 Code's own default. |
| `mcp`   | The MCP servers the stage's threads, and the T3 Code subagents they start, may use, by their name in the repository's mapping (up to 20). agentgate's own tools are always there. Others are neither listed nor callable.  |

`mcp` narrows what a factory thread sees by default, so a stage reaches a cloud or database server only when you name it. It is not a security boundary: the thread runs with your login at full access and could start a process of its own. A stage that should check its work in a browser needs that server named too, such as `mcp: [chrome-devtools]`. Threads try their tools before they report `blocked`, so a stage that keeps reporting it is missing access, such as a secrets manager or a deploy log, usually needs that server in its `mcp`.

The built-in briefs are a starting point. Triage closes reports that do not come from production (a CI runner, a developer's machine, test data) or that a third-party outage caused, asks you before anything about accounts, permissions, payments, other people's data, CI, deployment or secrets, and sends changes over about 400 lines to spec, which cuts a first slice. The implement thread fixes the cause everywhere it shows up, checks a change that shows on screen in the running app, stops what it started, and reads its whole diff as a reviewer would before it opens the PR. The review thread runs focused passes, as subagents where its agent can start them: correctness, tests (with the fix reverted), reuse and simplicity, efficiency, security, and the repository's own rules. It reports only findings it confirmed in the code, and the risk of the change. A `stages/review.md` replaces those passes with your own.

### rulings.md

Your standing decisions for the factory, added to every stage's brief. Only you change it. HTML comments (`<!-- -->`) are notes for whoever edits the file and never reach a brief; the file `factory init` writes asks two questions in one: whether the project is greenfield or has live data, and which packages you own, so causes in them are fixed there.

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
stages:
  implement:
    note: Run `bun test` in the package you changed before you open the PR.
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
model:
  provider: claudeAgent
  model: claude-opus-5-5
---

Fix the cause, not the symptom, and keep the diff small.
```

`stages/review.md`, on another provider than implement, since different models make different mistakes:

```text
---
model:
  provider: codex
  model: gpt-5
---

Review the PR in focused passes, and report only findings you confirmed in the code.
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

The factory polls every source every 2 minutes, and backs off while one fails. An issue the factory has finished does not come back by itself. `agentgate factory retry api-42` takes it in again while the machine that runs the factory still has the item: items are kept for 90 days, and stay behind when the factory moves to another machine.

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

Items are named after the repository and the issue, such as `api-42`, or `acme-api-42` when two of the folder's repositories share a name; the branch is `factory/api-42`, or `factory/api-42-2` when GitHub already has a branch of that name. The PR says `Fixes #<number>`, so merging it closes the issue. An issue that carries the labels of two sources is one item.

When the factory takes an issue in, it comments "The factory took this." While its machine's `gh` is offline or logged out, `agentgate factory show <item>` lists the comment as unreachable and the factory sends it again until it goes through, for up to a day; a comment GitHub refused is listed as failed.

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

Create a personal API key in Linear's settings and store it with `agentgate factory secret set LINEAR_KEY`. Items are named after the Linear issue, such as `web-42`, and the PR's title starts with the issue's key so Linear links it. Linear drops hidden HTML comments, so the factory's comments end with a visible line, `agentgate-factory:1 {...}`, that tells the factory what it has done with the issue. Leave it in place. Only the first 1,000 open labelled issues are read per poll; the board's source row says so when a team has more.

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
  only: # optional: only deliveries whose value is listed become items
    value: "{{body.event}}"
    in: [ticket.created, ticket.reopened]
  signature: # optional, but without it the URL is the only check
    header: X-Desk-Signature
    encoding: hex # or base64
    prefix: "sha256=" # default ""
    secret: secret:DESK_SIGNING
```

Templates fill in `{{body}}` (the delivery as sent), `{{body.a.b}}` (a value from a JSON body), `{{headers.name}}` and `{{query.name}}`; a missing value is empty. A title that comes out empty refuses the delivery. With `only`, a delivery whose `value` is not one of `in` is answered and adds nothing, for senders that post every change to a record. A delivery whose `dedupe` key one of the source's items has, open or finished within `dedupeWindow`, is answered as a duplicate and adds nothing. While intake is paused, or waits because too many items wait for you, a delivery waits for approval even with `intake: auto`. The signature is an HMAC-SHA256 of the exact body with the secret.

Each webhook source, and each GitHub or Linear source with `webhook`, gets a URL on the relay, `https://<relay>/hook/<key>`. `agentgate factory status` prints it once the factory machine has made it, within a minute of loading the folder; the `/factory` page and agents never see it. Give that URL to the sender:

- **GitHub**: the repository's **Settings → Webhooks**, content type `application/json`, the `GITHUB_HOOK` secret's value as the secret, and the **Issues** event.
- **Linear**: a webhook in Linear's API settings for **Issues**; store the signing secret Linear shows with `agentgate factory secret set LINEAR_HOOK`.

A GitHub or Linear delivery only makes the factory poll that source now, so a forged one costs one poll. A webhook source's delivery carries the item itself, which is why it waits for your approval by default.

Sentry alerts can come in the same way, through an integration's webhook for issues, with its client secret stored as `SENTRY_HOOK`:

```yaml
- id: sentry
  type: webhook
  repo: acme/api
  title: "{{body.data.issue.title}}"
  body: "{{body.data.issue.web_url}}"
  only:
    value: "{{body.action}}"
    in: [created, unresolved]
  dedupe: "{{body.data.issue.id}}-{{body.action}}"
  dedupeWindow: 1d
  signature:
    header: Sentry-Hook-Signature
    encoding: hex
    secret: secret:SENTRY_HOOK
```

Sentry sends a delivery for every change to an issue (created, resolved, assigned and so on). `only` keeps a new issue and one that came back after it was resolved, which usually means a fix did not hold; the rest add nothing. The dedupe key keeps repeats of one change to one item, and an issue that comes back while its item is still open adds nothing either.

What to expect:

- The relay answers for the factory machine, and nothing is queued. While that machine is offline a delivery gets `503`, and the sender must try again. GitHub and Linear sources catch up at their next poll anyway.
- Answers: `202` accepted, `200` a duplicate, `401` a bad signature, `422` an empty title, `429` while 20 of the source's items wait for your approval, `503` when the machine is offline or the signing secret is not set yet.
- Deliveries are limited to 1 MiB of UTF-8 text. The relay reads them, unlike sync traffic; see [webhook endpoints](../operations/relay.md#remote-mcp-endpoints).
- The URL stays when the factory moves to another machine. Removing the source from `factory.yaml` deletes it.

### Scouts

A scout looks for work on a schedule, such as slow endpoints, new errors or outdated dependencies. Each time, a T3 Code thread follows its prompt in a worktree of `repo`, and reports what it finds. Each finding becomes an item that goes through triage, a fix and review like any other.

A scout is one file, `scouts/<id>.md`: its settings as frontmatter, then the prompt. The file's name is the scout's id, which no source in `factory.yaml` may share. `scouts/production.md` checks what shipped yesterday:

```markdown
---
repo: acme/api
schedule:
  at: "09:00" # quoted, or some YAML tools read it as a number
  days: [mon, tue, wed, thu, fri] # default: every day
  timezone: Europe/Copenhagen # default: UTC
mcp: [railway] # optional: MCP servers the thread may use
intake: auto # default; hold makes each finding wait for approve
dedupeWindow: 14d # default
enabled: true # default
model: # optional, like a stage file's
  provider: claudeAgent
  model: claude-sonnet-5-5
---

Check the pull requests merged from 30 hours ago up to 6 hours ago (on a Monday, from 78 hours ago) in production. For each, find the Railway deploy that shipped it and compare the errors, logs and call volumes of what it touched before and after. File a fix that did not hold, and anything that got quieter without throwing: a job that stopped running, a webhook or an integration whose calls dropped. File an incident you see on the way too, even when no pull request caused it, with the numbers and their time spans. Say "cause not confirmed" when you cannot tell.
```

A check like this finds what tests and error trackers miss, because a job that stops or an email that is never sent throws nothing. The fixed window by the clock lets daily runs cover every merge once, since a run remembers nothing of the last.

- **When it runs**: `schedule: { every: 6h }` runs it that long after its last run, and at once the first time (at least `1h`). `at` runs it at that time on those days. A run that cannot start within an hour of its time, because the machine was off or intake was paused, is skipped until the next one. `agentgate factory scout production` and the **Run now** button run it at once. `enabled: false` keeps it in the folder but runs it only when you ask.
- **What it can use**: agentgate's tools, the repository, and the servers in `mcp`. A server must also be mapped to the repository's project, as for any session there. The thread changes no code and opens no PRs or issues.
- **Its tickets**: every finding a run reports is filed; say in the prompt how many are worth a run. Each finding has a key the thread chooses, such as `slow-orders-list`. A finding whose key one of the scout's items has, open or finished within `dedupeWindow`, is skipped, and the thread sees those keys so it can reuse them. A reworded key gets through as a new item. Findings wait for approval with `intake: hold`, and also while intake is paused or waits for you; nothing more is filed while 20 of its items wait.
- The board shows each scout's schedule, its next run, and what its last run filed, with a link to its thread.
- Its last run is remembered on the factory's machine, so after the factory moves, an `every` scout runs once at the next chance. A move does not wait for a scout that is running, and what that run finds is lost.

### Adding a webhook or a scout

The app's Factory view has **New webhook** and **New scout** under Status → Sources. The CLI takes the same as YAML on stdin:

```sh
agentgate factory source add <<'YAML'
source:
  id: perf
  type: scout
  repo: acme/api
  schedule: { every: 1d }
prompt: |
  Look at the p95 latency of every API endpoint over the last day.
YAML
```

For a folder kept in agentgate, either one changes the folder at once, and the source starts within 2 minutes. Otherwise it opens a PR on the factory's folder, with the `gh` login of the machine that runs the command. For a webhook, the PR adds the source at the end of `sources` in `factory.yaml`, keeping the file's comments; for a scout, it adds `scouts/<id>.md`. For a signed webhook, set its secret after the merge with `agentgate factory secret set`. The source starts when you merge the PR. The PR goes to the branch the factory follows. When the factory follows a tag, it goes to the default branch instead, with a warning. A `factory.yaml` it cannot edit safely, such as one with `sources` written on one line, is refused with the YAML to paste in yourself.

### By hand

```sh
agentgate factory add acme/api "Exports time out for large accounts" --body "Seen on accounts with over 10,000 rows."
```

Agents can do the same with the `agentgate__factory_add` tool, but their items wait for `approve` before triage starts a full-access thread on them. Grok, or another assistant that takes a server URL, can follow and steer the factory through a virtual project's endpoint with its factory switch on (`agentgate remote factory @grok on`); its tasks start at triage, and it can approve, reject, retry and drop items, so treat that URL and secret like your own login. An updates webhook on that endpoint (`agentgate remote webhook @grok <https-url>`) gets the same posts as `factory notify`. See [Your MCP servers and skills in Grok](../../README.md#your-mcp-servers-and-skills-in-grok). Items added by hand are named `m-<6 characters>`; they have no issue to comment on, so the board and the PR are where you follow them.

## Secrets

Values that `factory.yaml` names as `secret:NAME`, such as the Linear API key and webhook signing secrets; nothing declares them separately. Names are capital letters, digits and `_`, starting with a letter.

```sh
printf %s "$LINEAR_KEY" | agentgate factory secret set LINEAR_KEY   # the value comes from stdin, never an argument
agentgate factory secret list                                       # names only, and the declared ones not set yet
agentgate factory secret delete LINEAR_KEY
```

Secrets are copied to every paired machine, so whichever machine runs the factory has them, and they travel end-to-end encrypted through the relay. Like other agentgate secrets, they are stored unencrypted in each machine's `agentgate.db`. `agentgate export --no-secrets` leaves them out. A deleted secret stays deleted on a machine that was offline. Nothing the factory prints, logs or shows on the board contains a value.

## While it runs

The app's **Factory** view is the place to follow and steer it. Items that wait for you come first, with their question, the recommendation and options, the daemon's buttons for what you can do (each says what it does), and **Open in T3 Code** for the thread that asks. Below are the stages as columns; an item opens to its runs (each with its thread), the comments the factory posted and its events. Tabs show the status, sources with their webhook URLs and scout schedules (and buttons to add a webhook or scout), every machine's threads, the week's metrics and recent events, and Settings has pause and resume, reload, the T3 Code sign-in, moving the factory, turning it off, and the notify URL and secrets (on a local connection only). It works the same whichever machine the app is connected to.

Watch the board with `agentgate factory status`, or turn on the page with `agentgate dashboard on` (add `--node` for another machine) and open `/factory` on that machine's address. The page needs no sign-in, like the [machine dashboard](../../README.md#machine-dashboard), so anyone on your tailnet can read item titles and questions while it is on. It shows the items by stage with their PRs, review rounds and open findings, what waits for you, capacity, sources, every machine's T3 Code threads, recent events, and the last 7 days' numbers: PRs merged, merge rate, reverts within 14 days, median hours to merge, how often a person stepped in per item, and tokens per merged PR. Agents read the same board through the `agentgate__factory_status` tool.

An item is in one of these stages: `held`, `triage`, `spec`, `implement`, `pr` (a draft PR exists and its checks run), `review`, `ready`, and when it ends, `shipped` (the PR was merged) or `closed`. Items are named by their key, such as `api-42`, or their id; a bare number works while only one item has it.

`agentgate factory show <item>` tells what happened to one: its runs with their state, thread and last error, the comments the factory posted or failed to post, and its events. `agentgate factory pause` stops intake, new threads and nudges, and keeps everything else as it is; running threads finish their turn. `agentgate factory resume` starts them again.

An item that needs nobody says what it waits for, in `status`, the app and the page: a free thread, quota, the default branch's CI, its PR's checks, the implement thread's fixes for a review round, or another try at a launch that failed.

When an item waits for you, it stays in its stage, and `status`, `show`, the app and the comment on its issue all show the same block: what happened, the question, the recommendation and options when there are any, and each action you can take with what it will do. What you must do is one of three things:

| Kind        | Causes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | What you do                                                                                                                                                                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **start**   | `held`: a new item from a source with `intake: hold`, or an item before a stage with `start: manual`.                                                                                                                                                                                                                                                                                                                                                                                                    | `approve` starts the stage; `reject` closes it with a comment.                                                                                                                                                                                                        |
| **answer**  | `decision`: a stage reported a question with its recommendation. `blocked`: a stage reported what it is missing. `question`: the thread asks you something in T3 Code, such as the spec's Approve or Change; the wait shows what it asks, the spec included.                                                                                                                                                                                                                                             | `approve` with no text goes with the recommendation, `approve --reason "<your answer>"` answers in your words, and `reject` refuses it. For a blocker, provide it, then `approve --reason "<what changed>"`. Answer other thread questions in T3 Code.                |
| **stopped** | `failed`: a stage ended twice without reporting, or you asked for spec changes twice. `stalled`: the implement thread sat on a PR problem after every nudge. `stuck`: nothing moved it for four times `limits.stalledAfter`, or a launch may have started a thread before T3 Code's sign-in changed. `budget`: it went over `limits.itemTokens`. `stopped`: someone stopped its thread in T3 Code. `handed-off`: you handed its thread to another machine. `deleted`: its thread was deleted in T3 Code. | `retry` goes on: an item with a PR with that PR (when its thread was deleted, a new implement thread takes the PR over), any other with its stage in a new thread. Raise the limit first for `budget`. The factory never starts a thread you stopped again by itself. |

The factory comments on the issue when an item needs an answer or stopped, not when it waits to start. You can answer on a GitHub issue too: a comment after the factory's newest one, from the repository's owner, members or collaborators and without a factory marker, is read at the next intake pass (every 2 minutes, at most `limits.waitingForYou` items each pass). `/approve` and `/reject <reason>` act like the commands; any other text answers a question in your words, and does nothing on an item waiting to start. Each comment is used once, and the factory's next comment shows it was taken. Linear issues are answered with the CLI, the app or T3 Code.

GitHub never notifies you of comments your own login writes, and the factory comments as your `gh` login. `agentgate factory notify <https-url>` (or **Notifications** in the app's Factory settings) gives it a URL to post to when an item starts waiting for you and when a PR is ready. Each POST is JSON with a top-level `text` line, the question or the PR and a link, so a Slack-compatible incoming webhook shows it as it is, plus `node` and `updates` (`seq`, `at`, `kind`, `text` and the item). A failed post is tried once more a few seconds later. The URL is kept as a secret on every machine, set only from a machine itself, and shown by its host only; `agentgate factory notify` shows it and `notify off` stops it. The app marks its Factory view while items wait for you and sends a system notification at the same two moments, and the thread that asks is marked unread in T3 Code.

A `closed` item can be retried too: it starts again at triage. `reject` on a spec card answers **Change** with your reason as the feedback, and the spec gets another round.

- `drop` stops the item's threads and closes it with a comment. Its PR, if it has one, stays open for you to close.

A stage thread whose turn ends without a report is reminded once, then the stage starts again in a new thread; a second silent end makes the item wait for you as `failed`. A turn that waits on a command or a subagent is still working. The factory comments on the item's issue at most once for each moment, even when GitHub or Linear did not confirm the comment.

When the PR goes ready, the factory adds a section to the end of its description: each claim the implementer checked with its evidence, what it did not check, what the last review round left open or saw elsewhere, and the reviewer's risk notes (whether a revert undoes the change, how far a mistake reaches, changes the item did not ask for, and where to look first). It is written once, at ready, and names the commits it covers; later pushes leave it as it is. At the same moment, each problem the last review round found in code the PR did not change, and each slice the spec left for later, becomes an issue in the repository, without your source's label and with a line saying the factory filed it. Labelling one is how you approve it: the factory takes it in like any other issue. Review rounds before that stay between the factory's threads. To route sensitive paths, such as auth or billing, to the people who own them, add a `CODEOWNERS` file: GitHub requests code owners when the factory marks the PR ready.

On the PR, the factory wakes the implement thread itself when the thread sits idle on a problem, and quotes what was written:

- a failing check or a conflict at the PR's head;
- an open review conversation, a comment on a line, started or answered by the repository's owner, members or collaborators, or by any bot;
- reviews from those people and bots, and PR comments from those people, that the thread has not been shown yet. A bot's plain PR comment, such as a deploy preview, asks for nothing.

After the thread pushes a fix, it tells the factory which conversations it fixed and which it declined, and why. The factory replies "Fixed in `<commit>`" and resolves each fixed conversation. A declined one gets the thread's reason as a reply and stays open for you; it comes back to the thread only when someone answers it.

The factory wakes the thread once for each new problem, and again after `limits.stalledAfter`; after `limits.nudges` times the item stops as `stalled`. Nobody else's comments reach the thread. If you merge a PR before the factory calls it ready, the item ships and the event list says so.

When a branch requires checks, through a branch protection rule or a ruleset, only those count; otherwise every check does. The PR waits until each check that counts has passed, so a failing check the branch does not require, such as a preview deploy, holds nothing back, and a PR without checks counts as passing once its head is 10 minutes old. The factory reads a commit's first 100 checks, so a commit with more never counts as passing, though a failure among those 100 still counts. A new fix waits while a check that counts fails on the default branch's newest commit; a required check that runs only on pull requests is not waited for there.

## Several machines

One machine runs the factory. It polls the sources, starts the threads in its T3 Code and follows the PRs, and no other machine works on an item. On your other machines, `agentgate factory` commands and the agents' factory tools reach it over Tailscale or the relay, and `status` shows its board.

- **Handing off a stage thread** (`agentgate handoff`) takes it out of the factory: it becomes your thread on the other machine, and the item waits for you as `handed-off`. When you are done with it, `retry` starts the stage again here, or `drop` closes the item. A PR the thread opened is still followed: merging it ships the item.
- **Moving the factory**: `agentgate factory move <machine>`, or **Move…** in the app's Settings, keeps the folder and its ref. With no item open, the factory moves at once. Otherwise the machine that runs it finishes its open items first. It takes in no new issues, and a webhook delivery or a scout's finding waits for your approval, as while paused. The board and `status` say "Moving to srv once 3 items finish", and when the last one has shipped or closed and its last comment is posted, the factory moves by itself. An item that waits for you is open too, a PR ready for your review included, so answer it, merge it or `drop` it. `agentgate factory move` to the machine that runs it now cancels a move that waits.
- **Moving it now**: `agentgate factory move <machine> --now`, or **Move now** in the same dialog, does not wait. It is for when the machine that runs the factory is gone, or its items are not worth the wait. What that machine has open stays frozen there: a thread that is working finishes its turn, nothing more is started or followed for those items, and they are not on the new machine's board. The new machine takes their issues in again from triage, and a draft PR the old item opened stays open for you to close. On the old machine, `agentgate factory status` and the app list what is frozen, each with its id. Move the factory back to go on with those items where they stopped, or run `agentgate factory drop <id>` on that machine to close one; an item's key names the item on the machine that runs the factory. An item from a webhook, a scout or `factory add` has no issue, so nothing takes it in again: it waits on the old machine until you do one or the other.

## Commands

| Command                                                                      | What it does                                                                                                               |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `factory init <owner/repo> [--label <label>] [--node <machine>] [--json]`    | Start a factory for a repository, its folder kept in agentgate, and turn it on.                                            |
| `factory use <owner/repo>[:<path>] [--ref <branch\|tag>] [--node <machine>]` | Turn the factory on, or change its folder. Another `--node` moves it at once, like `move --now`.                           |
| `factory use --store agentgate [--node <machine>]`                           | Turn the factory on with the folder agentgate keeps.                                                                       |
| `factory folder ls\|cat <path>\|put <path>\|rm <path>\|delete`               | Read and edit the folder agentgate keeps; `put` reads the file from stdin.                                                 |
| `factory folder export <dir> [--force]` / `import <dir>`                     | Write the folder agentgate keeps into a directory, or replace it with one's files.                                         |
| `factory repo add <owner/repo> [--label <label>]` / `remove <owner/repo>`    | Add a repository and its labelled issues, or take one out: a PR on a folder in git, at once on the folder agentgate keeps. |
| `factory move <machine> [--now]`                                             | Run the same folder on another machine once the open items finish; `--now` does not wait, and leaves them frozen.          |
| `factory off`                                                                | Turn it off.                                                                                                               |
| `factory reload`                                                             | Fetch and check the folder now.                                                                                            |
| `factory status [--json]`                                                    | The board, with the webhook URLs.                                                                                          |
| `factory doctor [--canary] [--json]`                                         | Check what the factory needs, each with its fix; exit 1 if any fails. `--canary` runs one thread that only reports.        |
| `factory add <owner/repo> <title> [--body <text>]`                           | Add an item by hand.                                                                                                       |
| `factory approve\|reject\|retry\|drop <item> [--reason <text>]`              | Answer, restart or stop an item.                                                                                           |
| `factory show <item> [--json]`                                               | An item's runs, comments and events.                                                                                       |
| `factory pause` / `resume`                                                   | Stop intake, new threads and nudges, and start them again.                                                                 |
| `factory secret set <NAME>` / `list` / `delete <NAME>`                       | Manage secrets; `set` reads the value from stdin.                                                                          |
| `factory notify [<https-url> \| off]`                                        | Post to your URL when an item waits for you or a PR is ready; shows its host, or turns it off.                             |
| `factory t3 [sign-in]`                                                       | The factory's sign-in to T3 Code's MCP.                                                                                    |
| `factory scout <id>`                                                         | Run a scout now.                                                                                                           |
| `factory source add [--json] < source.yaml`                                  | Add a webhook source or scout: a PR, or at once for a folder kept in agentgate.                                            |

`agentgate factory help` lists them all. Each command is one operation, and the control API takes every operation by its name, the words after `factory`, with its input as JSON: `POST /api/factory/op/secret%20list`. `GET /api/factory` is the board.
