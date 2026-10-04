# Skills

Skill bundles are records like everything else: SQLite holds the whole bundle, and each daemon writes
its own copy to disk and links it where it is assigned
([`skills.ts`](../../apps/agentgate/src/skills.ts), [`skill-links.ts`](../../apps/agentgate/src/skill-links.ts)).

## Decisions

- One validator, the protocol `skillSchema`, guards every way in: local writes, previews, peer merges and
  backup imports. Merges and imports bypass `putSkill`, so checks in individual helpers are not enough.
- Sync pages are bounded by bytes, and the cursor acknowledges only records actually included in the page
  (`changePage` in `store.ts`). Skill records easily exceed the 16 MiB peer read limit.
- Installs use the exact files from an immutable preview token, never a fresh fetch, and the `skills`
  CLI is pinned (`SKILLS_CLI_VERSION`).
- Project ids are canonicalized (`canonicalProject`); otherwise case variants create duplicate projects.
- Links agentgate creates are kept out of Git through `.git/info/exclude`. Mirroring a repository's own
  skills for the other agent is an explicit opt-in per checkout. Agentgate never replaces an entry it did
  not create; a clash is reported instead.
- A connected GitHub repository is a `skillRepos` entry on each project it feeds, not a record kind of its
  own, so older peers keep syncing (they drop the field) without a `SYNC_PROTOCOL` bump. Every node syncs
  connected repositories itself; identical content writes nothing, so nodes converge without a leader.
  Skills are deleted only when a fresh fetch no longer has them, or on disconnect, never because a node
  has not yet seen the project change; otherwise a lagging node could tombstone a live repository's skills.
- Checkout registration (`/api/checkout`) is loopback-only and sits behind the `/api/*` guard.

## Traps

- Publishing a new disk copy is a two-rename swap (`dir → .old`, `.tmp → dir`) with rollback and recovery
  on restart. There is a brief gap during the swap; avoiding it would need versioned directories behind a
  symlink.
- Claude Code and Codex read skills before a session's MCP servers start, so links must exist before a
  session launches. Watching worktrees cannot guarantee that for the first session; `skills prepare`
  exists for that.
