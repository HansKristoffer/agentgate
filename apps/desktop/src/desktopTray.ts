import { useEffect, useRef } from "react";
import type { DesktopLogin, DesktopStatus, Status } from "@agentgate/protocol";
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { tightest } from "./views/ClaudeDesktop.tsx";

const name = (l: { label?: string; email?: string; accountUuid: string }) => l.label ?? l.email ?? l.accountUuid.slice(0, 8);
const pct = (data: Status, accountId?: string) => {
  const w = tightest(data.accounts.find((a) => a.account.id === accountId));
  return w ? `${Math.round(w.usedPct)}%` : "";
};

async function showApp() {
  const w = getCurrentWindow();
  await w.unminimize(); await w.show(); await w.setFocus();
}

/** A menu bar item for people who mostly live in Claude Desktop: which account it uses, and switching without opening Agentgate. */
export function useDesktopTray(data: Status | undefined, desktop: DesktopStatus | undefined, use: (l: DesktopLogin) => void, pool: (on: boolean) => void) {
  const tray = useRef<Promise<TrayIcon> | undefined>(undefined);
  const shown = useRef("");
  const handlers = useRef({ use, pool });
  handlers.current = { use, pool };
  const wanted = !!data && !!desktop?.available && (desktop.logins.length > 0 || desktop.mode === "pool");

  useEffect(() => {
    if (!wanted) {
      if (tray.current) void tray.current.then((t) => t.close()).catch(() => { });
      tray.current = undefined; shown.current = "";
      return;
    }
    const current = desktop!.mode === "signed-in" ? desktop!.current : undefined;
    const title = desktop!.mode === "pool" ? "✳ Shared" : current ? `✳ ${name(current)} ${pct(data!, current.accountId)}`.trim() : "✳";
    const usable = desktop!.logins.filter((l) => !l.expired && !l.problem);
    const key = JSON.stringify([title, desktop!.mode, current?.accountUuid, usable.map((l) => [l.accountUuid, name(l), pct(data!, l.accountId)])]);
    if (key === shown.current) return;
    shown.current = key;
    void (async () => {
      const items = [
        await MenuItem.new({ text: desktop!.mode === "pool" ? "Claude Desktop shares your subscriptions" : "Claude Desktop account", enabled: false }),
        ...(await Promise.all(usable.map((l) => CheckMenuItem.new({
          text: `${name(l)}${pct(data!, l.accountId) ? `  ${pct(data!, l.accountId)}` : ""}`,
          checked: desktop!.mode === "signed-in" && current?.accountUuid === l.accountUuid,
          action: () => handlers.current.use(l),
        })))),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await MenuItem.new({
          text: desktop!.mode === "pool" ? "Use my own sign-in in Claude Desktop" : "Share subscriptions automatically (Code tab)",
          action: () => handlers.current.pool(desktop!.mode !== "pool"),
        }),
        await MenuItem.new({ text: "Open Agentgate", action: () => void showApp() }),
      ];
      const menu = await Menu.new({ items });
      tray.current ??= TrayIcon.new({ id: "agentgate-desktop", tooltip: "Agentgate: Claude Desktop", menuOnLeftClick: true });
      const t = await tray.current;
      await t.setTitle(title);
      await t.setMenu(menu);
    })().catch(() => { shown.current = ""; });
  }, [wanted, data, desktop]);

  useEffect(() => () => { void tray.current?.then((t) => t.close()).catch(() => { }); }, []);
}

const sent = () => new Set<string>(JSON.parse(localStorage.getItem("desktopNotified") ?? "[]"));
async function notify(key: string, title: string, body: string) {
  const seen = sent();
  if (seen.has(key)) return;
  if (!(await isPermissionGranted()) && (await requestPermission()) !== "granted") return;
  sendNotification({ title, body });
  localStorage.setItem("desktopNotified", JSON.stringify([...seen, key].slice(-50)));
}

/** System notifications for things a Claude Desktop user should act on even with Agentgate closed to the menu bar. */
export function useDesktopNotifications(data: Status | undefined, desktop: DesktopStatus | undefined, daemonDown: boolean) {
  const lastMode = useRef<DesktopStatus["mode"]>(undefined);
  if (desktop) lastMode.current = desktop.mode;
  useEffect(() => {
    if (daemonDown && lastMode.current === "pool")
      void notify(`pool-down:${new Date().toDateString()}`, "Claude Desktop can't reach your subscriptions",
        "Its Code tab shares your subscriptions through Agentgate, which isn't running. Start Agentgate, or switch Claude Desktop back to your own sign-in.");
  }, [daemonDown]);
  useEffect(() => {
    if (!data || !desktop?.available) return;
    const current = desktop.mode === "signed-in" ? desktop.current : undefined;
    const account = data.accounts.find((a) => a.account.id === current?.accountId);
    if (current && account && (account.exhausted || (tightest(account)?.usedPct ?? 0) >= 100)) {
      const until = account.exhaustedUntil ?? tightest(account)?.resetsAt;
      const other = desktop.logins.find((l) => l.accountUuid !== current.accountUuid && !l.expired && !l.problem && !data.accounts.find((a) => a.account.id === l.accountId)?.exhausted);
      void notify(`limit:${current.accountUuid}:${until ?? ""}`, `${name(current)} has reached its limit`,
        `${until ? `It resets ${new Date(until).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}. ` : ""}${other ? `Switch Claude Desktop to ${name(other)} from the menu bar or in Agentgate.` : "Add or connect another account in Agentgate to keep going."}`);
    }
    for (const l of desktop.logins) {
      const days = l.sessionExpiresAt ? (l.sessionExpiresAt - Date.now()) / 86_400_000 : Infinity;
      if (l.accountUuid !== current?.accountUuid && days > 0 && days <= 3)
        void notify(`expiry:${l.accountUuid}:${l.sessionExpiresAt}`, `${name(l)} will disconnect from Claude Desktop soon`,
          `Use it in Claude Desktop once in the next ${Math.ceil(days)} day${days > 1 ? "s" : ""} to keep it connected.`);
    }
  }, [data, desktop]);
}
