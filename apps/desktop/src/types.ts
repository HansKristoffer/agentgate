import type { Connection, DesktopStatus, Status } from "@agentgate/protocol";

export type Perform = (task: () => Promise<unknown>, message?: string, key?: string) => Promise<void>;
export type ViewProps = {
  data: Status;
  connection: Connection;
  perform: Perform;
  local: boolean;
  /** Claude Desktop on this Mac; undefined for remote connections. */
  desktop?: DesktopStatus;
  /** Goes up when the daemon's records or factory events change (useChanges.ts): views that read more than the status
   * read again. */
  changes?: number;
};
