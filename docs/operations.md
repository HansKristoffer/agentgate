# Agentgate operations

The daemon owns the local SQLite store, subscription pool, MCP gateway and peer sync. Tauri is an optional client of the JSON control API. Every paired machine can continue independently; Tailscale carries peer traffic.

Account and MCP OAuth refreshes use holder coordination and a local cross-process lease. During a network partition, separate machines can still compete for a rotating provider token. Reconnect peers and sync the newer credential first; sign in again if the provider invalidated it. This is not a consensus protocol.

Back up before upgrading and upgrade paired nodes together. Management API 2 and sync protocol 4 reject incompatible app/daemon and peer versions. New backups use format 3; current Agentgate can also restore formats 1 and 2. Re-run setup and reinstall the user service after changing the home, port or binary location. The service executable is kept outside the desktop bundle so closing or updating the app does not remove the daemon.

A backup exported without secrets is a configuration inventory, not a working credential backup. Restore transports and logins separately; use a private full backup to restore working credentials. Deleted-record history is kept for safe offline peer catch-up.

Skill sync uses byte-bounded pages so initial pairing and offline catch-up can exceed 16 MiB. Each page commits independently; an interrupted pull resumes at the last committed cursor. Skill records and project assignments remain subject to the store's existing last-writer-wins replica policy.

Local skill reconciliation runs independently every 30 seconds, with event-driven retries for worktree creation. Publication failures restore the previous disk copy; interrupted swaps are recovered on restart. The two-rename directory swap has a brief availability gap during successful updates. Skills → **Skills need attention** reports filesystem/watch errors and case-variant project IDs that require consolidation. Managed skill links are kept out of Git status, and mirroring repository-owned skills is an explicit local opt-in.

The app/API restore limit is 16 MiB of serialized JSON. For larger inventories, restore on the daemon's machine with `agentgate import /absolute/path/backup.json`; the CLI validates the full backup before committing it. Exported backups can exceed the app restore limit. Protect skill sources and script contents as part of the backup.

Only pool accounts you own and use them within the provider's applicable terms. Automated fixture checks do not establish provider permission or support for every live CLI version.

## Distribution checks

CI covers fake provider traffic, OAuth state validation, replica/store invariants, MCP reconnects, frontend builds and standalone binary smoke tests on macOS/Linux, plus native Rust checks and app packaging on macOS. Before relying on a new provider or service-install change, also check real provider login/traffic, T3 sessions, two physical machines over Tailscale, and installed launchd/systemd behavior after logout/reboot.
