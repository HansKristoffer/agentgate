# Coding standards

Read this when reviewing a diff. It holds the judgement calls a compiler or test cannot make; anything mechanical belongs in a check instead. [AGENTS.md](AGENTS.md) still applies, especially "Hit every surface".

## Secrets stay out of what we print

- Text from a caught error can carry a token, a header value, a command environment or a URL with credentials. Before it reaches the daemon log, status, an API response or an MCP result, cut it to the error's name or a capped message from a source that cannot hold those.
- An error from a remote MCP server or provider goes to the client as a generic message. The detail goes to the daemon log, redacted as above.

## Credentials across machines

- A change to who refreshes a credential, or to when a login counts as dead, needs a test where a peer is offline and one where this node just woke from sleep. Rotating refresh tokens punish a guess.
- A token the provider refused is never sent again.

## Nothing hangs, nothing outlives the daemon

- Every network call and every child process has a deadline.
- A process that can start children of its own, such as a user's setup script or git over ssh, starts detached and is stopped with its whole group (`killGroup` in `apps/agentgate/src/runtime.ts`) when it runs past its deadline or its job or the daemon stops.
- A step that a daemon restart can interrupt either runs again safely or records that it finished. Check what the other machine sees while it is interrupted.

## One way to do a thing

- When the CLI and the API do the same thing, both call one function in `operations.ts`. Two copies drift, and the order of steps in a removal or rotation matters.
