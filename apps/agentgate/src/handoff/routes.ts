import { closeSync, ftruncateSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { CHANNEL_CHUNK } from "../channel.ts";
import { jsonInput } from "../http.ts";
import { MAX_BODY, readBody } from "../runtime.ts";
import type { Peer } from "../sync.ts";
import { abort, manifestSchema, peerStatus, prepare, prepareSchema, start, type DestState } from "./destination.ts";
import type { Handoffs } from "./jobs.ts";
import { safeRelative } from "./session.ts";
import { startHandoff } from "./source.ts";
import { T3Error, connectInput, connectT3, disconnectT3, pairing } from "./t3.ts";
import { localView, resolveTarget } from "./threads.ts";

/** `/peer/handoff/*` and `/peer/threads`, mounted behind the peer token check (sync.ts). Every step is keyed by the
 * handoff id, so a retried request is safe. Unknown ids answer 404. */

/** Decompressed size of everything one handoff may bring: session transcripts plus the code bundle. */
const MAX_TOTAL = 1024 * 1024 * 1024;
const id = z.string().uuid();

export function handoffRoutes(h: Handoffs) {
  const app = new Hono<{ Variables: { peer: Peer } }>();
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: "invalid handoff request" }, 400);
    if (error instanceof T3Error) return c.json({ error: error.message }, 409);
    throw error;
  });
  // A destination job answers only the node that started it.
  const own = (c: Context<{ Variables: { peer: Peer } }>) => {
    const job = h.load<DestState>("destination", id.parse(c.req.param("id")));
    return job?.state.source === c.get("peer").node ? job : undefined;
  };
  const missing = { error: "no such handoff" };

  app.get("/threads", async (c) => c.json(await localView(h)));

  // Set up from another machine: it forwards the pairing link created in this machine's T3 Code.
  app.post("/t3/connect", async (c) => c.json(await connectT3(h.s, pairing(connectInput.parse(await jsonInput(c.req.raw))))));
  app.post("/t3/disconnect", (c) => {
    disconnectT3(h.s);
    return c.json({ ok: true });
  });

  app.post("/handoff/request", async (c) => {
    const f = z.object({ threadId: z.string().min(1).max(512), to: z.string().min(1).max(512) }).strict().parse(await jsonInput(c.req.raw));
    // Resolve again with this node's view: it drives the handoff, so it must reach the target itself.
    const handoffId = await startHandoff(h, f.threadId, await resolveTarget(h, h.s.nodeId, f.to));
    return c.json({ handoffId });
  });
  app.get("/handoff/:id/job", (c) => {
    const job = h.load("source", id.parse(c.req.param("id")));
    return job ? c.json(h.view(job)) : c.json(missing, 404);
  });

  app.post("/handoff/:id/prepare", async (c) => {
    prepare(h, id.parse(c.req.param("id")), c.get("peer").node, prepareSchema.parse(await jsonInput(c.req.raw)));
    return c.json({ ok: true });
  });
  app.put("/handoff/:id/files", async (c) => {
    const job = own(c);
    if (!job) return c.json(missing, 404);
    if (job.step !== "prepare" && job.step !== "prepared") return c.json({ error: "the handoff no longer takes files" }, 409);

    const path = c.req.query("path") ?? "";
    const offset = Number(c.req.query("offset"));
    if (!safeRelative(path) || !(path === "bundle" || path.startsWith("session/"))) return c.json({ error: "invalid path" }, 400);
    if (!Number.isInteger(offset) || offset < 0) return c.json({ error: "invalid offset" }, 400);

    const chunk = gunzipSync(await readBody(c.req.raw.body, MAX_BODY, c.req.raw.signal), { maxOutputLength: CHANNEL_CHUNK });
    const file = join(h.dir(job.id), "files", path);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const fd = openSync(file, "a+", 0o600);
    try {
      // A retry restarts a file: cut it back to this chunk's offset before writing.
      if (offset > statSync(file).size) return c.json({ error: "offset past the end of the file" }, 409);
      ftruncateSync(fd, offset);
      if (totalSize(h, job.id) + chunk.byteLength > MAX_TOTAL) return c.json({ error: "the handoff is larger than 1 GiB" }, 413);
      writeSync(fd, chunk, 0, chunk.byteLength, offset);
    } finally {
      closeSync(fd);
    }
    h.touch("destination", job.id);
    return c.json({ size: offset + chunk.byteLength });
  });
  app.post("/handoff/:id/start", async (c) => {
    start(h, id.parse(c.req.param("id")), c.get("peer").node, manifestSchema.parse(await jsonInput(c.req.raw)));
    return c.json({ ok: true });
  });
  app.get("/handoff/:id", (c) => {
    const job = own(c);
    return job ? c.json(peerStatus(h, job)) : c.json(missing, 404);
  });
  app.delete("/handoff/:id", (c) => {
    const job = own(c);
    if (!job) return c.json(missing, 404);
    abort(h, job);
    return c.json({ ok: true });
  });
  return app;
}

/** The same routes for calls through the relay: the sender is the node the sealed call authenticates. */
export function relayedRoutes(h: Handoffs) {
  const app = new Hono<{ Bindings: { from: string }; Variables: { peer: Peer } }>()
    .use("*", async (c, next) => { c.set("peer", { node: c.env.from } as Peer); await next(); })
    .route("/", handoffRoutes(h));
  return async (from: string, req: Request) => app.fetch(req, { from });
}

function totalSize(h: Handoffs, jobId: string): number {
  const dir = join(h.dir(jobId), "files");
  let total = 0;
  for (const f of new Bun.Glob("**/*").scanSync({ cwd: dir, onlyFiles: true, dot: true })) total += statSync(join(dir, f)).size;
  return total;
}
