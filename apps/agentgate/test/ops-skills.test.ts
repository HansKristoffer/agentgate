import { afterAll, afterEach, expect, test } from "bun:test";
import type { SkillPreviewResponse } from "@agentgate/protocol";
import { join } from "node:path";
import { app, makeCtx } from "../src/daemon.ts";
import { SkillImports, type FetchedSkill } from "../src/skill-import.ts";
import { setSkillRepoProjects, skillRepoSummaries } from "../src/skills.ts";
import { Store } from "../src/store.ts";
import { removeTmp, tmp } from "./fixtures/git.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const REPO = "https://github.com/owner/skills";
const audited = (text: string): FetchedSkill[] => [
  {
    id: "x",
    description: "does x",
    files: [{ path: "SKILL.md", data: Buffer.from(text).toString("base64") }],
    security: { socket: "2 alerts", details: "https://skills.sh/owner/pack/x" },
  },
];

function initialized(s: Store) {
  s.setLocal("node", "a");
  s.setLocal("adminToken", "admin-secret");
  return s;
}

/** A daemon whose skill previews come from `imports` instead of `npx skills`. */
function daemon(imports = new SkillImports(async () => audited("v1"))) {
  const s = initialized(new Store(":memory:"));
  const ctx = makeCtx(s, { imports });
  const handler = app(ctx);
  cleanup.push(async () => {
    ctx.abort.abort();
    ctx.skills.close();
    ctx.imports.close();
    await ctx.imports.drain();
    await ctx.gateway.close();
    s.close();
  });
  const op = (name: string, body: unknown) =>
    handler.fetch(
      new Request(`http://127.0.0.1:7878/api/ops/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { host: "127.0.0.1:7878", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { listener: "loopback" },
    );
  const serve = () => {
    const served = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => handler.fetch(req, { listener: "loopback" }),
    });
    cleanup.push(() => served.stop(true));
    return served.port!;
  };
  return { s, op, serve };
}

/** The CLI from this checkout, with its own home and the daemon port given, and no terminal to answer it. */
async function cli(port: number, words: string[], home = tmp()) {
  initialized(new Store(join(home, "agentgate.db"))).close();
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

test("skills add in the CLI shows the app's preview with its audit, and installs only once agreed to", async () => {
  const { s, op, serve } = daemon();
  const port = serve();
  const preview = (await (await op("skills preview", { source: "owner/pack" })).json()) as SkillPreviewResponse;
  expect(preview.skills[0]!.security).toEqual({ socket: "2 alerts", details: "https://skills.sh/owner/pack/x" });

  const unanswered = await cli(port, ["skills", "add", "owner/pack", "--project", "owner/repo"]);
  expect(unanswered.code).toBe(1);
  expect(unanswered.out).toContain("security: socket: 2 alerts (https://skills.sh/owner/pack/x)");
  expect(unanswered.err).toContain("--yes");
  expect(s.get("skill", "x")).toBeUndefined();

  const agreed = await cli(port, ["skills", "add", "owner/pack", "--project", "owner/repo", "--yes"]);
  expect(agreed.code).toBe(0);
  expect(agreed.out).toContain("security: socket: 2 alerts");
  expect(agreed.out).toContain("installed x");
  expect(s.get("skill", "x")?.source).toBe("owner/pack");
  expect(s.get("project", "owner/repo")?.skills).toEqual(["x"]);
});

test("an install uses the reviewed preview, and an expired one is never fetched again", async () => {
  let fetches = 0,
    now = 0;
  const { s, op } = daemon(
    new SkillImports(
      async () => audited(`version-${++fetches}`),
      () => now,
    ),
  );
  const { token } = (await (await op("skills preview", { source: "owner/pack" })).json()) as SkillPreviewResponse;

  expect((await op("skills add", { token, ids: ["x"] })).status).toBe(200);
  expect(Buffer.from(s.get("skill", "x")!.files[0]!.data, "base64").toString()).toBe("version-1");
  now = 10 * 60_000;
  expect((await op("skills add", { token, ids: ["x"] })).status).toBe(409);
  expect(fetches).toBe(1);

  const other = (await (await op("skills preview", { source: "other/pack" })).json()) as SkillPreviewResponse;
  expect(other.skills[0]!.conflict).toContain("owner/pack");
  expect((await op("skills add", { token: other.token, ids: ["x"] })).status).toBe(409);
});

test("an edit opened before a newer save is refused, and a new skill cannot replace one", async () => {
  const { s, op } = daemon();
  expect((await op("skills new", { id: "x", skillMd: "first" })).status).toBe(200);
  const opened = s.record("skill", "x")!;
  const revision = JSON.stringify([opened.rev, opened.node, opened.updated_at]);

  expect(await (await op("skills new", { id: "x", skillMd: "again" })).json()).toEqual({
    error: "x already exists; use skills edit",
  });
  expect((await op("skills edit", { id: "x", skillMd: "newer", revision })).status).toBe(200);
  expect((await op("skills edit", { id: "x", skillMd: "stale", revision })).status).toBe(409);
  expect(Buffer.from(s.get("skill", "x")!.files[0]!.data, "base64").toString()).toBe("newer");
});

test("the app moves a repository's skills by what it changed, and only disconnecting empties its projects", async () => {
  const { s, op } = daemon();
  setSkillRepoProjects(s, REPO, ["owner/a"]);
  // Another machine adds owner/b after the app's form opened with only owner/a.
  setSkillRepoProjects(s, REPO, ["owner/a", "owner/b"]);

  const moved = await op("skills repo projects", { url: REPO, change: { add: ["owner/c"], remove: ["owner/a"] } });
  expect(await moved.json()).toEqual({ projects: ["owner/b", "owner/c"] });

  const emptied = await op("skills repo projects", { url: REPO, change: { projects: [] } });
  expect(emptied.status).toBe(400);
  expect(skillRepoSummaries(s).map((r) => r.url)).toEqual([REPO]);

  expect((await op("skills repo rm", { url: REPO })).status).toBe(200);
  expect(skillRepoSummaries(s)).toEqual([]);
});

test("with no daemon, the CLI still shows why a skill cannot be removed", async () => {
  const home = tmp();
  const s = new Store(join(home, "agentgate.db"));
  setSkillRepoProjects(s, REPO, ["owner/a"]);
  s.put("skill", "x", {
    id: "x",
    source: REPO,
    files: [{ path: "SKILL.md", data: Buffer.from("x").toString("base64") }],
    updatedAt: 0,
  });
  s.close();
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = closed.port!;
  closed.stop(true);

  const { code, err } = await cli(port, ["skills", "rm", "x"], home);

  expect(code).toBe(1);
  expect(err).toContain(`x comes from ${REPO}`);
});
