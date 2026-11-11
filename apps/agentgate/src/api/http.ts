import { ConfigurationConflict, SkillConflict } from "@agentgate/protocol";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Ctx } from "../daemon.ts";
import { jsonInput } from "../http.ts";
import { RelayBusy, RelayError } from "../relay.ts";

/** The control API's shared helpers, used by every family's routes in this folder. */

export const required = (value: unknown, name: string) => {
  if (!value) throw new HTTPException(404, { message: `No such ${name}` });
};

export const local = (listener: string) => {
  if (listener !== "loopback")
    throw new HTTPException(403, {
      message: "This operation requires a local connection",
    });
};

/** The request's own signal, ended early when the daemon stops. */
export const signal = (ctx: Ctx, req: Request) => AbortSignal.any([req.signal, ctx.abort.signal]);

export const optionalJson = async (req: Request) => (req.headers.get("content-type") ? jsonInput(req) : {});

// Relay messages are sanitized summaries, safe for a signed-in administrator.
export const relayed = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof RelayBusy) throw new HTTPException(409, { message: error.message });
    if (error instanceof RelayError)
      throw new HTTPException(error.status ? 502 : 400, {
        message: error.message,
      });
    throw error;
  }
};

// Operational input errors are safe to show to a signed-in administrator.
export const input = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (error) {
    if (
      error instanceof z.ZodError ||
      error instanceof HTTPException ||
      error instanceof SkillConflict ||
      error instanceof ConfigurationConflict
    )
      throw error;
    throw new HTTPException(400, {
      message: error instanceof Error ? error.message : "Invalid operation",
    });
  }
};
export const inputAsync = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    return input(() => {
      throw error;
    });
  }
};
