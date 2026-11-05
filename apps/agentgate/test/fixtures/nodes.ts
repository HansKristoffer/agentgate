import { rmSync } from "node:fs";
import { join } from "node:path";
import { app, makeCtx, type Ctx } from "../../src/daemon.ts";
import { NODE_PROTOCOL } from "../../src/remote.ts";
import { Store } from "../../src/store.ts";
import { tmp } from "./git.ts";

export interface TestNode {
  name: string;
  s: Store;
  ctx: Ctx;
  url: string;
  stop(): Promise<void>;
}

/** Daemons with in-memory stores, each serving the whole app on its own port, every pair peered as after
 * `agentgate pair`. They listen as the tailnet listener, the way peers reach each other, so `/api` needs the admin
 * token there; call the store or `ctx` directly instead. Handoff folders and Claude's home are temporary. */
export async function startNodes(...names: string[]): Promise<TestNode[]> {
  const nodes = names.map((name): TestNode => {
    const root = tmp();
    const s = new Store(":memory:");
    s.setLocal("node", name);
    const ctx = makeCtx(s, {
      handoffs: {
        claudeDir: join(root, "claude"),
        worktreesDir: join(root, "worktrees"),
        cloneDir: join(root, "clones"),
        tempDir: join(root, "handoffs"),
      },
    });
    const handler = app(ctx);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => handler.fetch(req, { listener: "tailnet" }),
    });
    return {
      name,
      s,
      ctx,
      url: `http://127.0.0.1:${server.port}`,
      async stop() {
        ctx.abort.abort();
        server.stop(true);
        ctx.skills.close();
        ctx.files.close();
        ctx.imports.close();
        ctx.remote.close();
        ctx.channel.close();
        ctx.health.stop();
        await ctx.gateway.close();
        await ctx.handoffs.close();
        await ctx.imports.drain();
        s.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  });

  // One token per pair, held by both sides: a peer is recognised by the token it sends.
  for (const [i, n] of nodes.entries())
    for (const m of nodes.slice(i + 1)) {
      const token = crypto.randomUUID();
      n.s.db.run("insert into peers values (?, ?, ?, 0, ?)", [m.name, m.url, token, n.s.now()]);
      m.s.db.run("insert into peers values (?, ?, ?, 0, ?)", [n.name, n.url, token, m.s.now()]);
    }
  for (const n of nodes) for (const m of nodes) n.s.put("node", m.name, { id: m.name, protocol: NODE_PROTOCOL });
  return nodes;
}
