import { useEffect, useState } from "react";
import { changesSchema, TOPICS, type Connection, type Topic } from "@agentgate/protocol";
import { native, request } from "./api.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A counter per topic that goes up when the daemon says that topic changed; `useDaemon` reloads on the ones it names. */
export type Versions = Record<Topic, number>;
const none = Object.fromEntries(TOPICS.map((t) => [t, 0])) as Versions;

/** The topics that moved between two answers whose tokens differ. A topic either answer leaves out counts as moved: an
 * older daemon sends no versions at all, and one that does not track a topic cannot say it stayed. Topics this build
 * does not know are ignored. */
export function moved(before?: Record<string, number>, after?: Record<string, number>) {
  return TOPICS.filter((t) => before?.[t] === undefined || after?.[t] === undefined || before[t] !== after[t]);
}

/**
 * The daemon's changes from `GET /api/changes`, so reads follow them as they happen instead of on their next poll.
 * A daemon without the route answers 404, and the reads' own intervals are all there is.
 */
export function useChanges(connection: Connection, enabled: boolean) {
  const [versions, setVersions] = useState(none);
  useEffect(() => {
    if (!native || !enabled) return;
    let stopped = false;
    void (async () => {
      let last: { token: string; versions?: Record<string, number> } | undefined;
      while (!stopped) {
        try {
          const query = last ? `&after=${encodeURIComponent(last.token)}` : "";
          const next = changesSchema.parse(await request<unknown>(connection, `/changes?wait=25${query}`));
          if (stopped) return;
          if (last && next.token !== last.token) {
            const topics = moved(last.versions, next.versions);
            if (topics.length) setVersions((v) => ({ ...v, ...Object.fromEntries(topics.map((t) => [t, v[t] + 1])) }));
          }
          last = next;
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
  return versions;
}
