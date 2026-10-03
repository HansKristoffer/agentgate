import {
  ConfigurationConflict,
  settingsPatchSchema,
  type SettingsUpdateResult,
} from "@agentgate/protocol";
import type { Kind, Store } from "./store.ts";

export function revision(s: Store, kind: Kind, id: string): string {
  const r = s.record(kind, id);
  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify(
        r ? [r.rev, r.node, r.updated_at, r.deleted, r.data] : null,
      ),
    )
    .digest("hex");
}
export function checkRevision(
  s: Store,
  kind: Kind,
  id: string,
  expected: string,
) {
  if (revision(s, kind, id) !== expected) throw new ConfigurationConflict();
}
export function patchSettings(
  s: Store,
  patch: unknown,
  expected: string,
): SettingsUpdateResult {
  const parsed = settingsPatchSchema.parse(patch);
  return s.transaction(() => {
    checkRevision(s, "setting", "settings", expected);
    const settings = s.put("setting", "settings", {
      ...s.settings(),
      ...parsed,
    });
    return { ...settings, revision: revision(s, "setting", "settings") };
  });
}
