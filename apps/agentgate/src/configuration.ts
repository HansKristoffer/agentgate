import { ConfigurationConflict, settingsPatchSchema, type SettingsUpdateResult } from "@agentgate/protocol";
import type { Kind, Store } from "./store.ts";

/** A record's version as clients see it. Every write and merge moves rev, node or updated_at, so the hash leaves out
 * the data: a project's carries env file contents, and status shows its revision to every client. */
export function revision(s: Store, kind: Kind, id: string): string {
  const r = s.record(kind, id);
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(r ? [r.rev, r.node, r.updated_at, r.deleted] : null))
    .digest("hex");
}
export function checkRevision(s: Store, kind: Kind, id: string, expected: string) {
  if (revision(s, kind, id) !== expected) throw new ConfigurationConflict();
}
/** A patch of one setting may leave out `expected`: it writes only that key, so it cannot undo another change. A patch
 * of several is a draft of the whole form and needs it. */
export function patchSettings(s: Store, patch: unknown, expected?: string): SettingsUpdateResult {
  const parsed = settingsPatchSchema.parse(patch);
  if (expected === undefined && Object.keys(parsed).length !== 1) throw new ConfigurationConflict();
  return s.transaction(() => {
    if (expected !== undefined) checkRevision(s, "setting", "settings", expected);
    const settings = s.put("setting", "settings", {
      ...s.settings(),
      ...parsed,
    });
    return { ...settings, revision: revision(s, "setting", "settings") };
  });
}
