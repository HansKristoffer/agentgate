import { Hono } from "hono";
import {
  factoryCommandResultSchema,
  type FactoryBoard,
  type FactoryModel,
  type FactoryPointer,
  type FactoryReport,
  type FactorySource,
  type MarkerPayload,
  type RunKind,
} from "@agentgate/protocol";
import type { Ctx, Env, Listener } from "../daemon.ts";
import type { Store } from "../store.ts";
import { FactoryEvents } from "./events.ts";
import type { FactoryItem, FactoryRun } from "./db.ts";
import { setupFeatures } from "./features.ts";

/**
 * The factory's shared runtime. Each feature file registers its routes, commands, tools, loops, run kinds, sources and
 * board parts here in its own `setup`, so features never edit shared files.
 */

/** Every node must advertise this before `settings.factory` is written: older nodes drop the field when they save settings. */
export const FACTORY_PROTOCOL = 8;

/** Throws, naming the nodes that are too old to keep `settings.factory`. */
export function requireFactoryProtocol(s: Store) {
  const old = s
    .list("node")
    .filter((n) => (n.protocol ?? 0) < FACTORY_PROTOCOL)
    .map((n) => n.id);
  if (old.length)
    throw new Error(`Update agentgate on ${old.join(", ")} first: older versions drop the factory setting`);
}

export type SourceType = "github" | "linear" | "webhook" | "manual";
/** thread: `_meta["dev.agentgate/t3Thread"]`, a label the shim adds, not proof; node: the machine that received the call. */
export interface ToolCaller {
  thread?: string;
  node: string;
}
export interface FactoryTool {
  name: string; // e.g. "factory_report"
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  local?: boolean; // never forwarded to the factory machine
  /** The value is returned as JSON text; a thrown error becomes a tool error. */
  call(args: Record<string, unknown>, caller: ToolCaller): Promise<unknown>;
}
export interface CommandIO {
  stdin?: string;
  out(line: string): void;
}
export interface FactoryCommand {
  usage: string;
  local?: boolean;
  /** Returns the exit code. */
  run(args: string[], io: CommandIO): Promise<number>;
}
export interface FactoryLoop {
  name: string;
  everyMs: number;
  where: "factory-node" | "every-node";
  run(): Promise<void>;
}
export interface IncomingItem {
  externalId: string;
  key: string;
  title: string;
  url?: string;
  snapshot: unknown;
}
export interface PostResult {
  status: "posted" | "failed" | "uncertain";
  error?: string;
}
export interface SourceAdapter {
  type: SourceType;
  /** Every open, labelled item now; the controller dedupes. */
  poll?(source: FactorySource): Promise<IncomingItem[]>;
  /** Re-checked before every stage. */
  isOpen?(item: FactoryItem): Promise<boolean>;
  /** body is already rendered by markers.ts. */
  post?(item: FactoryItem, body: string): Promise<PostResult>;
  newestMarker?(item: Pick<FactoryItem, "source" | "externalId" | "repo">): Promise<MarkerPayload | undefined>;
}
export interface LaunchSpec {
  repo: string; // owner/repo; the controller resolves or creates the T3 project
  title: string;
  brief: string; // the complete first message
  baseRef: string;
  branch: string;
  startFromOrigin: boolean;
  model?: FactoryModel;
  /** When set, the thread is launched idle, prepare runs, then the brief is sent. */
  prepare?(thread: { threadId: string; worktreePath?: string }): Promise<void>;
}
export interface RunKindDefinition {
  kind: RunKind;
  countsAsWorking?: boolean; // default true
  launch(run: FactoryRun, item: FactoryItem | undefined): Promise<LaunchSpec | { wait: string }>;
  /** An error message, or undefined. */
  validate(report: FactoryReport, run: FactoryRun, item: FactoryItem | undefined): Promise<string | undefined>;
  accept(report: FactoryReport, run: FactoryRun, item: FactoryItem | undefined): Promise<void>;
  /** `approve`/`reject` of a waiting run. */
  answer?(run: FactoryRun, decision: { approve: boolean; reason?: string }): Promise<void>;
}
export type ForwardOp =
  | { kind: "tool"; name: string; args: Record<string, unknown>; caller: ToolCaller }
  | { kind: "command"; name: string; args: string[]; stdin?: string };
export type Forwarder = (op: ForwardOp) => Promise<unknown>;

export interface FactoryRuntime {
  ctx: Ctx;
  s: Store;
  events: FactoryEvents;
  api: Hono<Env>; // mounted at /api/factory, behind management()'s guards
  peer: Hono<Env>; // mounted at /peer/factory, behind the peer token
  commands: Map<string, FactoryCommand>; // `agentgate factory <name> ...`
  tools: Map<string, FactoryTool>;
  loops: FactoryLoop[];
  runKinds: Map<RunKind, RunKindDefinition>;
  sources: Map<SourceType, SourceAdapter>;
  boardParts: Array<() => Promise<Partial<FactoryBoard>>>;
  intakeBlockers: Array<() => string | undefined>; // a reason to pause intake, or undefined
  page?: (req: Request, listener: Listener) => Promise<Response>; // set by the board feature
  forwarder?: Forwarder; // set by the follow feature
  adopt?: (ref: string) => Promise<FactoryItem | undefined>; // set by the move feature; `retry` calls it for an item this machine does not hold
  isFactoryNode(): boolean;
  pointer(): FactoryPointer | undefined;
}

/** Creates the runtime and calls every feature's setup. */
export function createFactoryRuntime(ctx: Ctx): FactoryRuntime {
  const { s } = ctx;
  const f: FactoryRuntime = {
    ctx,
    s,
    events: new FactoryEvents(s),
    api: new Hono<Env>(),
    peer: new Hono<Env>(),
    commands: new Map(),
    tools: new Map(),
    loops: [],
    runKinds: new Map(),
    sources: new Map(),
    boardParts: [],
    intakeBlockers: [],
    pointer: () => s.settings().factory,
    isFactoryNode: () => s.settings().factory?.node === s.nodeId,
  };
  setupFeatures(f);
  return f;
}

/** Where a call runs: here, unless the factory is on and runs on another machine. */
function forward(f: FactoryRuntime, local: boolean | undefined) {
  const pointer = f.pointer();
  if (local || !pointer || f.isFactoryNode()) return undefined;
  if (!f.forwarder) throw new Error(`The factory runs on ${pointer.node}, and this machine cannot reach it`);
  return f.forwarder;
}

export async function runTool(f: FactoryRuntime, name: string, args: Record<string, unknown>, caller: ToolCaller) {
  const tool = f.tools.get(name);
  if (!tool) throw new Error(`unknown factory tool ${name}`);
  const forwarder = forward(f, tool.local);
  return forwarder ? forwarder({ kind: "tool", name, args, caller }) : tool.call(args, caller);
}

export async function runCommand(f: FactoryRuntime, name: string, args: string[], io: CommandIO) {
  const command = f.commands.get(name);
  if (!command) throw new Error(`unknown factory command ${name}; run agentgate factory help`);
  const forwarder = forward(f, command.local);
  if (!forwarder) return command.run(args, io);
  const result = factoryCommandResultSchema.parse(
    await forwarder({ kind: "command", name, args, ...(io.stdin !== undefined && { stdin: io.stdin }) }),
  );
  result.output.forEach((line) => io.out(line));
  return result.code;
}

/** A loop as the daemon schedules it: a factory-node loop does nothing on other machines. */
export const loopTask = (f: FactoryRuntime, loop: FactoryLoop) => async () => {
  if (loop.where === "factory-node" && !f.isFactoryNode()) return;
  await loop.run();
};
