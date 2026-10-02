import { HTTPException } from "hono/http-exception";
import { MAX_BODY, readBody } from "./runtime.ts";

export async function jsonInput(req: Request): Promise<unknown> {
  if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new HTTPException(415, { message: "Send application/json" });
  try { return JSON.parse(new TextDecoder().decode(await readBody(req.body, MAX_BODY, req.signal))); }
  catch (error) {
    if (error instanceof SyntaxError) throw new HTTPException(400, { message: "Invalid JSON" });
    throw error;
  }
}
