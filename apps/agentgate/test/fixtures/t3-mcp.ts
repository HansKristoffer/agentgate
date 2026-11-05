import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { REQUIRED_T3_TOOLS } from "../../src/factory/t3-mcp.ts";
import { tmp } from "./git.ts";
import { fakeT3 } from "./t3.ts";

/** T3 Code's MCP sign-in and `/mcp`, as the nightly 0.1.7 serves them (`EnvironmentMcpOAuthHttpApi` and the
 * `AuthMcp*` schemas), mounted on a `fakeT3` through its `routes`. Pairing codes come from `pairBin`, a stand-in for
 * `t3 pair`. Access tokens have T3's shape, `<base64url claims>.<signature>`, and the nth signature is
 * `test-secret-token-<n>`, so a test can search output for it. */
export function fakeT3Mcp(fake: ReturnType<typeof fakeT3>) {
  const dir = tmp();
  const pairLog = join(dir, "pairs");
  const pairBin = join(dir, "t3");
  writeFileSync(
    pairBin,
    `#!/bin/sh\necho "$@" >> ${pairLog}\necho "Pairing URL: ${fake.url}/pair#token=pair-$$"\necho "Expires: 2026-12-01T00:00:00.000Z"\n`,
  );
  chmodSync(pairBin, 0o755);

  const clients = new Map<string, string[]>(); // client_id → redirect URIs
  const usedCodes = new Set<string>();
  const pending = new Map<string, { clientId: string; redirectUri: string; challenge: string; access: string }>();
  const active = new Map<string, string>(); // token → session id
  const answers = new Map<string, (args: Record<string, unknown>) => unknown>(
    REQUIRED_T3_TOOLS.map((tool) => [tool, () => ({ ok: true })]),
  );

  const api = {
    /** Tool calls that reached `/mcp`. */
    calls: [] as { tool: string; args: Record<string, unknown> }[],
    /** Replaces a tool's canned answer; a thrown error becomes a tool error, like T3's. */
    answer(tool: string, fn: (args: Record<string, unknown>) => unknown) {
      answers.set(tool, fn);
    },
    /** The tools `/mcp` lists; delete one to play an older T3. */
    tools: new Set<string>(REQUIRED_T3_TOOLS),
    /** Issued access tokens, in order. */
    tokens: [] as string[],
    registrations: [] as Record<string, unknown>[],
    decisions: [] as { authorization: Record<string, unknown>; decision: Record<string, unknown> }[],
    /** Session ids revoked through `/api/auth/clients/revoke`. */
    revoked: [] as string[],
    /** The `t3 pair` stand-in; point `host.t3` at it. */
    pairBin,
    /** The arguments of each `t3 pair` run. */
    pairs: () => (existsSync(pairLog) ? readFileSync(pairLog, "utf8").trim().split("\n") : []),
    /** Refuse revocation, like T3 for a bearer without `access:write`. */
    denyRevoke: false,
    /** Forget a token, so `/mcp` answers 401 for it, like T3 for a revoked session. */
    refuse(token: string) {
      active.delete(token);
    },
    /** Refuse every token, including those issued later. */
    refuseAll: false,
    routes: (req: Request) => routes(req),
  };

  const approvalError = (message: string) => Response.json({ _tag: "AuthMcpApprovalError", message }, { status: 400 });
  const tokenError = (error: string, error_description: string) =>
    Response.json({ error, error_description }, { status: 400 });
  const sha256 = async (text: string) =>
    Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("base64url");

  const handlers: Record<string, (req: Request) => Promise<Response>> = {
    "/.well-known/oauth-authorization-server": async () =>
      Response.json({
        issuer: fake.url,
        authorization_endpoint: `${fake.url}/oauth/mcp/authorize`,
        token_endpoint: `${fake.url}/oauth/mcp/token`,
        registration_endpoint: `${fake.url}/oauth/mcp/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"],
        authorization_response_iss_parameter_supported: true,
      }),
    "/oauth/mcp/register": async (req) => {
      const body = (await req.json()) as { client_name?: string; redirect_uris?: string[] };
      api.registrations.push(body);
      const uris = body.redirect_uris ?? [];
      if (!uris.length || !uris.every((u) => /^https:|^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(u)))
        return Response.json(
          { error: "invalid_redirect_uri", error_description: "Redirect URIs must be https, or http on loopback." },
          { status: 400 },
        );
      const clientId = `client-${clients.size + 1}`;
      clients.set(clientId, uris);
      return Response.json(
        {
          client_id: clientId,
          client_name: body.client_name ?? "MCP client",
          redirect_uris: uris,
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
        { status: 201 },
      );
    },
    "/oauth/mcp/decision": async (req) => {
      const body = (await req.json()) as (typeof api.decisions)[number];
      api.decisions.push(body);
      const { authorization: a, decision: d } = body;
      const clientId = String(a.client_id);
      if (!clients.get(clientId)?.includes(String(a.redirect_uri)))
        return approvalError("This sign-in link names an unknown app.");
      if (a.response_type !== "code" || a.code_challenge_method !== "S256" || !a.code_challenge)
        return approvalError("PKCE with code_challenge_method=S256 is required.");
      if (d._tag !== "pairing-code") return approvalError("Only pairing codes are faked.");
      const pairing = String(d.code);
      if (!pairing.startsWith("pair-") || usedCodes.has(pairing))
        return approvalError("That pairing code is unknown or already used.");
      usedCodes.add(pairing);
      const code = crypto.randomUUID();
      pending.set(code, {
        clientId,
        redirectUri: String(a.redirect_uri),
        challenge: String(a.code_challenge),
        access: String(d.access),
      });
      const redirect = new URL(String(a.redirect_uri));
      redirect.searchParams.set("code", code);
      if (a.state !== undefined) redirect.searchParams.set("state", String(a.state));
      redirect.searchParams.set("iss", fake.url);
      return Response.json({ redirectTo: redirect.toString() });
    },
    "/oauth/mcp/token": async (req) => {
      const form = new URLSearchParams(await req.text());
      if (form.get("grant_type") !== "authorization_code")
        return tokenError("unsupported_grant_type", "Only authorization_code is supported.");
      const code = form.get("code") ?? "";
      const grant = pending.get(code);
      pending.delete(code);
      if (
        !grant ||
        grant.clientId !== form.get("client_id") ||
        grant.redirectUri !== form.get("redirect_uri") ||
        grant.challenge !== (await sha256(form.get("code_verifier") ?? ""))
      )
        return tokenError("invalid_grant", "The code is unknown, used, or does not match.");
      const sid = crypto.randomUUID();
      const claims = Buffer.from(JSON.stringify({ v: 1, kind: "session", sid, sub: "mcp-client" })).toString(
        "base64url",
      );
      const token = `${claims}.test-secret-token-${api.tokens.length + 1}`;
      api.tokens.push(token);
      active.set(token, sid);
      return Response.json({ access_token: token, token_type: "Bearer", expires_in: 30 * 86_400, scope: "" });
    },
    "/api/auth/clients/revoke": async (req) => {
      // Only a session T3 itself accepts: ask the fake's own API with the same bearer.
      const auth = req.headers.get("authorization") ?? "";
      const check = await fetch(`${fake.url}/api/orchestration/shell`, {
        headers: { authorization: auth, "x-t3-orchestration-protocol": "2" },
      });
      if (!check.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (api.denyRevoke)
        return Response.json(
          { _tag: "EnvironmentAuthorizationError", message: "missing required scope: access:write" },
          { status: 403 },
        );
      const { sessionId } = (await req.json()) as { sessionId: string };
      const revoked = [...active].filter(([, sid]) => sid === sessionId);
      for (const [token] of revoked) active.delete(token);
      api.revoked.push(sessionId);
      return Response.json({ revoked: revoked.length > 0 });
    },
    "/mcp": (req) => mcp(req),
  };
  /** Tried first by `fakeT3`; `undefined` for its own paths. */
  const routes = (req: Request) => handlers[new URL(req.url).pathname]?.(req);

  async function mcp(req: Request) {
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (api.refuseAll || !active.has(token))
      return Response.json(
        { error: "invalid_mcp_credential", message: "A valid T3 Code MCP credential is required." },
        { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } },
      );
    const server = new Server({ name: "t3code", version: "0.1.7" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({
      tools: [...api.tools].map((name) => ({ name, inputSchema: { type: "object" as const } })),
    }));
    server.setRequestHandler("tools/call", async (request) => {
      const { name, arguments: args = {} } = request.params;
      api.calls.push({ tool: name, args });
      try {
        const value = await answers.get(name)!(args);
        // Like T3: the structured value, and its JSON as text.
        return {
          structuredContent: value as Record<string, unknown>,
          content: [{ type: "text", text: JSON.stringify(value) }],
        };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
      }
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(req);
  }

  return api;
}

/** A `fakeT3` with `fakeT3Mcp` mounted on it. */
export function fakeT3WithMcp(options: Omit<Parameters<typeof fakeT3>[0], "routes">) {
  let mcp: ReturnType<typeof fakeT3Mcp> | undefined;
  const t3 = fakeT3({ ...options, routes: (req) => mcp?.routes(req) });
  mcp = fakeT3Mcp(t3);
  return { t3, mcp };
}
