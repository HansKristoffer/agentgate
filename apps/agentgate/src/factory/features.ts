import type { Ctx } from "../daemon.ts";
import { FactoryEvents } from "./events.ts";
import { emptyRuntime, operationRoutes, type FactoryRuntime } from "./runtime.ts";
import { setup as board } from "./board.ts";
import { setup as preflight } from "./preflight.ts";
import { setup as config } from "./config.ts";
import { setup as stored } from "./stored.ts";
import { setup as t3Mcp } from "./t3-mcp.ts";
import { setup as actions } from "./actions.ts";
import { setup as view } from "./view.ts";
import { setup as controller } from "./controller.ts";
import { setup as intake } from "./intake.ts";
import { setup as secrets } from "./secrets.ts";
import { setup as github } from "./github.ts";
import { setup as follow } from "./follow.ts";
import { setup as linear } from "./linear.ts";
import { setup as hooks } from "./hooks.ts";
import { setup as implement } from "./implement.ts";
import { setup as pr } from "./pr.ts";
import { setup as review } from "./review.ts";
import { setup as records } from "./records.ts";
import { setup as spec } from "./spec.ts";
import { setup as skills } from "./skills.ts";
import { setup as init } from "./init.ts";
import { setup as repos } from "./repos.ts";
import { setup as scouts } from "./scouts.ts";
import { setup as sourceAdd } from "./source-add.ts";
import { setup as outbox } from "./outbox.ts";
import { setup as notify } from "./notify.ts";
import { setup as canary } from "./canary.ts";

/** Every feature. Each registers its operations, loops, run kinds, sources, board parts and checks on the runtime; none
 * replaces or wraps another's, so the order only orders the board's parts, the checks and the help text. */
const features = [
  board,
  preflight,
  config,
  stored,
  init,
  repos,
  t3Mcp,
  actions,
  view,
  controller,
  intake,
  secrets,
  github,
  follow,
  linear,
  hooks,
  implement,
  pr,
  review,
  records,
  spec,
  skills,
  scouts,
  sourceAdd,
  outbox,
  notify,
  canary,
];

/** The factory's runtime with every feature set up on it, and the control API's operation routes. */
export function createFactoryRuntime(ctx: Ctx): FactoryRuntime {
  const f = emptyRuntime(ctx, new FactoryEvents(ctx.s));
  for (const setup of features) setup(f);
  operationRoutes(f);
  return f;
}
