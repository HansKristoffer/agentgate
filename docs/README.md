# Agentgate docs

## Using agentgate

Start with the [README](../README.md).

- [Using Agentgate with Claude Desktop](./user/claude-desktop.md)
- [Proxy controls and diagnostics](./user/proxy.md)

## Running agentgate

- [Backups, upgrades and distribution checks](./operations/running.md)
- [The relay: trust model, limits and self-hosting](./operations/relay.md)
- [Releasing](./operations/releasing.md)

## Working on agentgate

Start with [AGENTS.md](../AGENTS.md). Internal notes keep architectural decisions, constraints and
traps the source alone does not explain. Most changes need no internal doc update; follow the
[documentation rules](../AGENTS.md#documentation) before adding one.

- [Architecture overview](./internals/overview.md)
- [Glossary](./internals/glossary.md)
- [Relay](./internals/relay.md)
- [Remote MCP endpoints](./internals/remote-mcp.md)
- [Skills](./internals/skills.md)
- [Claude Desktop](./internals/claude-desktop.md)
