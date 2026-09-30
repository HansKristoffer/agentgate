import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { connect, needsLogin } from "../src/mcp/gateway.ts";
import { finishLogin, startLogin } from "../src/mcp/oauth.ts";
import { newInstance, parseHeaders } from "../src/mcp/templates.ts";
import { Store } from "../src/store.ts";

// A fake hosted MCP server behind MCP OAuth: discovery, dynamic registration, PKCE, rotating refresh tokens.
const challenges = new Map<string, string>();
const access = new Set<string>();
const refresh = new Set<string>();
let n = 0;
const issue = () => {
  const t = { access_token: `at-${++n}`, refresh_token: `rt-${n}`, token_type: "Bearer", expires_in: 3600 };
  access.add(t.access_token);
  refresh.add(t.refresh_token);
  return Response.json(t);
};

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const base = url.origin;
    switch (url.pathname) {
      case "/.well-known/oauth-protected-resource/mcp":
        return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
      case "/.well-known/oauth-authorization-server":
        return Response.json({
          issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
          response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], grant_types_supported: ["authorization_code", "refresh_token"],
        });
      case "/register":
        return Response.json({ ...(await req.json() as object), client_id: "client-1" }, { status: 201 });
      case "/authorize": {
        // The user "logs in" at once and is sent back with a code.
        const code = `code-${++n}`;
        challenges.set(code, url.searchParams.get("code_challenge")!);
        const back = new URL(url.searchParams.get("redirect_uri")!);
        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state")!);
        return Response.redirect(back.href, 302);
      }
      case "/token": {
        const f = new URLSearchParams(await req.text());
        if (f.get("grant_type") === "authorization_code") {
          const want = challenges.get(f.get("code")!);
          const got = createHash("sha256").update(f.get("code_verifier")!).digest("base64url");
          return want === got ? issue() : Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return refresh.delete(f.get("refresh_token")!) ? issue() : Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      case "/mcp": {
        const token = req.headers.get("authorization")?.replace("Bearer ", "");
        if (!token || !access.has(token))
          return new Response("unauthorized", { status: 401, headers: { "www-authenticate": `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` } });
        const mcp = new McpServer({ name: "fake", version: "0" });
        mcp.registerTool("whoami", { description: "who" }, async () => ({ content: [{ type: "text", text: `token ${token}` }] }));
        const t = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
        await mcp.connect(t);
        return t.handleRequest(req);
      }
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop(true));

const call = async (s: Store, id: string) => {
  const c = await connect(s.get("mcp", id)!, undefined, s);
  const r = (await c.callTool({ name: "whoami", arguments: {} })).content as { text: string }[];
  await c.close();
  return r[0]!.text;
};

test("URL + name: login through the server's OAuth, then tools work and refresh on their own", async () => {
  const s = new Store(":memory:");
  s.setLocal("node", "t");
  s.put("mcp", "fake", newInstance({ id: "fake", url: `http://127.0.0.1:${server.port}/mcp` }));

  // Without a login the connect fails with something the UI treats as "needs login".
  expect(connect(s.get("mcp", "fake")!, undefined, s).then(() => "ok", (e) => needsLogin(e))).resolves.toBe(true);

  const authUrl = await startLogin(s, "fake", "http://127.0.0.1:7878/oauth/callback");
  expect(authUrl!.pathname).toBe("/authorize");
  expect(s.get("mcpCredential", "fake")!.client!.client_id).toBe("client-1");

  // The browser: login page → redirect to our callback with code and state.
  const res = await fetch(authUrl!, { redirect: "manual" });
  const back = new URL(res.headers.get("location")!);
  expect(back.pathname).toBe("/oauth/callback");
  expect(await finishLogin(s, back.searchParams.get("state")!, back.searchParams.get("code")!)).toBe("fake");
  const first = s.get("mcpCredential", "fake")!.tokens!.access_token;
  expect(await call(s, "fake")).toBe(`token ${first}`);

  // The access token dies; the next connect refreshes with the stored refresh token and saves the new pair.
  access.clear();
  const text = await call(s, "fake");
  const second = s.get("mcpCredential", "fake")!.tokens!.access_token;
  expect(second).not.toBe(first);
  expect(text).toBe(`token ${second}`);

  // A reused state is refused.
  expect(finishLogin(s, back.searchParams.get("state")!, "x")).rejects.toThrow();
});

test("headers parse from lines or pairs; ids and URLs are validated", () => {
  expect(parseHeaders("x-posthog-project-id: 12345\nAuthorization: Bearer a:b")).toEqual({ "x-posthog-project-id": "12345", Authorization: "Bearer a:b" });
  expect(parseHeaders(["x=1"])).toEqual({ x: "1" });
  expect(() => newInstance({ id: "bad name", url: "https://x.dev" })).toThrow();
  expect(() => newInstance({ id: "ok", url: "http://example.com/mcp" })).toThrow();
  expect(newInstance({ id: "local", url: "http://localhost:3000/mcp" }).transport).toBe("http");
});

test("MCP refresh uses holder coordination and concurrent callers rotate once", async () => {
  const holder = new Store(":memory:"); holder.setLocal("node", "holder"); holder.put("mcp", "fake", newInstance({ id: "fake", url: `http://127.0.0.1:${server.port}/mcp` }));
  const url = await startLogin(holder, "fake", "http://localhost/oauth/callback"); const response = await fetch(url!, { redirect: "manual" }); const back = new URL(response.headers.get("location")!);
  await finishLogin(holder, back.searchParams.get("state")!, back.searchParams.get("code")!);
  const remote = new Store(":memory:"); remote.setLocal("node", "remote"); for (const r of holder.changes(0).records) remote.merge(r);
  remote.db.run("insert into peers values ('holder', 'http://127.0.0.1:1', 'fake', 0, ?)", [remote.now()]);
  const { refreshMcp } = await import("../src/mcp/oauth.ts"); const first = holder.get("mcpCredential", "fake")!.tokens!.access_token;
  await expect(refreshMcp(remote, "fake", true)).rejects.toThrow("holder"); expect(remote.get("mcpCredential", "fake")?.tokens?.access_token).toBe(first);
  expect(remote.get("refreshRequest", "mcpCredential:fake")).toBeDefined();
  const [a, b] = await Promise.all([refreshMcp(holder, "fake", true), refreshMcp(holder, "fake", true)]); expect(a.tokens?.access_token).toBe(b.tokens?.access_token); expect(a.tokens?.access_token).not.toBe(first);
  holder.close(); remote.close();
});

test("expired MCP OAuth state is refused before token exchange", async () => {
  const s = new Store(":memory:"); s.setLocal("node", "n"); s.put("mcp", "fake", newInstance({ id: "fake", url: `http://127.0.0.1:${server.port}/mcp` }));
  const url = await startLogin(s, "fake", "http://localhost/oauth/callback"); const response = await fetch(url!, { redirect: "manual" }); const back = new URL(response.headers.get("location")!);
  s.now = () => Date.now() + 11 * 60000; await expect(finishLogin(s, back.searchParams.get("state")!, back.searchParams.get("code")!)).rejects.toThrow("expired"); expect(s.get("mcpCredential", "fake")?.tokens).toBeUndefined(); s.close();
});

test("tailnet OAuth callback completes with one-time state even without the Strict admin cookie", async () => {
  const { app, makeCtx } = await import("../src/daemon.ts");
  const s = new Store(":memory:"); s.setLocal("node", "tailnet"); s.setLocal("adminToken", "admin-token");
  s.put("mcp", "fake", newInstance({ id: "fake", url: `http://127.0.0.1:${server.port}/mcp` })); const ctx = makeCtx(s);
  try {
    const url = await startLogin(s, "fake", "http://127.0.0.1:7878/oauth/callback"); const response = await fetch(url!, { redirect: "manual" });
    const result = await app(ctx).fetch(new Request(response.headers.get("location")!), { listener: "tailnet" });
    expect(result.status).toBe(302); expect(s.get("mcpCredential", "fake")?.tokens?.access_token).toBeDefined(); expect(result.headers.get("location")).toContain("Logged");
  } finally { await ctx.gateway.close(); s.close(); }
});
