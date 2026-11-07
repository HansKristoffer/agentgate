# Factory live check

CI drives the factory against fakes of T3 Code, GitHub and Linear. This procedure checks it against the real ones
before a release that changes the factory, and after a T3 Code nightly that changes the tools it calls. Run it on the
always-on server, with the maintainer at hand, against a scratch repository that nothing else uses. Record the
results in the PR that ships the change: each step, what you saw, and anything that differed.

## Setup

- A scratch repository, such as `<you>/factory-scratch`, with a test that can fail, a CI workflow, and a branch
  protection rule on its default branch if your plan allows one.
- A factory folder in a second repository, with `limits.threads: 2`, `limits.stalledAfter: 15m`, a GitHub source on
  the scratch repository with `webhook: { secret: secret:GITHUB_HOOK }`, and a `webhook` source with a `signature`.
  Give `stages/implement.md` an `mcp:` list with one server the scratch repository maps, and leave another mapped
  server out.
- T3 Code's current nightly, connected (`agentgate t3 connect`), and `agentgate setup --primary` done on the server.
- `agentgate factory use <folder> --node <server>`. Note whether it warns that the folder's branch is unprotected.
- `agentgate dashboard on` on the server, so `/factory` shows the board.

## Steps

1. **One issue to a merged PR.** Open an issue that the failing test reproduces, and label it.
   - The issue gets "The factory took this." within 2 minutes, then the triage comment.
   - The implement thread opens a draft PR on `factory/<repo>-<n>`, and the issue gets its comment.
   - In the implement thread's T3 Code session, the MCP tools list agentgate's tools and the server the stage names,
     not the one left out. Ask the thread to list its tools if T3 Code does not show them.
   - The review thread runs focused passes (as subagents where its agent can) and leaves no review on the PR. The PR
     goes ready with your reviewers requested, the issue says so, and the PR's description ends with the factory's
     summary: claims with evidence, what was not checked, the last round, and risk notes. Merge it: the item ships,
     its threads settle, and the issue's last comment says shipped.
   - Compare with an item reviewed by the release before: findings per round, rounds until clean, any finding that was
     wrong, and the review runs' tokens from `agentgate factory show <key>`. Note whether a Codex review thread
     started subagents.
   - `agentgate factory show <key>` lists every run with its thread, and each comment as posted.
2. **One issue through a spec.** Label an issue that needs a decision, such as a feature with two reasonable designs.
   - Triage routes it to spec, and the spec thread asks Approve or Change in T3 Code.
   - `agentgate factory reject <key> --reason "<a change>"` starts a second round, and `approve` starts implement.
3. **A restart mid-launch.** Add an item with `agentgate factory add`, and restart the daemon
   (`agentgate service stop`, then `start`) while the board shows its run `starting`.
   - After the restart, T3 Code shows exactly one thread for the run, and the run is `running`.
4. **A PR merged early.** With an item in `pr` or `review`, merge its PR yourself.
   - The item ends `shipped`, not `closed`, with one shipped comment, and the events say it was merged before the
     factory called it ready. A queued review run is cancelled.
5. **A move and back.** With an item in `implement`, run `agentgate factory move <laptop>`.
   - The server keeps its T3 Code sign-in (`agentgate factory t3` on the server) and finishes the item; the laptop's
     board shows it as held by the server.
   - A new labelled issue is taken by the laptop. Move the factory back with `agentgate factory move <server>` once the item shipped,
     and check that the server takes the next issue.
6. **A signed webhook.** Send one delivery to the webhook source's URL from `agentgate factory status`, signed with
   its secret, and one with a wrong signature.
   - The signed one answers `202` and adds a `held` item; the other answers `401` and adds nothing.

7. **Start from the app.** With the factory off, press **Start a factory** in the app's Factory view for a second scratch
   repository.
   - A draft PR adds `factory/factory.yaml` and `factory/rulings.md` on `agentgate/factory-init`, the `factory` label
     exists, and the board shows the factory on at that branch.
   - Label an issue: it shows under Needs you or a stage, and **Open in T3 Code** opens its thread. Try it on a thread
     another machine holds, and record whether that opens.
   - Merge the PR: within 2 minutes the events say the factory follows the default branch.

## Things to record

- The status the implement thread shows in the board's threads while a T3 Code subagent it started works (`waiting`,
  `running`, or idle with a working child). The controller assumes such a thread is still working.
- Any tool or input the sign-in reports missing; refresh `test/fixtures/t3-tools.json` as
  [the internals](../internals/factory.md#t3-code-coupling) describe.
- Tokens per item on the board, and whether any item shows tokens as unknown.
