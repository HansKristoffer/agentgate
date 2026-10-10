import { useEffect, useRef } from "react";
import type { DesktopLogin, DesktopStatus, Status } from "@agentgate/protocol";
import { native } from "./api.ts";
import { tightest } from "./views/ClaudeDesktop.tsx";

const name = (l: { label?: string; email?: string; accountUuid: string }) => l.label ?? l.email ?? l.accountUuid.slice(0, 8);
const pct = (data: Status, accountId?: string) => {
  const w = tightest(data.accounts.find((a) => a.account.id === accountId));
  return w ? `${Math.round(w.usedPct)}%` : "";
};

// Menu clicks arrive by item id. tiny.tray.on has no way to unsubscribe, so one listener is
// registered for the app's lifetime and reads the menu the latest render built.
let clicks: Record<string, () => void> = {};
let listening = false;

/** A menu bar item for people who mostly live in Claude Desktop: which account it uses, and switching without opening Agentgate. */
export function useDesktopTray(data: Status | undefined, desktop: DesktopStatus | undefined, use: (l: DesktopLogin) => void, pool: (on: boolean) => void) {
  const shown = useRef(false);
  const key = useRef("");
  const handlers = useRef({ use, pool });
  handlers.current = { use, pool };
  const wanted = native && !!data && !!desktop?.available && (desktop.logins.length > 0 || desktop.mode === "pool");

  useEffect(() => {
    if (!wanted) {
      if (shown.current) void tiny.tray.remove().catch(() => { });
      shown.current = false; key.current = "";
      return;
    }
    const current = desktop!.mode === "signed-in" ? desktop!.current : undefined;
    const title = desktop!.mode === "pool" ? "✳ Shared" : current ? `✳ ${name(current)} ${pct(data!, current.accountId)}`.trim() : "✳";
    const usable = desktop!.logins.filter((l) => !l.expired && !l.problem);
    const next = JSON.stringify([title, desktop!.mode, current?.accountUuid, usable.map((l) => [l.accountUuid, name(l), pct(data!, l.accountId)])]);
    if (next === key.current) return;
    key.current = next;
    clicks = {
      pool: () => handlers.current.pool(desktop!.mode !== "pool"),
      open: () => void tiny.win.restore().then(() => tiny.win.show()),
      ...Object.fromEntries(usable.map((l) => [`use:${l.accountUuid}`, () => handlers.current.use(l)])),
    };
    if (!listening) {
      listening = true;
      tiny.tray.on((id) => clicks[id]?.());
    }
    shown.current = true;
    void tiny.tray.set({
      title,
      tooltip: "Agentgate: Claude Desktop",
      menu: [
        { label: desktop!.mode === "pool" ? "Claude Desktop shares your subscriptions" : "Claude Desktop account", enabled: false },
        ...usable.map((l) => ({
          id: `use:${l.accountUuid}`,
          label: `${name(l)}${pct(data!, l.accountId) ? `  ${pct(data!, l.accountId)}` : ""}`,
          checked: desktop!.mode === "signed-in" && current?.accountUuid === l.accountUuid,
        })),
        { separator: true },
        { id: "pool", label: desktop!.mode === "pool" ? "Use my own sign-in in Claude Desktop" : "Share subscriptions automatically (Code tab)" },
        { id: "open", label: "Open Agentgate" },
      ],
    }).catch(() => { key.current = ""; });
  }, [wanted, data, desktop]);

  useEffect(() => () => { if (shown.current) void tiny.tray.remove().catch(() => { }); }, []);
}

const sent = () => new Set<string>(JSON.parse(localStorage.getItem("desktopNotified") ?? "[]"));
async function notify(key: string, title: string, body: string) {
  const seen = sent();
  if (seen.has(key)) return;
  if (!native || !(await tiny.notify(title, body))) return;
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
