import { MAX_AGENTS_MD, projectSchema } from "@agentgate/protocol";
import { checkRevision } from "./configuration.ts";
import { UserError } from "./ops/registry.ts";
import { requireNodeProtocol, type Store } from "./store.ts";

/** The global AGENTS.md: text on the Global defaults project that every machine writes to its agentgate home and
 * links in as Claude Code's CLAUDE.md and Codex and Antigravity's AGENTS.md (`SkillLinks`). */

/** The node protocol that keeps `agentsMd` on the Global defaults project (see NODE_PROTOCOL in remote.ts). */
export const AGENTS_MD_PROTOCOL = 11;

export const agentsMd = (s: Store) => s.get("project", "*")?.agentsMd ?? "";

/** Replaces the global AGENTS.md on every machine; empty text removes it. `expected` is a Global defaults revision. */
export function setAgentsMd(s: Store, text: string, expected?: string) {
  s.transaction(() => {
    if (expected !== undefined) checkRevision(s, "project", "*", expected);
    if (text === agentsMd(s)) return;
    if (text.length > MAX_AGENTS_MD) throw new UserError(`AGENTS.md is over ${MAX_AGENTS_MD / 1024} KB`);
    // Removing needs no wait: an older daemon dropping the field reads as removed.
    if (text) requireNodeProtocol(s, AGENTS_MD_PROTOCOL, "drop the global AGENTS.md when they save Global defaults");
    const { agentsMd: _, ...defaults } = s.get("project", "*") ?? projectSchema.parse({ id: "*" });
    s.put("project", "*", text ? { ...defaults, agentsMd: text } : defaults);
  });
}
