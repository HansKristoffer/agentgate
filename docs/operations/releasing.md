# Releasing Agentgate

Squash PRs with conventional titles. Release Please updates one release PR with the root and `apps/desktop/tinyjs.json` versions plus a changelog. Keep the `@hanskristoffer/agentpool` release identity: it is the existing npm package; the installed binary remains `agentgate`.

Merging the passing release PR tags the commit and runs npm/binary publication and the signed universal macOS build. Select **Approve workflows to run** on the bot-created release PR, then wait for its PR checks before merging. GitHub requires this approval with the built-in repository token; manual CI dispatches do not satisfy branch protection. `scripts/npm.ts` publishes platform packages before the main package so optional dependencies resolve. It skips existing versions and fails on registry errors.

Configure npm trusted publishing for `@hanskristoffer/agentpool` and all four `agentpool-{darwin,linux}-{arm64,x64}` packages: owner `HansKristoffer`, repository `agentgate`, workflow `release.yml`, no environment, publish permission. Node 24 supplies compatible npm. No npm token is needed.

If publication fails, manually run Release with the existing release tag. An existing version is skipped, so partially published platform sets can be completed. A source fix needs a new release; npm versions are immutable. `build-macos.yml` also accepts an existing tag for rebuilding desktop assets. Inspect both paths before announcing availability.

Apple signing secrets are listed in the README. Installed apps accept an update only when it is signed by the same Apple team, so changing teams strands them. Platform binaries carry SHA256SUMS. See [running agentgate](running.md#distribution-checks) for the live distribution checks beyond CI.

GitHub documents this token behavior in [Triggering a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).
