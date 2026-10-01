import type { Connection, Status } from "@agentgate/protocol";

export type Perform = (
  task: () => Promise<unknown>,
  message?: string,
) => Promise<void>;
export type ViewProps = {
  data: Status;
  connection: Connection;
  perform: Perform;
  local: boolean;
};
