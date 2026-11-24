import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getErrorMessage } from "hanzio";
import { Hono } from "hono";
import { MiB } from "@agentgate/protocol/relay";
import { relayCall } from "./channel.ts";
import type { Ctx, Env } from "./daemon.ts";
import { transport } from "./handoff/jobs.ts";
import { fetchHeaders, killGroup, MAX_BODY, readBody } from "./runtime.ts";
import { peers } from "./sync.ts";

/**
 * Proxies the standalone skill-factory web app (http://127.0.0.1:4400 by default) so the desktop app can embed it
 * natively for any machine in the user's Tailscale or relay group. Only client-safe routes are forwarded; CLI-only
 * routes (/api/issue/*, /api/runs/*, /api/shutdown, /mcp) are refused.
 */

const DEFAULT_FACTORY_PORT = 4400;
const MAX_RESPONSE_BYTES = 16 * MiB;
const DEFAULT_TIMEOUT_MS = 30_000;
const CHANGES_TIMEOUT_MS = 40_000;

export function factoryPort(): number {
  const raw = process.env.FACTORY_PORT;
  if (!raw) return DEFAULT_FACTORY_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return DEFAULT_FACTORY_PORT;
  return port;
}

export const factoryBaseUrl = () => `http://127.0.0.1:${factoryPort()}`;

const RELOAD_HEALTH_MS = 2000;
const RELOAD_TIMEOUT_MS = 25_000;

function findBun(): string | undefined {
  const onPath = Bun.which("bun");
  if (onPath) return onPath;
  if (!Bun.main.startsWith("/$bunfs/")) return process.execPath;
  const homeBun = join(homedir(), ".bun", "bin", "bun");
  return existsSync(homeBun) ? homeBun : undefined;
}

const realpathOrSame = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Reloads a running local skill-factory service after agentgate syncs updated files for the `factory` skill.
 * Does nothing when factory is not running on this machine, or when the running service comes from another checkout.
 * Delegates the stop/restart handshake to the synced `app/cli.ts` (`ensureServer`), which handles both persistent
 * systemd/launchd services and transient units.
 */
export async function reloadFactoryService(
  skillDir: string,
  baseUrl: string,
  daemonSignal: AbortSignal,
  options: { bun?: string; timeoutMs?: number } = {},
): Promise<"reloaded" | "skipped"> {
  const appDir = join(skillDir, "app");
  const cli = join(appDir, "cli.ts");
  if (!existsSync(cli)) return "skipped";

  let runningAppDir: string | undefined;
  try {
    const res = await fetchHeaders(`${baseUrl}/health`, { signal: daemonSignal }, RELOAD_HEALTH_MS);
    if (!res.ok) {
      await res.body?.cancel();
      return "skipped";
    }
    const body = (await res.json()) as { appDir?: unknown };
    if (typeof body.appDir === "string") runningAppDir = body.appDir;
  } catch {
    // Factory is not running on this machine; never start it unasked.
    return "skipped";
  }

  if (runningAppDir && realpathOrSame(runningAppDir) !== realpathOrSame(appDir)) {
    return "skipped";
  }

  const bun = options.bun ?? findBun();
  if (!bun) return "skipped";

  const port = new URL(baseUrl).port || String(DEFAULT_FACTORY_PORT);
  const timeoutMs = options.timeoutMs ?? RELOAD_TIMEOUT_MS;
  const child = Bun.spawn([bun, cli, "board"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
    env: { ...process.env, FACTORY_PORT: port },
  });

  let timedOut = false;
  const stop = () => killGroup(child);
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  daemonSignal.addEventListener("abort", stop, { once: true });
  try {
    const code = await child.exited;
    if (daemonSignal.aborted) return "skipped";
    if (timedOut) throw new Error(`factory reload timed out after ${timeoutMs} ms`);
    if (code !== 0) throw new Error(`factory reload exited with code ${code}`);
    return "reloaded";
  } finally {
    clearTimeout(timer);
    daemonSignal.removeEventListener("abort", stop);
  }
}

/** Allowlist of browser/app routes on the factory service. Blocks CLI-only and shutdown routes. */
export function allowedFactoryPath(method: string, pathname: string): boolean {
  if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.includes("\\")) return false;
  if (pathname.split("/").some((p) => p === ".." || p === "." || p.toLowerCase().includes("%2e"))) return false;

  if (method === "GET") {
    if (
      pathname === "/" ||
      pathname === "/health" ||
      pathname === "/api/board" ||
      pathname === "/api/changes" ||
      pathname === "/api/settings" ||
      pathname === "/api/history" ||
      pathname === "/api/intake" ||
      pathname === "/api/intake/linear/teams" ||
      pathname === "/api/mcp" ||
      pathname === "/api/webhook"
    ) {
      return true;
    }
    if (/^\/api\/issues\/[^/]+(\/preview)?$/.test(pathname)) return true;
    if (/^\/api\/intake\/sources\/[^/]+\/items$/.test(pathname)) return true;
    if (pathname.startsWith("/evidence/") || pathname.startsWith("/overview/")) return true;
    return false;
  }

  if (method === "POST") {
    if (pathname === "/api/threads" || pathname === "/api/github/fetch" || pathname === "/api/webhook/test") {
      return true;
    }
    if (pathname === "/api/intake/sources") return true;
    if (/^\/api\/intake\/sources\/[^/]+\/start$/.test(pathname)) return true;
    if (/^\/api\/issues\/[^/]+\/(answers|message|drop|preview|deliver)$/.test(pathname)) return true;
    return false;
  }

  if (method === "PUT") {
    if (pathname === "/api/intake/linear" || pathname === "/api/webhook") return true;
    if (/^\/api\/intake\/sources\/[^/]+$/.test(pathname)) return true;
    if (pathname.startsWith("/api/settings/") && pathname.length > "/api/settings/".length) return true;
    return false;
  }

  if (method === "DELETE") {
    if (pathname === "/api/intake/linear") return true;
    if (/^\/api\/intake\/sources\/[^/]+$/.test(pathname)) return true;
    return false;
  }

  return false;
}

const timeoutFor = (pathname: string) => (pathname === "/api/changes" ? CHANGES_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const COMPRESSIBLE_RE = /^(text\/|application\/(json|javascript|xml)|image\/svg\+xml)/i;
const acceptsGzip = (req: Request) => /\bgzip\b/i.test(req.headers.get("accept-encoding") ?? "");
const isCompressible = (ct: string | null) => !!ct && COMPRESSIBLE_RE.test(ct.split(";")[0]!.trim());

function buildProxiedResponse(req: Request, status: number, payload: Uint8Array, upstream: Response): Response {
  const etag = upstream.headers.get("etag");
  const headers = new Headers({ "cache-control": etag || status === 304 ? "no-cache" : "no-store" });
  const ct = upstream.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  const csp = upstream.headers.get("content-security-policy");
  if (csp) headers.set("content-security-policy", csp);
  if (etag) headers.set("etag", etag);

  if (status === 304 || status === 204) {
    if (etag) headers.set("vary", "accept-encoding");
    return new Response(null, { status, headers });
  }

  if (acceptsGzip(req) && payload.byteLength >= 1024 && isCompressible(ct)) {
    headers.set("content-encoding", "gzip");
    headers.set("vary", "accept-encoding");
    const input =
      payload.buffer instanceof ArrayBuffer
        ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
        : new Uint8Array(payload);
    return new Response(Bun.gzipSync(input, { level: payload.byteLength >= 8192 ? 4 : 1 }), { status, headers });
  }
  if (isCompressible(ct)) headers.set("vary", "accept-encoding");
  return new Response(payload, { status, headers });
}

/** Forwards one validated request to this machine's local factory service. */
export async function proxyLocalFactory(
  req: Request,
  pathAndQuery: string,
  baseUrl: string,
  daemonSignal: AbortSignal,
): Promise<Response> {
  const normalized = pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`;
  const parsed = new URL(normalized, "http://127.0.0.1");
  if (!allowedFactoryPath(req.method, parsed.pathname)) {
    return jsonError(403, `Factory proxy refused ${req.method} ${parsed.pathname}`);
  }
  const timeout = timeoutFor(parsed.pathname);
  const signal = AbortSignal.any([req.signal, daemonSignal, AbortSignal.timeout(timeout)]);

  let body: Uint8Array | undefined;
  const contentType = req.headers.get("content-type");
  const ifNoneMatch = req.headers.get("if-none-match");
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await readBody(req.body, MAX_BODY, signal);
  }

  const upstreamHeaders: Record<string, string> = {};
  if (contentType) upstreamHeaders["content-type"] = contentType;
  if (ifNoneMatch) upstreamHeaders["if-none-match"] = ifNoneMatch;

  let res: Response;
  try {
    res = await fetchHeaders(
      `${baseUrl}${parsed.pathname}${parsed.search}`,
      {
        method: req.method,
        redirect: "manual",
        signal,
        headers: upstreamHeaders,
        ...(body && { body }),
      },
      timeout,
    );
  } catch {
    const port = new URL(baseUrl).port || String(DEFAULT_FACTORY_PORT);
    return jsonError(503, `Factory is not running on this machine (expected on port ${port})`);
  }

  let payload: Uint8Array;
  try {
    payload = await readBody(res.body, MAX_RESPONSE_BYTES, signal);
  } catch {
    return jsonError(502, "Factory response ended early or exceeded the proxy limit");
  }
  return buildProxiedResponse(req, res.status, payload, res);
}

function subPathOf(reqUrl: string, mountPrefix: string): string {
  const url = new URL(reqUrl);
  const rest = url.pathname.startsWith(mountPrefix) ? url.pathname.slice(mountPrefix.length) : url.pathname;
  const clean = rest.startsWith("/") ? rest : `/${rest}`;
  return `${clean}${url.search}`;
}

/** Mounted on `/peer/factory-proxy` (both Tailscale peer routes and encrypted relay channel). */
export function factoryPeerRoutes(baseUrl: string, daemonSignal: AbortSignal) {
  const app = new Hono();
  const handle = (req: Request) => {
    const url = new URL(req.url);
    const prefix = url.pathname.startsWith("/peer/factory-proxy") ? "/peer/factory-proxy" : "/factory-proxy";
    return proxyLocalFactory(req, subPathOf(req.url, prefix), baseUrl, daemonSignal);
  };
  app.all("/", (c) => handle(c.req.raw));
  app.all("/*", (c) => handle(c.req.raw));
  return app;
}

/** Hono's default 404 body: the peer's daemon has no `/factory-proxy` route, so it runs a version from before 0.37.0. */
const NO_ROUTE = "404 Not Found";

/** Copies a peer's answer, replacing a missing route with an error that names the fix instead of a plain-text 404. */
async function fromPeer(req: Request, ctx: Ctx, node: string, res: Response, signal: AbortSignal): Promise<Response> {
  const bytes = await readBody(res.body, MAX_RESPONSE_BYTES, signal);
  if (res.status === 404 && new TextDecoder().decode(bytes) === NO_ROUTE) {
    const version = ctx.s.get("node", node)?.version;
    return jsonError(
      502,
      `${node} runs Agentgate ${version ?? "from before 0.37.0"}, which cannot show its Factory. Update it with \`agentgate update ${node}\`.`,
    );
  }
  return buildProxiedResponse(req, res.status, bytes, res);
}

/** Mounted on `/api/factory-proxy` in the daemon's control API. Routes local or remote via Tailscale/relay. */
export function factoryProxyApi(ctx: Ctx) {
  const app = new Hono<Env>();

  const forward = async (req: Request, rawNode: string) => {
    let node: string;
    try {
      node = decodeURIComponent(rawNode);
    } catch {
      return jsonError(400, "Invalid machine name");
    }
    const prefix = `/api/factory-proxy/${rawNode}`;
    const pathAndQuery = subPathOf(req.url, prefix);
    const parsed = new URL(pathAndQuery, "http://127.0.0.1");

    if (!allowedFactoryPath(req.method, parsed.pathname)) {
      return jsonError(403, `Factory proxy refused ${req.method} ${parsed.pathname}`);
    }

    if (node === ctx.s.nodeId) {
      return proxyLocalFactory(req, pathAndQuery, ctx.factoryUrl, ctx.abort.signal);
    }

    const timeout = timeoutFor(parsed.pathname);
    const signal = AbortSignal.any([req.signal, ctx.abort.signal, AbortSignal.timeout(timeout)]);
    const contentType = req.headers.get("content-type") ?? undefined;
    const ifNoneMatch = req.headers.get("if-none-match") ?? undefined;
    const body = req.method !== "GET" && req.method !== "HEAD" ? await readBody(req.body, MAX_BODY, signal) : undefined;
    const peerPath = `/factory-proxy${parsed.pathname}${parsed.search}`;

    const direct = peers(ctx.s).find((p) => p.node === node);
    if (direct) {
      let res: Response;
      try {
        res = await fetchHeaders(
          `${direct.url}/peer${peerPath}`,
          {
            method: req.method,
            redirect: "manual",
            signal,
            headers: {
              authorization: `Bearer ${direct.token}`,
              "accept-encoding": "gzip",
              ...(contentType && { "content-type": contentType }),
              ...(ifNoneMatch && { "if-none-match": ifNoneMatch }),
            },
            ...(body && { body }),
          },
          timeout,
        );
      } catch {
        return jsonError(503, `${node} is not reachable`);
      }
      return fromPeer(req, ctx, node, res, signal);
    }

    if (transport(ctx.s, node) === "relay") {
      try {
        const res = await relayCall(ctx.s, node, peerPath, {
          method: req.method,
          body,
          type: contentType,
          timeout,
        });
        return await fromPeer(req, ctx, node, res, signal);
      } catch (error) {
        const status =
          error &&
          typeof error === "object" &&
          "status" in error &&
          typeof error.status === "number" &&
          error.status >= 400
            ? error.status
            : 503;
        return jsonError(status, getErrorMessage(error));
      }
    }

    return jsonError(404, `${node} is not paired with ${ctx.s.nodeId} over Tailscale or a relay`);
  };

  app.all("/:node", (c) => forward(c.req.raw, c.req.param("node")));
  app.all("/:node/*", (c) => forward(c.req.raw, c.req.param("node")));
  return app;
}
