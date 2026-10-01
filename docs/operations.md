# Agentgate operations

The daemon owns the local SQLite store, subscription pool, MCP gateway and peer sync. Tauri is an optional client of the JSON control API. Every paired machine can continue independently; Tailscale carries peer traffic.

Account and MCP OAuth refreshes use holder coordination and a local cross-process lease. During a network partition, separate machines can still compete for a rotating provider token. Reconnect peers and sync the newer credential first; sign in again if the provider invalidated it. This is not a consensus protocol.

Back up before upgrading and upgrade paired nodes together. Sync protocol 2 rejects older peers. Re-run setup and reinstall the user service after changing the home, port or binary location. The service executable is kept outside the desktop bundle so closing or updating the app does not remove the daemon.

A backup exported without secrets is a configuration inventory, not a working credential backup. Restore transports and logins separately; use a private full backup to restore working credentials. Deleted-record history is kept for safe offline peer catch-up.

Only pool accounts you own and use them within the provider's applicable terms. Automated fixture checks do not establish provider permission or support for every live CLI version.

## Distribution checks

CI covers fake provider traffic, OAuth state validation, replica/store invariants, MCP reconnects, frontend builds and standalone binary smoke tests on macOS/Linux, plus native Rust checks and app packaging on macOS. Before relying on a new provider or service-install change, also check real provider login/traffic, T3 sessions, two physical machines over Tailscale, and installed launchd/systemd behavior after logout/reboot.
