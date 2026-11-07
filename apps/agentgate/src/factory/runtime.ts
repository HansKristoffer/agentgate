import { getErrorMessage } from "hanzio";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  ConfigurationConflict,
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

/** Throws, naming the nodes too old to sync `settings.factory` and factory secrets. */
export function requireFactoryProtocol(s: Store) {
  const old = s
    .list("node")
    .filter((n) => (n.protocol ?? 0) < FACTORY_PROTOCOL)
    .map((n) => n.id);
  if (old.length)
    throw new Error(
      `Update agentgate on ${old.join(", ")} first: older versions cannot sync factory settings and secrets`,
    );
}

export type SourceType = "github" | "linear" | "webhook" | "scout" | "manual";
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
  /** Listed only to a factory run's own threads (`threadScope`). */
  forRuns?: boolean;
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
  /** Runs while the factory is off too, to undo what it set up there (a T3 sign-in, the shell stream). Every other
   * loop does nothing without a pointer: off freezes the items where they are. */
  whenOff?: true;
  run(): Promise<void>;
}
export interface IncomingItem {
  externalId: string;
  key: string;
  title: string;
  url?: string;
  snapshot: unknown;
  /** A webhook or scout item's dedupe key, which agentgate chose; it never goes into the untrusted snapshot. */
  dedupe?: string;
}
export interface PostResult {
  status: "posted" | "failed" | "uncertain";
  error?: string;
}
export interface SourceAdapter {
  type: SourceType;
  /** Every open, labelled item now; the controller dedupes. */
  poll?(source: FactorySource): Promise<IncomingItem[]>;
  /** Read before every stage, and now and then while its PR is followed: whether the issue is open, and its newest
   * factory marker, which names the machine holding it (a takeover elsewhere fences this one). One read. */
  check?(item: FactoryItem): Promise<{ open: boolean; newest?: MarkerPayload }>;
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
}
export interface RunKindDefinition {
  kind: RunKind;
  countsAsWorking?: boolean; // default true
  launch(run: FactoryRun, item: FactoryItem | undefined): Promise<LaunchSpec | { wait: string }>;
  /** The model a run of a kind that does not take it from its stage file starts with, so dispatch can check quota
   * before building the launch, whose work (a PR read, a brief) would otherwise repeat every pass while it waits. */
  model?(run: FactoryRun): FactoryModel | undefined;
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
  page?: (req: Request, listener: Listener) => Promise<Response>; // set by the board feature
  forwarder?: Forwarder; // set by the follow feature
  adopt?: (ref: string) => Promise<FactoryItem | undefined>; // set by the move feature; `retry` calls it for an item this machine does not hold
  /** Per item, the end of its last queued step (`withItem`). */
  locks: Map<string, Promise<unknown>>;
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
    locks: new Map(),
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

/** An error's message for a note or a run's error, cut short: an adapter's or T3's message could be long. */
export function shortError(e: unknown) {
  const text = getErrorMessage(e);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** Errors whose messages agentgate writes itself and keeps tokens out of (t3-mcp.ts, linear.ts, the report checks), so a
 * log line can carry the message. Any other error, whose text could hold anything, is logged by its name. */
const SAFE_ERRORS = new Set(["ReportError", "T3McpError", "T3Error", "FolderError", "LinearError"]);
export const logError = (e: unknown) =>
  e instanceof Error
    ? SAFE_ERRORS.has(e.name) || SAFE_ERRORS.has(e.constructor.name)
      ? shortError(e)
      : e.name
    : "error";

/**
 * Runs `step` once every earlier step of the same item has settled, so two transitions of one item never interleave
 * across their awaits: a report, a loop pass, a person's action. A step's failure does not hold up the next one. A
 * step must not await another `withItem` of its own item, which would wait for itself; it can queue one with `later`.
 */
export function withItem<T>(f: FactoryRuntime, item: string, step: () => Promise<T>): Promise<T> {
  const run = (f.locks.get(item) ?? Promise.resolve()).then(step);
  const settled = run.then(
    () => {},
    () => {},
  );
  f.locks.set(item, settled);
  void settled.then(() => {
    if (f.locks.get(item) === settled) f.locks.delete(item);
  });
  return run;
}

/** Queues `step` after the item's current step without waiting for it; its failure becomes a note naming `what`. */
export function later(f: FactoryRuntime, item: string, what: string, step: () => Promise<void>) {
  void withItem(f, item, step).catch((e) =>
    f.events.emit({ kind: "note", item, text: `${what} failed: ${shortError(e)}` }),
  );
}

/** For routes: what an administrator typed wrong is a 400, like the rest of the control API. */
export async function asInput<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof HTTPException || error instanceof ConfigurationConflict)
      throw error;
    throw new HTTPException(400, { message: getErrorMessage(error) });
  }
}

/** For routes: the command run as the CLI runs it, forwarded to the factory machine when it runs elsewhere; a command
 * that fails is a 400 with its output. */
export async function commandRoute(f: FactoryRuntime, name: string, args: string[]) {
  const output: string[] = [];
  const code = await asInput(() => runCommand(f, name, args, { out: (line) => output.push(line) }));
  if (code) throw new HTTPException(400, { message: output.join("\n") || `factory ${name} failed` });
  return output;
}

/** A loop as the daemon schedules it: nothing while the factory is off (unless it cleans up), and a factory-node loop
 * nothing on other machines. */
export const loopTask = (f: FactoryRuntime, loop: FactoryLoop) => async () => {
  if (!f.pointer() && !loop.whenOff) return;
  if (loop.where === "factory-node" && !f.isFactoryNode()) return;
  await loop.run();
};
