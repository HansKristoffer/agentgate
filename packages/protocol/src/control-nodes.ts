import type { z } from "zod";
import type { nodeSchema } from "./index.ts";

type Node = z.output<typeof nodeSchema>;
type Relayed = { command: string; cleanupPending: boolean };

/** The machines family's control operations the app calls, by name (see control.ts). */
export interface NodeOps {
  "nodes always-on": { input: { node: string; on: boolean }; result: Node };
  /** `args` is what `agentgate join` takes on a machine that has agentgate already; `command` installs it too. */
  pair: {
    input: { method: "tailnet" | "relay"; name?: string; relayUrl?: string };
    result: { method: "tailnet" | "relay"; command: string; args: string; expiresIn?: number; notes: string[] };
  };
  /** `command`: a pasted `agentgate join …` line, or the whole install line around it. `peer`: the machine paired
   * with over Tailscale; absent for a relay group. The counts are what this machine has after the first sync. */
  join: {
    input: { command: string };
    result: { peer?: string; accounts: number; servers: number; projects: number };
  };
  /** Endpoints that got a new URL, and the new relay join command when removing a relay machine rotated the secret. */
  unpair: {
    input: { node: string };
    result: { endpoints: { project: string; url: string }[]; rotated?: Relayed };
  };
  dashboard: { input: { node: string; on: boolean }; result: Node };
  "nodes update": { input: { node: string }; result: { node: string; version?: string; restarting: boolean } };
  "nodes route": { input: { node: string; on: boolean }; result: { node: string; message: string } };
  "relay reconcile": { input: Record<string, never>; result: { ok: true } };
  "relay rotate": { input: Record<string, never>; result: Relayed };
  "relay leave": { input: { wipe?: boolean }; result: { cleanupPending: boolean } };
  "relay cleanup": { input: { abandon?: boolean }; result: { cleanupPending: boolean } };
  "relay key": { input: { key: string | null }; result: { ok: true } };
  /** Where handoffs put new worktrees and clones on that machine. A folder left out keeps its value. */
  "t3 dirs": {
    input: { worktrees?: string; clones?: string };
    result: { worktreesDir: string; cloneDir: string };
  };
}
