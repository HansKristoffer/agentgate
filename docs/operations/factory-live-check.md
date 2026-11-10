# Factory live check

CI drives the factory against fakes of T3 Code, GitHub and Linear. This procedure checks it against the real ones
before a release that changes the factory, and after a T3 Code nightly that changes the tools it calls. It runs from
a checkout, beside the live install and without touching it, against `HansKristoffer/factory-scratch`, a private
repository that nothing else uses, with a planted bug, a test that fails on it and a CI workflow. On a tiny
repository and a cheap model, one issue reaches ready in about 5 minutes. Record the results in the PR that ships the
change: each step, what you saw, and anything that differed.

## Setup

- **The checkout's daemon.** With no dev daemon running, `bun run seed-dev-store`, then `bun run dev` (the daemon and
  the desktop app, which step 8 uses) or `bun start` (the daemon only), and keep its terminal: it prints the port and
  state folder, and you stop it there, never by a pattern. Run every command below
  as `bun run cli -- factory …` from the checkout.
- **T3 Code**, its current nightly, connected to the dev daemon: `bun run cli -- t3 connect`. It shows up as a
  connection of its own under T3 Code's **Settings → Connections**.
- **Stage threads report to the checkout.** `setup --primary` and `setup --mcp` are refused from a checkout, so the
  scratch repository carries the route itself. Its `.mcp.json` names agentgate's MCP server as the checkout's
  `cli.ts mcp`, run by `bun`, and `.claude/settings.json` has `"enableAllProjectMcpServers": true` so Claude Code starts
  it without asking:

  ```json
  {
    "mcpServers": {
      "agentgate": {
        "type": "stdio",
        "command": "/home/<you>/.bun/bin/bun",
        "args": ["/<checkout>/apps/agentgate/src/cli.ts", "mcp"]
      }
    }
  }
  ```

  Both paths are absolute, and no `env` is needed: the shim finds the dev daemon by the port derived from the
  checkout's path. Point it at the checkout you are testing, and push that to the scratch repository's default branch
  before you start, since every stage's worktree starts from it. This entry replaces the
  user's own `agentgate` server in the scratch repository only. Codex does not read `.mcp.json`, so every stage runs
  on Claude here; a Codex review thread needs an install.

- **The factory.** `bun run cli -- factory init HansKristoffer/factory-scratch --node dev`. The seeded store keeps
  the live machines' records, and without `--node` the factory would go to the always-on one, which the dev daemon
  cannot reach. Then give each stage a cheap model with a stage file that has only frontmatter, which keeps the
  built-in brief:

  ```sh
  for stage in triage spec implement review; do
    printf -- '---\nmodel:\n  provider: claudeAgent\n  model: claude-sonnet-5-5\n---\n' |
      bun run cli -- factory folder put stages/$stage.md
  done
  ```

  For step 2, also give `stages/implement.md` an `mcp:` list with one server the scratch repository's project maps,
  and leave another mapped server out.

- `bun run cli -- dashboard on`, so `/factory` on the dev port shows the board.

Tokens read 0 here. T3 Code's sessions go through the live daemon's proxy, as `setup --primary` set them up, so the
dev daemon sees none of them: the `proxy` check warns, and token figures and `limits.itemTokens` need an install.

## Steps

1. **The checks.** `bun run cli -- factory doctor` (`init` printed it too). Expect every check `ok` except `proxy`,
   which warns as above. The `mcp` check passes on the user's own `~/.claude.json` and never sees the scratch
   repository's `.mcp.json`, so it proves nothing here. `bun run cli -- factory doctor --canary` does: one thread on
   triage's model that only reports back, `ok` within 90 seconds. Fix anything that fails before you go on.
2. **One issue to a merged PR.** Open an issue that the failing test reproduces, and label it `factory`.
   - The issue gets "The factory took this." within 2 minutes, then the triage comment.
   - The implement thread opens a draft PR on `factory/factory-scratch-<n>`, and the issue gets its comment.
   - In the implement thread's session, the MCP tools list agentgate's tools and the server the stage names, not the
     one left out. Ask the thread to list its tools if T3 Code does not show them.
   - The review thread runs focused passes (as subagents where its agent can) and leaves no review on the PR. The PR
     goes ready, the issue says so, and the PR's description ends with the factory's summary. Merge it: the item
     ships, its threads settle, and the issue's last comment says shipped.
   - Compare with an item reviewed by the release before: findings per round, rounds until clean, and any finding
     that was wrong.
   - `factory show <key>` lists every run with its thread, and each comment as posted.
3. **One issue through a question.** Label an issue that needs a decision, such as a feature with two reasonable
   designs.
   - Triage stops with one question and a recommendation, or routes it to spec, whose thread asks Approve or Change in
     T3 Code. The thread is marked unread in T3 Code; record whether T3 Code notifies you of it.
   - Answer once on the issue (`/approve`, or your answer in your own words) and once with
     `factory reject <key> --reason "<a change>"` on the spec card, which starts a second round. Each answer is taken
     once, and the factory's next comment shows it.
4. **A restart mid-launch.** Add an item with `factory add`, and stop the dev daemon in its terminal while the board
   shows its run `starting`, then start it again.
   - After the restart, T3 Code shows exactly one thread for the run, and the run is `running`.
   - Then stop that thread in T3 Code mid-turn. The item waits as `stopped`, the thread gets no reminder, and a T3 Code
     restart in the middle of another run's turn continues that turn instead of stopping its item.
5. **A PR merged early.** With an item in `pr` or `review`, merge its PR yourself.
   - The item ends `shipped`, not `closed`, with one shipped comment, and the events say it was merged before the
     factory called it ready. A queued review run is cancelled.
6. **A PR conversation.** On a PR the factory follows, leave a review comment on a line.
   - The implement thread is woken within the follower's 2 minutes, pushes a fix, and the factory replies
     "Fixed in `<commit>`" and resolves the conversation.
7. **A webhook source.** Add one with a `signature` (`factory source add`), and set its secret. The dev store has no
   relay of its own, so its URL is an endpoint on the hosted relay; removing the source from the folder deletes it.
   - `factory source test <id> < delivery.json` prints the title, body and what would happen, and adds nothing.
   - `factory deliver <id> < delivery.json` adds a `held` item.
   - Within a minute, `factory status` prints the URL, and `factory doctor` passes "The webhook URLs can receive
     deliveries", or fails it on a relay deployed before webhook URLs.
   - `factory source test <id> --send < delivery.json` answers `202` and adds a `held` item. The same delivery sent
     with a wrong signature, such as by `curl` to the URL, answers `401` and adds nothing.
8. **Start from the app.** With the factory off (`factory off`, then `factory folder delete`, since `init` refuses
   while agentgate keeps a folder), press **Start a factory** in the dev app's Factory view, with **Runs on** set to `dev`.
   - Nothing is pushed to the repository, the `factory` label exists, and Settings shows the factory on with its
     folder stored in agentgate.
   - Label an issue: it shows under Needs you or a stage, and **Open in T3 Code** opens its thread.
   - **Add to the factory** in another repository's menu in Projects adds it at once and creates its label;
     `factory repo remove` takes it out again.

## Needs an install

A seeded checkout has no peers, and its sessions do not pass through its proxy. Run these on the release candidate
installed on two paired machines, or record them as not run:

- **A move that waits, and one that does not.** With an item in `implement` on the server, label a second issue and
  run `agentgate factory move <laptop>` on the laptop. Both machines' `status` say "Moving to <laptop> once 1 item
  finishes", and the server does not take the second issue. Once the item has shipped, the factory moves within a
  minute: the server signs out of T3 Code (`agentgate factory t3` there), and the laptop takes the second issue. With
  that item in `pr`, `agentgate factory move <server> --now`: the laptop lists it as frozen, the server takes the
  issue in again on `factory/<repo>-<n>-2`, and `agentgate factory drop <id>` on the laptop closes the frozen item
  without a comment. Close the draft PR it left.
- **Tokens.** Tokens per item on the board, and whether any item shows tokens as unknown.

## Things to record

- The status the implement thread shows in the board's threads while a T3 Code subagent it started works (`waiting`,
  `running`, or idle with a working child). The controller assumes such a thread is still working.
- What GitHub answers today: `bun scripts/record-gh.ts` runs each read `gh.ts` makes against the scratch repository
  and writes new or changed entries into `test/fixtures/gh-recorded.json`; commit that diff if it has one.
- Any tool or input the sign-in reports missing; refresh `test/fixtures/t3-tools.json` as
  [the internals](../internals/factory.md#t3-code-coupling) describe.
