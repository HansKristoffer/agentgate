import type { ControlOps } from "@agentgate/protocol/control";
import { afterAll, afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { app, makeCtx } from "../src/daemon.ts";
import { newInstance } from "../src/mcp/templates.ts";
import { Store } from "../src/store.ts";
import { removeTmp, tmp } from "./fixtures/git.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** A daemon with one shared local-command server `fs` (tools cwd, slow and env), which notes each start in `starts`. */
function daemon() {
  const s = new Store(":memory:");
  s.setLocal("node", "a");
  s.put("node", "a", { id: "a" });
  const starts = join(tmp(), "starts");
  const fixture = join(import.meta.dir, "fixtures", "mcp.ts");
  s.put(
    "mcp",
    "fs",
    newInstance({
      id: "fs",
      command: process.execPath,
      args: [
        "-e",
        `require("node:fs").appendFileSync(${JSON.stringify(starts)}, "x"); await import(${JSON.stringify(fixture)})`,
      ],
    }),
  );
  const ctx = makeCtx(s);
  const handler = app(ctx);
  cleanup.push(async () => {
    ctx.abort.abort();
    ctx.skills.close();
    ctx.imports.close();
    await ctx.gateway.close();
    s.close();
  });
  const post = (path: string, body: unknown) =>
    handler.fetch(
      new Request(`http://127.0.0.1:7878/api${path}`, {
        method: "POST",
        headers: { host: "127.0.0.1:7878", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { listener: "loopback" },
    );
  /** What the app's `control()` sends. */
  const control = <N extends keyof ControlOps>(name: N, input: ControlOps[N]["input"]) =>
    post(`/ops/${encodeURIComponent(name)}`, input);
  /** What the CLI sends the running daemon for its words. */
  const cli = async (...words: string[]) =>
    (await (await post("/ops-terminal", { words })).json()) as { lines: string[]; code: number };
  return { ctx, control, cli, starts: async () => (await Bun.file(starts).text()).length };
}

test("tool settings made in the CLI show in the app's preview, and the app's show in the CLI's", async () => {
  const { control, cli } = daemon();

  for (const words of [
    ["mcp", "tools", "fs", "cwd", "env"],
    ["mcp", "instructions", "fs", "Use cwd for paths"],
    ["mcp", "limit", "fs", "500"],
  ])
    expect((await cli(...words)).code).toBe(0);
  const preview = (await (await control("mcp test", { id: "fs" })).json()) as ControlOps["mcp test"]["result"];
  expect(preview.tuning).toEqual({
    id: "fs",
    tools: ["cwd", "env"],
    instructions: "Use cwd for paths",
    maxResultChars: 500,
  });

  for (const res of [
    await control("mcp tools", { id: "fs" }),
    await control("mcp instructions", { id: "fs", instructions: "" }),
    await control("mcp limit", { id: "fs", tool: "slow", chars: 0 }),
  ])
    expect(res.status).toBe(200);
  expect((await cli("mcp", "test", "fs")).lines).toEqual([
    "fs: 3 tools  (instructions hidden, limit 500, 1 tool settings)",
    "  cwd",
    "  slow  (limit off)",
    "  env",
  ]);
});

test("the tools preview of a local command uses the connection sessions share instead of starting it again", async () => {
  const { ctx, control, starts } = daemon();
  await ctx.gateway.shared(ctx.s.get("mcp", "fs")!); // a session connected it

  for (let i = 0; i < 2; i++) expect((await control("mcp test", { id: "fs" })).status).toBe(200);

  expect(await starts()).toBe(1);
});

test("removing a server that does not exist is refused with its name", async () => {
  const { control } = daemon();

  const res = await control("mcp rm", { id: "missing" });

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "No MCP server missing" });
});
