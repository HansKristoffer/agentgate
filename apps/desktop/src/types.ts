import type { Connection, DesktopStatus, Status } from "@agentgate/protocol";

export type Perform = (task: () => Promise<unknown>, message?: string, key?: string) => Promise<void>;
export type ViewProps = {
  data: Status;
  connection: Connection;
  perform: Perform;
  local: boolean;
  /** Claude Desktop on this Mac; undefined for remote connections. */
  desktop?: DesktopStatus;
  /** Goes up on any change the daemon reports (useChanges.ts), for views that do not read through `useDaemon` yet. */
  changes?: number;
};
