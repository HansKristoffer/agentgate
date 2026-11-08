import { afterEach, expect, spyOn, test } from "bun:test";
import { app, makeCtx } from "../src/daemon.ts";
import { runs } from "../src/factory/db.ts";
import { loopTask } from "../src/factory/runtime.ts";
import { t3Mcp, T3McpError } from "../src/factory/t3-mcp.ts";
import { connectT3, host as t3Host, t3State } from "../src/handoff/t3.ts";
import { Store } from "../src/store.ts";
import { tmp } from "./fixtures/git.ts";
import { fakeT3WithMcp } from "./fixtures/t3-mcp.ts";

const DAY = 86_400_000;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function until(fn: () => boolean, what: string) {
  const deadline = Date.now() + 2_000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** A daemon context connected to a fake T3 Code (as `agentgate t3 connect` leaves it) that serves the MCP sign-in,
 * on the factory machine, with fake time. */
async function fixture() {
  const { t3, mcp } = fakeT3WithMcp({ claudeDir: tmp() });
  const s = new Store(":memory:");
  s.setLocal("node", "a");
  s.setLocal("adminToken", "admin-secret");
  s.put("node", "a", { id: "a", protocol: 8 });
  const ctx = makeCtx(s);
  const real = t3Host.t3;
  t3Host.t3 = () => mcp.pairBin;
  cleanup.push(t3.stop, () => {
    t3Host.t3 = real;
    ctx.abort.abort();
    ctx.skills.close();
    ctx.imports.close();
    return ctx.gateway.close().then(() => s.close());
  });
  await connectT3(s, { url: t3.url, token: t3.pairingToken() });
  s.put("setting", "settings", { ...s.settings(), factory: { store: "github", repo: "acme/api", node: "a" } });
  let now = Date.now();
  s.now = () => now;
  const f = ctx.factory;
  const loop = f.loops.find((l) => l.name === "t3-mcp")!;
  return {
    s,
    ctx,
    f,
    t3,
    mcp,
    client: t3Mcp(f),
    tick: loopTask(f, loop),
    advance: (ms: number) => (now += ms),
    stored: () => JSON.parse(s.local("factory:t3mcp") ?? "null") as { token: string; expiresAt: number } | null,
  };
}

test("signing in pairs with the four scopes, approves at full access with the pairing code and stores the token here", async () => {
  const { s, mcp, client, stored } = await fixture();
  await client.signIn();

  const [pair] = mcp.pairs();
  for (const scope of ["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"])
    expect(pair).toContain(`--scope ${scope}`);
  expect(mcp.registrations).toEqual([
    expect.objectContaining({
      client_name: "AgentGate factory",
      redirect_uris: ["http://127.0.0.1/agentgate-factory"],
    }),
  ]);
  expect(mcp.decisions[0]?.decision).toEqual({
    _tag: "pairing-code",
    access: "full-access",
    code: expect.stringMatching(/^pair-/),
  });
  // The fake issues a token only for the verifier whose S256 challenge was approved.
  expect(stored()).toEqual({ token: mcp.tokens[0]!, expiresAt: s.now() + 30 * DAY });
  expect(client.status()).toEqual({ mcp: "signed-in", expiresAt: s.now() + 30 * DAY });

  mcp.answer("t3_pending_request", () => ({ requestIds: ["r1"] }));
  expect(await client.call<unknown>("t3_pending_request", { action: "list", threadId: "t1" })).toEqual({
    requestIds: ["r1"],
  });
  expect(mcp.calls).toEqual([{ tool: "t3_pending_request", args: { action: "list", threadId: "t1" } }]);
  // The resource the token is for, as T3's own sign-in between environments names it (RFC 8707).
  expect(mcp.decisions[0]!.authorization).toMatchObject({ resource: `${t3State(s).url}/mcp` });
});

test("a token T3 refuses is replaced by exactly one new sign-in, and is never sent again", async () => {
  const { mcp, client, stored } = await fixture();
  await client.signIn();
  mcp.refuse(mcp.tokens[0]!);

  mcp.answer("t3_thread_interrupt", () => ({ status: "no_active_run" }));
  const session = client.session();
  await client.call("t3_thread_interrupt", { threadId: "t1" });
  expect(mcp.tokens).toHaveLength(2);
  expect(stored()?.token).toBe(mcp.tokens[1]!);
  expect(mcp.calls).toEqual([{ tool: "t3_thread_interrupt", args: { threadId: "t1" } }]);
  // A new sign-in is a new session: T3 dedupes a launch's clientRequestId within one session only.
  expect(client.session()).toBeString();
  expect(client.session()).not.toBe(session);

  mcp.refuseAll = true;
  await expect(client.call("t3_thread_interrupt", { threadId: "t1" })).rejects.toThrow(T3McpError);
  expect(mcp.tokens).toHaveLength(3);
  expect(stored()).toBeNull();
  expect(mcp.calls).toHaveLength(1);
});

test("the loop replaces a token within 3 days of its end and revokes the old session", async () => {
  const { mcp, client, tick, advance, stored } = await fixture();
  await client.signIn();
  const first = stored()!;

  advance(26 * DAY);
  await tick();
  expect(mcp.tokens).toHaveLength(1);

  advance(1 * DAY);
  await tick();
  expect(mcp.tokens).toHaveLength(2);
  expect(stored()?.token).toBe(mcp.tokens[1]!);
  expect(stored()!.expiresAt).toBeGreaterThan(first.expiresAt);
  expect(mcp.revoked).toHaveLength(1);
  expect(client.status().mcp).toBe("signed-in");
});

test("the loop does not renew a token while a launch sent under it waits for its answer", async () => {
  const { s, mcp, client, tick, advance, stored } = await fixture();
  await client.signIn();
  // A launch whose answer did not come: only its session can find the thread again, so the session must stay.
  runs.insert(s, {
    id: "run_launching",
    kind: "learn",
    attempt: 1,
    state: "queued",
    nudges: 0,
    configCommit: "c",
    launchSession: client.session(),
  });
  advance(27 * DAY);
  await tick();
  expect(mcp.tokens).toHaveLength(1);

  runs.update(s, "run_launching", { state: "running", launchSession: undefined });
  await tick();
  expect(mcp.tokens).toHaveLength(2);
  expect(stored()?.token).toBe(mcp.tokens[1]!);
});

test("turning the factory off revokes the session through T3, or says where to remove it when T3 refuses", async () => {
  const { s, f, mcp, client, tick, stored } = await fixture();
  const settings = s.settings();
  await client.signIn();
  f.events.emit({ kind: "factory.off", text: "factory off" });
  await until(() => mcp.revoked.length === 1, "the revocation");
  await until(() => stored() === null, "the token to be forgotten");
  expect(client.status()).toEqual({ mcp: "off" });

  // Turned off on another machine: no event here, only the synced setting.
  await client.signIn();
  s.put("setting", "settings", { ...settings, factory: undefined });
  await tick();
  expect(mcp.revoked).toHaveLength(2);
  expect(stored()).toBeNull();
  expect(mcp.tokens).toHaveLength(2);
  await expect(client.signIn()).rejects.toThrow("the factory does not run on a");
  s.put("setting", "settings", settings);

  await client.signIn();
  mcp.denyRevoke = true;
  await client.signOut();
  expect(stored()).toBeNull();
  expect(client.status()).toEqual({ mcp: "off", error: expect.stringContaining("Settings → Connections") });
});

test("when T3's MCP lacks a required tool, the status names it and calls are refused", async () => {
  const { f, mcp, client } = await fixture();
  mcp.tools.delete("t3_pending_request");
  await client.signIn();

  expect(client.status()).toMatchObject({ mcp: "failed", error: expect.stringContaining("t3_pending_request") });
  const parts = await Promise.all(f.boardParts.map((p) => p()));
  expect(parts.find((part) => part.t3)?.t3 as unknown).toEqual({
    mcp: "failed",
    mcpExpiresAt: expect.any(Number),
    error: expect.stringContaining("t3_pending_request"),
  });
  await expect(client.call("t3_thread_interrupt", { threadId: "t1" })).rejects.toThrow(/t3_pending_request/);
  expect(mcp.calls).toEqual([]);
});

test("when a T3 tool lacks an input the factory sends, such as a launch's clientRequestId, the sign-in names it and calls are refused", async () => {
  const { mcp, client } = await fixture();
  mcp.dropInput("t3_thread_launch", "clientRequestId");
  await client.signIn();
  expect(client.status()).toMatchObject({
    mcp: "failed",
    error: "T3 Code's MCP lacks t3_thread_launch (clientRequestId); update T3 Code",
  });
  await expect(client.call("t3_thread_interrupt", { threadId: "t1" })).rejects.toThrow(/update T3 Code/);
  expect(mcp.calls).toEqual([]);
});

test("the fake T3 refuses an argument its recorded tools do not take, as a newer T3 would refuse a renamed one", async () => {
  const { mcp, client } = await fixture();
  await client.signIn();
  const refused = await client
    .call("t3_thread_interrupt", { threadId: "t1", runIds: ["r1"] })
    .catch((e: T3McpError) => e);
  expect(refused).toBeInstanceOf(T3McpError);
  expect((refused as T3McpError).message).toContain("t3_thread_interrupt takes no argument runIds");
  // T3 answered, so nothing ran: a launch refused this way may be sent again under any session.
  expect((refused as T3McpError).answered).toBe(true);
  expect(mcp.calls).toHaveLength(1);
});

test("the token appears in no log line, status, board part, command output or error", async () => {
  const { ctx, f, mcp, client } = await fixture();
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error"] as const) {
    const spy = spyOn(console, method).mockImplementation((...args) => void lines.push(args.join(" ")));
    cleanup.push(() => spy.mockRestore());
  }
  const handler = app(ctx);
  const request = async (path: string, method = "GET") => {
    const req = new Request(`http://127.0.0.1:7878${path}`, { method, headers: { host: "127.0.0.1:7878" } });
    return (await handler.fetch(req, { listener: "loopback" })).text();
  };

  const seen: string[] = [await request("/api/factory/t3/sign-in", "POST")];
  expect(seen[0]).toContain("mcp: signed-in");
  const secret = "test-secret-token-1";
  expect(mcp.tokens[0]).toContain(secret);
  // A T3 that echoes the credential in a tool error, then refuses it, then refuses its replacement.
  mcp.answer("t3_thread_send", () => {
    throw new Error(`rejected ${mcp.tokens[0]}`);
  });
  seen.push(await client.call("t3_thread_send", {}).then(String, (e: Error) => e.message));
  mcp.refuseAll = true;
  seen.push(await client.call("t3_thread_send", {}).then(String, (e: Error) => e.message));

  const output: string[] = [];
  await f.commands.get("t3")!.run([], { out: (line) => output.push(line) });
  seen.push(
    ...output,
    await request("/status"),
    JSON.stringify(await Promise.all(f.boardParts.map((p) => p()))),
    JSON.stringify(client.status()),
    ...lines,
  );
  expect(seen[1]).toContain("[redacted]");
  for (const text of seen) expect(text).not.toContain(secret);
});
