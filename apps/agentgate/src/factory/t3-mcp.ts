import { createHash } from "node:crypto";
import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type { FactoryBoard } from "@agentgate/protocol";
import { z } from "zod";
import { createPairingLink, parsePairing, t3State, T3Error } from "../handoff/t3.ts";
import { VERSION } from "../mcp/gateway.ts";
import { fetchHeaders, readBody } from "../runtime.ts";
import { runs } from "./db.ts";
import { noWords, operation, type FactoryRuntime } from "./runtime.ts";

/** The factory drives T3 Code through its own `/mcp`, signed in like any outside MCP client: OAuth with PKCE, approved
 * with a pairing code from the local `t3 pair` at full access. T3 issues no refresh token, so the factory signs in
 * again before the 30 days end. The token is node-local and never leaves this module: not in status, errors or logs. */

/** Every input the factory sends to each T3 tool. A sign-in reads `tools/list` and refuses a T3 Code whose tools lack
 * one: an older T3 drops an input it does not know, such as `clientRequestId`, which makes a retried launch start a
 * second thread instead of finding the first. */
export const REQUIRED_T3_INPUTS = {
  t3_thread_launch: [
    "projectId",
    "title",
    "runtimeMode",
    "workspaceStrategy",
    "modelSelection",
    "message",
    "clientRequestId",
  ],
  t3_thread_send: ["threadId", "message", "mode"],
  t3_thread_interrupt: ["threadId", "reason"],
  t3_thread_organize: ["threadId", "action"],
  t3_pending_request: ["action", "threadId", "requestId", "answers"],
} as const;
export const REQUIRED_T3_TOOLS = Object.keys(REQUIRED_T3_INPUTS) as (keyof typeof REQUIRED_T3_INPUTS)[];
export type T3Tool = keyof typeof REQUIRED_T3_INPUTS;

const pendingIds = z.object({ requestIds: z.array(z.string()) });
const pendingRequest = z.object({
  requestId: z.string(),
  questions: z.array(
    z.object({
      id: z.string(),
      question: z.string(),
      options: z.array(z.object({ label: z.string(), value: z.string().optional() })),
    }),
  ),
});
export type PendingRequest = z.infer<typeof pendingRequest>;

/** The question cards a thread waits on in T3 Code. T3 lists questions only, not permission approvals. */
export async function pendingRequests(mcp: T3McpClient, threadId: string): Promise<PendingRequest[]> {
  const { requestIds } = pendingIds.parse(await mcp.call("t3_pending_request", { action: "list", threadId }));
  const requests: PendingRequest[] = [];
  for (const requestId of requestIds)
    requests.push(pendingRequest.parse(await mcp.call("t3_pending_request", { action: "read", threadId, requestId })));
  return requests;
}
export class T3McpError extends Error {
  /** T3 answered the call with an error, so it ran nothing; otherwise the outcome is unknown. */
  answered = false;
}

export interface T3McpClient {
  /** Parses the tool's JSON result; throws T3McpError on a tool error or transport failure. With `session`, the call
   * goes only under that MCP session: a sign-in that changed meanwhile, even one this call made after T3 refused the
   * token, fails it unsent, as an answered error. */
  call<T = unknown>(tool: T3Tool, args: Record<string, unknown>, options?: { session?: string }): Promise<T>;
  /** The MCP session the current token belongs to, or undefined while signed out. T3 dedupes `clientRequestId`
   * within one session only. */
  session(): string | undefined;
  /** The session calls go under now, signing in first when needed. */
  sessionId(): Promise<string>;
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
/** How long T3 has to answer a tool call. Launching a thread creates a worktree, which can take a while on a large
 * repository. Every other call answers quickly and runs inside an item's lock, which "Drop" in the app waits on. */
export const deadlines = { launch: 5 * 60_000, call: 20_000 };
const HTTP_TIMEOUT = 15_000;
const UNREVOKED = `Signed out here, but T3 Code could not revoke the session; remove ${CLIENT_NAME} in T3 Code's Settings → Connections`;

const savedSchema = z.object({ token: z.string(), expiresAt: z.number() });
type Saved = z.infer<typeof savedSchema>;

/** T3's session tokens are `<base64url claims>.<signature>`, and the claims name the session (`sid`). A token of
 * another shape is its own session. */
function sessionOf(token: string): string {
  try {
    const sid = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()).sid;
    if (typeof sid === "string" && sid) return sid;
  } catch {
    // Not T3's shape.
  }
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

/** A machine signs in, and mirrors T3's threads, only while it runs the factory: no other machine drives items, and
 * the open ones a machine has left when the factory moves away stay frozen. */
export const needsSignIn = (f: FactoryRuntime) => f.isFactoryNode();

/** A launch whose answer has not come: renewing the session now would make it impossible to send again safely. */
const launching = (f: FactoryRuntime) =>
  runs.list(f.s, { states: ["queued", "starting"] }).some((r) => r.state === "starting" || r.launchSession);

/** T3 refused the token: the one failure where repeating a call is safe, because nothing ran. */
class Refused extends Error {}

/** The machine's one T3 MCP client. */
export function t3Mcp(f: FactoryRuntime): T3McpClient {
  return client(f);
}

function client(f: FactoryRuntime) {
  return f.memory("T3 MCP client", () => create(f));
}

export function setup(f: FactoryRuntime) {
  const mcp = client(f);
  f.events.on("factory.off", () => mcp.signOut());
  f.ctx.abort.signal.addEventListener("abort", () => mcp.disconnect(), { once: true });
  // Every node: `factory off` emits factory.off only where it ran, and other machines learn of it by sync.
  f.loops.push({ name: "t3-mcp", everyMs: 60_000, where: "every-node", whenOff: true, run: () => mcp.tick() });
  f.boardParts.push(async () => {
    const { mcp: state, expiresAt, error } = mcp.status();
    // Only the sign-in's fields; the board merges them with the stream state it owns.
    return { t3: { mcp: state, ...(expiresAt && { mcpExpiresAt: expiresAt }), ...(error && { error }) } } as Partial<
      Pick<FactoryBoard, "t3">
    >;
  });
  f.checks.push({
    name: "T3 Code's MCP",
    run() {
      const { mcp: state, error } = mcp.status();
      const check = { id: "t3-mcp", title: "The factory is signed in to T3 Code's MCP, which has every tool it uses" };
      if (state === "signed-in") return [{ ...check, state: "ok" }];
      if (state === "failed")
        return [{ ...check, state: "fail", ...(error && { detail: error }), fix: "agentgate factory t3 sign-in" }];
      // The loop signs in within a minute of the factory turning on here.
      return [{ ...check, state: "unknown", detail: state === "off" ? "not signed in yet" : "signing in" }];
    },
  });
  // Both run on the factory machine, the only one that signs in.
  const said = {
    parse: noWords,
    print: (status: ReturnType<typeof mcp.status>) => [
      `mcp: ${status.mcp}${status.expiresAt ? ` until ${new Date(status.expiresAt).toISOString()}` : ""}`,
      ...(status.error ? [`error: ${status.error}`] : []),
    ],
  };
  operation(f, {
    name: "t3",
    summary: "the factory's sign-in to T3 Code's MCP; it ends when the factory is turned off",
    input: z.object({}),
    run: () => mcp.status(),
    terminal: { usage: "t3", ...said },
  });
  operation(f, {
    name: "t3 sign-in",
    summary: "sign in to T3 Code's MCP again now",
    input: z.object({}),
    async run() {
      await mcp.signIn().catch(() => {}); // the status says why, also when the sign-in worked and T3 lacks a tool
      const status = mcp.status();
      if (status.mcp !== "signed-in") throw new T3McpError(status.error ?? "The sign-in to T3 Code's MCP failed");
      return status;
    },
    terminal: { usage: "t3 sign-in", ...said },
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
    // Cleared in `.finally`, which runs after the assignment even when the attempt fails before its first await.
    signing ??= attemptSignIn().finally(() => {
      signing = undefined;
    });
    return signing;
  }

  async function attemptSignIn() {
    try {
      // The loop signs out on any other machine, so a token here would not last.
      if (!needsSignIn(f)) throw new T3McpError(`the factory does not run on ${s.nodeId}`);
      const old = saved();
      s.setLocal(KEY, JSON.stringify(await authorize(s, t3Url())));
      error = failedAt = missing = undefined;
      // The replaced session would linger in T3's Connections until it expires. Its connection goes first, so the
      // SDK does not reopen its event stream with the revoked token.
      if (old) {
        disconnect();
        await revoke(s, old.token);
      }
      await check(false); // never throws: a missing tool or unreachable MCP shows in the status
    } catch (e) {
      failedAt = s.now();
      error = e instanceof T3McpError || e instanceof T3Error ? e.message : `T3 MCP sign-in failed: ${name(e)}`;
      throw new T3McpError(error);
    }
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

  /** The one MCP connection, kept for the token it was opened with. T3 finds a launch's `clientRequestId` by the
   * sign-in's session, which every request names in its bearer, not by the MCP transport session, so a launch may go
   * out on the same connection as any other call. */
  let open: { url: string; token: string; client: Promise<Client> } | undefined;

  function connection(url: string, token: string) {
    if (open && (open.url !== url || open.token !== token)) disconnect();
    if (open) return open;
    const mcp = new Client({ name: "agentgate-factory", version: VERSION });
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      // A backstop for the headers only; each request has its own deadline.
      fetch: (input, init) => fetchHeaders(input, init, deadlines.launch),
    });
    const entry = { url, token, client: mcp.connect(transport, { timeout: 10_000 }).then(() => mcp) };
    mcp.onclose = () => {
      if (open === entry) open = undefined;
    };
    return (open = entry);
  }

  /** Closes the connection; with `entry`, only while it is still the open one. */
  function disconnect(entry = open) {
    if (!entry || open !== entry) return;
    open = undefined;
    // Closing aborts its requests still in flight, such as one past its deadline.
    void entry.client.then((mcp) => mcp.close()).catch(() => {});
  }

  async function connected<T>(
    url: string,
    token: string,
    fn: (client: Client, token: string) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const entry = connection(url, token);
      let mcp: Client | undefined;
      try {
        mcp = await entry.client;
        return await fn(mcp, token);
      } catch (e) {
        if (e instanceof T3McpError) throw e; // T3 answered over a working connection
        // A call past its deadline leaves the connection to the calls still in flight on it, such as a launch.
        const late = mcp && e instanceof SdkError && e.code === SdkErrorCode.RequestTimeout;
        if (!late) disconnect(entry);
        const status = e instanceof UnauthorizedError ? 401 : e instanceof SdkHttpError ? e.status : undefined;
        if (status === 401) throw new Refused();
        // T3 no longer knows the MCP session, as after a restart, and ran nothing: send once more on a new one.
        if (status === 404 && attempt === 1) continue;
        throw new T3McpError(
          `T3 Code's MCP on ${s.nodeId} failed: ${scrub(e instanceof Error ? e.message : String(e), token)}`,
        );
      }
    }
  }

  /** Reads tools/list and records what T3 lacks: a required tool, or an input the factory sends it. */
  async function check(renew: boolean) {
    try {
      const inputs = new Map<string, Set<string>>();
      await session(async (mcp) => {
        let cursor: string | undefined;
        do {
          const page = await mcp.listTools(cursor ? { cursor } : {}, { timeout: 30_000 });
          for (const tool of page.tools) inputs.set(tool.name, new Set(Object.keys(tool.inputSchema.properties ?? {})));
          cursor = page.nextCursor;
        } while (cursor);
      }, renew);
      missing = Object.entries(REQUIRED_T3_INPUTS).flatMap(([tool, wanted]) => {
        const has = inputs.get(tool);
        if (!has) return [tool];
        const lacks = wanted.filter((input) => !has.has(input));
        return lacks.length ? [`${tool} (${lacks.join(", ")})`] : [];
      });
      error = missing.length ? `T3 Code's MCP lacks ${missing.join(", ")}; update T3 Code` : undefined;
    } catch (e) {
      error = e instanceof T3McpError ? e.message : `T3 Code's MCP check failed: ${name(e)}`;
    }
  }

  async function signOut() {
    await signing?.catch(() => {}); // a sign-in in flight would store its token after this
    const old = saved();
    s.setLocal(KEY, undefined);
    disconnect();
    failedAt = missing = undefined;
    error = old && !(await revoke(s, old.token)) ? UNREVOKED : undefined;
  }

  return {
    signIn,
    signOut,
    disconnect: () => disconnect(),
    session() {
      const token = valid();
      return token && sessionOf(token.token);
    },
    async sessionId() {
      let token = valid();
      if (!token) {
        if (coolingDown()) throw new T3McpError(error ?? "T3 MCP sign-in failed");
        await signIn();
        token = valid();
      }
      if (!token) throw new T3McpError(error ?? `the factory is not signed in to T3 Code on ${s.nodeId}`);
      return sessionOf(token.token);
    },
    status() {
      const token = valid();
      // Signed out with a session T3 would not revoke is still off; any other error is a failure.
      const failed = error !== undefined && error !== UNREVOKED;
      const mcp = signing ? "signing-in" : failed ? "failed" : token ? "signed-in" : "off";
      return { mcp, ...(token && { expiresAt: token.expiresAt }), ...(error && { error }) } as const;
    },
    async call<T = unknown>(
      tool: T3Tool,
      args: Record<string, unknown>,
      options: { session?: string } = {},
    ): Promise<T> {
      if (missing?.length) throw new T3McpError(error ?? `T3 Code's MCP lacks ${missing.join(", ")}`);
      return session(async (mcp, token) => {
        if (options.session && sessionOf(token) !== options.session) {
          const changed = new T3McpError(`T3 Code's sign-in changed before ${tool} was sent`);
          changed.answered = true;
          throw changed;
        }
        const timeout = tool === "t3_thread_launch" ? deadlines.launch : deadlines.call;
        const result = await mcp.callTool({ name: tool, arguments: args }, { timeout });
        const text = (result.content as { type: string; text?: string }[] | undefined)?.find(
          (c) => c.type === "text",
        )?.text;
        if (result.isError) {
          const refused = new T3McpError(`T3 Code's ${tool} failed: ${scrub(errorText(text), token)}`);
          refused.answered = true;
          throw refused;
        }
        if (result.structuredContent !== undefined) return result.structuredContent as T;
        if (text === undefined) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          return text as T;
        }
      });
    },
    /** The loop. On a machine that does not run the factory, sign out a token left from when it ran here.
     * Otherwise renew a token close to its end, unless a launch's answer is still out, and read tools/list until it
     * has every required tool and input (T3 may be updated meanwhile); reading it also finds a token T3 stopped
     * accepting. */
    async tick() {
      if (signing) return;
      if (!needsSignIn(f)) {
        if (saved()) await signOut();
        return;
      }
      const token = valid();
      if (!token || (token.expiresAt - s.now() <= RENEW_AHEAD && !launching(f))) {
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

  // The resource the token is for (RFC 8707), as T3's own sign-in between environments names it.
  const resource = `${url}/mcp`;
  const decided = await http(url, "/oauth/mcp/decision", {
    json: {
      authorization: {
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        resource,
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
      resource,
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
