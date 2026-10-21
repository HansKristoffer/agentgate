import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repos, sh, tmp } from "./fixtures/git.ts";
import { fakeT3 } from "./fixtures/t3.ts";
import { addWorktree, createBundle, describe, fetchBundle, moveToSource, snapshot, stashIfUnchanged } from "../src/handoff/code.ts";
import { claudeProjectKey, claudeSessions, rewriteCwd, safeRelative } from "../src/handoff/session.ts";
import { claudeInstance, connectT3, parsePairing, projection, t3Client, t3State } from "../src/handoff/t3.ts";
import { Store } from "../src/store.ts";

const stops: (() => unknown)[] = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });

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
  expect(rewriteCwd(lines, ["/a/wt", "/a/main"], "/b/wt")).toBe([
    `{"type":"user","cwd":"/b/wt","message":{"content":"cd /a/wt"}}`,
    `{"cwd" : "/b/wt","tool":{"input":{"cwd":"/elsewhere"}}}`,
    `{"text":"{\\"cwd\\":\\"/a/wt\\"}"}`,
    `not json`,
  ].join("\n"));
});

test("a Claude session is found with its subagent transcripts and placed under another checkout", () => {
  const home = tmp(), cwd = tmp(), sid = "44957c3e-2fd8-41d9-a055-4301c88e0d7e";
  const elsewhere = join(home, "projects", "-somewhere-else");
  mkdirSync(join(elsewhere, sid, "subagents"), { recursive: true });
  writeFileSync(join(elsewhere, `${sid}.jsonl`), `{"cwd":"/a/wt"}\n`);
  writeFileSync(join(elsewhere, sid, "subagents", "agent-1.jsonl"), `{"cwd":"/a/wt"}\n`);
  writeFileSync(join(elsewhere, "other.jsonl"), "{}\n");
  const found = claudeSessions.locate(home, sid, cwd)!;
  expect(found).toEqual({ root: elsewhere, files: [`${sid}.jsonl`, `${sid}/subagents/agent-1.jsonl`] });
  expect(claudeSessions.locate(home, "../escape", cwd)).toBeUndefined();

  const dest = tmp(), target = tmp();
  claudeSessions.place(dest, sid, found.root, found.files, target, ["/a/wt"]);
  const root = join(dest, "projects", claudeProjectKey(target));
  expect(readFileSync(join(root, `${sid}.jsonl`), "utf8")).toBe(`{"cwd":${JSON.stringify(target)}}\n`);
  expect(readFileSync(join(root, sid, "subagents", "agent-1.jsonl"), "utf8")).toBe(`{"cwd":${JSON.stringify(target)}}\n`);

  // Received paths never leave the session's own files, and placing never passes through a symlink.
  expect(claudeSessions.accepts(sid, "../settings.json")).toBe(false);
  expect(claudeSessions.accepts(sid, `${sid}/../../x.jsonl`)).toBe(false);
  expect(safeRelative("/abs") || safeRelative("a//b") || safeRelative("a\\b")).toBe(false);
  const elsewhereTarget = tmp();
  symlinkSync(tmp(), join(dest, "projects", claudeProjectKey(elsewhereTarget)));
  expect(() => claudeSessions.place(dest, sid, found.root, found.files, elsewhereTarget, [])).toThrow("not a directory");
});

test("code travels as a bundle: unpushed commits and uncommitted, untracked and deleted files arrive; the source stays untouched until it stashes", async () => {
  const r = repos("a", "b");
  const wtA = join(r.root, "wt-a");
  sh(r.a, "worktree", "add", wtA, "-b", "feature", "main");
  writeFileSync(join(wtA, "feature.txt"), "committed\n"); sh(wtA, "add", "-A"); sh(wtA, "commit", "-m", "unpushed");
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
  sh(wtB, "add", "-A"); sh(wtB, "commit", "-m", "on b");
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
  const write = (dir: string, file: string, text: string) => { mkdirSync(join(dir, file, ".."), { recursive: true }); writeFileSync(join(dir, file), text); };
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

test("a destination with its own changes or commits keeps its code", async () => {
  const r = repos("a", "b");
  writeFileSync(join(r.a, "a.txt"), "a\n"); sh(r.a, "add", "-A"); sh(r.a, "commit", "-m", "a");
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
  const t3 = fakeT3({ claudeDir, label: "laptop" }); stops.push(t3.stop);
  const s = new Store(":memory:"); s.setLocal("node", "a");
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
    expect(await claudeInstance(call, "claudeAgent", "/unused")).toEqual({ instanceId: "claudeAgent", home: realpathSync(claudeDir) });
    // Another machine's instance id falls back to the default instance; without a home it uses Claude's default.
    t3.homePath = undefined;
    expect(await claudeInstance(call, "claude-work", claudeDir)).toEqual({ instanceId: "claudeAgent", home: realpathSync(claudeDir) });
  });

  // The token never shows in state, and an expired one asks for a new pairing.
  expect(JSON.stringify(t3State(s))).not.toContain(s.local("t3:token")!);
  s.now = () => Date.now() + 31 * 86_400_000;
  expect(t3State(s)).toMatchObject({ connected: false, repair: true });
  expect(() => t3Client(s)).toThrow("expired");
});

test("a T3 Code server on another orchestration protocol fails with an update message", async () => {
  const t3 = fakeT3({ claudeDir: tmp(), protocol: 3 }); stops.push(t3.stop);
  const s = new Store(":memory:"); s.setLocal("node", "a");
  await expect(connectT3(s, { url: t3.url, token: t3.pairingToken() })).rejects.toThrow("T3 Code on a uses a newer protocol; update agentgate");
});
