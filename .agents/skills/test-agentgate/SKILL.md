---
name: test-agentgate
description: Run and exercise agentgate's daemon, CLI and desktop app from this checkout against isolated dev state, with realistic data. Use to confirm a change works in the running daemon rather than only in unit tests, or when asked to run, start or try agentgate.
---

# Test agentgate

Everything here runs from the checkout. The checkout's code keeps its own state in the gitignored
`.agentgate` folder on a port derived from the checkout path, and refuses to touch the machine's real
service, `~/.claude`, `~/.codex` or Claude Desktop. Leave `AGENTGATE_HOME` and `AGENTGATE_PORT` unset
so that stays true. Never run the installed `agentgate` binary or point anything at `~/.config/agentgate`.

## Get realistic data

With no dev daemon running, seed the checkout from a scrubbed copy of the live store:

```sh
bun run seed-dev-store            # --force replaces an existing dev store
```

Accounts arrive signed out, and MCP servers arrive without secrets. That is deliberate: the dev daemon
must never refresh a real token. If a flow needs a working login, ask the developer before signing in
with `bun run cli -- login claude --label dev-test`; never import a login from `~/.claude` or `~/.codex`.

Without seeding, run `bun run cli -- init --name dev` for an empty node.

## Start the daemon

Start it in the background and keep its PID or terminal session:

```sh
bun start
```

The first log line prints the address (`http://127.0.0.1:<port>`). Read the port from it; do not assume
7878, which belongs to the developer's live daemon.

## Exercise the change

- **CLI:** `bun run cli -- <command>` talks to the dev daemon, for example `status`, `accounts`,
  `mcp ls`, `project ls`, `skills ls`. `accounts exhaust <id> [min]` fakes a limit for pool tests.
- **Control API:** `curl -s http://127.0.0.1:<port>/api/status`. Loopback needs no token. Do not send an
  `Origin` header; the API rejects browser requests.
- **Proxy:** point a client at `http://127.0.0.1:<port>/anthropic` or `/codex/...` only with a working
  test login, and only when the developer agreed to spend real quota.
- **Desktop app:** only when the developer asks. Stop your daemon first, then run `bun run dev`, which
  starts the daemon and the Tauri app together against the same dev state. It needs Rust and Xcode tools.

Capture the output that proves the behavior, then report it with the commands you ran.

## Stop

Stop only what you started, by the PID or session you kept. Never `pkill` by name: the developer's live
service and other worktrees' dev daemons match the same patterns. Leave `.agentgate` in place unless the
developer asks you to reset it; it is gitignored.
