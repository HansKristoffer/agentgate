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
import { setup as move } from "./move.ts";
import { setup as review } from "./review.ts";
import { setup as records } from "./records.ts";
import { setup as spec } from "./spec.ts";
import { setup as scorers } from "./scorers.ts";
import { setup as learning } from "./learning.ts";
import { setup as bench } from "./bench.ts";

/** Every feature, in the order their setup runs. Each registers what it adds on the runtime. */
const features = [
  board,
  config,
  t3Mcp,
  controller,
  secrets,
  github,
  follow,
  linear,
  hooks,
  implement,
  move,
  review,
  records,
  spec,
  scorers,
  learning,
  bench,
];

export function setupFeatures(f: FactoryRuntime) {
  for (const setup of features) setup(f);
}
