// The app's backend. tinyjs runs it on txiki.js beside the window; the page reaches each `api`
// method through tiny.api.call. All daemon HTTP goes through here, never the page.
import type { Connection } from "@agentgate/protocol";

const encoder = new TextEncoder();
const exeDir = tjs.exePath.replace(/\/[^/]*$/, "");
// A packaged app runs tjs from Agentgate.app/Contents/MacOS, beside the daemon the build puts
// there. `tinyjs dev` runs its shared tjs in apps/desktop, where scripts/desktop-prepare.ts
// compiles the daemon into binaries/.
const packaged = exeDir.endsWith(".app/Contents/MacOS");
const bundled = packaged ? `${exeDir}/agentgate` : `${tjs.cwd}/binaries/agentgate`;

export const defaultConnection = (): Connection => ({
  url: `http://127.0.0.1:${tjs.env.AGENTGATE_PORT ?? "7878"}`,
});

const port = (url: URL) => url.port || (url.protocol === "https:" ? "443" : "80");

export function requireLocal(connection: Connection) {
  const url = endpoint(connection, "/status");
  const own = endpoint(defaultConnection(), "/status");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || port(url) !== port(own))
    throw new Error("Connect to this app's local daemon before managing its service or coding-tool settings");
}

export function endpoint(connection: Connection, path: string) {
  let url: URL;
  try {
    url = new URL(connection.url);
  } catch {
    throw new Error("Enter a valid daemon URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    /[?#]/.test(connection.url)
  )
    throw new Error("Use a daemon origin such as http://127.0.0.1:7878");
  if (!path.startsWith("/") || path.startsWith("//") || /[#\\]/.test(path)) throw new Error("Invalid API path");
  const [pathname = "", query] = path.split(/\?(.*)/s);
  if (pathname.split("/").some((p) => p === ".." || p === "." || p.toLowerCase().includes("%2e")))
    throw new Error("Invalid API path");
  const target = new URL(`/api${pathname}`, url.origin);
  if (query !== undefined) target.search = query;
  return target;
}

// The request goes through curl rather than fetch: txiki's fetch always sends an Origin header,
// which the daemon refuses as a browser. curl reads the token from a private config file, never
// from its arguments, and follows no redirects, so the token never reaches another host.
async function send(connection: Connection, path: string, method: string, body?: unknown) {
  const url = endpoint(connection, path);
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("Unsupported method");
  if (/[\0-\x1f\x7f]/.test(connection.token ?? "")) throw new Error("The admin token contains invalid characters");
  const quote = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;
  const dir = await tjs.makeTempDir(`${tjs.tmpDir}/agentgate-XXXXXX`);
  let out: Awaited<ReturnType<typeof exec>>;
  try {
    const config = [`url = ${quote(url.href)}`, `request = ${quote(method)}`];
    if (connection.token) config.push(`header = ${quote(`Authorization: Bearer ${connection.token}`)}`);
    if (body !== undefined) {
      await privateWrite(`${dir}/body.json`, encoder.encode(JSON.stringify(body)));
      config.push(`header = "Content-Type: application/json"`, `data-binary = ${quote(`@${dir}/body.json`)}`);
    }
    await privateWrite(`${dir}/config`, encoder.encode(`${config.join("\n")}\n`));
    out = await exec(
      ["curl", "--silent", "--proto", "=http,https", "--connect-timeout", "5", "--max-time", "120",
        "--write-out", "\\n%{http_code}", "--config", `${dir}/config`],
      130_000,
    );
  } finally {
    await tjs.remove(dir, { recursive: true }).catch(() => {});
  }
  if (!out.ok) throw new Error("Cannot reach the daemon. Start its service and check the connection address.");
  const split = out.stdout.lastIndexOf("\n");
  const status = Number(out.stdout.slice(split + 1));
  let result: unknown;
  try {
    result = JSON.parse(out.stdout.slice(0, split));
  } catch {
    throw new Error("The daemon did not return JSON. Check the address and Agentgate version.");
  }
  if (status < 200 || status > 299) {
    const error = result && typeof result === "object" && "error" in result ? result.error : undefined;
    throw new Error(typeof error === "string" ? error : "The daemon rejected the request");
  }
  return result;
}

/** Writes a file only this user can read, replacing any old one in a single step. */
export async function privateWrite(path: string, data: Uint8Array) {
  const temp = path.replace(/(\.[^./]*)?$/, ".tmp");
  try {
    const file = await tjs.open(temp, "wx", 0o600);
    try {
      await file.write(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await tjs.rename(temp, path);
  } catch (e) {
    await tjs.remove(temp).catch(() => {});
    throw e;
  }
}

// Where Tauri kept it, so the connection saved by earlier versions carries over.
function connectionFile() {
  const dir = /^Mac/.test(navigator.platform)
    ? `${tjs.homeDir}/Library/Application Support/dev.agentgate.desktop`
    : `${tjs.env.XDG_CONFIG_HOME ?? `${tjs.homeDir}/.config`}/dev.agentgate.desktop`;
  // `bun run dev` shares the installed app's config dir; keep its saved connection separate.
  return { dir, file: `${dir}/${tjs.env.AGENTGATE_DEV === "1" ? "connection.dev.json" : "connection.json"}` };
}

const configHome = () => tjs.env.AGENTGATE_HOME ?? `${tjs.homeDir}/.config/agentgate`;

async function installBinary() {
  const dir = `${configHome()}/bin`;
  await tjs.makeDir(dir, { recursive: true });
  const target = `${dir}/agentgate`;
  const temp = `${dir}/agentgate-${Date.now()}.tmp`;
  try {
    await tjs.copyFile(bundled, temp);
    await tjs.chmod(temp, 0o755);
    await tjs.rename(temp, target);
  } catch (e) {
    await tjs.remove(temp).catch(() => {});
    throw new Error(`Bundled daemon could not be installed: ${e instanceof Error ? e.message : e}`);
  }
  return target;
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

async function exec(args: string[], timeout: number, env = tjs.env) {
  const child = tjs.spawn(args, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeout);
  const [stdout, stderr, status] = await Promise.all([readAll(child.stdout), readAll(child.stderr), child.wait()]);
  clearTimeout(timer);
  return { ok: !timedOut && status.exit_status === 0 && !status.term_signal, timedOut, stdout, stderr };
}

async function runCli(binary: string, args: string[]) {
  const home = tjs.homeDir;
  const path = [
    `${configHome()}/bin`,
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    `${home}/.cargo/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    tjs.env.PATH,
  ]
    .filter(Boolean)
    .join(":");
  const out = await exec([binary, ...args], 60_000, { ...tjs.env, PATH: path });
  if (out.timedOut) throw new Error("The command timed out; check Agentgate service logs");
  if (!out.ok) throw new Error(out.stderr.trim());
  return out.stdout.trim();
}

const actions: Record<string, string[]> = {
  install: ["service", "install"],
  start: ["service", "start"],
  stop: ["service", "stop"],
  setup: ["setup"],
  "primary-on": ["setup", "--primary"],
  "primary-off": ["setup", "--primary", "off"],
  "mcp-on": ["setup", "--mcp"],
  "mcp-off": ["setup", "--mcp", "off"],
  "admin-token": ["admin-token"],
};

const readJson = async (path: string) => JSON.parse(new TextDecoder().decode(await tjs.readFile(path)));

export const api = {
  packaged: async () => packaged,
  api_request: ({ connection, path, method, body }: { connection: Connection; path: string; method: string; body?: unknown }) =>
    send(connection, path, method, body),
  local_connection: async () => defaultConnection(),
  async load_connection() {
    try {
      return (await readJson(connectionFile().file)) as Connection;
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return defaultConnection();
      throw new Error("Connection settings could not be read");
    }
  },
  async save_connection({ connection }: { connection: Connection }) {
    endpoint(connection, "/status");
    const { dir, file } = connectionFile();
    await tjs.makeDir(dir, { recursive: true });
    await privateWrite(file, encoder.encode(JSON.stringify({ url: connection.url, token: connection.token || undefined })));
  },
  async local_action({ action, connection }: { action: string; connection: Connection }) {
    requireLocal(connection);
    const args = Object.hasOwn(actions, action) ? actions[action] : undefined;
    if (!args) throw new Error("Unknown local action");
    // Services and generated MCP shims point outside the app bundle, so quitting or
    // removing the control app leaves Agentgate running and its CLI usable.
    const binary = await installBinary();
    if (action === "install") await runCli(binary, ["init"]);
    return runCli(binary, args);
  },
  async export_backup({ connection, path, secrets }: { connection: Connection; path: string; secrets: boolean }) {
    const data = await send(connection, `/backup?secrets=${secrets}`, "GET");
    await privateWrite(path, encoder.encode(JSON.stringify(data, null, 2)));
  },
  async import_backup({ connection, path }: { connection: Connection; path: string }) {
    const bytes = await tjs.readFile(path);
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("Choose a valid Agentgate JSON backup");
    }
    if (encoder.encode(JSON.stringify(data)).length > 16 * 1024 * 1024)
      throw new Error("This backup exceeds the app's 16 MiB restore limit. Use agentgate import <backup-file> on the daemon's machine.");
    return send(connection, "/backup", "POST", data);
  },
};

/**
 * An app update replaces the bundled daemon but not the copy the service runs.
 * When the service runs that copy and it differs, install the new one and restart.
 */
async function refreshDaemon() {
  const installed = `${configHome()}/bin/agentgate`;
  let service: string;
  try {
    service = new TextDecoder().decode(await tjs.readFile(`${tjs.homeDir}/Library/LaunchAgents/dev.agentgate.plist`));
  } catch {
    return;
  }
  if (!service.includes(installed)) return;
  const fresh = await tjs.readFile(bundled);
  const current = await tjs.readFile(installed).catch(() => undefined);
  if (current && current.length === fresh.length && current.every((b, i) => b === fresh[i])) return;
  await runCli(await installBinary(), ["service", "install"]);
}

export function init() {
  // A dev run would push a dev daemon into the real service.
  if (packaged) refreshDaemon().catch((e) => console.error(`Could not refresh the Agentgate service: ${e instanceof Error ? e.message : e}`));
}
