import type { AccountOps } from "./control-accounts.ts";
import type { NodeOps } from "./control-nodes.ts";
import type { ProjectOps } from "./control-projects.ts";
import type { ServerOps } from "./control-servers.ts";
import type { SkillOps } from "./control-skills.ts";

/**
 * The control operations the app calls, by name: what `POST /api/ops/<name>` takes and returns for each. A name is the
 * CLI words, such as `nodes always-on`. The daemon registers each operation in `apps/agentgate/src/ops`, where
 * `controlOp` checks the ones named here against these types. Each family keeps its entries in its own file.
 */
export interface ControlOps extends AccountOps, ServerOps, NodeOps, SkillOps, ProjectOps {}
