import { afterAll, afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { repos, sh, tmp, removeTmp } from "./fixtures/git.ts";
import { fakeT3 } from "./fixtures/t3.ts";
import { Handoffs } from "../src/handoff/jobs.ts";
import { syncT3Projects } from "../src/handoff/projects.ts";
import { connectT3, t3State } from "../src/handoff/t3.ts";
import { Store } from "../src/store.ts";

afterAll(removeTmp);

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function node(name: string) {
  const root = tmp();
  const s = new Store(":memory:");
  s.setLocal("node", name);
  s.put("setting", "settings", { ...s.settings(), t3ProjectSync: true });
  const t3 = fakeT3({ claudeDir: join(root, "claude") });
  await connectT3(s, { url: t3.url, token: t3.pairingToken() });
  const h = new Handoffs(s, { claudeDir: join(root, "claude"), worktreesDir: join(root, "worktrees"), cloneDir: join(root, "clones"), tempDir: join(root, "handoffs") });
  cleanup.push(async () => { await h.close(); t3.stop(); s.close(); });
  return { s, t3, h, root };
}

/** What sync would carry: the project records. */
const carry = (from: Store, to: Store) => { for (const p of from.list("project")) to.put("project", p.id, p); };

test("a project added in one machine's T3 Code is cloned into the other's, once", async () => {
  const r = repos("a");
  const repo = r.url.match(/github\.com\/(.+)\.git$/)![1]!;
  const a = await node("a"), b = await node("b");
  a.t3.addProject(r.a).title = "My repo";

  await syncT3Projects(a.h);
  expect(a.s.get("project", repo)?.t3Title).toBe("My repo");
  carry(a.s, b.s);

  await syncT3Projects(b.h);
  const dest = join(b.root, "clones", repo.split("/")[1]!);
  // HTTPS: b has no checkouts that say otherwise. T3 itself would pick SSH.
  expect(b.t3.clones).toEqual([expect.objectContaining({ provider: "github", repository: repo, title: "My repo", destinationPath: dest, protocol: "https" })]);

  // While it clones, nothing starts a second one.
  await syncT3Projects(b.h);
  expect(b.t3.clones).toHaveLength(1);

  // Once it has arrived, removing it on b stays removed.
  sh(join(b.root, "clones"), "clone", r.url, dest);
  await syncT3Projects(b.h);
  b.t3.projects.length = 0;
  await syncT3Projects(b.h);
  expect(b.t3.clones).toHaveLength(1);
  expect(t3State(b.s).projectSyncError).toBeUndefined();
});

test("a clone of a renamed repository counts once it arrives under the new name", async () => {
  const r = repos("a");
  const a = await node("a"), b = await node("b");
  a.t3.addProject(r.a); // a's checkout still names the old repository
  await syncT3Projects(a.h);
  carry(a.s, b.s);

  await syncT3Projects(b.h);
  // GitHub redirects the old name, so the checkout's origin is the new one.
  const dest = String(b.t3.clones[0]!.destinationPath);
  sh(b.root, "clone", r.url, dest);
  sh(dest, "remote", "set-url", "origin", "https://github.com/test/renamed.git");
  await syncT3Projects(b.h);
  await syncT3Projects(b.h);
  expect(b.t3.clones).toHaveLength(1);
});

test("a failed clone removed in T3 Code is tried again", async () => {
  const r = repos("a");
  const a = await node("a"), b = await node("b");
  a.t3.addProject(r.a);
  await syncT3Projects(a.h);
  carry(a.s, b.s);

  await syncT3Projects(b.h); // the clone fails: T3 keeps the project, with no checkout
  b.t3.projects.length = 0;
  await syncT3Projects(b.h);
  expect(b.t3.clones).toHaveLength(2);
});

test("a clone T3 Code refuses for a permission is reported once, with how to fix it", async () => {
  const a = await node("a"), b = await node("b");
  a.t3.addProject(repos("a").a);
  a.t3.addProject(repos("a").a);
  await syncT3Projects(a.h);
  carry(a.s, b.s);
  b.t3.denyClones = true;

  await syncT3Projects(b.h);
  expect(t3State(b.s).projectSyncError).toBe("T3 Code on b has not given agentgate the source-control:write permission; pair it again: Connect T3 Code under Machines on the T3 Code page, or agentgate t3 connect on b");

  b.t3.denyClones = false; // paired again
  await syncT3Projects(b.h);
  expect(b.t3.clones).toHaveLength(2);
  expect(t3State(b.s).projectSyncError).toBeUndefined();
});

test("a machine whose checkouts use SSH clones over SSH", async () => {
  const r = repos("a", "b");
  const a = await node("a"), b = await node("b");
  a.t3.addProject(r.a);
  await syncT3Projects(a.h);
  carry(a.s, b.s);
  const other = join(b.root, "other");
  sh(b.root, "init", other);
  sh(other, "remote", "add", "origin", "git@github.com:test/other.git");
  b.t3.addProject(other);

  await syncT3Projects(b.h);
  expect(b.t3.clones).toEqual([expect.objectContaining({ protocol: "ssh" })]);
});

test("a machine that already has a checkout of the repository gets a project for it instead of a clone", async () => {
  const r = repos("a", "b");
  const repo = r.url.match(/github\.com\/(.+)\.git$/)![1]!;
  const a = await node("a"), b = await node("b");
  a.t3.addProject(r.a);
  b.s.setLocal("checkouts", JSON.stringify({ [r.b]: repo }));

  await syncT3Projects(a.h);
  carry(a.s, b.s);
  await syncT3Projects(b.h);
  expect(b.t3.clones).toHaveLength(0);
  expect(b.t3.projects.map((p) => p.workspaceRoot)).toEqual([r.b]);
});

test("nothing moves with the setting off", async () => {
  const r = repos("a");
  const a = await node("a");
  a.s.put("setting", "settings", { ...a.s.settings(), t3ProjectSync: false });
  a.t3.addProject(r.a);
  await syncT3Projects(a.h);
  expect(a.s.list("project")).toHaveLength(0);
});
