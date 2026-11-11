import { afterAll, afterEach, expect, test } from "bun:test";
import { ConfigurationConflict } from "@agentgate/protocol";
import { join } from "node:path";
import { revision } from "../src/configuration.ts";
import { app, makeCtx } from "../src/daemon.ts";
import { newInstance } from "../src/mcp/templates.ts";
import { Store } from "../src/store.ts";
import { removeTmp, repos, tmp } from "./fixtures/git.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const STALE = new ConfigurationConflict().message;

function machine(s: Store) {
  s.setLocal("node", "a");
  s.put("node", "a", { id: "a" });
  return s;
}

/** A daemon on a real port, so the CLI goes through it, and the app's typed call. */
function daemon() {
  const s = machine(new Store(":memory:"));
  const ctx = makeCtx(s);
  const handler = app(ctx);
  const served = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => handler.fetch(req, { listener: "loopback" }),
  });
  cleanup.push(async () => {
    served.stop(true);
    ctx.abort.abort();
    ctx.skills.close();
    ctx.imports.close();
    await ctx.gateway.close();
    s.close();
  });
  const op = async (name: string, input: unknown) => {
    const res = await handler.fetch(
      new Request(`http://127.0.0.1:7878/api/ops/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { host: "127.0.0.1:7878", "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
      { listener: "loopback" },
    );
    return { status: res.status, body: (await res.json()) as unknown };
  };
  return { s, ctx, op, port: served.port! };
}

/** The CLI from this checkout, with its own home and the daemon port given. */
async function cli(home: string, port: number, ...words: string[]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...words], {
    env: { ...process.env, AGENTGATE_HOME: home, AGENTGATE_PORT: String(port), AGENTGATE_DEV: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanup.push(() => child.kill());
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
}

/** A port nothing listens on, so the CLI runs store operations in its own process. */
function closedPort() {
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = closed.port!;
  closed.stop(true);
  return port;
}

test("project scan lists a folder's repositories and registers their checkouts, from the CLI and the app", async () => {
  const { ctx, op, port } = daemon();
  const r = repos("a");
  const project = `test/${r.url
    .split("/")
    .at(-1)!
    .replace(/\.git$/, "")}`;

  const { code, out } = await cli(tmp(), port, "project", "scan", r.root);
  expect(code).toBe(0);
  expect(out).toBe(`${project.padEnd(40)} ${r.a}\n${project.padEnd(40)} ${join(r.root, "seed")}\n`);
  expect(ctx.skills.checkouts()).toEqual({ [r.a]: project, [join(r.root, "seed")]: project });

  const scanned = await op("project scan", { dir: r.root });
  expect(scanned.body).toEqual({
    repos: [
      { repo: project, path: r.a },
      { repo: project, path: join(r.root, "seed") },
    ],
  });
});

test("project mirroring turns skill sharing on and off in every checkout of a repository here", async () => {
  const { ctx, op, port } = daemon();
  const r = repos("a", "b");
  const project = `test/${r.url
    .split("/")
    .at(-1)!
    .replace(/\.git$/, "")}`;
  ctx.skills.register(r.a, project, false);
  ctx.skills.register(r.b, project, false);

  const { code } = await cli(tmp(), port, "project", "mirroring", project, "on");
  expect(code).toBe(0);
  expect([ctx.skills.mirroring(r.a), ctx.skills.mirroring(r.b)]).toEqual([true, true]);

  expect((await op("project mirroring", { project, on: false })).status).toBe(200);
  expect([ctx.skills.mirroring(r.a), ctx.skills.mirroring(r.b)]).toEqual([false, false]);

  const missing = await op("project mirroring", { project: "other/repo", on: true });
  expect(missing.status).toBe(400);
  expect(missing.body).toEqual({ error: expect.stringContaining("No checkout of other/repo on this machine") });
});

test("project tools lists the tools a project offers, from the CLI and the app", async () => {
  const { s, op, port } = daemon();
  const fixture = newInstance({
    id: "fixture",
    command: process.execPath,
    args: [join(import.meta.dir, "fixtures/mcp.ts")],
  });
  s.put("mcp", "fixture", { ...fixture, tools: ["cwd", "env"] });
  s.put("mcp", "local", newInstance({ id: "local", command: "local-mcp", mode: "perSession" }));
  s.put("project", "owner/repo", { id: "owner/repo", mcp: { fx: "fixture", local: "local" }, inheritDefaults: false });

  expect((await op("project tools", { id: "owner/repo" })).body).toEqual([
    { name: "fx__cwd" },
    { name: "fx__env" },
    { name: "local__*", description: "Starts inside each session's worktree" },
  ]);
  const { code, out } = await cli(tmp(), port, "project", "tools", "owner/repo");
  expect(code).toBe(0);
  expect(out.split("\n").map((line) => line.split(" ")[0])).toEqual(["fx__cwd", "fx__env", "local__*", ""]);
});

test("a project save naming a stale revision is refused the same way from the app and the CLI", async () => {
  const { s, op, port } = daemon();
  s.put("mcp", "docs", newInstance({ id: "docs", url: "https://docs.example/mcp" }));
  s.put("project", "owner/repo", { id: "owner/repo" });
  const opened = revision(s, "project", "owner/repo");
  s.put("project", "owner/repo", { id: "owner/repo", skills: [], inheritDefaults: false });

  const app = await op("project set", { id: "owner/repo", mcp: { docs: "docs" }, revision: opened });
  expect(app).toEqual({ status: 400, body: { error: STALE } });
  const viaDaemon = await cli(tmp(), port, "project", "set", "owner/repo", "docs=docs", "--if-revision", opened);
  expect([viaDaemon.code, viaDaemon.err.trim()]).toEqual([1, STALE]);
  expect(s.get("project", "owner/repo")!.mcp).toEqual({});

  const home = tmp();
  const own = machine(new Store(join(home, "agentgate.db")));
  own.put("mcp", "docs", newInstance({ id: "docs", url: "https://docs.example/mcp" }));
  own.put("project", "owner/repo", { id: "owner/repo", inheritDefaults: false });
  own.close();
  const inProcess = await cli(home, closedPort(), "project", "set", "owner/repo", "docs=docs", "--if-revision", opened);
  expect([inProcess.code, inProcess.err.trim()]).toEqual([1, STALE]);
});

test("project set from the CLI changes only the tool prefixes it names, and an empty server removes one", async () => {
  const { s, port } = daemon();
  for (const id of ["a", "b", "c"]) s.put("mcp", id, newInstance({ id, url: `https://${id}.example/mcp` }));
  s.put("project", "owner/repo", { id: "owner/repo", mcp: { a: "a", b: "b" } });

  expect((await cli(tmp(), port, "project", "set", "owner/repo", "b=", "c=c")).code).toBe(0);
  expect(s.get("project", "owner/repo")!.mcp).toEqual({ a: "a", c: "c" });
});
