import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { app, makeCtx, type Ctx } from "../../src/daemon.ts";
import { fetcher } from "../../src/factory/folder.ts";
import { mirrorOf } from "../../src/factory/mirror.ts";
import { loopTask, runCommand, type FactoryRuntime } from "../../src/factory/runtime.ts";
import { REQUIRED_T3_TOOLS } from "../../src/factory/t3-mcp.ts";
import { connectT3, host } from "../../src/handoff/t3.ts";
import { host as login } from "../../src/logins.ts";
import { Store } from "../../src/store.ts";
import { repos, tmp } from "./git.ts";
import { fakeT3, type FakeThread } from "./t3.ts";
import recordedTools from "./t3-tools.json";

const realGh = login.gh;

/** The inputs T3 Code's tools take, recorded from the nightly: `tools/list` serves them and a call naming another is
 * refused, so a renamed or dropped input fails here before it fails against T3. */
const TOOL_INPUTS = Object.fromEntries(
  Object.entries(recordedTools).filter(([name]) => !name.startsWith("_")),
) as Record<string, { type: "object"; properties: Record<string, Record<string, never>>; required?: string[] }>;

/** T3 Code's MCP sign-in and `/mcp`, as the nightly 0.1.7 serves them (`EnvironmentMcpOAuthHttpApi` and the
 * `AuthMcp*` schemas), mounted on a `fakeT3` through its `routes`. Pairing codes come from `pairBin`, a stand-in for
 * `t3 pair`. Access tokens have T3's shape, `<base64url claims>.<signature>`, and the nth signature is
 * `test-secret-token-<n>`, so a test can search output for it. */
export function fakeT3Mcp(fake: ReturnType<typeof fakeT3>) {
  /** This fake's own copy, so a test that drops an input plays an older T3 only for itself. */
  const inputs = structuredClone(TOOL_INPUTS);
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
  const answers = new Map<string, (args: Record<string, unknown>, session: string) => unknown>(
    Object.keys(inputs).map((tool) => [tool, () => ({ ok: true })]),
  );
  /** Launches by T3 session and `clientRequestId`: T3 finds a retried launch's thread within one session only. */
  const launches = new Map<string, string>();

  // Threads made through `/mcp` reach the shell stream with their status, the way T3's shell shows a turn.
  let sequence = 1_000_000;
  const push = (t: FakeThread, patch: { status?: string; needsYou?: boolean } = {}) => {
    const state = { status: "idle", needsYou: false, ...t.shell, ...patch };
    t.shell = state;
    t.updatedAt = new Date().toISOString();
    fake.shell.push({
      kind: "thread.updated",
      sequence: ++sequence,
      location: t.archivedAt ? "archive" : "active",
      thread: {
        id: t.id,
        projectId: t.projectId,
        title: t.title,
        status: state.status,
        pendingRuntimeRequest: state.needsYou ? { id: "request-1", kind: "user-input", createdAt: t.updatedAt } : null,
        settledOverride: t.settledOverride ?? null,
        archivedAt: t.archivedAt,
        worktreePath: t.worktreePath,
        updatedAt: t.updatedAt,
        lineage: { parentThreadId: t.parentThreadId ?? null, relationshipToParent: t.subagent ? "subagent" : null },
      },
    });
  };
  const thread = (args: Record<string, unknown>) => {
    const t = fake.threads.get(String(args.threadId));
    if (!t) throw new Error(`Thread ${String(args.threadId)} was not found.`);
    return t;
  };
  answers.set("t3_thread_launch", (args, session) => {
    // Like T3, the same clientRequestId answers with the same thread, within the MCP session that sent it.
    const request = String(args.clientRequestId ?? crypto.randomUUID());
    let id = launches.get(`${session} ${request}`);
    if (!id) {
      id = `mcp:launch:${request}`;
      for (let n = 2; fake.threads.has(id); n++) id = `mcp:launch:${request}:${n}`;
      launches.set(`${session} ${request}`, id);
      const strategy = args.workspaceStrategy as { branch?: string } | undefined;
      const t = fake.addThread({
        id,
        projectId: String(args.projectId),
        sessionId: crypto.randomUUID(),
        title: String(args.title),
        runtimeMode: String(args.runtimeMode ?? "auto"),
        branch: strategy?.branch ?? null,
        worktreePath: `/worktrees/${id}`,
      });
      if (typeof args.message === "string") t.messages.push(args.message);
      push(t, { status: args.message ? "running" : "idle" });
    }
    return { threadId: id, link: `https://t3.test/threads/${encodeURIComponent(id)}` };
  });
  answers.set("t3_thread_send", (args) => {
    const t = thread(args);
    t.messages.push(String(args.message));
    push(t, { status: "running" });
    return { ok: true };
  });
  answers.set("t3_thread_interrupt", (args) => {
    // Like T3: the call answers, and the turn stops a moment later.
    const t = thread(args);
    setTimeout(() => push(t, { status: "interrupted" }), 20);
    return { ok: true };
  });
  answers.set("t3_thread_organize", (args) => {
    const t = thread(args);
    // Like T3: a turn must end, or be stopped, before its thread settles.
    if (args.action === "settle" && t.shell?.status === "running")
      throw new Error(`Thread ${t.id} is still running. Stop it before settling.`);
    if (args.action === "settle") t.settledOverride = "settled";
    push(t);
    return { ok: true };
  });

  const api = {
    /** Tool calls that reached `/mcp`. */
    calls: [] as { tool: string; args: Record<string, unknown> }[],
    /** Replaces a tool's canned answer; a thrown error becomes a tool error, like T3's. */
    answer(tool: string, fn: (args: Record<string, unknown>) => unknown) {
      answers.set(tool, fn);
    },
    /** The tools `/mcp` lists; delete one to play an older T3. */
    tools: new Set<string>(REQUIRED_T3_TOOLS),
    /** Inputs a tool lacks, as an older T3 would: they are left out of `tools/list`, and a call naming one is refused. */
    dropInput(tool: string, input: string) {
      const schema = inputs[tool]!;
      const { [input]: _, ...rest } = schema.properties;
      inputs[tool] = { ...schema, properties: rest };
    },
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
    /** Changes a thread made through `/mcp` as its turn would: `running`, `idle` when it ends, or waiting on a person. */
    setThread(threadId: string, patch: { status?: string; needsYou?: boolean }) {
      push(thread({ threadId }), patch);
    },
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
      tools: [...api.tools].map((name) => ({ name, inputSchema: inputs[name] ?? { type: "object" as const } })),
    }));
    server.setRequestHandler("tools/call", async (request) => {
      const { name, arguments: args = {} } = request.params;
      api.calls.push({ tool: name, args });
      try {
        const known = inputs[name]?.properties;
        const unknown = known && Object.keys(args).find((key) => !(key in known));
        if (unknown) throw new Error(`${name} takes no argument ${unknown}`);
        const value = await answers.get(name)!(args, active.get(token)!);
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

/** Waits until no item has a step queued: what a report or a loop pass left to do after it answered, such as the
 * comments it posts, has run. */
export async function idle(f: FactoryRuntime) {
  while (f.locks.size) await Promise.all([...f.locks.values()]);
}

/** A `fakeT3` with `fakeT3Mcp` mounted on it. */
export function fakeT3WithMcp(options: Omit<Parameters<typeof fakeT3>[0], "routes">) {
  let mcp: ReturnType<typeof fakeT3Mcp> | undefined;
  const t3 = fakeT3({ ...options, routes: (req) => mcp?.routes(req) });
  mcp = fakeT3Mcp(t3);
  return { t3, mcp };
}

/** One git origin for the factory tests in a file: making one is ~60 ms of git, and no test changes it. A file's
 * `afterAll(removeTmp)` deletes it, so the next file makes its own. */
let shared: ReturnType<typeof repos> | undefined;
function sharedOrigin() {
  if (!shared || !existsSync(shared.origin)) shared = repos();
  return shared;
}

/**
 * The factory machine `a` on an in-memory store with fake time: connected to a `fakeT3WithMcp`, its folder loaded
 * from `folder` (factory.yaml as an object, plus other files), the mirror live, and every repository in
 * `repositories` a real git origin with no T3 project yet. `config` and `files` may be functions of the repository's
 * name. `cleanup` collects what a test's afterEach undoes.
 */
export async function factoryNode(
  cleanup: (() => unknown)[],
  folder: {
    config?: Record<string, unknown> | ((repo: string) => Record<string, unknown>);
    files?: Record<string, string> | ((repo: string) => Record<string, string>);
  } = {},
) {
  const origin = sharedOrigin();
  const repo = origin.url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const commit = Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  const realFetch = fetcher.fetch;
  const realRoot = fetcher.root;
  fetcher.root = tmp();
  const dir = join(fetcher.root, commit);
  const files = {
    "factory.yaml": JSON.stringify({
      version: 1,
      name: "acme",
      repositories: { [repo]: {} },
      ...(typeof folder.config === "function" ? folder.config(repo) : folder.config),
    }),
    "rulings.md": "# Rulings\n\n- Keep public field names.",
    ...(typeof folder.files === "function" ? folder.files(repo) : folder.files),
  };
  for (const [file, text] of Object.entries(files)) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  fetcher.fetch = async () => ({ commit, dir });

  const { t3, mcp } = fakeT3WithMcp({ claudeDir: tmp() });
  const s = new Store(":memory:");
  s.setLocal("node", "a");
  s.setLocal("adminToken", "admin-secret");
  s.setLocal("handoff:cloneDir", tmp());
  s.put("node", "a", { id: "a", protocol: 8 });
  const realT3 = host.t3;
  host.t3 = () => mcp.pairBin;
  // Every daemon context this node ran, stopped once each; a restart starts another on the same store.
  const contexts = new Set<Ctx>();
  const stop = async (ctx: Ctx) => {
    if (!contexts.delete(ctx)) return;
    ctx.abort.abort();
    ctx.skills.close();
    ctx.imports.close();
    await ctx.gateway.close();
  };
  cleanup.push(t3.stop, async () => {
    host.t3 = realT3;
    fetcher.fetch = realFetch;
    fetcher.root = realRoot;
    for (const ctx of [...contexts]) await stop(ctx);
    s.close();
  });
  let now = Date.now();
  const until = async (fn: () => unknown, what: string) => {
    const deadline = Date.now() + 3_000;
    while (!fn()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(5);
    }
  };

  /** The node's handles, bound to one daemon context. */
  const bind = async (ctx: Ctx) => {
    const f = ctx.factory;
    const command = async (name: string, ...args: string[]) => {
      const output: string[] = [];
      const code = await runCommand(f, name, args, { out: (line) => output.push(line) }).catch((e: Error) => {
        output.push(e.message);
        return 1;
      });
      return { code, output };
    };
    const mirror = mirrorOf(f);
    await until(() => mirror.status().stream === "live", "the shell stream");
    const loop = (name: string) =>
      loopTask(
        f,
        f.loops.find((l) => l.name === name)!,
      );
    const handler = app(ctx);
    const node = {
      s,
      ctx,
      f,
      t3,
      mcp,
      mirror,
      repo,
      origin,
      commit,
      command,
      until,
      advance: (ms: number) => (now += ms),
      dispatch: loop("factory-dispatch"),
      intake: loop("factory-intake"),
      /** A control API request on loopback. */
      api: (path: string, method = "GET", body?: unknown) =>
        handler.fetch(
          new Request(`http://127.0.0.1:7878${path}`, {
            method,
            headers: { host: "127.0.0.1:7878", ...(body !== undefined && { "content-type": "application/json" }) },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
          { listener: "loopback" },
        ),
      /** The daemon restarting on the same store, T3 Code and clock: a new context and factory runtime, and whatever
       * the old one held only in memory gone. Returns the node bound to the new daemon. */
      async restart() {
        await stop(ctx);
        return start();
      },
    };
    return node;
  };
  const start = () => {
    const ctx = makeCtx(s);
    contexts.add(ctx);
    return bind(ctx);
  };

  const first = makeCtx(s);
  contexts.add(first);
  await connectT3(s, { url: t3.url, token: t3.pairingToken() });
  // No test reaches GitHub: one that needs gh answers stubs it after this.
  login.gh = async () => undefined;
  cleanup.push(() => (login.gh = realGh));
  const output: string[] = [];
  const used = await runCommand(first.factory, "use", ["acme/factory", "--node", "a"], {
    out: (line) => output.push(line),
  }).catch((e: Error) => (output.push(e.message), 1));
  if (used) throw new Error(`the factory folder did not load: ${output.join("\n")}`);
  s.now = () => now;
  return bind(first);
}
