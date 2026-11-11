import {
  API_VERSION,
  factoryBoardSchema,
  statusSchema,
  type Connection,
  type DesktopStatus,
  type FactoryOps,
} from "@agentgate/protocol";
import type { ControlOps } from "@agentgate/protocol/control";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

export const native = isTauri();
export function request<T>(connection: Connection, path: string, method = "GET", body?: unknown): Promise<T> {
  if (!native) return Promise.reject(new Error("Open the Agentgate native app to connect to your setup."));
  return invoke<T>("api_request", { connection, path, method, body });
}
/** One factory operation by its name, the words after `agentgate factory`, with the input and result `FactoryOps`
 * gives it. The daemon sends it on to the machine that runs the factory when it is that machine's to run, and a
 * refusal rejects with its reason. */
export const factoryOp = <N extends keyof FactoryOps>(connection: Connection, name: N, input: FactoryOps[N]["input"]) =>
  request<FactoryOps[N]["result"]>(connection, `/factory/op/${encodeURIComponent(name)}`, "POST", input);
/** One control operation by its name, the CLI words, with the input and result `ControlOps` gives it. A refusal
 * rejects with its reason. */
export const control = <N extends keyof ControlOps>(
  connection: Connection,
  name: N,
  input: ControlOps[N]["input"],
): Promise<ControlOps[N]["result"]> =>
  request<ControlOps[N]["result"]>(connection, `/ops/${encodeURIComponent(name)}`, "POST", input);
export async function status(connection: Connection) {
  const data = await request<unknown>(connection, "/status");
  if (!data || typeof data !== "object" || !("apiVersion" in data) || data.apiVersion !== API_VERSION)
    throw new Error("This daemon uses a different API version. Update Agentgate on both machines.");
  const parsed = statusSchema.safeParse(data);
  if (!parsed.success)
    throw new Error("The daemon returned incompatible status data. Update Agentgate on both machines.");
  return parsed.data;
}
export async function factoryBoard(connection: Connection) {
  const parsed = factoryBoardSchema.safeParse(await request<unknown>(connection, "/factory"));
  if (!parsed.success)
    throw new Error("The daemon returned a factory board this app cannot read. Update Agentgate on both machines.");
  return parsed.data;
}
export const openExternal = (url: string) => openUrl(url);
/** Starts the Infisical CLI's browser login on the daemon's own machine, which then shares it with every machine. */
export const INFISICAL_SIGNIN_STARTED =
  "Finish signing in to Infisical in your browser. Every machine signs in with it once you're done.";
export async function signInToInfisical(connection: Connection) {
  const r = await request<{ url?: string; opened: boolean }>(connection, "/logins/infisical/signin", "POST");
  if (r.url && !r.opened) await openExternal(r.url);
}
/** The commands `local_action` in src-tauri/src/lib.rs runs with this machine's own CLI. */
export type LocalAction =
  "install" | "start" | "stop" | "setup" | "primary-on" | "primary-off" | "mcp-on" | "mcp-off" | "admin-token";
export const localAction = (action: LocalAction, connection: Connection) =>
  invoke<string>("local_action", { action, connection });
export const localConnection = () => invoke<Connection>("local_connection");
export const loadConnection = () => invoke<Connection>("load_connection");
export const saveConnection = (connection: Connection) => invoke<void>("save_connection", { connection });
export const backupFile = (connection: Connection, path: string, secrets: boolean) =>
  invoke<void>("export_backup", { connection, path, secrets });
export const restoreFile = (connection: Connection, path: string) =>
  invoke<{ restored: number }>("import_backup", { connection, path });
export const desktopStatus = (connection: Connection) => request<DesktopStatus>(connection, "/desktop");
