import { ConfigurationConflict, SkillConflict } from "@agentgate/protocol";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Ctx } from "../daemon.ts";
import { jsonInput } from "../http.ts";

/** The control API's shared helpers, used by every family's routes in this folder. */

/** Narrows the value after the call, so a route can use it without a `!`. */
export function required(value: unknown, name: string): asserts value {
  if (!value) throw new HTTPException(404, { message: `No such ${name}` });
}

export const local = (listener: string) => {
  if (listener !== "loopback")
    throw new HTTPException(403, {
      message: "This operation requires a local connection",
    });
};

/** The request's own signal, ended early when the daemon stops. */
export const signal = (ctx: Ctx, req: Request) => AbortSignal.any([req.signal, ctx.abort.signal]);

export const optionalJson = async (req: Request) => (req.headers.get("content-type") ? jsonInput(req) : {});

// Operational input errors are safe to show to a signed-in administrator.
export const input = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (error) {
    throw inputError(error);
  }
};

export const inputAsync = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    throw inputError(error);
  }
};

/** Errors the routes already answer pass through; any other failure becomes a 400 with its message. */
const inputError = (error: unknown) => {
  if (
    error instanceof z.ZodError ||
    error instanceof HTTPException ||
    error instanceof SkillConflict ||
    error instanceof ConfigurationConflict
  )
    return error;
  return new HTTPException(400, {
    message: error instanceof Error ? error.message : "Invalid operation",
  });
};
