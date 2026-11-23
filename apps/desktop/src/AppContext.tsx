import { createContext, use } from "react";
import type { Connection } from "@agentgate/protocol";
import type { Versions } from "./useChanges.ts";

/** What `useDaemon` reads with: the connection, the change feed, and the last answer of each keyed read. The cache is
 * made per connection, so another daemon's answers are never shown. */
export const Feed = createContext<{ connection: Connection; versions: Versions; cache: Map<string, unknown> } | null>(
  null,
);
export function useFeed() {
  const feed = use(Feed);
  if (!feed) throw new Error("useDaemon is used outside the app's Feed.");
  return feed;
}
