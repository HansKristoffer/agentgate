import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ProtocolError, Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, makeCtx } from "../src/daemon.ts";
import { MAX_RESULT_CHARS, capResult, mergeInstructions, type Source } from "../src/mcp/gateway.ts";
import { buildShim } from "../src/mcp/shim.ts";
import { newInstance } from "../src/mcp/templates.ts";
import { Store, type McpInstance } from "../src/store.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => servers.forEach((x) => x.stop(true)));

const source = (alias: string, instructions: string, instance?: Partial<McpInstance>): Source => ({
  alias,
  client: { getInstructions: () => instructions } as Client,
  instance: instance as McpInstance,
});

test("merged instructions fit the budget, and every server keeps its heading and first lines", () => {
  const long = (name: string) =>
    Array.from({ length: 200 }, (_, i) => `${name} line ${i}: use ${name} for its things.`).join("\n");
  const trimmed: string[][] = [];
  const merged = mergeInstructions(
    [source("railway", long("railway")), source("docs", "Short docs note."), source("brain", long("brain"))],
    (aliases) => trimmed.push(aliases),
  );
  expect(merged.length).toBeLessThanOrEqual(4000);
  expect(merged).toContain("## docs\nShort docs note.");
  for (const name of ["railway", "brain"]) {
    expect(merged).toContain(`## ${name}\n${name} line 0: use ${name} for its things.\n${name} line 1:`);
    expect(merged).not.toContain(`${name} line 199`);
  }
  expect(merged).toContain("agentgate cut the rest");
  expect(trimmed.map((aliases) => aliases.sort())).toEqual([["brain", "railway"]]);

  // A server's instructions can be replaced, or hidden with an empty override.
  expect(mergeInstructions([source("a", "own", { instructions: "replaced" }), source("b", "own b")])).toBe(
    "## a\nreplaced\n\n## b\nown b",
  );
  expect(mergeInstructions([source("a", "own", { instructions: "" }), source("b", "own b")])).toBe("## b\nown b");
});

test("a result past the limit is cut, keeps other content, and says how to ask for less", () => {
  const result = capResult(
    {
      content: [
        { type: "text", text: "x".repeat(60_000) },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "text", text: "y".repeat(40_000) },
      ],
      structuredContent: { rows: [] },
    },
    MAX_RESULT_CHARS,
  );
  const texts = result.content.flatMap((c) => (c.type === "text" ? [c.text] : []));
  expect(texts[0]).toBe("x".repeat(MAX_RESULT_CHARS));
  expect(texts.at(-1)).toContain(`cut this result at ${MAX_RESULT_CHARS} of 100000 characters`);
  expect(texts.at(-1)).toContain("a filter");
  expect(texts.join("").length).toBeLessThan(MAX_RESULT_CHARS + 200);
  expect(result.content.some((c) => c.type === "image")).toBe(true);
  expect(result.structuredContent).toBeUndefined();
});

/** An upstream with a huge result, a strict output schema it breaks, a slow tool, an echo and a failing tool. */
function upstream() {
  const strictSchema = {
    type: "object" as const,
    properties: { fix: { type: "object", properties: { title: { type: "string" } }, additionalProperties: false } },
  };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const mcp = new Server(
        { name: "upstream", version: "0" },
        { capabilities: { tools: {} }, instructions: "Upstream's own instructions." },
      );
      mcp.setRequestHandler("tools/list", async () => ({
        tools: [
          { name: "big", inputSchema: { type: "object" } },
          { name: "strict", inputSchema: { type: "object" }, outputSchema: strictSchema },
          { name: "wait", inputSchema: { type: "object" } },
          { name: "echo", inputSchema: { type: "object" } },
          { name: "fail", inputSchema: { type: "object" } },
        ],
      }));
      mcp.setRequestHandler("tools/call", async (r) => {
        const args = r.params.arguments ?? {};
        if (r.params.name === "big") return { content: [{ type: "text", text: "z".repeat(100_000) }] };
        if (r.params.name === "strict") {
          const structuredContent = { fix: { title: "Raise memory", extra: "not in the schema" } };
          return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
        }
        if (r.params.name === "wait") {
          await Bun.sleep(Number(args.ms));
          return { content: [{ type: "text", text: "waited" }] };
        }
        if (r.params.name === "echo") return { content: [{ type: "text", text: JSON.stringify(args) }] };
        throw new ProtocolError(-32602, "limit must be at most 500");
      });
      const t = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await mcp.connect(t);
      return t.handleRequest(req);
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/mcp`;
}

async function setup(instance: Partial<McpInstance> = {}) {
  const s = new Store(":memory:");
  s.setLocal("node", "n");
  s.put("mcp", "up", { ...newInstance({ id: "up", url: upstream() }), ...instance });
  s.put("project", "o/r", { id: "o/r", mcp: { up: "up" } });
  const ctx = makeCtx(s),
    handler = app(ctx);
  const requests: string[] = [];
  const daemon = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: (req) => {
      requests.push(`${req.method} ${new URL(req.url).pathname}`);
      return handler.fetch(req, { listener: "loopback" });
    },
  });
  servers.push(daemon);
  const url = `http://127.0.0.1:${daemon.port}`;
  const cwd = mkdtempSync(join(tmpdir(), "agentgate-gateway-"));
  const open: { close(): Promise<void> }[] = [];
  const session = async (options: { handshakeMs?: number; env?: Record<string, string> } = {}) => {
    const { env, ...rest } = options;
    const shim = await buildShim(cwd, url, { AGENTGATE_PROJECT: "o/r", ...env }, { reconnectMs: 60_000, ...rest });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "agent", version: "0" });
    await Promise.all([shim.server.connect(a), client.connect(b)]);
    open.push(client, shim);
    return client;
  };
  const done = async () => {
    for (const x of open.reverse()) await x.close();
    await ctx.gateway.close();
    s.close();
    rmSync(cwd, { recursive: true, force: true });
  };
  return { s, ctx, url, cwd, requests, session, done };
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("");

test("results are cut at the server's or tool's limit, and each call is logged without its arguments", async () => {
  const g = await setup({ toolOptions: { echo: { maxResultChars: 10 } } });
  try {
    const client = await g.session();
    const big = text(await client.callTool({ name: "up__big", arguments: {} }));
    expect(big.length).toBeLessThan(MAX_RESULT_CHARS + 200);
    expect(big).toContain(`cut this result at ${MAX_RESULT_CHARS} of 100000 characters`);
    const echo = text(await client.callTool({ name: "up__echo", arguments: { secret: "do-not-log-me" } }));
    expect(echo).toStartWith('{"secret":');
    expect(echo).toContain("cut this result at 10 of");

    const rows = g.s.db
      .query("select account, model, status, ms, note from request_log where provider = 'mcp' and model != ''")
      .all() as { account: string; model: string; status: number; ms: number; note: string }[];
    expect(rows.map((r) => [r.account, r.model, r.status])).toEqual([
      ["up", "big", 200],
      ["up", "echo", 200],
    ]);
    expect(rows[0]!.note).toMatch(/^big \d+ ms, 100000 chars, cut to 20000$/);
    expect(JSON.stringify(rows)).not.toContain("do-not-log-me");

    // 0 turns the limit off for a server.
    g.s.put("mcp", "up", { ...g.s.get("mcp", "up")!, maxResultChars: 0 });
    expect(text(await client.callTool({ name: "up__big", arguments: {} }))).toHaveLength(100_000);
  } finally {
    await g.done();
  }
});

test("results pass through without output-schema checks, and upstream errors keep their own message", async () => {
  const g = await setup();
  try {
    const client = await g.session();
    const listed = (await client.listTools()).tools.find((t) => t.name === "up__strict");
    expect(listed?.outputSchema).toBeUndefined();
    const result = await client.callTool({ name: "up__strict", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ fix: { title: "Raise memory", extra: "not in the schema" } });
    const failure = await client.callTool({ name: "up__fail", arguments: {} }).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("limit must be at most 500");
  } finally {
    await g.done();
  }
});

test("an allowlist, an instructions override and default arguments shape what agents see", async () => {
  const g = await setup({
    tools: ["echo"],
    instructions: "Pass a filter to get-logs.",
    toolOptions: { echo: { defaults: { limit: 30 } } },
  });
  try {
    const client = await g.session();
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["up__echo"]);
    expect(client.getInstructions()).toBe("## up\nPass a filter to get-logs.");
    expect(JSON.parse(text(await client.callTool({ name: "up__echo", arguments: {} })))).toEqual({ limit: 30 });
    expect(JSON.parse(text(await client.callTool({ name: "up__echo", arguments: { limit: 5 } })))).toEqual({
      limit: 5,
    });
    expect((await client.callTool({ name: "up__big", arguments: {} })).isError).toBe(true);
  } finally {
    await g.done();
  }
});

test("a call that outlasts the handshake deadline returns through the shim, without rereading the session", async () => {
  const g = await setup();
  try {
    const client = await g.session({ handshakeMs: 200 });
    await client.listTools();
    const reads = g.requests.filter((r) => r === "GET /api/shim").length;
    expect(text(await client.callTool({ name: "up__wait", arguments: { ms: 600 } }))).toBe("waited");
    await client.callTool({ name: "up__echo", arguments: {} });
    expect(g.requests.filter((r) => r === "GET /api/shim").length).toBe(reads);
  } finally {
    await g.done();
  }
});

test("a client whose connection drops mid-call cancels the call upstream", async () => {
  const cancelled = join(mkdtempSync(join(tmpdir(), "agentgate-drop-")), "cancelled");
  const g = await setup({
    transport: "stdio",
    url: undefined,
    command: process.execPath,
    args: [join(import.meta.dir, "fixtures", "mcp.ts")],
    env: { AGENTGATE_CANCEL_FILE: cancelled },
  });
  const drop = new AbortController();
  const client = new Client({ name: "agent", version: "0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${g.url}/mcp?project=o/r`), {
        fetch: (url, init) =>
          fetch(url, { ...init, signal: AbortSignal.any([drop.signal, ...(init?.signal ? [init.signal] : [])]) }),
      }),
    );
    await client.listTools();
    const call = client.callTool({ name: "up__slow", arguments: {} }).catch(() => "dropped");
    for (let i = 0; i < 100 && !g.ctx.gateway.upstreams.get("up")?.calls; i++) await Bun.sleep(10);
    drop.abort(); // the connection goes away without a cancel notice, as when the agent's process dies
    for (let i = 0; i < 100 && !(await Bun.file(cancelled).exists()); i++) await Bun.sleep(10);
    expect(await Bun.file(cancelled).text()).toBe("yes");
    expect(await call).toBe("dropped");
  } finally {
    await client.close().catch(() => {});
    await g.done();
  }
});

test("sessions hear of tool changes only when their tools may differ", async () => {
  const g = await setup();
  try {
    const client = await g.session();
    let notices = 0;
    client.setNotificationHandler("notifications/tools/list_changed", () => void notices++);
    await client.listTools();
    await g.session(); // another session starts, and records its project
    g.s.put("mcpCredential", "up", {
      instanceId: "up",
      holder: "n",
      tokens: { access_token: "a", token_type: "Bearer" },
    });
    g.ctx.gateway.toolsChanged(); // signing in can change the tools
    g.s.put("mcpCredential", "up", {
      instanceId: "up",
      holder: "n",
      tokens: { access_token: "b", token_type: "Bearer" },
    });
    g.ctx.gateway.toolsChanged(); // a token refresh does not
    g.s.put("project", "o/r", { ...g.s.get("project", "o/r")!, seenAt: g.s.now() + 1 });
    g.ctx.gateway.toolsChanged(); // nor does recording the project again
    for (let i = 0; i < 50 && notices < 1; i++) await Bun.sleep(10);
    await Bun.sleep(50);
    expect(notices).toBe(1);
  } finally {
    await g.done();
  }
});

test("a session whose shim names a scoped thread lists and calls only the servers its scope allows", async () => {
  const g = await setup({ tools: ["echo"] });
  try {
    g.s.put("mcp", "other", { ...newInstance({ id: "other", url: upstream() }), tools: ["echo"] });
    g.s.put("project", "o/r", { id: "o/r", mcp: { up: "up", other: "other" } });
    // agentgate's own tools: one for anyone, one only a factory run's thread sees.
    g.ctx.gateway.builtin = async () => {
      const server = new Server({ name: "builtin", version: "0" }, { capabilities: { tools: {} } });
      server.setRequestHandler("tools/list", async () => ({
        tools: ["factory_report", "factory_status"].map((name) => ({ name, inputSchema: { type: "object" as const } })),
      }));
      server.setRequestHandler("tools/call", async (r) => ({ content: [{ type: "text", text: r.params.name }] }));
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "agentgate", version: "0" });
      await Promise.all([server.connect(a), client.connect(b)]);
      return { alias: "agentgate", client };
    };
    // The factory's answer, as `threadScope` gives it: a run's thread and a subagent under it get `up`.
    const scoped = new Set(["thread-run", "thread-sub"]);
    const asked: (string | undefined)[] = [];
    g.ctx.gateway.scope = (thread) => {
      asked.push(thread);
      return thread && scoped.has(thread) ? { servers: ["up"] } : { hidden: ["factory_report"] };
    };
    const names = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);

    const run = await g.session({ env: { T3CODE_THREAD_ID: "thread-run" } });
    // The shim names its thread from the first request, so the session's instructions already leave `other` out.
    expect(asked[0]).toBe("thread-run");
    expect(run.getInstructions()).not.toContain("## other");
    expect(await names(run)).toEqual(["agentgate__factory_report", "agentgate__factory_status", "up__echo"]);
    const refused = await run.callTool({ name: "other__echo", arguments: {} });
    expect(refused).toMatchObject({ isError: true, content: [{ text: "agentgate: unavailable tool other__echo" }] });
    const sub = await g.session({ env: { T3CODE_THREAD_ID: "thread-sub" } });
    expect(await names(sub)).toEqual(await names(run));

    // The maintainer's session in the same repository: every server, and no tool made for a run's thread.
    const own = await g.session();
    expect(await names(own)).toEqual(["agentgate__factory_status", "other__echo", "up__echo"]);
    // A listing works the scope out for its sources and its tools, not once per tool.
    asked.length = 0;
    await names(own);
    expect(asked).toEqual([undefined, undefined]);
    expect((await own.callTool({ name: "agentgate__factory_report", arguments: {} })).isError).toBe(true);
    // The per-session servers the shim runs itself are narrowed the same way.
    g.s.put("mcp", "local", newInstance({ id: "local", command: "local-mcp", mode: "perSession" }));
    g.s.put("project", "o/r", { id: "o/r", mcp: { up: "up", other: "other", local: "local" } });
    const children = async (query: string) =>
      ((await (await fetch(`${g.url}/api/shim?project=o/r${query}`)).json()) as { alias: string }[]).map(
        (c) => c.alias,
      );
    expect(await children("")).toEqual(["local"]);
    expect(await children("&thread=thread-run")).toEqual([]);

    // A thread whose run starts after its session did hears that its tools changed, and loses `other`.
    const late = await g.session({ env: { T3CODE_THREAD_ID: "thread-late" } });
    expect(await names(late)).toContain("other__echo");
    let notices = 0;
    late.setNotificationHandler("notifications/tools/list_changed", () => void notices++);
    scoped.add("thread-late");
    g.ctx.gateway.toolsChanged();
    for (let i = 0; i < 50 && !notices; i++) await Bun.sleep(10);
    expect(notices).toBe(1);
    // Each call is checked against the scope as it is now, before the client lists again.
    expect((await late.callTool({ name: "other__echo", arguments: {} })).isError).toBe(true);
    expect(await names(late)).toEqual(await names(run));
  } finally {
    await g.done();
  }
});

test("a server that cannot be reached is retried with backoff, not on every listing", async () => {
  const closed = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = closed.port;
  closed.stop(true);
  const g = await setup({ url: `http://127.0.0.1:${port}/mcp` });
  let time = Date.now();
  g.s.now = () => time;
  const failures = () =>
    (g.s.db.query("select count(*) as n from request_log where note like 'connect failed%'").get() as { n: number }).n;
  try {
    const client = await g.session();
    await client.listTools();
    await client.listTools();
    expect(failures()).toBe(1);
    time += 31_000;
    await client.listTools();
    expect(failures()).toBe(2);
    await client.listTools();
    expect(failures()).toBe(2);
    // A Test that reached the server ends the wait.
    g.s.setLocal("mcpHealth:up", JSON.stringify({ ok: true, at: time }));
    await client.listTools();
    expect(failures()).toBe(3);
  } finally {
    await g.done();
  }
});
