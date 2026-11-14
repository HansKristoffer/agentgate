import type { z } from "zod";
import type { accountSchema, LoginStart, modelPolicySchema, Provider } from "./index.ts";

/** An account as saved, with the revision a later change of it passes to be refused if someone else changed it first. */
type Saved = z.output<typeof accountSchema> & { revision: string };
/** `revision` may be left out: each of these writes one field, so it cannot undo another change. */
type Change<T> = { input: { id: string; revision?: string } & T; result: Saved };
type One = { input: { id: string }; result: Saved };

/** The accounts family's control operations the app calls, by name (see control.ts). */
export interface AccountOps {
  "accounts claude-code login": { input: Record<string, never>; result: { url: string; opened: boolean } };
  "accounts claude-code cancel": { input: Record<string, never>; result: null };
  "accounts claude-code finish": { input: { code: string }; result: null };
  "accounts rename": Change<{ label: string }>;
  "accounts priority": Change<{ priority: number }>;
  "accounts policy": Change<{ policy: z.input<typeof modelPolicySchema> }>;
  "accounts enable": One;
  "accounts disable": One;
  "accounts pin": One;
  "accounts unpin": One;
  "accounts rm": { input: { id: string }; result: { id: string } };
  import: { input: { provider: Provider; dir: string; label?: string }; result: { id: string } };
  /** The browser sign-in: `start` gives the provider's page, `finish` takes the pasted code (Cursor has none, and
   * answers `pending` until its sign-in is done), `cancel` forgets an attempt. */
  "accounts login start": { input: { provider: Provider; label?: string; email?: string }; result: LoginStart };
  "accounts login finish": { input: { state: string; code?: string }; result: { id: string } | { pending: true } };
  "accounts login cancel": { input: { state: string }; result: null };
}
