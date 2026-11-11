import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repos, sh, tmp, removeTmp } from "./fixtures/git.ts";
import { fakeT3 } from "./fixtures/t3.ts";
import {
  addWorktree,
  createBundle,
  describe,
  fetchBundle,
  moveToSource,
  snapshot,
  stashIfUnchanged,
} from "../src/handoff/code.ts";
import { claudeProjectKey, claudeSessions, rewriteCwd, safeRelative } from "../src/handoff/session.ts";
import {
  activeT3,
  claudeInstance,
  connectT3,
  connectWith,
  createPairingLink,
  host as t3Host,
  parsePairing,
  projection,
  t3Client,
  t3State,
} from "../src/handoff/t3.ts";
import { allNodes, handoffJob } from "../src/handoff/threads.ts";
import { sessionLines, sessionMessages } from "../src/handoff/history.ts";
import { Handoffs } from "../src/handoff/jobs.ts";
import { handoffRoutes } from "../src/handoff/routes.ts";
import { CHANNEL_CHUNK } from "../src/channel.ts";
import { startLagProbe } from "../src/lag.ts";
import type { Peer } from "../src/sync.ts";
import { Hono } from "hono";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";
import { Store } from "../src/store.ts";
import { nodeThreadsSchema } from "@agentgate/protocol";
import { startNodes } from "./fixtures/nodes.ts";

afterAll(removeTmp);
const gzip = promisify(gzipCallback);

const stops: (() => unknown)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

test("claudeProjectKey matches Claude Code's directory names, hashing paths past 200 characters", () => {
  expect(claudeProjectKey("/Users/me/My Repo.git")).toBe("-Users-me-My-Repo-git");
  const long = `/${"a".repeat(250)}`;
  expect(claudeProjectKey(long).startsWith(`-${"a".repeat(199)}-`)).toBe(true);
  expect(claudeProjectKey(long)).not.toBe(claudeProjectKey(`/${"a".repeat(251)}`));
});

test("rewriteCwd changes only recorded cwd values and keeps every other byte", () => {
  const lines = [
    `{"type":"user","cwd":"/a/wt","message":{"content":"cd /a/wt"}}`,
    `{"cwd" : "/a/main","tool":{"input":{"cwd":"/elsewhere"}}}`,
    `{"text":"{\\"cwd\\":\\"/a/wt\\"}"}`,
    `not json`,
  ].join("\n");
  expect(rewriteCwd(lines, ["/a/wt", "/a/main"], "/b/wt")).toBe(
    [
      `{"type":"user","cwd":"/b/wt","message":{"content":"cd /a/wt"}}`,
      `{"cwd" : "/b/wt","tool":{"input":{"cwd":"/elsewhere"}}}`,
      `{"text":"{\\"cwd\\":\\"/a/wt\\"}"}`,
      `not json`,
    ].join("\n"),
  );
});

test("a Claude session is found with its subagent transcripts and placed under another checkout", async () => {
  const home = tmp(),
    cwd = tmp(),
    sid = "44957c3e-2fd8-41d9-a055-4301c88e0d7e";
  const elsewhere = join(home, "projects", "-somewhere-else");
  mkdirSync(join(elsewhere, sid, "subagents"), { recursive: true });
  writeFileSync(join(elsewhere, `${sid}.jsonl`), `{"cwd":"/a/wt"}\n`);
  writeFileSync(join(elsewhere, sid, "subagents", "agent-1.jsonl"), `{"cwd":"/a/wt"}\n`);
  writeFileSync(join(elsewhere, "other.jsonl"), "{}\n");
  const found = claudeSessions.locate(home, sid, cwd)!;
  expect(found).toEqual({ root: elsewhere, files: [`${sid}.jsonl`, `${sid}/subagents/agent-1.jsonl`] });
  expect(claudeSessions.locate(home, "../escape", cwd)).toBeUndefined();

  const dest = tmp(),
    target = tmp();
  await claudeSessions.place(dest, sid, found.root, found.files, target, ["/a/wt"]);
  const root = join(dest, "projects", claudeProjectKey(target));
  expect(readFileSync(join(root, `${sid}.jsonl`), "utf8")).toBe(`{"cwd":${JSON.stringify(target)}}\n`);
  expect(readFileSync(join(root, sid, "subagents", "agent-1.jsonl"), "utf8")).toBe(
    `{"cwd":${JSON.stringify(target)}}\n`,
  );

  // Received paths never leave the session's own files, and placing never passes through a symlink.
  expect(claudeSessions.accepts(sid, "../settings.json")).toBe(false);
  expect(claudeSessions.accepts(sid, `${sid}/../../x.jsonl`)).toBe(false);
  expect(safeRelative("/abs") || safeRelative("a//b") || safeRelative("a\\b")).toBe(false);
  const elsewhereTarget = tmp();
  symlinkSync(tmp(), join(dest, "projects", claudeProjectKey(elsewhereTarget)));
  await expect(claudeSessions.place(dest, sid, found.root, found.files, elsewhereTarget, [])).rejects.toThrow(
    "not a directory",
  );
});

/** Node b with a handoff from a waiting for its files, and b's peer routes as a reaches them. `restart` stands for a
 * daemon restart: the same store and folders, new routes. */
function receiver(maxTotal?: number) {
  const s = new Store(":memory:");
  s.setLocal("node", "b");
  stops.push(() => s.close());
  const options = { claudeDir: tmp(), worktreesDir: tmp(), cloneDir: tmp(), tempDir: tmp() };
  const routes = (h: Handoffs) =>
    new Hono<{ Variables: { peer: Peer } }>()
      .use("*", async (c, next) => {
        c.set("peer", { node: "a" } as Peer);
        await next();
      })
      .route("/", handoffRoutes(h, maxTotal));
  const h = new Handoffs(s, options);
  let app = routes(h);
  const { id } = h.create({
    id: crypto.randomUUID(),
    role: "destination",
    thread: "",
    target: "b",
    step: "prepare",
    state: {
      source: "a",
      prepare: {
        remoteUrl: "https://github.com/test/repo.git",
        projectTitle: "repo",
        branch: null,
        baseSha: null,
        worktree: false,
      },
      warnings: [],
      timings: [],
    },
  });
  return {
    files: join(h.dir(id), "files"),
    /** Send `bytes` gzipped as the source does, and answer with the status. */
    async put(path: string, offset: number, bytes: Uint8Array) {
      const query = new URLSearchParams({ path, offset: String(offset) });
      const body = await gzip(bytes);
      return (await app.request(`/handoff/${id}/files?${query}`, { method: "PUT", body })).status;
    },
    restart() {
      app = routes(new Handoffs(s, options));
    },
  };
}

test("a 50 MB transcript is received, placed and read for its history without stalling the daemon", async () => {
  const sid = "44957c3e-2fd8-41d9-a055-4301c88e0d7e";
  const { files, put } = receiver();
  // Lines of uneven length, so reads end mid-line and mid-character.
  const lines: string[] = [];
  let size = 0;
  while (size < 50 * 1024 * 1024) {
    const i = lines.length;
    const content = `${i} ø ${"x".repeat(i % 3000)}`;
    lines.push(JSON.stringify({ type: i % 2 ? "assistant" : "user", cwd: "/a/wt", message: { content } }));
    size += lines[i]!.length + 1;
  }
  const text = lines.join("\n") + "\n";
  const transcript = new TextEncoder().encode(text);

  const home = tmp(),
    target = tmp();
  const file = Bun.file(join(files, "session", `${sid}.jsonl`));
  const statuses = new Set<number>();
  const probe = startLagProbe(10);
  let n, history;
  try {
    for (let offset = 0; offset < transcript.length; offset += CHANNEL_CHUNK)
      statuses.add(await put(`session/${sid}.jsonl`, offset, transcript.subarray(offset, offset + CHANNEL_CHUNK)));
    await claudeSessions.place(home, sid, join(files, "session"), [`${sid}.jsonl`], target, ["/a/wt"]);
    n = await sessionLines(file);
    history = await sessionMessages(file, n - 3, "2026-10-15T08:00:00.000Z");
  } finally {
    probe.stop();
  }

  expect(probe.read().worstMs).toBeLessThan(50);
  expect([...statuses]).toEqual([200]);
  expect(n).toBe(lines.length);
  expect(history?.map((m) => m.text.split(" ")[0])).toEqual([n - 3, n - 2, n - 1].map(String));
  const placed = await Bun.file(join(home, "projects", claudeProjectKey(target), `${sid}.jsonl`)).text();
  // Compared as a boolean: a failure would otherwise print both 50 MB strings.
  expect(placed === rewriteCwd(text, ["/a/wt"], target)).toBe(true);
});

test("a handoff past its size cap is refused, counting retried chunks once and the files already there after a restart", async () => {
  const b = receiver(10);
  const bytes = (n: number) => new Uint8Array(n).fill(120);

  expect(await b.put("session/s.jsonl", 0, bytes(6))).toBe(200);
  expect(await b.put("bundle", 0, bytes(4))).toBe(200);
  // A retry restarts the file: its earlier bytes no longer count.
  expect(await b.put("session/s.jsonl", 0, bytes(6))).toBe(200);
  expect(await b.put("bundle", 4, bytes(1))).toBe(413);

  b.restart();
  expect(await b.put("bundle", 4, bytes(1))).toBe(413);
  expect(await b.put("bundle", 0, bytes(4))).toBe(200);
});

test("code travels as a bundle: unpushed commits and uncommitted, untracked and deleted files arrive; the source stays untouched until it stashes", async () => {
  const r = repos("a", "b");
  const wtA = join(r.root, "wt-a");
  sh(r.a, "worktree", "add", wtA, "-b", "feature", "main");
  writeFileSync(join(wtA, "feature.txt"), "committed\n");
  sh(wtA, "add", "-A");
  sh(wtA, "commit", "-m", "unpushed");
  writeFileSync(join(wtA, "README.md"), "edited\n");
  writeFileSync(join(wtA, "new.txt"), "untracked\n");
  unlinkSync(join(wtA, "old.txt"));
  const statusBefore = sh(wtA, "status", "--porcelain");

  const code = await describe(wtA);
  expect(code).toMatchObject({ branch: "feature", remoteUrl: r.url, baseSha: sh(r.a, "rev-parse", "main") });
  const snap = await snapshot(wtA, "h1", code.headSha);
  expect(snap.uncommitted).toBe(true);
  const bundle = join(r.root, "out.bundle");
  expect(await createBundle(wtA, "h1", snap.sha, bundle)).toBe(true);
  expect(sh(wtA, "status", "--porcelain")).toBe(statusBefore);
  expect(sh(wtA, "for-each-ref", "refs/agentgate")).toBe("");

  // B builds its worktree from the base before the bundle arrives, then moves onto the source's code.
  const wtB = join(r.root, "wt-b");
  await addWorktree(r.b, wtB, "feature", code.baseSha!);
  expect(await fetchBundle(r.b, bundle, "h1")).toBe(true);
  expect(await moveToSource(wtB, "feature", code.headSha, snap)).toEqual({ replaced: [] });
  expect(readFileSync(join(wtB, "feature.txt"), "utf8")).toBe("committed\n");
  expect(readFileSync(join(wtB, "README.md"), "utf8")).toBe("edited\n");
  expect(readFileSync(join(wtB, "new.txt"), "utf8")).toBe("untracked\n");
  expect(existsSync(join(wtB, "old.txt"))).toBe(false);
  expect(sh(wtB, "rev-parse", "HEAD")).toBe(code.headSha);

  // A stashes only while its worktree is exactly what was sent.
  writeFileSync(join(wtA, "late.txt"), "written after sending\n");
  expect(await stashIfUnchanged(wtA, snap, "agentgate: handed to b")).toBe(false);
  unlinkSync(join(wtA, "late.txt"));
  expect(await stashIfUnchanged(wtA, snap, "agentgate: handed to b")).toBe(true);
  expect(sh(wtA, "status", "--porcelain")).toBe("");

  // Round trip: B commits; A, clean and behind, takes B's code.
  sh(wtB, "add", "-A");
  sh(wtB, "commit", "-m", "on b");
  writeFileSync(join(wtB, "b.txt"), "dirty on b\n");
  const back = await describe(wtB);
  const snapB = await snapshot(wtB, "h2", back.headSha);
  const bundleB = join(r.root, "back.bundle");
  expect(await createBundle(wtB, "h2", snapB.sha, bundleB)).toBe(true);
  expect(await fetchBundle(r.a, bundleB, "h2")).toBe(true);
  expect(await moveToSource(wtA, "feature", back.headSha, snapB)).toEqual({ replaced: [] });
  expect(readFileSync(join(wtA, "b.txt"), "utf8")).toBe("dirty on b\n");
  expect(readFileSync(join(wtA, "new.txt"), "utf8")).toBe("untracked\n");
});

test("ignored files travel except rebuilt folders; the destination's own versions go to a stash, a stale copy does not", async () => {
  const r = repos("a", "b");
  const write = (dir: string, file: string, text: string) => {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  write(r.a, ".plans/plan.md", "v1\n");
  write(r.a, ".env", "from a\n");
  write(r.a, "node_modules/dep.js", "a's dependency\n");
  write(r.b, ".env", "b's own\n");
  write(r.b, "node_modules/own.js", "b's dependency\n");
  const head = sh(r.a, "rev-parse", "HEAD");

  const snap = await snapshot(r.a, "h1", head);
  expect(snap.uncommitted).toBe(true);
  expect(await createBundle(r.a, "h1", snap.sha, join(r.root, "a.bundle"))).toBe(true);
  expect(await fetchBundle(r.b, join(r.root, "a.bundle"), "h1")).toBe(true);
  expect(await moveToSource(r.b, "main", head, snap)).toEqual({ replaced: [".env"] });
  expect(readFileSync(join(r.b, ".plans/plan.md"), "utf8")).toBe("v1\n");
  expect(readFileSync(join(r.b, ".env"), "utf8")).toBe("from a\n");
  expect(existsSync(join(r.b, "node_modules/dep.js"))).toBe(false);
  expect(existsSync(join(r.b, "node_modules/own.js"))).toBe(true);
  expect(sh(r.b, "show", "stash@{0}^3:.env")).toBe("b's own");
  expect(sh(r.b, "status", "--porcelain")).toBe("");

  // Ignored files are not stashed on the source, so writing one after sending does not keep the rest from it.
  write(r.a, ".plans/later.md", "written after sending\n");
  expect(await stashIfUnchanged(r.a, snap, "agentgate: handed to b")).toBe(true);
  expect(readFileSync(join(r.a, ".plans/plan.md"), "utf8")).toBe("v1\n");

  // Round trip: B's edited plan replaces A's copy without a stash, since A sent that copy itself.
  write(r.b, ".plans/plan.md", "v2\n");
  const snapB = await snapshot(r.b, "h2", head);
  expect(await createBundle(r.b, "h2", snapB.sha, join(r.root, "b.bundle"))).toBe(true);
  expect(await fetchBundle(r.a, join(r.root, "b.bundle"), "h2")).toBe(true);
  expect(await moveToSource(r.a, "main", head, snapB)).toEqual({ replaced: [] });
  expect(readFileSync(join(r.a, ".plans/plan.md"), "utf8")).toBe("v2\n");
  expect(sh(r.a, "stash", "list")).toBe("");
});

test("ignored files the file store carries stay out of the snapshot", async () => {
  const r = repos("a");
  writeFileSync(join(r.a, ".env"), "machine a\n");
  const head = sh(r.a, "rev-parse", "HEAD");
  expect(await snapshot(r.a, "h1", head, [".env"])).toEqual({ sha: head, uncommitted: false });
});

test("a token in the origin URL stays on the source; an SSH user travels", async () => {
  const r = repos("a");
  sh(r.a, "remote", "set-url", "origin", "https://user:tok@host/x.git");
  expect((await describe(r.a)).remoteUrl).toBe("https://host/x.git");
  sh(r.a, "remote", "set-url", "origin", "ssh://git@host/x.git");
  expect((await describe(r.a)).remoteUrl).toBe("ssh://git@host/x.git");
});

test("a destination with its own changes or commits keeps its code", async () => {
  const r = repos("a", "b");
  writeFileSync(join(r.a, "a.txt"), "a\n");
  sh(r.a, "add", "-A");
  sh(r.a, "commit", "-m", "a");
  const head = sh(r.a, "rev-parse", "HEAD");
  const bundle = join(r.root, "a.bundle");
  expect(await createBundle(r.a, "x", head, bundle)).toBe(true);
  expect(await fetchBundle(r.b, bundle, "x")).toBe(true);
  writeFileSync(join(r.b, "README.md"), "local edit\n");
  expect((await moveToSource(r.b, "main", head, undefined)).kept).toBe("it has uncommitted changes");
  sh(r.b, "commit", "-am", "b's own work");
  expect((await moveToSource(r.b, "main", head, undefined)).kept).toBe("it has commits the source does not");
  expect(readFileSync(join(r.b, "README.md"), "utf8")).toBe("local edit\n");
  // Nothing unpushed and nothing dirty: no bundle at all, B fetches origin.
  expect(await createBundle(r.b, "y", sh(r.b, "rev-parse", "origin/main"), join(r.root, "none.bundle"))).toBe(false);
});

test("the T3 client pairs, reads over HTTP, calls RPC methods and decodes failures", async () => {
  const claudeDir = tmp();
  const t3 = fakeT3({ claudeDir, label: "laptop" });
  stops.push(t3.stop);
  const s = new Store(":memory:");
  s.setLocal("node", "a");
  expect(t3State(s)).toEqual({ connected: false });
  expect(() => t3Client(s)).toThrow("not connected");
  const token = t3.pairingToken();
  expect(parsePairing(`${t3.url}/pair#token=${token}`)).toEqual({ url: t3.url, token });
  await connectT3(s, parsePairing(`${t3.url}/pair#token=${token}`));
  expect(t3State(s)).toMatchObject({ connected: true, url: t3.url, label: "laptop", repair: false });
  await expect(connectT3(s, { url: t3.url, token })).rejects.toThrow("single-use");
  await expect(connectT3(s, { url: "https://t3.example.com/pair", token: "x" })).rejects.toThrow("on this machine");
  // A link with this machine's LAN address (T3 shows links only with network access on) goes to loopback instead.
  await connectT3(s, parsePairing(`http://192.168.1.2:${new URL(t3.url).port}/pair#token=${t3.pairingToken()}`));
  expect(t3State(s).url).toBe(t3.url);
  expect(JSON.stringify(s.localPrefixed("t3:"))).toContain(":token");

  const project = t3.addProject(tmp());
  const thread = t3.addThread({ projectId: project.id, sessionId: "s1" });
  const client = t3Client(s);
  expect((await client.shell()).threads.map((t) => t.id)).toEqual([thread.id]);
  await client.rpc(async (call) => {
    expect((await projection(call, thread.id)).thread.title).toBe("Fix the bug");
    await expect(projection(call, "missing")).rejects.toThrow("thread not found");
    expect(await claudeInstance(call, "claudeAgent", "/unused")).toEqual({
      instanceId: "claudeAgent",
      home: realpathSync(claudeDir),
    });
    // Another machine's instance id falls back to the default instance; without a home it uses Claude's default.
    t3.homePath = undefined;
    expect(await claudeInstance(call, "claude-work", claudeDir)).toEqual({
      instanceId: "claudeAgent",
      home: realpathSync(claudeDir),
    });
  });

  // The token never shows in state, and an expired one asks for a new pairing.
  expect(JSON.stringify(t3State(s))).not.toContain(s.local("t3:token")!);
  s.now = () => Date.now() + 31 * 86_400_000;
  expect(t3State(s)).toMatchObject({ connected: false, repair: true });
  expect(() => t3Client(s)).toThrow("expired");
});

test("T3 Code's own t3 pair creates the link: shown to the user, or redeemed to connect", async () => {
  const t3 = fakeT3({ claudeDir: tmp() });
  stops.push(t3.stop);
  const s = new Store(":memory:");
  s.setLocal("node", "a");
  // A stand-in for `t3 pair`, printing what upstream prints around a fresh token.
  const dir = tmp(),
    bin = join(dir, "t3"),
    args = join(dir, "args");
  const fake = (body: string) => {
    writeFileSync(bin, `#!/bin/sh\necho "$@" > ${args}\n${body}`, { mode: 0o755 });
  };
  const real = t3Host.t3;
  t3Host.t3 = () => bin;
  stops.push(() => {
    t3Host.t3 = real;
  });

  fake(
    `echo "Pairing URL: ${t3.url}/pair#token=${t3.pairingToken()}"\necho "Expires: 2026-10-14T12:05:00.000Z"\necho ""\necho "Note: This URL is only reachable from this machine."`,
  );
  const link = await createPairingLink(s, { tailscale: true });
  expect(link).toEqual({
    url: expect.stringContaining("/pair#token="),
    expiresAt: "2026-10-14T12:05:00.000Z",
    notes: ["This URL is only reachable from this machine."],
  });
  expect(readFileSync(args, "utf8").trim()).toBe("pair --log-level error --tailscale");

  fake(`echo "Pairing URL: ${t3.url}/pair#token=${t3.pairingToken()}"`);
  await connectWith(s, { create: true });
  expect(t3State(s)).toMatchObject({ connected: true, url: t3.url });
  expect(readFileSync(args, "utf8").trim()).toBe("pair --log-level error --label agentgate a");

  // A failure says why and which t3 ran, and never repeats stdout, where a token would be.
  const failure = (run: Promise<unknown>) => run.then(String, (e: Error) => e.message);
  fake(`echo "Token: secret-token"\necho "No running T3 Code server found." >&2\nexit 1`);
  expect(await failure(createPairingLink(s))).toBe(`t3 pair failed on a (${bin}): No running T3 Code server found.`);
  // An older t3 answers a flag it does not know with its usage.
  fake(`echo "USAGE: t3 pair [--label text]. Token: secret-token"`);
  expect(await failure(createPairingLink(s))).toBe(`t3 pair failed on a (${bin}): it printed no pairing link`);

  // T3 Code refusing a token this t3 made a moment ago points at the binary; a pasted link may be used or old.
  const stray = `${t3.url}/pair#token=another-servers-token`;
  fake(`echo "Pairing URL: ${stray}"`);
  const refused = await failure(connectWith(s, { create: true }));
  expect(refused).toContain(`rejected the pairing token ${bin} had just created`);
  expect(refused).not.toContain("another-servers-token");
  await expect(connectWith(s, { pairingUrl: stray })).rejects.toThrow("single-use and expires");

  t3Host.t3 = () => undefined;
  await expect(createPairingLink(s)).rejects.toThrow("not installed on a");
});

test("the t3 command is the running T3 Code server's own binary when T3 Code names one", () => {
  const home = tmp();
  const state = join(home, "runtime", "service-state.json");
  const bin = join(home, "runtime", "versions", "0.1.9-nightly.20261110.4452", "t3");
  // T3 Code keeps no versions here, as without its self-updating service.
  expect(activeT3(home)).toBeUndefined();

  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(state, "{ half-written");
  expect(activeT3(home)).toBeUndefined();
  // A version that is named and not installed.
  writeFileSync(state, JSON.stringify({ protocol: 3, activeVersion: "0.1.8-nightly.20261106.4262" }));
  expect(activeT3(home)).toBeUndefined();
  writeFileSync(
    state,
    JSON.stringify({ protocol: 3, activeVersion: "0.1.9-nightly.20261110.4452", update: { status: "committed" } }),
  );
  expect(activeT3(home)).toBe(bin);

  // T3CODE_HOME names T3's folder when it is not ~/.t3. Where a t3 is on PATH too, the running server's still wins.
  const real = process.env.T3CODE_HOME;
  stops.push(() => {
    if (real === undefined) delete process.env.T3CODE_HOME;
    else process.env.T3CODE_HOME = real;
  });
  process.env.T3CODE_HOME = home;
  expect(t3Host.t3()).toBe(bin);
});

test("a machine whose thread view this one cannot read is listed with an error, and the others stay listed", async () => {
  const [a, b] = await startNodes("a", "b");
  stops.push(a!.stop, b!.stop);
  const odd = Bun.serve({
    port: 0,
    fetch: () => Response.json({ t3: { connected: true }, threads: [{ id: 1 }], jobs: [] }),
  });
  stops.push(() => odd.stop(true));
  a!.s.db.run("insert into peers values ('c', ?, 'tok', 0, ?)", [`http://127.0.0.1:${odd.port}`, a!.s.now()]);
  a!.s.put("node", "c", { id: "c" });

  const views = await allNodes(a!.ctx.handoffs);
  // What the app parses the list with: one bad entry would fail all of it.
  expect(nodeThreadsSchema.array().safeParse(views).success).toBe(true);
  const byNode = new Map(views.map((v) => [v.node, v]));
  expect(byNode.get("b")).toMatchObject({ online: true, threads: [] });
  expect(byNode.get("b")!.error).toBeUndefined();
  expect(byNode.get("c")).toMatchObject({ threads: [], error: expect.stringContaining("c answered /threads") });
  // An answer read for its fields is checked too, and the error names the machine.
  await expect(handoffJob(a!.ctx.handoffs, crypto.randomUUID(), "c")).rejects.toThrow(
    /^c answered \/handoff\/[^ ]+\/job in a form a cannot read \(/,
  );
});

test("a T3 Code server on another orchestration protocol fails with an update message", async () => {
  const t3 = fakeT3({ claudeDir: tmp(), protocol: 3 });
  stops.push(t3.stop);
  const s = new Store(":memory:");
  s.setLocal("node", "a");
  await expect(connectT3(s, { url: t3.url, token: t3.pairingToken() })).rejects.toThrow(
    "T3 Code on a uses a newer protocol; update agentgate",
  );
});
