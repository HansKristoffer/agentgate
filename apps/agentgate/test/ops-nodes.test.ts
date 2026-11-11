import { afterAll, afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { app, handoffOptions, makeCtx } from "../src/daemon.ts";
import { Store } from "../src/store.ts";
import { peers } from "../src/sync.ts";
import { removeTmp, tmp } from "./fixtures/git.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** A daemon named `name` with an in-memory store, served on loopback, its node record carrying the URL a joiner uses
 * (so neither side asks Tailscale). */
function daemon(name: string) {
  const s = new Store(":memory:");
  s.setLocal("node", name);
  const ctx = makeCtx(s);
  const handler = app(ctx);
  const served = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => handler.fetch(req, { listener: "loopback" }),
  });
  const url = `http://127.0.0.1:${served.port}`;
  s.put("node", name, { id: name, url });
  cleanup.push(async () => {
    served.stop(true);
    ctx.abort.abort();
    ctx.skills.close();
    ctx.imports.close();
    await ctx.gateway.close();
    s.close();
  });
  /** The app's typed call, `control(conn, name, input)`. */
  const control = async (op: string, input: unknown) => {
    const res = await fetch(`${url}/api/ops/${encodeURIComponent(op)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(res.status).toBe(200);
    return res.json();
  };
  /** The CLI from this checkout, with its own home, talking to this daemon. */
  const cli = async (...words: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...words], {
      env: { ...process.env, AGENTGATE_HOME: tmp(), AGENTGATE_PORT: String(served.port), AGENTGATE_DEV: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    cleanup.push(() => child.kill());
    const out = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return out;
  };
  return { s, control, cli };
}

/** Both machines list each other as peers, and b has a's records after its first pull. */
function expectPaired(a: ReturnType<typeof daemon>, b: ReturnType<typeof daemon>) {
  expect(peers(a.s).map((p) => p.node)).toEqual(["b"]);
  expect(peers(b.s).map((p) => p.node)).toEqual(["a"]);
  expect(b.s.get("account", "acc")?.label).toBe("from a");
}

test("a machine pairs from the CLI words and the other joins from the app", async () => {
  const a = daemon("a"),
    b = daemon("b");
  a.s.put("account", "acc", { id: "acc", provider: "claude", label: "from a" });

  const printed = await a.cli("pair", "--tailnet");
  const command = printed.split("\n").find((line) => line.trim().startsWith("agentgate join "));
  expect(command).toBeDefined();
  expect(await b.control("join", { command: command!.trim() })).toMatchObject({ peer: "a", accounts: 1 });

  expectPaired(a, b);
});

test("a machine pairs from the app and the other joins from the CLI words", async () => {
  const a = daemon("a"),
    b = daemon("b");
  a.s.put("account", "acc", { id: "acc", provider: "claude", label: "from a" });

  const { args } = (await a.control("pair", { method: "tailnet" })) as { args: string };
  expect(await b.cli("join", ...args.split(" "))).toStartWith("paired with a;");

  expectPaired(a, b);
});

test("handoff folders set from the app are where handoffs put worktrees and clones", async () => {
  const a = daemon("a");
  const root = tmp();

  await a.control("t3 dirs", { worktrees: join(root, "wt"), clones: join(root, "src") });
  const o = handoffOptions(a.s);
  expect([o.worktreesDir, o.cloneDir]).toEqual([join(root, "wt"), join(root, "src")]);

  // A folder left out keeps its value.
  await a.control("t3 dirs", { clones: join(root, "other") });
  expect(handoffOptions(a.s).worktreesDir).toBe(join(root, "wt"));
});
