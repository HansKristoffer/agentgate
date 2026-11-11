import { createContext, use } from "react";
import type { Connection, FactoryBoard } from "@agentgate/protocol";
import type { Perform } from "./types.ts";
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

/** What every view needs from the app. `board` is the factory board the app reads once for the sidebar, the
 * notifications and the views; undefined while the factory is off or the board has not loaded. */
export type AppValue = {
  connection: Connection;
  local: boolean;
  perform: Perform;
  versions: Versions;
  board?: FactoryBoard;
};
export const AppContext = createContext<AppValue | null>(null);
export function useApp() {
  const app = use(AppContext);
  if (!app) throw new Error("useApp is used outside the app's AppContext.");
  return app;
}
