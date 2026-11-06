import type { FactoryRuntime } from "./runtime.ts";
import { setup as board } from "./board.ts";
import { setup as config } from "./config.ts";
import { setup as t3Mcp } from "./t3-mcp.ts";
import { setup as controller } from "./controller.ts";
import { setup as secrets } from "./secrets.ts";
import { setup as github } from "./github.ts";
import { setup as follow } from "./follow.ts";
import { setup as linear } from "./linear.ts";
import { setup as hooks } from "./hooks.ts";
import { setup as implement } from "./implement.ts";
import { setup as pr } from "./pr.ts";
import { setup as move } from "./move.ts";
import { setup as review } from "./review.ts";
import { setup as records } from "./records.ts";
import { setup as spec } from "./spec.ts";
import { setup as scorers } from "./scorers.ts";
import { setup as learning } from "./learning.ts";
import { setup as init } from "./init.ts";

/** Every feature. Each registers its routes, commands, tools, loops, run kinds, sources and board parts on the
 * runtime; none replaces or wraps another's, so the order only orders the board's parts and the help text. */
const features = [
  board,
  config,
  init,
  t3Mcp,
  controller,
  secrets,
  github,
  follow,
  linear,
  hooks,
  implement,
  pr,
  move,
  review,
  records,
  spec,
  scorers,
  learning,
];

export function setupFeatures(f: FactoryRuntime) {
  for (const setup of features) setup(f);
}
