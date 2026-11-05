import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { FactoryBoard, FactoryCommandResult } from "@agentgate/protocol";
import { z } from "zod";
import { createPairingLink, parsePairing, t3State, T3Error } from "../handoff/t3.ts";
import { VERSION } from "../mcp/gateway.ts";
import { fetchHeaders, readBody } from "../runtime.ts";
import { runCommand, type FactoryRuntime } from "./runtime.ts";

/** The factory drives T3 Code through its own `/mcp`, signed in like any outside MCP client: OAuth with PKCE, approved
 * with a pairing code from the local `t3 pair` at full access. T3 issues no refresh token, so the factory signs in
 * again before the 30 days end. The token is node-local and never leaves this module: not in status, errors or logs. */

export const REQUIRED_T3_TOOLS = [
  "t3_project_list",
  "t3_thread_launch",
  "t3_thread_send",
  "t3_thread_read",
  "t3_thread_interrupt",
  "t3_thread_organize",
  "t3_pending_request",
  "link_pull_request",
  "watch_pull_request",
  "unwatch_pull_request",
] as const;
export type T3Tool = (typeof REQUIRED_T3_TOOLS)[number];
export class T3McpError extends Error {}

export interface T3McpClient {
  /** Parses the tool's JSON result; throws T3McpError on a tool error or transport failure. */
  call<T = unknown>(tool: T3Tool, args: Record<string, unknown>): Promise<T>;
  status(): { mcp: "signed-in" | "signing-in" | "failed" | "off"; expiresAt?: number; error?: string };
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

const KEY = "factory:t3mcp";
const CLIENT_NAME = "AgentGate factory";
/** What T3's full access requires of the pairing code (its `mcpClientScopes("full-access")`). */
const SCOPES = ["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"];
/** Registered, never served: the code is read from the `redirectTo` T3 answers the decision with. T3 matches
 * loopback redirects by host and path, so no port is needed. */
const REDIRECT = "http://127.0.0.1/agentgate-factory";
const RENEW_AHEAD = 3 * 86_400_000;
/** Each attempt makes a pairing link in T3, so a failed sign-in is not retried on its own sooner than this. */
const RETRY_AFTER = 10 * 60_000;
/** Launching a thread creates a worktree, which can take a while on a large repository. */
const CALL_TIMEOUT = 5 * 60_000;
const HTTP_TIMEOUT = 15_000;
const UNREVOKED = `Signed out here, but T3 Code could not revoke the session; remove ${CLIENT_NAME} in T3 Code's Settings → Connections`;

const savedSchema = z.object({ token: z.string(), expiresAt: z.number() });
type Saved = z.infer<typeof savedSchema>;

/** T3 refused the token: the one failure where repeating a call is safe, because nothing ran. */
class Refused extends Error {}

const clients = new WeakMap<FactoryRuntime, ReturnType<typeof create>>();

/** The machine's one T3 MCP client. */
export function t3Mcp(f: FactoryRuntime): T3McpClient {
  return client(f);
}

function client(f: FactoryRuntime) {
  let c = clients.get(f);
  if (!c) clients.set(f, (c = create(f)));
  return c;
}

export function setup(f: FactoryRuntime) {
  const mcp = client(f);
  f.events.on("factory.off", () => mcp.signOut());
  f.loops.push({ name: "t3-mcp", everyMs: 60_000, where: "factory-node", run: () => mcp.tick() });
  f.boardParts.push(async () => {
    const { mcp: state, expiresAt, error } = mcp.status();
    // Only the sign-in's fields; the board merges them with the stream state it owns.
    return { t3: { mcp: state, ...(expiresAt && { mcpExpiresAt: expiresAt }), ...(error && { error }) } } as Partial<
      Pick<FactoryBoard, "t3">
    >;
  });
  f.commands.set("t3", {
    usage:
      "t3 [sign-in|sign-out]  T3 Code MCP sign-in of the factory machine (while the factory is on, it signs in again by itself)",
    async run(args, io) {
      const [action] = args;
      if (action === "sign-in")
        await mcp.signIn().catch(() => {}); // the status below says why
      else if (action === "sign-out") await mcp.signOut();
      else if (action !== undefined) {
        io.out(`unknown t3 action ${action}; use sign-in or sign-out`);
        return 2;
      }
      const status = mcp.status();
      io.out(`mcp: ${status.mcp}${status.expiresAt ? ` until ${new Date(status.expiresAt).toISOString()}` : ""}`);
      if (status.error) io.out(`error: ${status.error}`);
      return action === "sign-in" && status.mcp !== "signed-in" ? 1 : 0;
    },
  });
  // Through the command, so the app signs in on the factory machine like the CLI does.
  f.api.post("/t3/sign-in", async (c) => {
    const output: string[] = [];
    const code = await runCommand(f, "t3", ["sign-in"], { out: (line) => output.push(line) });
    return c.json({ code, output } satisfies FactoryCommandResult, code ? 409 : 200);
  });
}

function create(f: FactoryRuntime) {
  const { s } = f;
  let signing: Promise<void> | undefined;
  let error: string | undefined;
  let failedAt: number | undefined; // the last sign-in failed then
  let missing: string[] | undefined; // undefined until tools/list was read for this token

  const saved = (): Saved | undefined => {
    const raw = s.local(KEY);
    const parsed = raw ? savedSchema.safeParse(JSON.parse(raw)) : undefined;
    return parsed?.success ? parsed.data : undefined;
  };
  const valid = () => {
    const token = saved();
    return token && token.expiresAt > s.now() ? token : undefined;
  };
  const t3Url = () => {
    const url = t3State(s).url;
    if (!url) throw new T3McpError(`T3 Code is not connected on ${s.nodeId}; run agentgate t3 connect there`);
    return url;
  };
  const coolingDown = () => failedAt !== undefined && s.now() - failedAt < RETRY_AFTER;

  function signIn(): Promise<void> {
    signing ??= (async () => {
      try {
        const old = saved();
        s.setLocal(KEY, JSON.stringify(await authorize(s, t3Url())));
        error = failedAt = missing = undefined;
        // The replaced session would linger in T3's Connections until it expires.
        if (old) await revoke(s, old.token);
        await check(false); // never throws: a missing tool or unreachable MCP shows in the status
      } catch (e) {
        failedAt = s.now();
        error = e instanceof T3McpError || e instanceof T3Error ? e.message : `T3 MCP sign-in failed: ${name(e)}`;
        throw new T3McpError(error);
      } finally {
        signing = undefined;
      }
    })();
    return signing;
  }

  /** A connected client for one batch of requests, signing in first when needed and once more if T3 refuses. */
  async function session<T>(fn: (client: Client, token: string) => Promise<T>, renew = true): Promise<T> {
    const url = t3Url();
    let token = valid()?.token;
    if (!token && renew) {
      if (coolingDown()) throw new T3McpError(error ?? "T3 MCP sign-in failed");
      await signIn();
      token = valid()?.token;
    }
    if (!token) throw new T3McpError(error ?? `the factory is not signed in to T3 Code on ${s.nodeId}`);
    const attempt = async (token: string) => {
      try {
        return { value: await connected(url, token, fn) };
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
        // A refused token is never sent again.
        if (saved()?.token === token) s.setLocal(KEY, undefined);
        return undefined;
      }
    };
    let done = await attempt(token);
    if (!done && renew) {
      await signIn();
      const fresh = valid()?.token;
      if (fresh) done = await attempt(fresh);
    }
    if (done) return done.value;
    failedAt = s.now();
    throw new T3McpError((error = `T3 Code on ${s.nodeId} refused the factory's MCP sign-in`));
  }

  async function connected<T>(
    url: string,
    token: string,
    fn: (client: Client, token: string) => Promise<T>,
  ): Promise<T> {
    let wasRefused = false;
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (input, init) => {
        const res = await fetchHeaders(input, init, CALL_TIMEOUT);
        if (res.status === 401) wasRefused = true;
        return res;
      },
    });
    const mcp = new Client({ name: "agentgate-factory", version: VERSION });
    try {
      await mcp.connect(transport, { timeout: 10_000 });
      return await fn(mcp, token);
    } catch (e) {
      if (wasRefused) throw new Refused();
      if (e instanceof T3McpError) throw e;
      throw new T3McpError(
        `T3 Code's MCP on ${s.nodeId} failed: ${scrub(e instanceof Error ? e.message : String(e), token)}`,
      );
    } finally {
      await mcp.close().catch(() => {});
    }
  }

  /** Reads tools/list and records the required tools T3 lacks. */
  async function check(renew: boolean) {
    try {
      const names = new Set<string>();
      await session(async (mcp) => {
        let cursor: string | undefined;
        do {
          const page = await mcp.listTools(cursor ? { cursor } : {}, { timeout: 30_000 });
          for (const tool of page.tools) names.add(tool.name);
          cursor = page.nextCursor;
        } while (cursor);
      }, renew);
      missing = REQUIRED_T3_TOOLS.filter((tool) => !names.has(tool));
      error = missing.length ? `T3 Code's MCP lacks ${missing.join(", ")}; update T3 Code` : undefined;
    } catch (e) {
      error = e instanceof T3McpError ? e.message : `T3 Code's MCP check failed: ${name(e)}`;
    }
  }

  return {
    signIn,
    async signOut() {
      await signing?.catch(() => {}); // a sign-in in flight would store its token after this
      const old = saved();
      s.setLocal(KEY, undefined);
      failedAt = missing = undefined;
      error = old && !(await revoke(s, old.token)) ? UNREVOKED : undefined;
    },
    status() {
      const token = valid();
      // Signed out with a session T3 would not revoke is still off; any other error is a failure.
      const failed = error !== undefined && error !== UNREVOKED;
      const mcp = signing ? "signing-in" : failed ? "failed" : token ? "signed-in" : "off";
      return { mcp, ...(token && { expiresAt: token.expiresAt }), ...(error && { error }) } as const;
    },
    async call<T = unknown>(tool: T3Tool, args: Record<string, unknown>): Promise<T> {
      if (missing?.length) throw new T3McpError(error ?? `T3 Code's MCP lacks ${missing.join(", ")}`);
      return session(async (mcp, token) => {
        const result = await mcp.callTool({ name: tool, arguments: args }, { timeout: CALL_TIMEOUT });
        const text = (result.content as { type: string; text?: string }[] | undefined)?.find(
          (c) => c.type === "text",
        )?.text;
        if (result.isError) throw new T3McpError(`T3 Code's ${tool} failed: ${scrub(errorText(text), token)}`);
        if (result.structuredContent !== undefined) return result.structuredContent as T;
        if (text === undefined) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          return text as T;
        }
      });
    },
    /** The loop: renew a token close to its end, and read tools/list until it has every required tool (T3 may be
     * updated meanwhile); reading it also finds a token T3 stopped accepting. */
    async tick() {
      if (signing) return;
      const token = valid();
      if (!token || token.expiresAt - s.now() <= RENEW_AHEAD) {
        if (!coolingDown()) await signIn().catch(() => {}); // the status says why
      } else if (!missing || missing.length) await check(true);
    },
  };
}

/** T3's tool errors are a message, or the JSON of a tagged error. */
function errorText(text: string | undefined) {
  if (!text) return "no detail";
  try {
    const parsed = JSON.parse(text) as { message?: unknown; _tag?: unknown };
    if (typeof parsed?.message === "string") return parsed.message;
    if (typeof parsed?._tag === "string") return parsed._tag;
  } catch {
    // plain text
  }
  return text;
}

/** T3's own text, cut short, with any secret of this sign-in taken out. */
function scrub(text: string, ...secrets: (string | undefined)[]) {
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[redacted]");
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

async function http(url: string, path: string, body?: { json: unknown } | { form: Record<string, string> }) {
  const res = await fetchHeaders(
    `${url}${path}`,
    body
      ? {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "json" in body ? "application/json" : "application/x-www-form-urlencoded" },
          body: "json" in body ? JSON.stringify(body.json) : new URLSearchParams(body.form),
        }
      : { redirect: "manual" },
    HTTP_TIMEOUT,
  ).catch(() => {
    throw new T3McpError(`T3 Code is not reachable at ${url}`);
  });
  const text = new TextDecoder().decode(await readBody(res.body, 1024 * 1024, AbortSignal.timeout(HTTP_TIMEOUT)));
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON: callers check the shape of what they need and report it missing.
  }
  return { ok: res.ok, json };
}

const detail = (json: unknown) => {
  const o = json as { error_description?: unknown; message?: unknown; error?: unknown } | undefined;
  return String(o?.error_description ?? o?.message ?? o?.error ?? "no detail");
};
/** A caught error's name only: the message of an unexpected error can hold a URL with the sign-in code. */
const name = (e: unknown) => (e instanceof Error ? e.name : "error");
const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** T3's MCP OAuth (`EnvironmentMcpOAuthHttpApi`): register, then approve with a pairing code at full access, then
 * exchange the code with the PKCE verifier. */
async function authorize(s: FactoryRuntime["s"], url: string) {
  const metadata = await http(url, "/.well-known/oauth-authorization-server");
  const methods = (metadata.json as { code_challenge_methods_supported?: unknown })?.code_challenge_methods_supported;
  if (!metadata.ok || !Array.isArray(methods) || !methods.includes("S256"))
    throw new T3McpError(`T3 Code at ${url} has no MCP sign-in; update T3 Code`);

  const registered = await http(url, "/oauth/mcp/register", {
    json: { client_name: CLIENT_NAME, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" },
  });
  const clientId = (registered.json as { client_id?: unknown })?.client_id;
  if (!registered.ok || typeof clientId !== "string")
    throw new T3McpError(`T3 Code refused to register ${CLIENT_NAME}: ${scrub(detail(registered.json))}`);

  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const pairing = parsePairing((await createPairingLink(s, { label: CLIENT_NAME, scopes: SCOPES })).url).token;

  const decided = await http(url, "/oauth/mcp/decision", {
    json: {
      authorization: {
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      },
      decision: { _tag: "pairing-code", access: "full-access", code: pairing },
    },
  });
  const redirectTo = (decided.json as { redirectTo?: unknown })?.redirectTo;
  if (!decided.ok || typeof redirectTo !== "string")
    throw new T3McpError(`T3 Code refused the pairing code: ${scrub(detail(decided.json), pairing)}`);
  const answer = new URL(redirectTo).searchParams;
  if (answer.get("error")) throw new T3McpError(`T3 Code denied the sign-in: ${scrub(answer.get("error")!)}`);
  const code = answer.get("code");
  if (answer.get("state") !== state || !code) throw new T3McpError("T3 Code answered the sign-in without its code");

  const exchanged = await http(url, "/oauth/mcp/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    },
  });
  const token = z
    .object({ access_token: z.string().min(1), expires_in: z.number().positive() })
    .safeParse(exchanged.json);
  if (!exchanged.ok || !token.success)
    throw new T3McpError(`T3 Code refused the sign-in code: ${scrub(detail(exchanged.json), code, verifier)}`);
  return { token: token.data.access_token, expiresAt: s.now() + token.data.expires_in * 1000 };
}

/** Revokes the session through T3 with handoff's bearer, which needs `access:write`. Whether it worked. */
async function revoke(s: FactoryRuntime["s"], token: string) {
  const url = t3State(s).url;
  const bearer = s.local("t3:token");
  // T3's session tokens are `<base64url claims>.<signature>`; the claims name the session.
  let sessionId: unknown;
  try {
    sessionId = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()).sid;
  } catch {
    return false;
  }
  if (!url || !bearer || typeof sessionId !== "string") return false;
  const res = await fetchHeaders(
    `${url}/api/auth/clients/revoke`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    },
    HTTP_TIMEOUT,
  ).catch(() => undefined);
  await res?.body?.cancel().catch(() => {});
  return !!res?.ok;
}
