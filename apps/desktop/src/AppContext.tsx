import { createContext, use } from "react";
import type { Connection, FactoryBoard, Status } from "@agentgate/protocol";
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
 * notifications and the views, also while the factory is off; undefined until it loads. */
export type AppValue = {
  connection: Connection;
  local: boolean;
  perform: Perform;
  versions: Versions;
  board?: FactoryBoard;
  boardError: string;
  reloadBoard(): Promise<void>;
};
/** How often the board, and an item's detail, are read with no change reported. The daemon's feed carries a factory
 * on another machine only over Tailscale; over a relay this poll is all there is. */
export const boardEvery = ({ settings, node }: Pick<Status, "settings" | "node">) =>
  settings.factory && settings.factory.node !== node ? 30_000 : undefined;
export const AppContext = createContext<AppValue | null>(null);
export function useApp() {
  const app = use(AppContext);
  if (!app) throw new Error("useApp is used outside the app's AppContext.");
  return app;
}
