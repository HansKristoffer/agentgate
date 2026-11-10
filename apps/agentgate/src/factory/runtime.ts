import { getErrorMessage } from "hanzio";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  ConfigurationConflict,
  factoryCommandInputSchema,
  operationFor,
  type FactoryBoard,
  type FactoryCommandResult,
  type FactoryModel,
  type FactoryOperationInfo,
  type FactoryOps,
  type FactoryPointer,
  type FactoryReport,
  type FactorySource,
  type MarkerPayload,
  type RunKind,
} from "@agentgate/protocol";
import type { Ctx, Env, Listener } from "../daemon.ts";
import { jsonInput } from "../http.ts";
import type { Store } from "../store.ts";
import { FactoryEvents } from "./events.ts";
import type { FactoryItem, FactoryRun } from "./db.ts";
import { setupFeatures } from "./features.ts";

/**
 * The factory's shared runtime. Each feature file registers its operations, loops, run kinds, sources and board parts
 * here in its own `setup`, so features never edit shared files. An operation is registered once, and the CLI, the
 * control API, the agents' MCP tools and a virtual project's remote endpoint are all made from that one entry.
 */

export { FACTORY_PROTOCOL, requireFactoryProtocol } from "../store.ts";

export type SourceType = "github" | "linear" | "webhook" | "scout" | "manual";
/**
 * Who calls an operation. `via`: the CLI, the control API (the app), an agent's MCP tool, or a virtual project's
 * remote endpoint. `thread`: `_meta["dev.agentgate/t3Thread"]` of a tool call, a label the shim adds, not proof.
 * `node`: the machine that received the call. A call forwarded to the factory machine carries its caller along.
 */
export interface Caller {
  via: "terminal" | "api" | "tool" | "remote";
  thread?: string;
  node: string;
}

/** Thrown by a terminal form's `parse` for words it cannot read: the operation's `usage` is printed, with exit code 2. */
export class UsageError extends Error {}
/** The `parse` of an operation that takes no words. */
export const noWords = (args: string[]) => {
  if (args.length) throw new UsageError();
  return { input: {} };
};

/**
 * One thing the factory can do, however it is asked. `run` takes the input its schema checked and returns JSON. It
 * runs on the factory machine, wherever the call arrives, unless it is `local` or `here` says this input is this
 * machine's to answer. `terminal`, `tool` and `remote` say how the CLI, agents and a remote endpoint reach it; the
 * control API reaches every operation by its name.
 */
export interface Operation<S extends z.ZodType = z.ZodType, O = unknown, N extends string = string> {
  /** The words after `agentgate factory`, such as `secret set`. */
  name: N;
  /** One line for `agentgate factory help`. */
  summary: string;
  input: S;
  /** Runs on the machine that is asked, never forwarded. */
  local?: boolean;
  /** Whether this input is answered here though another machine runs the factory: it names an item frozen in this
   * machine's tables, which no other machine can reach. */
  here?(input: z.output<S>): boolean;
  /** Refused over the tailnet, like the control API's other secret routes. */
  loopbackOnly?: boolean;
  run(input: z.output<S>, caller: Caller): O | Promise<O>;
  terminal?: {
    /** The name and its arguments, as help and a parse error show them. */
    usage: string;
    /** The CLI reads stdin only for an operation that says so: under an agent or a cron job stdin stays open and
     * silent, so reading it would wait forever, and in a `while read` loop it would swallow the loop's input. */
    stdin?: boolean;
    /** The input from the words after the name, and from stdin when `stdin` is set; `json` when the person asked for
     * the result as JSON. Throws a UsageError for words it cannot read. */
    parse(args: string[], stdin: string | undefined): { input: unknown; json?: boolean };
    /** The result as lines, with the exit code when it is not 0. */
    print(result: O, asked: { input: z.output<S>; json?: boolean }): string[] | { lines: string[]; code: number };
  };
  /** An MCP tool for local sessions. `forRuns`: listed only to a factory run's own threads (`threadScope`). `result`
   * is what the tool answers when that is not the operation's own result. */
  tool?: { name: string; description: string; forRuns?: boolean; result?(value: O): unknown };
  /** Offered on a virtual project's endpoint whose `factoryTools` is on, as the tool `factory__<name>`. */
  remote?: { description: string; result?(value: O): unknown };
}

/** What an operation the app calls returns: its result in the protocol's `FactoryOps`. `never`, so that registering it
 * does not compile, when its schema would refuse what the app sends. Other operations return anything. */
type Returns<N extends string, S extends z.ZodType> = N extends keyof FactoryOps
  ? [FactoryOps[N]["input"]] extends [z.input<S>]
    ? FactoryOps[N]["result"]
    : never
  : unknown;

/** Registers an operation. */
export function operation<S extends z.ZodType, N extends string, O extends Returns<N, S>>(
  f: FactoryRuntime,
  op: Operation<S, O, N>,
): void {
  f.operations.set(op.name, op);
}

export interface FactoryLoop {
  name: string;
  everyMs: number;
  /** `factory-node`: only on the machine the pointer names, which alone drives items. `every-node` is for what a
   * machine does about itself whoever runs the factory: its T3 Code sign-in and stream, and posting its own events. */
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
  /** When the issue last changed, as its source lists it: a new comment changes it, so its marker is read again. */
  updatedAt?: string;
}
/** How a write to a source ended, which decides what the outbox does next (outbox.ts). `failed`: the service refused
 * it, so nothing was written. `unreachable`: the request certainly never reached the service, so sending it again is
 * safe. `uncertain`: no answer said either way, so it may have been written. */
export interface PostResult {
  status: "posted" | "failed" | "unreachable" | "uncertain";
  error?: string;
}
export interface SourceAdapter {
  type: SourceType;
  /** Every open, labelled item now; the controller dedupes. */
  poll?(source: FactorySource): Promise<IncomingItem[]>;
  /** Read before every stage: whether the issue is still open. */
  check?(item: FactoryItem): Promise<{ open: boolean }>;
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
/** A call sent to the factory machine through `/peer/factory/op` (follow.ts). */
export interface ForwardOp {
  name: string;
  input: unknown;
  caller: Caller;
}
export type Forwarder = (op: ForwardOp) => Promise<unknown>;

export interface FactoryRuntime {
  ctx: Ctx;
  s: Store;
  events: FactoryEvents;
  api: Hono<Env>; // mounted at /api/factory, behind management()'s guards
  peer: Hono<Env>; // mounted at /peer/factory, behind the peer token
  operations: Map<string, Operation>; // by name; register with `operation`
  loops: FactoryLoop[];
  runKinds: Map<RunKind, RunKindDefinition>;
  sources: Map<SourceType, SourceAdapter>;
  boardParts: Array<() => Promise<Partial<FactoryBoard>>>;
  page?: (req: Request, listener: Listener) => Promise<Response>; // set by the board feature
  forwarder?: Forwarder; // set by the follow feature
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
    operations: new Map(),
    loops: [],
    runKinds: new Map(),
    sources: new Map(),
    boardParts: [],
    locks: new Map(),
    pointer: () => s.settings().factory,
    isFactoryNode: () => s.settings().factory?.node === s.nodeId,
  };
  setupFeatures(f);
  routes(f);
  return f;
}

/** How a call reaches the factory machine, or undefined when it runs here: the factory is off, or this machine runs
 * it. */
export function toFactoryMachine(f: FactoryRuntime): Forwarder | undefined {
  const pointer = f.pointer();
  if (!pointer || f.isFactoryNode()) return undefined;
  if (!f.forwarder) throw new Error(`The factory runs on ${pointer.node}, and this machine cannot reach it`);
  return f.forwarder;
}

/** Checks the input here, so a mistake is refused the same way on every machine, then runs the operation here or on
 * the factory machine. That machine gets the input as it was given and checks it again. */
async function perform(f: FactoryRuntime, op: Operation, given: unknown, caller: Caller) {
  const input = op.input.parse(given);
  const forward = op.local || op.here?.(input) ? undefined : toFactoryMachine(f);
  const result = forward ? await forward({ name: op.name, input: given, caller }) : await op.run(input, caller);
  return { input, result };
}

/** The operation's result, for the transports that take typed input: the control API, tools, the remote endpoint and
 * a call another machine forwarded. An input the schema refuses throws a ZodError, which each transport words. */
export async function runOperation(f: FactoryRuntime, name: string, input: unknown, caller: Caller): Promise<unknown> {
  const op = f.operations.get(name);
  if (!op) throw new Error(`unknown factory operation ${name}`);
  return (await perform(f, op, input, caller)).result;
}

type TerminalOperation = Operation & { terminal: NonNullable<Operation["terminal"]> };
const terminalOperations = (f: FactoryRuntime) =>
  [...f.operations.values()].filter((op): op is TerminalOperation => !!op.terminal);

/** `agentgate factory <words>`: the operation the words name, its input parsed from the rest here, and its result
 * printed here, wherever it ran. */
export async function runTerminal(f: FactoryRuntime, words: string[], stdin?: string): Promise<FactoryCommandResult> {
  const operations = terminalOperations(f);
  const op = operationFor(operations, words);
  if (!op) {
    // A first word several operations share, such as `secret`: the ones it could have meant.
    const family = operations.filter((o) => o.name.startsWith(`${words[0]} `));
    if (family.length) return { code: 2, output: family.map((o) => `usage: agentgate factory ${o.terminal.usage}`) };
    // Only the first word is repeated: what follows could be a value typed in the wrong place.
    throw new Error(`unknown factory command ${words[0] ?? ""}; run agentgate factory help`);
  }
  const { terminal } = op;
  let asked: ReturnType<typeof terminal.parse>;
  try {
    asked = terminal.parse(words.slice(op.name.split(" ").length), terminal.stdin ? stdin : undefined);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    return { code: 2, output: [`usage: agentgate factory ${terminal.usage}`] };
  }
  const { input, result } = await perform(f, op, asked.input, { via: "terminal", node: f.s.nodeId });
  const printed = terminal.print(result, { input, ...(asked.json && { json: true }) });
  return Array.isArray(printed) ? { code: 0, output: printed } : { code: printed.code, output: printed.lines };
}

/** The control API's routes for operations; the board (`GET /`) is board.ts's. A refusal is a 400 with its message,
 * like the rest of the control API. */
function routes(f: FactoryRuntime) {
  const local = (listener: Listener) => {
    if (listener !== "loopback")
      throw new HTTPException(403, { message: "This operation requires a local connection" });
  };
  f.api.get("/operations", (c) =>
    c.json(
      terminalOperations(f).map(({ name, summary, terminal }): FactoryOperationInfo => ({
        name,
        summary,
        usage: terminal.usage,
        ...(terminal.stdin && { stdin: true }),
      })),
    ),
  );
  f.api.post("/op/:name", async (c) => {
    const op = f.operations.get(c.req.param("name"));
    if (!op) throw new HTTPException(404, { message: "No such factory operation" });
    if (op.loopbackOnly) local(c.env.listener);
    const input = await jsonInput(c.req.raw);
    const result = await asInput(() => runOperation(f, op.name, input, { via: "api", node: f.s.nodeId }));
    return c.json(result ?? null);
  });
  // The words the CLI got. Loopback only as a whole: they include setting secrets, and the app sends typed input.
  f.api.post("/terminal", async (c) => {
    local(c.env.listener);
    const { args, stdin } = factoryCommandInputSchema.parse(await jsonInput(c.req.raw));
    return c.json(await asInput(() => runTerminal(f, args, stdin)));
  });
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
async function asInput<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof HTTPException || error instanceof ConfigurationConflict)
      throw error;
    throw new HTTPException(400, { message: getErrorMessage(error) });
  }
}

/** The last failure each loop logged, so one that fails every pass says so once until it changes or recovers. */
const loopFailures = new WeakMap<FactoryRuntime, Map<string, string>>();

/** A loop as the daemon schedules it: nothing while the factory is off (unless it cleans up), and a factory-node loop
 * nothing on other machines, whose open items stay frozen as `factory off` leaves them. A failure is logged with the
 * loop's name, once per distinct error. */
export const loopTask = (f: FactoryRuntime, loop: FactoryLoop) => async () => {
  if (!f.pointer() && !loop.whenOff) return;
  if (loop.where === "factory-node" && !f.isFactoryNode()) return;
  let failures = loopFailures.get(f);
  if (!failures) loopFailures.set(f, (failures = new Map()));
  try {
    await loop.run();
    failures.delete(loop.name);
  } catch (e) {
    const text = logError(e);
    if (failures.get(loop.name) !== text) console.error(`factory: the ${loop.name} loop failed: ${text}`);
    failures.set(loop.name, text);
  }
};
