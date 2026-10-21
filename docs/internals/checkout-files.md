# Checkout files

A repository's gitignored files (`.env.local`, `apps/expo-app/.env`) live in a per-machine **file store** that
[buncargo](https://github.com/HansKristoffer/buncargo) defines and copies into every checkout, keeping local edits. Buncargo owns
what happens inside a checkout. Agentgate owns moving the store between machines and carrying a checkout's local edits
in a handoff ([`checkout-files.ts`](../../apps/agentgate/src/checkout-files.ts)).

## The contract (owned by buncargo)

This is a copy of buncargo's checkout files spec (on its `checkout-files` branch). If they differ, buncargo's wins;
fix this side and its fixture stores in `test/checkout-files.test.ts`.

- Store root: `$HOME/.buncargo/files`.
- Repo key, from `git remote get-url origin` in the checkout:
  - scp form `user@host:path` → `host/path`; URL form `scheme://[user[:pass]@]host[:port]/path` → `host/path` (drop the port);
  - strip a trailing `/` and `.git`, lowercase the whole key;
  - it must match `^[a-z0-9.-]+(/[a-z0-9._-]+)+$`; otherwise, or without an origin:
    `local/<first 16 hex of sha256(realpath of the git common dir)>`. Such stores are machine-bound and never sync.
  - `https://github.com/Bliss-Budget/budget-app.git` and `git@github.com:Bliss-Budget/budget-app.git` both give
    `github.com/bliss-budget/budget-app`.
- Store dir `<root>/<repo key>/`, directories 0700, files 0600:
  - `manifest.json`: `{ "version": 1, "files": { "<path>": { "sha256": "<hex of data bytes>", "updatedAt": "<ISO-8601 UTC>", "machine": false } } }`
  - `data/<path>`: the exact bytes. `<path>` is a POSIX path relative to the checkout root: no `..`, no leading `/`,
    no backslash; at most 1 MiB.
- Writing: take the lock, write data files (temp + rename in the same directory), then the manifest (temp + rename),
  release. Removing: drop the manifest entry, then the data file. Readers trust the manifest; a data file whose sha256
  differs from its entry counts as absent (mid-write) and is retried; data files without an entry are ignored.
- Lock: `mkdir <store dir>/.lock` (atomic), then write `{ "pid", "host", "createdAt" }` to `.lock/owner.json`. It is
  stale when the pid is dead on this host or it is older than 30 seconds. Remove the directory to release.
- An unknown `version`: leave the store alone and warn.
- `machine: true` entries never leave their machine.
- In a checkout that uses buncargo (`dev.config.ts` and buncargo in `node_modules`):
  `bunx buncargo files status --json` → `{ "version": 1, "repoKey": "...", "files": [ { "path", "state", "machine" } ] }`
  with `state` one of `in-sync`, `store-newer`, `local-edits`, `conflict`, `missing`; and
  `bunx buncargo files pull [path…]` copies the store into the checkout and never overwrites local edits.

## Decisions

- The store travels on the `project` record (`files`), not a record kind of its own, so older nodes keep syncing
  ([overview](overview.md#versions-and-old-nodes)). Older daemons drop the field when they save a project, so no node
  writes it until every node reports node protocol 6.
- Projects are GitHub `owner/repo`, so only `github.com/<owner>/<repo>` stores sync. Other hosts and `local/` stores stay
  on their machine.
- Agentgate never runs buncargo for store sync: it works per machine, and buncargo exists only inside a repository, at
  the version that repository pins. It runs buncargo only inside a checkout (`files pull`, `files status`).
- Each file merges on its own by `updatedAt`, and a removed file stays on the record as `deleted`. A file missing from
  one side is unknown there, not deleted. That is what lets two machines save different files while apart: the record
  as a whole is last-writer-wins, and the losing machine merges its own files back in the next pass. Each node keeps
  what it last reconciled (`checkoutFiles:base:<project>`, node-local) to tell a file removed from its store from one
  it never had.
- One project record must fit one relay entry (1 MiB sealed), so all of a repository's files together can be about
  700 KiB. A larger set stays on its machine with an error, rather than blocking relay uploads.
- File contents are secrets: status shows only paths, reading or editing contents is loopback-only, and
  `export --no-secrets` drops them. On disk in `agentgate.db`
  they are plaintext, like MCP secrets.
- A checkout's dev daemon uses `.agentgate/home/.buncargo/files` and runs buncargo with that `HOME`, so it never reads or
  writes the real store.
