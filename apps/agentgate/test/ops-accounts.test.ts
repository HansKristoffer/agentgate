import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, makeCtx } from "../src/daemon.ts";
import { cool, cooldowns } from "../src/llm/policy.ts";
import { Store } from "../src/store.ts";
import { removeTmp, tmp } from "./fixtures/git.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

function daemon(s = new Store(":memory:")) {
  s.setLocal("node", "a");
  s.put("node", "a", { id: "a" });
  s.put("account", "work", { id: "work", provider: "claude", label: "work" });
  const ctx = makeCtx(s);
  const handler = app(ctx);
  cleanup.push(async () => {
    ctx.abort.abort();
    ctx.skills.close();
    ctx.imports.close();
    await ctx.gateway.close();
    s.close();
  });
  const call = async (path: string, body: unknown) => {
    const res = await handler.fetch(
      new Request(`http://127.0.0.1:7878/api${path}`, {
        method: "POST",
        headers: { host: "127.0.0.1:7878", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { listener: "loopback" },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  /** What the CLI sends the daemon for `agentgate <words>`. */
  const words = (...w: string[]) => call("/ops-terminal", { words: w });
  return { s, handler, call, words };
}

test("an account is renamed by the CLI words and by the app's call to the same operation", async () => {
  const { s, call, words } = daemon();

  expect(await words("accounts", "rename", "work", "Work", "laptop")).toEqual({
    status: 200,
    body: { code: 0, lines: ["work is now called Work laptop"] },
  });
  expect(s.get("account", "work")?.label).toBe("Work laptop");

  const renamed = await call("/ops/accounts%20rename", { id: "work", label: "Personal" });
  expect(renamed.status).toBe(200);
  expect(renamed.body).toMatchObject({ id: "work", label: "Personal" });
  expect(s.get("account", "work")?.label).toBe("Personal");
});

test("deleting an account that does not exist fails with the same message from the CLI and the app", async () => {
  const { call, words } = daemon();

  const fromCli = await words("accounts", "rm", "missing");
  const fromApp = await call("/ops/accounts%20rm", { id: "missing" });

  expect(fromCli).toEqual({ status: 400, body: { error: "No account missing" } });
  expect(fromApp).toEqual(fromCli);
});

test("a login from the terminal clears the running daemon's backoff for that account", async () => {
  const home = tmp();
  const id = "codex-abcd1234";
  const { s, handler } = daemon(new Store(join(home, "agentgate.db")));
  s.put("account", id, { id, provider: "codex", label: "codex" });
  cool(s, id, "login", s.now() + 3600_000);
  const served = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => handler.fetch(req, { listener: "loopback" }),
  });
  cleanup.push(() => served.stop(true));
  // Stands in for the official `codex login`: it leaves a login in the folder CODEX_HOME names.
  const bin = tmp();
  const login = { tokens: { access_token: "access", refresh_token: "refresh", account_id: "abcd1234" } };
  writeFileSync(join(bin, "codex"), `#!/bin/sh\necho '${JSON.stringify(login)}' > "$CODEX_HOME/auth.json"\n`);
  chmodSync(join(bin, "codex"), 0o755);

  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "login", "codex"], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      AGENTGATE_HOME: home,
      AGENTGATE_PORT: String(served.port),
      AGENTGATE_DEV: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanup.push(() => child.kill());

  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toBe(`added ${id}\n`);
  expect(cooldowns(s, id)).toEqual([]);
});
