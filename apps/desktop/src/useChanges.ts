import { useEffect, useState } from "react";
import { changesSchema, type Connection } from "@agentgate/protocol";
import { native, request } from "./api.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A number that goes up whenever the daemon's records or factory events change, from `GET /api/changes`, so views
 * refresh as things happen instead of on their next poll. The polls stay for what changes without a record (quotas,
 * threads on other machines); a daemon without the route answers 404, and the polls are all there is.
 */
export function useChanges(connection: Connection, enabled: boolean) {
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    if (!native || !enabled) return;
    let stopped = false;
    void (async () => {
      let token: string | undefined;
      while (!stopped) {
        try {
          const query = token ? `&after=${encodeURIComponent(token)}` : "";
          const next = changesSchema.parse(await request<unknown>(connection, `/changes?wait=25${query}`)).token;
          if (stopped) return;
          if (token !== undefined && next !== token) setChanges((n) => n + 1);
          token = next;
          // A burst of changes, such as a sync, refreshes at most twice a second.
          await pause(500);
        } catch {
          await pause(30_000);
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [connection, enabled]);
  return changes;
}
