import { useCallback, useEffect, useRef, useState } from "react";
import { API_VERSION, statusSchema, type Connection, type DesktopStatus } from "@agentgate/protocol";

/** False in a plain browser tab, where there is no backend to reach the daemon through. */
export const native = typeof tiny !== "undefined";

/** A thrown value as text for the user: the message of an Error, otherwise the value. */
export const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error: /, "");

/** Calls a method of the backend (src/main.ts); a failure rejects with its message. */
const call = <T>(method: string, params?: unknown) =>
  tiny.api.call(method, params).catch((e: unknown) => {
    throw new Error(messageOf(e));
  }) as Promise<T>;

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
  return call<T>("api_request", { connection, path, method, body });
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
/** Opens a web page in the browser. Only http(s): the URL can come from a remote daemon. */
export const openExternal = async (url: string) => {
  if (!/^https?:\/\//i.test(url)) throw new Error("Only web links can be opened");
  await tiny.app.shell.open(url);
};
export const localAction = (action: string, connection: Connection) =>
  call<string>("local_action", { action, connection });
export const localConnection = () => call<Connection>("local_connection");
export const loadConnection = () => call<Connection>("load_connection");
export const saveConnection = (connection: Connection) =>
  call<void>("save_connection", { connection });
export const backupFile = (
  connection: Connection,
  path: string,
  secrets: boolean,
) => call<void>("export_backup", { connection, path, secrets });
export const restoreFile = (connection: Connection, path: string) =>
  call<{ restored: number }>("import_backup", { connection, path });
export const desktopStatus = (connection: Connection) =>
  request<DesktopStatus>(connection, "/desktop");

/** Asks before something that cannot be undone, as a native alert; window.confirm in a browser. */
export const confirmDialog = (message: string, { okLabel = "OK" }: { okLabel?: string } = {}) =>
  native ? tiny.dialog.confirm(message, { ok: okLabel }) : Promise.resolve(window.confirm(message));

/** The running app's version, or "" until it is known. */
export function useAppVersion() {
  const [version, setVersion] = useState("");
  useEffect(() => {
    if (native) void tiny.app.info().then((i) => setVersion(i.version), () => {});
  }, []);
  return version;
}

/** Four hours: the app is left open for days at a time. */
const UPDATE_INTERVAL = 4 * 60 * 60 * 1000;

/**
 * Checks for a newer release on launch and every four hours, and holds the one on offer. Nothing
 * downloads until `install`, which verifies the archive's sha256 and that it is signed by the same
 * Apple team, swaps the app and relaunches. Only a packaged app can update itself.
 */
export function useAppUpdate() {
  const [update, setUpdate] = useState<{ version: string } | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    if (!native) return;
    let stopped = false;
    const check = () =>
      tiny.api.call("update.check").then((r) => {
        const found = r as { available?: boolean; latest?: string };
        if (!stopped && found.available && found.latest) setUpdate({ version: found.latest });
      }, () => {});
    let timer: ReturnType<typeof setInterval> | undefined;
    void call<boolean>("packaged").then((packaged) => {
      if (!packaged || stopped) return;
      void check();
      timer = setInterval(check, UPDATE_INTERVAL);
    });
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  /** Rejects if the download or install fails. A call while one is under way does nothing. */
  const install = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      await call("update.install");
    } finally {
      busy.current = false;
    }
  }, []);
  const dismiss = useCallback(() => setUpdate(null), []);
  return { update, install, dismiss };
}
