import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { repos, tmp } from "./fixtures/git.ts";
import { fakeT3 } from "./fixtures/t3.ts";
import { Handoffs } from "../src/handoff/jobs.ts";
import { syncT3Projects } from "../src/handoff/projects.ts";
import { connectT3, t3State } from "../src/handoff/t3.ts";
import { Store } from "../src/store.ts";

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
  expect(b.t3.clones).toEqual([expect.objectContaining({ provider: "github", repository: repo, title: "My repo", destinationPath: join(b.root, "clones", repo.split("/")[1]!) })]);

  // Removing it on b stays removed.
  b.t3.projects.length = 0;
  await syncT3Projects(b.h);
  expect(b.t3.clones).toHaveLength(1);
  expect(b.t3.projects).toHaveLength(0);
  expect(t3State(b.s).projectSyncError).toBeUndefined();
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
