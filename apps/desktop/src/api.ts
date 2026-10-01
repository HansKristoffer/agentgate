import { API_VERSION, type Connection, type Status } from "@agentgate/protocol";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

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
  const data = await request<Status>(connection, "/status");
  if (data.apiVersion !== API_VERSION)
    throw new Error(
      "This daemon uses a different API version. Update Agentgate on both machines.",
    );
  return data;
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
/** A signed build newer than this one; the pubkey in tauri.conf.json refuses anything else. */
export async function checkForUpdate() {
  const update = await check();
  return (
    update && {
      version: update.version,
      install: async () => {
        await update.downloadAndInstall();
        await relaunch();
      },
    }
  );
}
