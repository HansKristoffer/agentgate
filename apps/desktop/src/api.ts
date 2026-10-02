import { API_VERSION, statusSchema, type Connection } from "@agentgate/protocol";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

export const native = isTauri();
export function request<T>(
  connection: Connection,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  if (!native)
    return Promise.reject(
      new Error("Open the Agentgate native app to connect to your setup."),
    );
  return invoke<T>("api_request", { connection, path, method, body });
}
export async function status(connection: Connection) {
  const data = await request<unknown>(connection, "/status");
  if (!data || typeof data !== "object" || !("apiVersion" in data) || data.apiVersion !== API_VERSION)
    throw new Error(
      "This daemon uses a different API version. Update Agentgate on both machines.",
    );
  const parsed = statusSchema.safeParse(data);
  if (!parsed.success) throw new Error("The daemon returned incompatible status data. Update Agentgate on both machines.");
  return parsed.data;
}
export const openExternal = (url: string) => openUrl(url);
export const localAction = (action: string, connection: Connection) =>
  invoke<string>("local_action", { action, connection });
export const localConnection = () => invoke<Connection>("local_connection");
export const loadConnection = () => invoke<Connection>("load_connection");
export const saveConnection = (connection: Connection) =>
  invoke<void>("save_connection", { connection });
export const backupFile = (
  connection: Connection,
  path: string,
  secrets: boolean,
) => invoke<void>("export_backup", { connection, path, secrets });
export const restoreFile = (connection: Connection, path: string) =>
  invoke<{ restored: number }>("import_backup", { connection, path });
