import type { Connection, DesktopStatus, Status } from "@agentgate/protocol";

export type Perform = (
  task: () => Promise<unknown>,
  message?: string,
) => Promise<void>;
export type ViewProps = {
  data: Status;
  connection: Connection;
  perform: Perform;
  local: boolean;
  /** Claude Desktop on this Mac; undefined for remote connections. */
  desktop?: DesktopStatus;
};
