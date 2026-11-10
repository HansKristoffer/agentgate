// Seeds this checkout's dev store from a scrubbed copy of the live one, so the dev daemon has real
// accounts, MCP servers, projects, skills and activity to show. Credentials, shared logins, MCP and factory secrets, peers, relay
// membership, registered checkouts, the factory's pointer and items, and other node-local state stay behind: the dev daemon
// must never refresh a real token, sync with a real machine, link skills into a real repository, or act on a live PR.
// Usage, with the dev daemon stopped: bun scripts/seed-dev-store.ts [--force]
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NODE_PROTOCOL } from "../apps/agentgate/src/remote.ts";
import { CONFIG_DIR, DEV, type Kind, LOCAL_URL, SECRET_KINDS, Store } from "../apps/agentgate/src/store.ts";

/** Drops everything a dev daemon must not act on: secrets, peers, relay membership, node-local state, MCP secrets, and
 * the factory's pointer, tables and session usage, so a dev daemon never follows the live install's items or PRs
 * through this machine's real `gh` login. */
export function scrubDevStore(s: Store) {
  s.transaction(() => {
    s.db.run(`delete from records where kind in (${SECRET_KINDS.map(() => "?").join(", ")})`, SECRET_KINDS);
    s.db.run("delete from peers");
    s.db.run("delete from local");
    const tables = (s.db.query("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map(
      (t) => t.name,
    );
    for (const table of tables)
      if (["relay_counters", "relay_pending", "session_usage"].includes(table) || table.startsWith("factory_"))
        s.db.run(`delete from ${table}`);
    for (const row of s.db.query("select id, data from records where kind = 'mcp' and deleted = 0").all() as {
      id: string;
      data: string;
    }[]) {
      const { secrets: _secrets, headers: _headers, env: _env, ...config } = JSON.parse(row.data);
      s.db.run("update records set data = ? where kind = 'mcp' and id = ?", [
        JSON.stringify({ ...config, secrets: {} }),
        row.id,
      ]);
    }
    // Every machine posts its factory updates to a virtual project's webhook; a dev daemon must not post to a real one.
    for (const row of s.db.query("select id, data from records where kind = 'project' and deleted = 0").all() as {
      id: string;
      data: string;
    }[]) {
      const { factoryWebhook, ...project } = JSON.parse(row.data);
      if (factoryWebhook)
        s.db.run("update records set data = ? where kind = 'project' and id = ?", [JSON.stringify(project), row.id]);
    }
    const settings = s.db.query("select data from records where kind = 'setting' and id = 'settings'").get() as {
      data: string;
    } | null;
    if (settings) {
      const { factory: _factory, ...rest } = JSON.parse(settings.data);
      s.db.run("update records set data = ? where kind = 'setting' and id = 'settings'", [JSON.stringify(rest)]);
    }
    s.setLocal("node", "dev");
    s.setLocal("adminToken", crypto.randomUUID().replace(/-/g, ""));
    s.put("node", "dev", { id: "dev", alwaysOn: false, protocol: NODE_PROTOCOL });
  });
}

async function main() {
  const die = (message: string) => {
    console.error(message);
    process.exit(1);
  };
  if (!DEV) die("Run this from a checkout without AGENTGATE_HOME set; it only writes a checkout's dev store.");
  const live = join(homedir(), ".config", "agentgate", "agentgate.db");
  if (!existsSync(live)) die(`No live store at ${live}.`);
  if (
    await fetch(`${LOCAL_URL}/api/status`).then(
      () => true,
      () => false,
    )
  )
    die(`Stop the dev daemon at ${LOCAL_URL} first.`);
  const target = join(CONFIG_DIR, "agentgate.db");
  if (existsSync(target) && !Bun.argv.includes("--force")) die(`${target} exists; pass --force to replace it.`);

  for (const suffix of ["", "-wal", "-shm"]) rmSync(target + suffix, { force: true });
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // A read-only snapshot: the live daemon keeps writing while we copy, and nothing flows back.
  const source = new Database(live, { readonly: true });
  source.run(`vacuum into '${target.replaceAll("'", "''")}'`);
  source.close();

  const s = new Store(target);
  scrubDevStore(s);
  const count = (kind: Kind) => s.list(kind).length;
  console.log(
    `Seeded ${target}: ${count("account")} accounts (signed out), ${count("mcp")} MCP servers (no secrets), ${count("project")} projects, ${count("skill")} skills.`,
  );
  s.close();
}

if (import.meta.main) await main();
