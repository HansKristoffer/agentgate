import { useState } from "react";
import { CircleHelp, ExternalLink, Pin, Plus } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Tabs } from "@heroui/react";
import type { AccountStatus, BatchResult, DesktopStatus, Provider } from "@agentgate/protocol";
import { useAccountLogin } from "../components/Login.tsx";
import {
  Badge,
  Choice,
  Empty,
  Field,
  Modal,
  Panel,
  HeaderActions,
  RowMenu,
} from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { DesktopAlerts, DesktopHelp, desktopActions, desktopNote, forgetLogin, nameOf, usable } from "./ClaudeDesktop.tsx";
import { request } from "../api.ts";
import { AccountQuota, QuotaNotes } from "../features/proxy/AccountQuota.tsx";
import { AccountPolicy } from "../features/proxy/AccountPolicy.tsx";
import {
  field,
  idPath,
  providerIcon,
  providerName,
  confirmDelete,
  planName,
} from "./utils.ts";

/** What a provider's sessions use: Automatic, or the pinned account while it has room. With Claude Desktop on this Mac,
 * pinning an account also moves Desktop to it; Automatic leaves Desktop where it is, since every switch restarts it. */
function poolSummary(accounts: AccountStatus[], provider: Provider, app?: DesktopStatus) {
  const tool = provider === "claude" ? "Claude Code" : "Codex";
  const pinned = accounts.find((a) => a.account.pinned);
  if (pinned) {
    const desktop = app && usable(app.logins.find((l) => l.accountId === pinned.account.id)) ? " Claude Desktop uses it too." : "";
    return `Pinned: ${tool} uses ${pinned.account.label} while it has room.${desktop} Unpin it to go back to automatic.`;
  }
  const current = app?.mode === "signed-in" ? app.current : undefined;
  const desktop = !app
    ? ""
    : app.mode === "pool"
      ? " Claude Desktop shares your subscriptions in its Code tab."
      : app.mode === "other-gateway"
        ? " Claude Desktop uses another gateway."
        : current
          ? ` Claude Desktop stays on ${nameOf(current)}.`
          : " Claude Desktop isn't signed in.";
  return `Automatic: ${tool} uses the account with the most room left. Pin an account to prefer it.${desktop}`;
}

export function Accounts({ data, connection, perform, local, desktop }: ViewProps) {
  const [add, setAdd] = useState(false);
  const [mode, setMode] = useState<"login" | "import">("login");
  const [folder, setFolder] = useState("");
  const [edit, setEdit] = useState<AccountStatus>();
  const refreshUsage = (id: string) =>
    void perform(async () => {
      const [result] = await request<BatchResult[]>(connection, "/accounts/batch", "POST", { ids: [id], action: "quota" });
      if (!result?.ok) throw new Error(result?.error ?? "Couldn't refresh usage");
    }, "Usage refreshed");
  const [help, setHelp] = useState(false);
  const { start: begin, dialog: login } = useAccountLogin(connection, perform);
  // Claude Desktop is on this Mac only; its parts of the page appear when it's installed.
  const app = desktop?.available ? desktop : undefined;
  const act = desktopActions(connection, perform);
  const loginFor = (id: string) => app?.logins.find((l) => l.accountId === id);
  const desktopOnly = app?.logins.filter((l) => !l.accountId) ?? [];
  // A login Desktop runs that Agentgate hasn't saved yet: it shows on its account's row, or as its own row.
  const unsaved = app?.mode === "signed-in" && app.current && !app.current.saved ? app.current : undefined;
  /** Only states that need attention get a badge; a working account needs none, and a missing login shows Sign in again instead. */
  const problem = (a: AccountStatus) =>
    a.needsLogin || a.expired ? undefined : a.refreshError ? "Refresh failed" : !a.account.enabled ? "Disabled" : a.exhausted ? "Limit reached" : undefined;
  const pinnable = (a: AccountStatus) => a.account.enabled && !a.needsLogin;
  const pinTitle = (a: AccountStatus) =>
    a.account.pinned
      ? "Pinned. Click to go back to automatic."
      : !a.account.enabled
        ? "Enable this account to pin it"
        : a.needsLogin
          ? "Sign in again to pin this account"
          : `Pin: ${a.account.provider === "claude" ? "Claude Code" : "Codex"} prefers this account while it has room`;
  const setPin = async (a: AccountStatus, pinned: boolean) => {
    let saved = false;
    await perform(async () => {
      await request(connection, `/accounts/${idPath(a.account.id)}`, "PATCH", { pinned });
      saved = true;
    }, pinned ? `${a.account.label} pinned` : `${providerName(a.account.provider)} is back on automatic`);
    // Desktop follows once the pin is saved; its own confirmation covers the restart.
    const login = saved && pinned ? loginFor(a.account.id) : undefined;
    const current = app?.mode === "signed-in" ? app.current : undefined;
    if (usable(login) && current?.accountUuid !== login!.accountUuid) await act.use(login!);
  };
  const start = (provider: Provider, label: string, email?: string) => {
    setAdd(false);
    return begin(provider, label, email);
  };
  return (
    <>
      <HeaderActions>
        <Button
          size="sm"
          onPress={() => {
            setMode("login");
            setAdd(true);
          }}
        >
          <Plus size={15} />
          Add account
        </Button>
      </HeaderActions>
      {app && <DesktopAlerts data={data} connection={connection} perform={perform} local={local} desktop={app} act={act} />}
      {data.detected.length > 0 && (
        <Panel
          title={local ? "Signed in on this Mac" : `Signed in on ${data.node}`}
          detail="Add these accounts to the pool. You confirm once in the browser, so Claude Code and Codex keep their own logins."
        >
          {data.detected.map((d) => (
            <div className="item" key={d.provider}>
              <div className={`provider-icon ${d.provider}`}>
                {providerIcon(d.provider)}
              </div>
              <div className="grow">
                <strong>{d.email}</strong>
                <small>
                  {providerName(d.provider)} · {d.source}
                </small>
              </div>
              {d.plan && <Badge>{d.plan.replace(/^claude_/, "")}</Badge>}
              <Button size="sm" onPress={() => void start(d.provider, "", d.email)}>
                Add to pool
                <ExternalLink size={14} />
              </Button>
            </div>
          ))}
        </Panel>
      )}
      {(["claude", "codex", "cursor"] as const).map((provider) => (
        <Panel
          key={provider}
          title={providerName(provider)}
          detail={
            provider === "cursor"
              ? "Cursor subscriptions and their monthly usage. Agentgate doesn't route Cursor's own traffic."
              : data.accounts.some((a) => a.account.provider === provider)
              ? poolSummary(data.accounts.filter((a) => a.account.provider === provider), provider, provider === "claude" ? app : undefined)
              : provider === "claude"
                ? "Claude subscriptions, shared across your sessions."
                : "ChatGPT subscriptions for your Codex sessions."
          }
          action={
            provider === "claude" &&
            app && (
              <Button size="sm" variant="ghost" onPress={() => setHelp(true)}>
                <CircleHelp size={15} /> Claude Desktop help
              </Button>
            )
          }
          foot={
            data.unknownQuota[provider] &&
            `Quota headers were not recognized for ${providerName(provider)}. Routing still uses provider limit responses.`
          }
        >
          {!data.accounts.some((a) => a.account.provider === provider) &&
          !(provider === "claude" && (desktopOnly.length || unsaved)) ? (
            <Empty>No {providerName(provider)} accounts yet.</Empty>
          ) : (
            data.accounts
              .filter((a) => a.account.provider === provider)
              .map((a) => (
                <div className="item stack account" key={a.account.id}>
                  <div className="row">
                    <div className={`provider-icon ${provider}`}>
                      {providerIcon(provider)}
                    </div>
                    <div className="grow">
                      <strong>{a.account.label}</strong>
                      <small>
                        {[
                          a.account.email && a.account.email !== a.account.label && a.account.email,
                          a.account.plan && planName(a.account.plan),
                          app && desktopNote(app, loginFor(a.account.id)),
                          unsaved?.accountId === a.account.id && "Claude Desktop login not saved",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </div>
                    {a.active && a.account.enabled && <Badge good>In {provider === "claude" ? "Claude Code" : "Codex"}</Badge>}
                    {app?.mode === "signed-in" && app.current?.accountId === a.account.id && <Badge good>In Claude Desktop</Badge>}
                    {problem(a) && <Badge>{problem(a)}</Badge>}
                    {unsaved?.accountId === a.account.id && (
                      <Button size="sm" variant="tertiary" onPress={() => void act.save()}>
                        Save login
                      </Button>
                    )}
                    <AccountQuota account={a} onRefresh={data.daemon?.providers[provider].quota ? () => refreshUsage(a.account.id) : undefined} />
                    {(a.needsLogin || a.expired) && (
                      <Button size="sm" variant="tertiary" onPress={() => void start(provider, a.account.label, a.account.email)}>
                        Sign in again
                      </Button>
                    )}
                    {provider !== "cursor" && <button
                      type="button"
                      className={a.account.pinned ? "pin-account pinned" : "pin-account"}
                      title={pinTitle(a)}
                      aria-label={pinTitle(a)}
                      aria-pressed={a.account.pinned}
                      disabled={!a.account.pinned && !pinnable(a)}
                      onClick={() => void setPin(a, !a.account.pinned)}
                    >
                      <Pin size={14} fill={a.account.pinned ? "currentColor" : "none"} />
                    </button>}
                    <RowMenu
                      label={`More for ${a.account.label}`}
                      items={[
                        provider !== "cursor" && (a.account.pinned || pinnable(a)) && {
                          label: a.account.pinned ? "Unpin (back to automatic)" : "Pin this account",
                          onAction: () => void setPin(a, !a.account.pinned),
                        },
                        provider !== "cursor" && { label: "Edit policy", onAction: () => setEdit(a) },
                        // Verify, model discovery, login refresh, backoff reset and probes live in `agentgate accounts`.
                        !!data.daemon?.providers[provider].quota && {
                          label: "Refresh usage",
                          onAction: () => refreshUsage(a.account.id),
                        },
                        !!app && provider === "claude" && !usable(loginFor(a.account.id)) && {
                          label: loginFor(a.account.id) ? "Connect Claude Desktop again" : "Connect to Claude Desktop",
                          onAction: () => void act.connect(a.account.email),
                        },
                        { label: a.account.enabled ? "Disable" : "Enable", onAction: () => void perform(() => request(connection, `/accounts/${idPath(a.account.id)}`, "PATCH", { enabled: !a.account.enabled })) },
                        !!app && !!loginFor(a.account.id) && !(app.mode === "signed-in" && app.current?.accountId === a.account.id) &&
                          { label: "Forget Claude Desktop login", onAction: () => void forgetLogin(connection, perform, loginFor(a.account.id)!)() },
                        {
                          label: "Delete",
                          danger: true,
                          onAction: async () => {
                            if (await confirmDelete(a.account.label))
                              void perform(() => request(connection, `/accounts/${idPath(a.account.id)}`, "DELETE"), "Account deleted");
                          },
                        },
                      ]}
                    />
                  </div>
                  <QuotaNotes account={a} />
                </div>
              ))
          )}
          {provider === "claude" &&
            app &&
            desktopOnly.map((l) => (
              <div className="item" key={l.accountUuid}>
                <div className="provider-icon claude">✳</div>
                <div className="grow">
                  <strong>{nameOf(l)}</strong>
                  <small>
                    Saved in Claude Desktop only, so no usage
                    {desktopNote(app, l) ? ` · ${desktopNote(app, l)}` : ""}
                  </small>
                </div>
                {app.mode === "signed-in" && app.current?.accountUuid === l.accountUuid && <Badge good>In Claude Desktop</Badge>}
                <RowMenu
                  label={`More for ${nameOf(l)}`}
                  items={[
                    { label: "Add to subscriptions", onAction: () => void start("claude", nameOf(l)) },
                    !usable(l) && { label: "Connect Claude Desktop again", onAction: () => void act.connect(l.email) },
                    { label: "Forget login", danger: true, onAction: () => void forgetLogin(connection, perform, l)() },
                  ]}
                />
              </div>
            ))}
          {provider === "claude" && unsaved && !unsaved.accountId && (
            <div className="item">
              <div className="provider-icon claude">✳</div>
              <div className="grow">
                <strong>{nameOf(unsaved)}</strong>
                <small>Not in Agentgate yet. Add it to switch back to it later and use it in Claude Code.</small>
              </div>
              <Badge good>In Claude Desktop</Badge>
              {/* One step: keep Desktop's login for switching, then sign in so Claude Code can use it too. */}
              <Button
                size="sm"
                variant="tertiary"
                onPress={async () => {
                  await act.save();
                  await start("claude", nameOf(unsaved), unsaved.email);
                }}
              >
                Add
              </Button>
            </div>
          )}
        </Panel>
      ))}
      {add && (
        <Modal title="Add an account" close={() => setAdd(false)}>
          <Tabs
            className="segmented"
            selectedKey={mode}
            onSelectionChange={(key) => setMode(key as "login" | "import")}
          >
            <Tabs.ListContainer>
              <Tabs.List aria-label="How to add the account">
                <Tabs.Tab id="login">
                  Sign in
                  <Tabs.Indicator />
                </Tabs.Tab>
                {local && (
                  <Tabs.Tab id="import">
                    Import login
                    <Tabs.Indicator />
                  </Tabs.Tab>
                )}
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const provider = field(f, "provider") as Provider;
              if (mode === "login") void start(provider, field(f, "label"));
              else
                void perform(async () => {
                  await request(connection, "/accounts/import", "POST", {
                    provider,
                    dir: folder,
                    label: field(f, "label") || undefined,
                  });
                  setAdd(false);
                }, "Account imported");
            }}
          >
            <Choice
              label="Provider"
              name="provider"
              defaultValue="claude"
              options={[
                { id: "claude", label: "Claude" },
                { id: "codex", label: "Codex" },
                { id: "cursor", label: "Cursor" },
              ]}
            />
            <Field
              label="Label"
              name="label"
              placeholder="e.g. Personal or Work"
            />
            {mode === "import" && (
              <>
                <div className="row items-end field-with-button">
                  <Field
                    label="Login folder"
                    isRequired
                    value={folder}
                    onChange={setFolder}
                    placeholder="~/.claude, ~/.codex or ~/.config/cursor"
                  />
                  <Button
                    size="sm"
                    variant="tertiary"
                    onPress={() =>
                      void perform(async () => {
                        const path = await open({ directory: true });
                        if (typeof path === "string") setFolder(path);
                      })
                    }
                  >
                    Choose…
                  </Button>
                </div>
                <p className="note">
                  Agentgate takes ownership of this login. Stop using the
                  original CLI login after importing it.
                </p>
              </>
            )}
            <Button type="submit" size="sm">
              {mode === "login" ? "Continue in browser" : "Import account"}
              <ExternalLink size={15} />
            </Button>
          </form>
        </Modal>
      )}
      {login}
      {help && <DesktopHelp close={() => setHelp(false)} />}
      {edit && <AccountPolicy account={edit} connection={connection} perform={perform} close={() => setEdit(undefined)} />}
    </>
  );
}
