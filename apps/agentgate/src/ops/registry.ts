import { operationFor } from "@agentgate/protocol";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { ControlOps } from "@agentgate/protocol/control";
import { z } from "zod";
import type { Ctx } from "../daemon.ts";
import type { Store } from "../store.ts";

/**
 * The control plane's operation registry, modelled on the factory's (factory/runtime.ts). Each family registers its
 * operations from its own file in this folder, and the CLI words, the app's typed call (`POST /api/ops/<name>`) and
 * the CLI's call through the daemon (`POST /api/ops-terminal`) are all made from that one entry (api/ops.ts).
 */

export class UserError extends Error {} // its message is shown to the caller; anything else is not

export interface ControlOp<S extends z.ZodType = z.ZodType, O = unknown, N extends string = string> {
  name: N; // the CLI words, e.g. "nodes always-on"
  summary: string;
  input: S;
  /** "store": may run in the CLI's own process when no daemon answers. "daemon": needs the running daemon. */
  needs: "store" | "daemon";
  /** Refused on the tailnet listener. */
  loopbackOnly?: boolean;
  run(input: z.output<S>, ctx: { s: Store; daemon?: Ctx }): O | Promise<O>;
  terminal?: {
    usage: string;
    /** The CLI reads stdin only for an operation that says so, so a command run under an agent or a cron job, whose
     * stdin stays open and silent, never waits on it. */
    stdin?: boolean;
    /** The input from the words after the name. Throws a UserError for words it cannot read, which prints the usage. */
    parse(args: string[], stdin: string | undefined, cwd: string | undefined): { input: unknown; json?: boolean };
    print(result: O, asked: { input: z.output<S>; json?: boolean }): string[] | { lines: string[]; code: number };
  };
}

/** What an operation the app calls returns: its result in the protocol's `ControlOps`. `never`, so that registering it
 * does not compile, when its schema would refuse what the app sends. Other operations return anything. */
type Returns<N extends string, S extends z.ZodType> = N extends keyof ControlOps
  ? [ControlOps[N]["input"]] extends [z.input<S>]
    ? ControlOps[N]["result"]
    : never
  : unknown;

export const controlOps = new Map<string, ControlOp>();

/** Registers an operation. */
export function controlOp<S extends z.ZodType, N extends string, O extends Returns<N, S>>(
  op: ControlOp<S, O, N>,
): ControlOp<S, O, N> {
  controlOps.set(op.name, op);
  return op;
}

export type TerminalOp = ControlOp & { terminal: NonNullable<ControlOp["terminal"]> };
export interface TerminalResult {
  lines: string[];
  code: number;
}

/** The operation the CLI words name: the one with the longest name they start with. */
export const terminalOpFor = (words: readonly string[]) =>
  operationFor(
    [...controlOps.values()].filter((op): op is TerminalOp => !!op.terminal),
    words,
  );

/** Runs the operation the words name and returns what to print: in the daemon for `/api/ops-terminal`, or in the
 * CLI's own process when no daemon answers. */
export async function runTerminal(
  op: TerminalOp,
  words: string[],
  stdin: string | undefined,
  cwd: string | undefined,
  ctx: { s: Store; daemon?: Ctx },
): Promise<TerminalResult> {
  const { terminal } = op;
  let asked: ReturnType<typeof terminal.parse>;
  try {
    asked = terminal.parse(words.slice(op.name.split(" ").length), terminal.stdin ? stdin : undefined, cwd);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    return { code: 2, lines: [...(e.message ? [e.message] : []), `usage: agentgate ${terminal.usage}`] };
  }
  const input = op.input.parse(asked.input);
  const result = await op.run(input, ctx);
  const printed = terminal.print(result, { input, ...(asked.json && { json: true }) });
  return Array.isArray(printed) ? { lines: printed, code: 0 } : printed;
}

/** The words after an operation's name, read strictly: an unknown or malformed flag prints the usage. */
export function parseWords<const O extends ParseArgsOptionsConfig>(args: string[], options: O) {
  try {
    return parseArgs<{ args: string[]; options: O; allowPositionals: true; strict: true }>({
      args,
      options,
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    throw new UserError(e instanceof Error ? e.message : "");
  }
}

/** The word `on` or `off`; any other prints the usage. */
export const onOff = (word: string | undefined) => {
  if (word !== "on" && word !== "off") throw new UserError();
  return word === "on";
};

/** A plain `Error`'s message: the record changes and provider adapters word those for the caller. A subclass, such as
 * a TypeError from `URL` quoting credentials or a SyntaxError quoting a credentials file, stays hidden. */
export const plainMessage = (e: unknown) => (e instanceof Error && e.constructor === Error ? e.message : undefined);

/** Runs `fn`, sync or async, and rethrows an error `shown` gives a message for as a UserError with that message. */
export function asUserError<T>(fn: () => T, shown: (e: unknown) => string | undefined = plainMessage): T {
  const mapped = (e: unknown) => {
    const message = shown(e);
    return message === undefined ? e : new UserError(message);
  };
  let result: T;
  try {
    result = fn();
  } catch (e) {
    throw mapped(e);
  }
  if (!(result instanceof Promise)) return result;
  return result.catch((e) => {
    throw mapped(e);
  }) as T;
}

/** The text a caller may see for an operation's error: a UserError's message or what the input schema refused.
 * Undefined for any other error, whose text could hold another program's output or a secret. */
export function shownError(e: unknown) {
  if (e instanceof UserError) return e.message;
  if (e instanceof z.ZodError) return z.prettifyError(e);
  return undefined;
}
