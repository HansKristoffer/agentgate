import { afterAll, afterEach, expect, test } from "bun:test";
import { ask, moveItem } from "../src/factory/controller.ts";
import { items, runs } from "../src/factory/db.ts";
import { newInstance } from "../src/mcp/templates.ts";
import { delivery } from "../src/factory/notify.ts";
import { saveProject, setFactoryTools, setFactoryWebhook } from "../src/operations.ts";
import { exportBackup } from "../src/store.ts";
import { removeTmp } from "./fixtures/git.ts";
import { factoryNode, idle, postOp } from "./fixtures/t3-mcp.ts";

afterAll(removeTmp);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const rpc = (method: string, params: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

test("a virtual project's endpoint offers the factory's tools only while its switch is on", async () => {
  const n = await factoryNode(cleanup);
  saveProject(n.s, "@grok", { mcp: {} });
  const remote = async (method: string, params?: Record<string, unknown>) => {
    const { response } = await n.ctx.gateway.handleRemote("@grok", rpc(method, params), {}, AbortSignal.timeout(5000));
    type Result = { tools: { name: string }[]; isError?: boolean; content: { text: string }[] };
    return ((await response.json()) as { result: Result }).result;
  };
  const names = async () => (await remote("tools/list")).tools.map((t) => t.name);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await remote("tools/call", { name: `factory__${name}`, arguments: args });
    return { error: !!result.isError, text: result.content[0]!.text };
  };

  expect(await names()).toEqual(["skills__list", "skills__read"]);
  // A node on the previous protocol would drop the switch when it saves the project.
  expect(() => setFactoryTools(n.s, "@grok", true)).toThrow("Update agentgate on a first");
  n.s.put("node", "a", { ...n.s.get("node", "a")!, protocol: 9 });
  setFactoryTools(n.s, "@grok", true);
  expect(await names()).toEqual([
    "factory__add",
    "factory__approve",
    "factory__drop",
    "factory__pause",
    "factory__reject",
    "factory__resume",
    "factory__retry",
    "factory__show",
    "factory__status",
    "factory__webhook",
    "skills__list",
    "skills__read",
  ]);

  // Grok learns where it may add work, adds a task that goes straight to triage, follows it and drops it.
  expect((await call("status")).text).toContain(`Repositories: ${n.repo}`);
  const refused = await call("add", { repo: "acme/elsewhere", title: "Crash" });
  expect(refused).toEqual({ error: true, text: `acme/elsewhere is not one of the factory's repositories: ${n.repo}` });
  expect((await call("add", { title: "no repo" })).error).toBe(true);
  const added = JSON.parse((await call("add", { repo: n.repo, title: "Crash on save", body: "Steps" })).text);
  expect(added).toMatchObject({ repo: n.repo, phase: "triage" });
  expect(items.get(n.s, added.id)).toMatchObject({ source: "manual", phase: "triage", title: "Crash on save" });
  expect((await call("status")).text).toContain(`${added.key} Crash on save`);
  expect((await call("show", { item: added.key })).text).toContain(`${added.key} Crash on save (${n.repo}, triage)`);
  expect((await call("drop", { item: added.key, reason: "not needed" })).error).toBe(false);
  expect(items.get(n.s, added.id)!.phase).toBe("closed");
  expect(await call("pause")).toEqual({ error: false, text: expect.stringContaining("Paused") });
  expect((await call("status")).text).toContain("Paused");
  await call("resume");

  setFactoryTools(n.s, "@grok", false);
  expect(await names()).toEqual(["skills__list", "skills__read"]);
  expect(n.s.get("project", "@grok")).not.toHaveProperty("factoryTools");
});

test("only virtual projects offer the factory's tools, and they keep the factory prefix for them", async () => {
  const n = await factoryNode(cleanup);
  n.s.put("node", "a", { ...n.s.get("node", "a")!, protocol: 9 });
  n.s.put("mcp", "docs", newInstance({ id: "docs", url: "https://docs.example/mcp" }));
  saveProject(n.s, "acme/api", { mcp: {} });
  expect(() => setFactoryTools(n.s, "acme/api", true)).toThrow("Only virtual projects");
  expect(() => setFactoryTools(n.s, "@nobody", true)).toThrow("no project @nobody");
  expect(() => saveProject(n.s, "@grok", { mcp: { factory: "docs" } })).toThrow("reserved");
  // Through the control API, as the app turns it on.
  saveProject(n.s, "@grok", { mcp: {} });
  const response = await n.api("/api/projects/factory-tools", "PUT", { id: "@grok", on: true });
  expect(await response.json()).toMatchObject({ id: "@grok", factoryTools: true });
});

/** Every POST the outlets send, answered with `status`. */
function capturePosts() {
  const posts: {
    url: string;
    body: { text: string; node: string; updates: { seq: number; kind: string; item: { key: string } }[] };
  }[] = [];
  const answer = { status: 200 };
  const real = { ...delivery };
  delivery.post = async (url, body) => {
    posts.push({ url, body: JSON.parse(body) });
    return new Response(null, { status: answer.status });
  };
  delivery.retryMs = 0;
  cleanup.push(() => Object.assign(delivery, real));
  return { posts, answer };
}

test("an item that waits for you, and a PR that is ready, are posted once to your notify URL and to Grok's webhook, and the asking thread is marked unread", async () => {
  const n = await factoryNode(cleanup);
  n.s.put("node", "a", { ...n.s.get("node", "a")!, protocol: 9 });
  const { posts, answer } = capturePosts();
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.join(" "));
  cleanup.push(() => (console.error = realError));

  const mine = "https://hooks.slack.example/services/T0/B0/notify-token";
  expect((await n.command("notify", "http://hooks.slack.example/x")).output).toEqual([
    "The webhook must be an https URL",
  ]);
  expect(await n.command("notify", mine)).toEqual({
    code: 0,
    output: ["Posts to hooks.slack.example when an item waits for you or a PR is ready."],
  });
  saveProject(n.s, "@grok", { mcp: {} });
  setFactoryTools(n.s, "@grok", true);
  const grok = "https://bot.example/hook?token=receiver-token";
  setFactoryWebhook(n.s, "@grok", grok);

  // Adding work and starting it is not a moment to tell.
  const { output } = await n.command("add", n.repo, "Crash on save", "--json");
  const added = JSON.parse(output[0]!) as { id: string; key: string };
  await n.dispatch();
  await n.until(() => runs.forItem(n.s, added.id)[0]?.threadId, "the triage thread");
  expect(posts).toEqual([]);

  const run = runs.forItem(n.s, added.id)[0]!;
  ask(n.f, items.get(n.s, added.id)!, { cause: "decision", question: "Keep v1 alive?", recommendation: "Yes", run });
  await n.until(() => posts.length === 2, "the two posts");
  expect(posts.map((p) => p.url).sort()).toEqual([grok, mine].sort());
  const link = run.threadLink ?? "";
  expect(posts[0]!.body.text).toBe(
    `${added.key} needs you (Needs a decision): Keep v1 alive?${link ? ` ${link}` : ""}`,
  );
  expect(posts[0]!.body.updates).toEqual([
    expect.objectContaining({ kind: "item.needs-you", item: expect.objectContaining({ key: added.key }) }),
  ]);
  await n.until(
    () => n.mcp.calls.some((c) => c.tool === "t3_thread_organize" && c.args.action === "mark_unread"),
    "the thread marked unread",
  );
  expect(n.mcp.calls.find((c) => c.args.action === "mark_unread")!.args.threadId).toBe(run.threadId);

  // A PR that is ready is the other moment; a failing receiver is tried once more and logged once, without its URL.
  answer.status = 503;
  const url = `https://github.com/${n.repo}/pull/7`;
  items.update(n.s, added.id, { pr: { url, head: "c1", headAt: 0, run: run.id, thread: run.threadId!, nudges: 0 } });
  moveItem(n.f, added.id, "ready", true);
  await n.until(() => posts.length === 6, "the posts and their retries");
  expect(posts.at(-1)!.body.text).toBe(
    `${added.key}'s PR is ready for you: Crash on save https://github.com/${n.repo}/pull/7`,
  );
  await n.until(() => logged.length === 2, "the failures logged");
  expect(logged).toEqual([
    "factory: a notify URL did not take an update: HTTP 503",
    "factory: a notify URL did not take an update: HTTP 503",
  ]);

  // The URL is shown only by its host, never in status, the board, the API, a backup without secrets or a log.
  expect(await n.command("notify")).toEqual({
    code: 0,
    output: ["Posts to hooks.slack.example when an item waits for you or a PR is ready."],
  });
  expect(await (await n.op("notify", {})).json()).toEqual({ host: "hooks.slack.example" });
  expect(
    (await postOp(n.ctx, "notify", { url: null }, "tailnet", { authorization: "Bearer admin-secret" })).status,
  ).toBe(403);
  const shown = [
    (await n.command("status")).output.join("\n"),
    await (await n.api("/api/factory")).text(),
    await (await n.api("/api/status")).text(),
    JSON.stringify(exportBackup(n.s, false)),
    (await n.command("secret", "list")).output.join("\n"),
    logged.join("\n"),
  ].join("\n");
  expect(shown).not.toContain("notify-token");
  expect(shown).not.toContain("receiver-token");

  // Off stops it.
  expect((await n.command("notify", "off")).output).toEqual(["Notifications are off."]);
  setFactoryWebhook(n.s, "@grok", undefined);
  const before = posts.length;
  moveItem(n.f, added.id, "review");
  moveItem(n.f, added.id, "ready");
  await idle(n.f);
  expect(posts).toHaveLength(before);
  expect((await n.command("notify")).output).toEqual(["No notify URL is set: agentgate factory notify <https-url>"]);
});

test("a webhook needs the factory's tools, https and no credentials before the host, and goes when they are off", async () => {
  const n = await factoryNode(cleanup);
  n.s.put("node", "a", { ...n.s.get("node", "a")!, protocol: 9 });
  saveProject(n.s, "@grok", { mcp: {} });
  expect(() => setFactoryWebhook(n.s, "@grok", "https://bot.example/hook")).toThrow("turn them on first");
  setFactoryTools(n.s, "@grok", true);
  expect(() => setFactoryWebhook(n.s, "@grok", "https://user:pass@bot.example/hook")).toThrow("path or query");
  expect(() => setFactoryWebhook(n.s, "@grok", "not a url")).toThrow("must be a URL");
  setFactoryWebhook(n.s, "@grok", "https://bot.example/hook");
  setFactoryTools(n.s, "@grok", false);
  setFactoryTools(n.s, "@grok", true);
  expect(n.s.get("project", "@grok")!.factoryWebhook).toBeUndefined();
});

test("the app's change feed answers when a record or a factory event changes, and otherwise when the wait ends", async () => {
  const n = await factoryNode(cleanup);
  const changes = async (query: string) =>
    ((await (await n.api(`/api/changes?${query}`)).json()) as { token: string }).token;
  const token = await changes("wait=0");
  expect(await changes(`after=${token}&wait=0`)).toBe(token);
  const waiting = changes(`after=${token}&wait=5`);
  n.f.events.emit({ kind: "note", text: "something happened" });
  const next = await waiting;
  expect(next).not.toBe(token);
  const record = changes(`after=${next}&wait=5`);
  saveProject(n.s, "@grok", { mcp: {} });
  expect(await record).not.toBe(next);
});
