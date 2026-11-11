import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Ctx, Env } from "../daemon.ts";
import { jsonInput as json } from "../http.ts";
import { controlOps, runTerminal, shownError, terminalOpFor } from "../ops/index.ts";
import { local } from "./http.ts";

const terminalInput = z
  .object({
    words: z
      .array(z.string().max(64 * 1024))
      .min(1)
      .max(100),
    stdin: z
      .string()
      .max(1024 * 1024)
      .optional(),
    cwd: z.string().max(4096).optional(), // the CLI's working directory, which a relative path names a file in
  })
  .strict();

/** A UserError or a refused input is a 400 with its message. Any other error goes on to the daemon's error handler,
 * which answers a fixed 500 and logs only the error's name. */
async function shown<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = shownError(error);
    if (message !== undefined) throw new HTTPException(400, { message: message || "Invalid operation" });
    throw error;
  }
}

/** The registered control operations (ops/): a list for help, a typed call for the app, and the CLI's words. */
export function ops(ctx: Ctx) {
  const { s } = ctx;
  const app = new Hono<Env>();
  app.get("/ops", (c) =>
    c.json(
      [...controlOps.values()].map((op) => ({
        name: op.name,
        usage: op.terminal?.usage,
        summary: op.summary,
        needs: op.needs,
      })),
    ),
  );
  app.post("/ops/:name", async (c) => {
    const op = controlOps.get(c.req.param("name"));
    if (!op) throw new HTTPException(404, { message: "No such operation" });
    if (op.loopbackOnly) local(c.env.listener);
    const given = await json(c.req.raw);
    return c.json((await shown(async () => op.run(op.input.parse(given), { s, daemon: ctx }))) ?? null);
  });
  // Loopback only as a whole, like the factory's terminal route: the CLI runs here, and the app sends typed input.
  app.post("/ops-terminal", async (c) => {
    local(c.env.listener);
    const { words, stdin, cwd } = terminalInput.parse(await json(c.req.raw));
    const op = terminalOpFor(words);
    if (!op) throw new HTTPException(404, { message: `Unknown command ${words[0]}; run agentgate help` });
    return c.json(await shown(() => runTerminal(op, words, stdin, cwd, { s, daemon: ctx })));
  });
  return app;
}
