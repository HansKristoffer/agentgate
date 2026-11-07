import { afterAll, afterEach, expect, test } from "bun:test";
import { items } from "../src/factory/db.ts";
import { newInstance } from "../src/mcp/templates.ts";
import { deliver, delivery } from "../src/factory/notify.ts";
import { saveProject, setFactoryTools, setFactoryWebhook } from "../src/operations.ts";
import { exportBackup } from "../src/store.ts";
import { removeTmp } from "./fixtures/git.ts";
import { factoryNode } from "./fixtures/t3-mcp.ts";

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

test("the factory posts its updates to the webhook Grok sets, again after a failure, and never its history", async () => {
  const n = await factoryNode(cleanup);
  n.s.put("node", "a", { ...n.s.get("node", "a")!, protocol: 9 });
  saveProject(n.s, "@grok", { mcp: {} });
  setFactoryTools(n.s, "@grok", true);
  const posts: {
    url: string;
    body: { node: string; updates: { seq: number; kind: string; item?: { key: string } }[] };
  }[] = [];
  let status = 200;
  const realPost = delivery.post;
  delivery.post = async (url, body) => {
    posts.push({ url, body: JSON.parse(body) });
    return new Response(null, { status });
  };
  cleanup.push(() => (delivery.post = realPost));
  const tool = async (args: Record<string, unknown>) => {
    const { response } = await n.ctx.gateway.handleRemote(
      "@grok",
      rpc("tools/call", { name: "factory__webhook", arguments: args }),
      {},
      AbortSignal.timeout(5000),
    );
    return ((await response.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
  };

  expect((await tool({ url: "http://bot.example/hook" })).content[0]!.text).toBe("The webhook must be an https URL");
  await n.command("add", n.repo, "Before the webhook");
  const url = "https://bot.example/hook?token=receiver-token";
  expect((await tool({ url })).isError).toBeUndefined();
  await deliver(n.f);
  expect(posts).toEqual([]); // the item added before is history

  const { output } = await n.command("add", n.repo, "Crash on save", "--json");
  const added = JSON.parse(output[0]!) as { key: string };
  await deliver(n.f);
  expect(posts).toHaveLength(1);
  expect(posts[0]!.url).toBe(url);
  expect(posts[0]!.body.node).toBe("a");
  expect(posts[0]!.body.updates.map((u) => [u.kind, u.item?.key])).toEqual([["item.created", added.key]]);

  // A refused post keeps its updates, waits out the backoff and sends them again with the newer ones.
  await n.command("drop", added.key);
  status = 503;
  await deliver(n.f);
  await deliver(n.f);
  expect(posts).toHaveLength(2);
  status = 200;
  n.advance(31_000);
  await deliver(n.f);
  expect(posts).toHaveLength(3);
  expect(posts[2]!.body).toEqual(posts[1]!.body);
  expect(posts[2]!.body.updates.map((u) => u.kind)).toContain("item.phase");
  await deliver(n.f);
  expect(posts).toHaveLength(3);

  // The API and backups without secrets never show the URL's token; clearing it forgets the cursor.
  const shown = (await (await n.api("/api/status")).json()) as { projects: { id: string; factoryWebhook?: string }[] };
  expect(shown.projects.find((p) => p.id === "@grok")!.factoryWebhook).toBe("https://bot.example");
  expect(JSON.stringify(exportBackup(n.s, false))).not.toContain("receiver-token");
  await tool({ url: "" });
  expect(n.s.get("project", "@grok")!.factoryWebhook).toBeUndefined();
  await deliver(n.f);
  expect(n.s.db.query("select count(*) as n from local where key like 'factory:webhook:%'").get()).toEqual({ n: 0 });
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
