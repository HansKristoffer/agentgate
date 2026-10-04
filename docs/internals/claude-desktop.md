# Claude Desktop

Agentgate switches Claude Desktop between saved logins and can put its Code tab behind the pool
([`desktop.ts`](../../apps/agentgate/src/desktop.ts)). Desktop's storage is undocumented; every path
and key is kept in `DESKTOP`. The user guide is [Using Agentgate with Claude Desktop](../user/claude-desktop.md).

## Decisions

- Pool routing through settings cannot cover the Code tab: Desktop forces
  `ANTHROPIC_BASE_URL=https://api.anthropic.com` on the CLI it starts. Gateway mode (the `Claude-3p`
  profile with `deploymentMode: "3p"`) exists for that reason.
- Saved logins are cookie and token values copied as they are, never decrypted; they are encrypted with
  this Mac's Keychain key. They live only in the `local` table: this Mac only, no sync, no backup.
- Desktop's own Log out ends the session on the server, so "add account" signs out locally only
  (`switchLogin(s, null)`), keeping saved logins valid.

## Traps

- Never force-kill Desktop; it may be asking about unsaved work.
- `open` hands the caller's environment to Desktop, so `host.open` passes a clean one.
- `writeLogin` deletes all matching cookie rows before inserting. Accounts have different cookie counts,
  so an upsert would leave stale rows.
- Cookies and tokens must belong to the same account. A failed `config.json` write restores the old
  cookies, the `desktop:switching` journal finishes a switch a crash left halfway, and a lease (re-checked
  after the backup) keeps the CLI and daemon from switching at once.
- The outgoing login is saved before switching. A login that exists but cannot be read refuses the
  switch instead of being erased. Logins from a different cookie schema or Desktop major version are
  refused before Desktop is quit.
- The first backup uses `VACUUM INTO`, so data still in the WAL is included.
- Desktop starts MCP servers with a reduced PATH, so the shim falls back to `/usr/bin/git`.
