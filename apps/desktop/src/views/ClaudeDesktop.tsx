import { Alert, Button } from "@heroui/react";
import { confirmDialog } from "@hanskristoffer/taurio/runtime";
import type { AccountStatus, Connection, DesktopLogin, DesktopStatus, Status } from "@agentgate/protocol";
import { localAction, request } from "../api.ts";
import { Modal, Panel, Toggle } from "../components/ui.tsx";
import type { Perform, ViewProps } from "../types.ts";

const DAY = 86_400_000;

/** The window closest to its limit. */
export const tightest = (a?: AccountStatus) =>
  a?.windows.slice().sort((x, y) => y.usedPct - x.usedPct)[0];
export const nameOf = (l: { label?: string; email?: string; accountUuid: string }) =>
  l.label ?? l.email ?? `Account ${l.accountUuid.slice(0, 8)}`;

/** Switching restarts Desktop; say so once, then trust the user. */
export async function confirmRestart() {
  if (localStorage.getItem("desktopRestartOk")) return true;
  const ok = await confirmDialog(
    "Claude Desktop will restart. Running Cowork and Code sessions stop, and messages you haven't sent are lost. You won't be asked again.",
    { okLabel: "Restart Claude Desktop" },
  );
  if (ok) localStorage.setItem("desktopRestartOk", "1");
  return ok;
}

/** Desktop actions shared by this screen and the menu bar. */
export function desktopActions(connection: Connection, perform: Perform) {
  const run = async (path: string, body: unknown, message: string) => {
    if (await confirmRestart()) await perform(() => request(connection, path, "POST", body), message);
  };
  return {
    use: (l: DesktopLogin) => run("/desktop/use", { accountUuid: l.accountUuid }, `Claude Desktop is restarting with ${nameOf(l)}`),
    connect: (email?: string) =>
      run("/desktop/add", { expected: email }, `Claude Desktop restarted. Sign in${email ? ` with ${email}` : ""} there; Agentgate saves it automatically.`),
    pool: (on: boolean) =>
      run("/desktop/gateway", { on }, on ? "Claude Desktop is restarting; its Code tab now shares your subscriptions" : "Claude Desktop is restarting with its own sign-in"),
  };
}

/** Which saved login to suggest when Desktop's account runs low. */
export function suggestion(data: Status, desktop: DesktopStatus) {
  if (desktop.mode !== "signed-in" || !desktop.current?.accountId) return undefined;
  const byId = (id?: string) => data.accounts.find((a) => a.account.id === id);
  const now = tightest(byId(desktop.current.accountId));
  if (!now || now.usedPct < data.settings.threshold) return undefined;
  const room = desktop.logins
    .filter((l) => l.accountId && l.accountUuid !== desktop.current?.accountUuid && !l.expired && !l.problem)
    .map((l) => ({ login: l, used: tightest(byId(l.accountId))?.usedPct ?? 0 }))
    .filter((x) => x.used < data.settings.threshold && !byId(x.login.accountId)?.exhausted)
    .sort((a, b) => a.used - b.used)[0];
  return room && { from: desktop.current, used: now, to: room.login };
}

type Actions = ReturnType<typeof desktopActions>;
const usable = (l?: DesktopLogin) => !!l && !l.expired && !l.problem;
const isCurrent = (desktop: DesktopStatus, l?: DesktopLogin) =>
  !!l && desktop.mode === "signed-in" && desktop.current?.accountUuid === l.accountUuid;

/** Why this saved login needs attention, for the account row. */
export function desktopNote(desktop: DesktopStatus, l?: DesktopLogin) {
  if (!l) return undefined;
  if (l.expired) return "Claude Desktop login expired";
  if (l.problem) return l.problem;
  const days = l.sessionExpiresAt && Math.ceil((l.sessionExpiresAt - Date.now()) / DAY);
  if (days && days > 0 && days <= 5 && !isCurrent(desktop, l)) return `Open it in Claude Desktop within ${days} day${days === 1 ? "" : "s"} to stay connected`;
}

/** The one Claude Desktop action an account row offers. */
export function DesktopButton({ desktop, act, login, email }: { desktop: DesktopStatus; act: Actions; login?: DesktopLogin; email?: string }) {
  if (isCurrent(desktop, login)) return null;
  return usable(login) ? (
    <Button size="sm" variant="tertiary" onPress={() => void act.use(login!)}>Use in Desktop</Button>
  ) : (
    <Button size="sm" variant="tertiary" onPress={() => void act.connect(email)}>{login ? "Connect Desktop again" : "Connect to Desktop"}</Button>
  );
}

export function forgetLogin(connection: Connection, perform: Perform, l: DesktopLogin) {
  return async () => {
    if (await confirmDialog(`Forget the saved Claude Desktop login for ${nameOf(l)}? You can connect it again later.`, { okLabel: "Forget" }))
      void perform(() => request(connection, `/desktop/logins/${encodeURIComponent(l.accountUuid)}`, "DELETE"), "Login forgotten");
  };
}

/** Sign-in progress and problems, shown above the accounts. */
export function DesktopAlerts({ data, connection, perform, desktop, act }: ViewProps & { desktop: DesktopStatus; act: Actions }) {
  const suggest = suggestion(data, desktop);
  const dismiss = () => void perform(() => request(connection, "/desktop/add", "DELETE"));
  return (
    <>
      {desktop.pendingAdd && (
        <Alert status="accent" className="callout">
          <Alert.Content>
            <Alert.Title>Waiting for you to sign in to Claude Desktop{desktop.pendingAdd.expected ? ` with ${desktop.pendingAdd.expected}` : ""}</Alert.Title>
            <Alert.Description>Agentgate saves the login as soon as you're in. Don't use Log out in Claude Desktop: it ends saved logins.</Alert.Description>
          </Alert.Content>
          <Button size="sm" variant="tertiary" onPress={dismiss}>Cancel</Button>
        </Alert>
      )}
      {desktop.addMismatch && (
        <Alert status="warning" className="callout">
          <Alert.Content>
            <Alert.Title>You signed in as {nameOf(desktop.addMismatch)}, not {desktop.addMismatch.expected}</Alert.Title>
            <Alert.Description>That login was saved. {desktop.addMismatch.expected} is still not connected.</Alert.Description>
          </Alert.Content>
          <Button size="sm" onPress={() => void act.connect(desktop.addMismatch!.expected)}>Connect {desktop.addMismatch.expected}</Button>
          <Button size="sm" variant="tertiary" onPress={dismiss}>Dismiss</Button>
        </Alert>
      )}
      {desktop.signedOut && !desktop.pendingAdd && (
        <Alert status="warning" className="callout">
          <Alert.Content>
            <Alert.Title>Claude Desktop was signed out</Alert.Title>
            <Alert.Description>Signing out in Claude Desktop ends that saved login. Use Connect to Desktop instead; it keeps your other logins working.</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {suggest && (
        <Alert status="warning" className="callout">
          <Alert.Content>
            <Alert.Title>{nameOf(suggest.from)} is at {Math.round(suggest.used.usedPct)}% of its {suggest.used.name} limit</Alert.Title>
            <Alert.Description>{nameOf(suggest.to)} has room. Switch Claude Desktop to it?</Alert.Description>
          </Alert.Content>
          <Button size="sm" onPress={() => void act.use(suggest.to)}>Switch</Button>
        </Alert>
      )}
    </>
  );
}

/** What Claude Desktop uses now, how it uses your subscriptions, and its tools. */
export function DesktopPanel({ data, connection, perform, desktop, act }: ViewProps & { desktop: DesktopStatus; act: Actions }) {
  const current = desktop.mode === "signed-in" ? desktop.current : undefined;
  const pool = desktop.mode === "pool";
  const active = data.accounts.find((a) => a.account.provider === "claude" && a.active)?.account.label;
  const [title, body] = pool
    ? ["Its Code tab shares your subscriptions", `Now using ${active ?? "the next available subscription"}. Chat isn't available in this mode, and your claude.ai chats aren't shown.`]
    : desktop.mode === "other-gateway"
      ? ["It uses another gateway", "Set up by you or your company. Agentgate leaves it alone unless you pick a mode."]
      : current
        ? [`Signed in as ${nameOf(current)}`, current.accountId ? "Chat, Cowork and Code use this account. Switch with Use in Desktop below." : "Not in your subscriptions, so Agentgate can't show its usage."]
        : ["Not signed in", "Connect one of your accounts below, or sign in in Claude Desktop and press Save this account."];
  return (
    <Panel title="Claude Desktop" foot={!desktop.running && "Claude Desktop is closed. Changes apply when it opens."}>
      <div className="item">
        <span className="labelled grow">
          {title}
          <small>{body}</small>
        </span>
        {current && !current.saved && (
          <Button size="sm" variant="tertiary" onPress={() => void perform(() => request(connection, "/desktop/capture", "POST"), "Saved; you can switch back to this account any time")}>
            Save this account
          </Button>
        )}
      </div>
      <div className="item stack">
        <div className="row wrap">
          {(["signed-in", "pool"] as const).map((m) => (
            <Button key={m} size="sm" variant={desktop.mode === m ? "primary" : "tertiary"} aria-pressed={desktop.mode === m} onPress={() => desktop.mode !== m && void act.pool(m === "pool")}>
              {m === "pool" ? "Share automatically" : "Switch accounts"}
            </Button>
          ))}
        </div>
        <small className="muted">
          {desktop.mode === "other-gateway"
            ? "Pick one to replace the other gateway. Your settings for it are kept."
            : pool
            ? "The Code tab moves to whichever subscription has room by itself. Agentgate must keep running."
            : "Your full account in Desktop: Chat, Cowork, Code and your history. Switching restarts Desktop."}
        </small>
      </div>
      <Toggle
        label="Use Agentgate's MCP servers in the Code tab"
        description="Also applies to Claude Code in the terminal. Chat and Cowork don't load them."
        isSelected={desktop.mcp}
        onChange={(on) => void perform(() => localAction(on ? "mcp-on" : "mcp-off", connection), on ? "MCP servers added" : "MCP servers removed")}
      />
    </Panel>
  );
}

export function DesktopHelp({ close }: { close: () => void }) {
  return (
    <Modal title="How Agentgate works with Claude Desktop" close={close}>
      <p>Claude Desktop can use your subscriptions in two ways:</p>
      <table className="compare">
        <thead>
          <tr><th /><th>Switch accounts</th><th>Share automatically</th></tr>
        </thead>
        <tbody>
          <tr><td>Chat</td><td>Yes</td><td>Not available</td></tr>
          <tr><td>Cowork</td><td>Yes</td><td>Not yet verified</td></tr>
          <tr><td>Code tab</td><td>Yes</td><td>Yes</td></tr>
          <tr><td>Your claude.ai history and projects</td><td>Yes</td><td>No, a separate local profile</td></tr>
          <tr><td>When a subscription runs out</td><td>You switch (one click, Desktop restarts)</td><td>Moves on by itself</td></tr>
          <tr><td>Needs Agentgate running</td><td>Only to switch</td><td>Yes</td></tr>
        </tbody>
      </table>
      <ol className="steps">
        <li><strong>Why does Claude Desktop restart?</strong><p>It only reads its sign-in when it starts.</p></li>
        <li><strong>What happens to my chats?</strong><p>They stay in your claude.ai account. The shared mode keeps its own local history next to it.</p></li>
        <li><strong>Why not just sign out and in?</strong><p>Signing out in Claude Desktop ends that login for good. Agentgate keeps each login saved on this Mac, so switching back needs no password.</p></li>
        <li><strong>What if I remove Agentgate?</strong><p>Claude Desktop keeps the account it was last switched to. Switch back to your own sign-in first if you use the shared mode.</p></li>
        <li><strong>Which rules apply?</strong><p>Agentgate only uses accounts you sign in to yourself, and only sends Claude Code requests with subscription logins. The terms of each plan still apply.</p></li>
      </ol>
      <p className="note">Saved logins stay on this Mac. They're encrypted with its keychain and never synced to your other machines.</p>
    </Modal>
  );
}
