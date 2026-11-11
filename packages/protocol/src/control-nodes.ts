import type { z } from "zod";
import type { nodeSchema } from "./index.ts";

/** The machines family's control operations the app calls, by name (see control.ts). */
export interface NodeOps {
  "nodes always-on": { input: { node: string; on: boolean }; result: z.output<typeof nodeSchema> };
}
