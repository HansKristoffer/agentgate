import { afterAll, afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FactoryBoard, FactoryCheck } from "@agentgate/protocol";
import { canaryTiming } from "../src/factory/canary.ts";
import { items, runs } from "../src/factory/db.ts";
import { loopTask } from "../src/factory/runtime.ts";
import { host as t3Host } from "../src/handoff/t3.ts";
import { host as login, type GhAnswer } from "../src/logins.ts";
import { LOCAL_URL } from "../src/store.ts";
import { recorded } from "./fixtures/gh.ts";
import { removeTmp, tmp } from "./fixtures/git.ts";
import { factoryNode } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** The scratch repository and label the recordings were made against: GitHub has no such label there. */
const SCRATCH = "HansKristoffer/factory-scratch";

/**
 * `gh` for the preflight's own reads, answered by their arguments. Only the label's 404 is a recording; the login
 * (`api user --include`) and push access were never recorded, so they are stubbed here in the shape gh prints them.
 */
function ghAnswers(scopes = "repo, read:org") {
  login.gh = async (args): Promise<GhAnswer> => {
    if (args.join(" ") === "api user --include")
      return {
        ok: true,
        exit: 0,
        out: `HTTP/2.0 200 OK\nContent-Type: application/json; charset=utf-8\nX-Oauth-Scopes: ${scopes}\n\n{"login":"factory-bot","id":1}`,
      };
    if (args[0] === "api" && args.at(-1) === ".permissions.push") return { ok: true, exit: 0, out: "true" };
    if (args[1] === `repos/${SCRATCH}/labels/no-such-label`) return recorded("label.missing");
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
}

const byId = (checks: FactoryCheck[], id: string) => checks.find((c) => c.id === id);
const board = async (n: Awaited<ReturnType<typeof factoryNode>>) =>
  (await (await n.api("/api/factory")).json()) as FactoryBoard;
const doctor = async (n: Awaited<ReturnType<typeof factoryNode>>, input: { canary?: boolean } = {}) =>
  ((await (await n.op("doctor", input)).json()) as { checks: FactoryCheck[] }).checks;

test("doctor passes, exit 0, when T3 Code, its MCP, gh, the provider home, the folder and secrets are all set up", async () => {
  const n = await factoryNode(cleanup);
  expect((await n.command("t3", "sign-in")).code).toBe(0);
  const home = n.t3.homePath!;
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { agentgate: { type: "stdio" } } }));
  writeFileSync(join(home, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `${LOCAL_URL}/anthropic` } }));
  n.t3.settings = { storageCleanup: { worktreeAfterDays: null, worktreeOnMerge: true } };
  n.t3.serverVersion = "0.1.9-nightly.20261110.4452";
  const real = t3Host.t3;
  t3Host.t3 = () => `${tmp()}/runtime/versions/0.1.9-nightly.20261110.4452/t3`;
  cleanup.push(() => (t3Host.t3 = real));
  ghAnswers();

  const { code, output } = await n.command("doctor");
  expect(output.filter((l) => !l.startsWith("ok "))).toEqual(["", "Nothing failing."]);
  expect(code).toBe(0);
  expect(output.find((l) => l.includes("gh is signed in"))).toBe(
    "ok    gh is signed in with the repo scope: as factory-bot",
  );
});

test("each check fails with its fix: a t3 of another version, gh without the repo scope, a missing label, an unset secret, and a provider home without agentgate", async () => {
  const n = await factoryNode(cleanup, {
    config: (repo) => ({
      repositories: { [repo]: {}, [SCRATCH]: {} },
      sources: [
        { id: "issues", type: "github", repo: SCRATCH, label: "no-such-label" },
        {
          id: "desk",
          type: "webhook",
          repo,
          title: "{{body.subject}}",
          signature: { header: "X-Desk-Signature", encoding: "hex", secret: "secret:DESK_SIGNING" },
        },
      ],
    }),
  });
  n.t3.serverVersion = "0.1.9";
  const real = t3Host.t3;
  t3Host.t3 = () => "/opt/t3/runtime/versions/0.1.8/t3";
  cleanup.push(() => (t3Host.t3 = real));
  ghAnswers("read:org, gist");

  const { code, output } = await n.command("doctor");
  expect(code).toBe(1);
  const checks = await doctor(n);
  expect(byId(checks, "t3-binary")).toMatchObject({
    state: "fail",
    detail: "/opt/t3/runtime/versions/0.1.8/t3 is 0.1.8, but T3 Code runs 0.1.9",
  });
  expect(byId(checks, "gh")).toMatchObject({ state: "fail", fix: "gh auth refresh --scopes repo" });
  expect(byId(checks, "label:issues")).toMatchObject({
    state: "fail",
    fix: `gh label create no-such-label --repo ${SCRATCH}`,
  });
  expect(byId(checks, `push:${SCRATCH}`)).toMatchObject({ state: "ok" });
  expect(byId(checks, "secrets")).toMatchObject({ state: "fail", detail: "DESK_SIGNING is not set" });
  expect(byId(checks, "mcp")).toMatchObject({ state: "fail" });
  // Neither the cleanup nor the routing are set in the fake T3 Code: neither fails doctor.
  expect(byId(checks, "t3-worktrees")?.state).toBe("unknown");
  expect(byId(checks, "proxy")?.state).toBe("warn");
  // Every failing check prints its fix under it.
  const failing = output.findIndex((l) => l.startsWith("FAIL  agentgate's t3"));
  expect(output[failing + 1]).toStartWith("      fix: put T3 Code 0.1.9's own t3 first on PATH");

  // Status leads with the failing checks.
  const status = (await n.command("status")).output;
  expect(status[0]).toBe("Failing checks (agentgate factory doctor says how to fix each):");
  expect(status).toContain("  Every secret:NAME the folder names is set: DESK_SIGNING is not set");
});

test("signed out of gh, the preflight says so once and asks nothing else of GitHub", async () => {
  const n = await factoryNode(cleanup);
  const asked: string[][] = [];
  login.gh = async (args) => (asked.push(args), recorded("loggedOut.repoView"));
  const checks = await doctor(n);
  expect(byId(checks, "gh")).toMatchObject({
    state: "fail",
    detail: "gh is not logged in on this machine (gh auth login)",
    fix: "install gh and run gh auth login",
  });
  expect(checks.filter((c) => c.id.startsWith("push:"))).toEqual([]);
  expect(asked).toEqual([["api", "user", "--include"]]);
});

test("the board never waits for gh: it shows the last answers while the loop asks again", async () => {
  const n = await factoryNode(cleanup);
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  login.gh = async () => {
    await gate;
    return undefined; // not installed
  };
  const loop = loopTask(
    n.f,
    n.f.loops.find((l) => l.name === "factory-preflight")!,
  );
  const refreshing = loop();
  // gh has not answered, and the board answers with the cheap checks alone.
  const first = await board(n);
  expect(byId(first.checks, "t3")?.state).toBe("ok");
  expect(byId(first.checks, "gh")).toBeUndefined();
  release();
  await refreshing;
  expect(byId((await board(n)).checks, "gh")).toMatchObject({ state: "fail", detail: "gh is not installed" });
});

test("a factory machine that does not answer is a failing check on the board and in doctor, not an empty healthy board", async () => {
  const n = await factoryNode(cleanup);
  n.s.put("node", "b", { id: "b", protocol: 8 });
  expect((await n.command("move", "b", "--now")).code).toBe(0);

  const shown = await board(n);
  expect(shown.factory?.online).toBe(false);
  expect(shown.checks[0]).toMatchObject({
    id: "factory-machine",
    title: "The factory machine b answers",
    state: "fail",
  });
  const { code, output } = await n.command("doctor");
  expect(code).toBe(1);
  expect(output[0]).toStartWith("FAIL  The factory machine b answers: b did not answer a");
  expect((await n.command("status")).output[1]).toStartWith("  The factory machine b answers");
  // The canary starts its thread where the factory runs.
  expect((await n.command("doctor", "--canary")).output[0]).toBe(
    "The canary starts a thread on b: run agentgate factory doctor --canary there",
  );
});

test("doctor --canary starts one thread that only reports, and passes when its report arrives; no item is made", async () => {
  const n = await factoryNode(cleanup);
  const builtin = (await n.ctx.gateway.builtin!()).client;
  const asked = doctor(n, { canary: true });
  const canaries = () => runs.list(n.s, { kinds: ["canary"] });
  await n.until(() => canaries().length, "the canary run");
  await n.dispatch();
  const run = canaries()[0]!;
  expect(run).toMatchObject({ state: "running", attempt: 2 });
  const thread = n.t3.threads.get(run.threadId!)!;
  expect(thread.messages[0]).toContain(`{ "run": "${run.id}", "outcome": "done", "summary": "canary" }`);
  expect(thread.branch).toBe(`factory/canary-${run.id}`);

  const reported = await builtin.callTool({
    name: "factory_report",
    arguments: { run: run.id, outcome: "done", summary: "canary" },
    _meta: { "dev.agentgate/t3Thread": run.threadId },
  });
  expect(reported.isError).toBeFalsy();
  expect(byId(await asked, "canary")).toMatchObject({ state: "ok" });
  expect(runs.get(n.s, run.id)!.state).toBe("reported");
  expect(items.list(n.s)).toEqual([]);
});

test("doctor --canary fails, exit 1, when no report comes in time, and ends the run so nothing starts later", async () => {
  const n = await factoryNode(cleanup);
  const wait = canaryTiming.waitMs;
  canaryTiming.waitMs = 20;
  cleanup.push(() => (canaryTiming.waitMs = wait));
  // Nothing dispatches: the thread never starts.
  const { code, output } = await n.command("doctor", "--canary");
  expect(code).toBe(1);
  expect(output.find((l) => l.includes("(canary)"))).toStartWith(
    "FAIL  A factory thread starts and reports back (canary): the thread did not start within 0s",
  );
  expect(runs.list(n.s, { kinds: ["canary"] })).toMatchObject([{ state: "cancelled" }]);
});
