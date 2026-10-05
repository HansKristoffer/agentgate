import { afterAll, expect, test } from "bun:test";
import { InvalidGrant } from "../src/credentials.ts";
import { CURSOR, cursor, finish, parseQuota } from "../src/llm/cursor.ts";
import { app, makeCtx } from "../src/daemon.ts";
import { Store } from "../src/store.ts";

const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const access = jwt({ sub: "auth0|user_1", exp: 4_000_000_000 });
let polls = 0, refresh: unknown = { access_token: jwt({ sub: "auth0|user_1", exp: 4_100_000_000 }) };
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/auth/poll") return ++polls < 2 ? new Response("", { status: 404 }) : Response.json({ accessToken: access, refreshToken: access });
    if (url.pathname.endsWith("/GetMe")) return Response.json({ authId: "auth0|user_1", email: "me@example.com" });
    if (url.pathname.endsWith("/GetPlanInfo")) return Response.json({ planInfo: { planName: "Pro" } });
    if (url.pathname === "/oauth/token") return Response.json(refresh);
    return new Response("", { status: 500 });
  },
});
Object.assign(CURSOR, { api: `http://127.0.0.1:${server.port}`, pollMs: 1 });
afterAll(() => server.stop(true));

test("Cursor plan usage becomes one account window that resets with the billing cycle", () => {
  expect(parseQuota({ billingCycleEnd: "1790000000000", planUsage: { totalPercentUsed: 104, autoPercentUsed: 20 } })).toEqual({
    windows: [{ name: "month", usedPct: 100, resetsAt: 1_790_000_000_000, scope: { kind: "account" } }], status: "exhausted",
  });
  expect(parseQuota({ planUsage: {} })).toBeUndefined();
  expect(parseQuota(null)).toBeUndefined();
});

test("Cursor sign-in waits for the browser, then saves one account per Cursor user", async () => {
  const s = new Store(":memory:"); s.setLocal("node", "n");
  try {
    polls = 0;
    const id = await finish(s, "uuid", "verifier", undefined, new AbortController().signal, 5000);
    expect(polls).toBe(2);
    expect(s.get("account", id!)).toMatchObject({ provider: "cursor", label: "me@example.com", email: "me@example.com", plan: "Pro" });
    expect(s.get("credential", id!)).toMatchObject({ accessToken: access, expiresAt: 4_000_000_000_000, holder: "n" });
    polls = 0;
    expect(await finish(s, "uuid", "verifier", "Work", new AbortController().signal, 5000)).toBe(id);
    expect(s.list("account").length).toBe(1);
    polls = -1_000_000;
    expect(await finish(s, "uuid", "verifier", undefined, new AbortController().signal, 20)).toBeUndefined();
  } finally { s.close(); }
});

test("Cursor refresh keeps the new access token as the refresh token and stops when Cursor ends the login", async () => {
  const next = await cursor.refresh(access);
  expect(next.refreshToken).toBe(next.accessToken);
  expect(next.expiresAt).toBe(4_100_000_000_000);
  refresh = { shouldLogout: true };
  await expect(cursor.refresh(access)).rejects.toBeInstanceOf(InvalidGrant);
});

test("the control API signs in to Cursor without a pasted code", async () => {
  const s = new Store(":memory:"); s.setLocal("node", "n"); s.setLocal("adminToken", "admin-secret");
  const ctx = makeCtx(s), handler = app(ctx);
  const call = (path: string, body: unknown) => handler.fetch(new Request(`http://127.0.0.1:7878/api${path}`, { method: "POST", headers: { host: "127.0.0.1:7878", "content-type": "application/json" }, body: JSON.stringify(body) }), { listener: "loopback" });
  try {
    polls = 0;
    const start = await (await call("/accounts/login", { provider: "cursor" })).json() as { state: string; url: string };
    expect(new URL(start.url).searchParams.get("uuid")).toBe(start.state);
    expect(start.state).toMatch(/^[0-9a-f-]{36}$/);
    const done = await (await call("/accounts/login/finish", { state: start.state })).json() as { id?: string };
    expect(s.get("account", done.id!)?.provider).toBe("cursor");
    expect((await call("/accounts/login/finish", { state: start.state })).status).toBe(400);
  } finally { ctx.abort.abort(); ctx.skills.close(); ctx.imports.close(); await ctx.imports.drain(); await ctx.gateway.close(); s.close(); }
});
