import { useState } from "react";
import { CircleHelp, ExternalLink, Pin, Plus } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { typedSwitch } from "hanzio";
import { Button } from "@heroui/react";
import type { AccountStatus, BatchResult, DesktopStatus, Provider } from "@agentgate/protocol";
import { useAccountLogin, useClaudeCodeLogin } from "../components/Login.tsx";
import {
  Badge,
  Choice,
  Empty,
  Field,
  Modal,
  Panel,
  HeaderActions,
  RowMenu,
  Segmented,
  usePending,
} from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import {
  DesktopAlerts,
  DesktopHelp,
  desktopActions,
  desktopNote,
  forgetLogin,
  nameOf,
  usable,
} from "./ClaudeDesktop.tsx";
import { control, request } from "../api.ts";
import { accountProblem, accountState } from "@agentgate/protocol/attention";
import { AccountQuota, QuotaNotes } from "../features/proxy/AccountQuota.tsx";
import { AccountPolicy } from "../features/proxy/AccountPolicy.tsx";
import { field, providerIcon, providerName, providerOptions, toolName, confirmDelete, planName } from "./utils.ts";

/** What a provider's sessions use: Automatic, or the pinned account while it has room. With Claude Desktop on this Mac,
 * pinning an account also moves Desktop to it; Automatic leaves Desktop where it is, since every switch restarts it. */
function poolSummary(accounts: AccountStatus[], provider: Provider, app?: DesktopStatus) {
  const tool = toolName(provider);
  const pinned = accounts.find((a) => a.account.pinned);
  if (pinned) {
    const desktop =
      app && usable(app.logins.find((l) => l.accountId === pinned.account.id)) ? " Claude Desktop uses it too." : "";
    return `Pinned: ${tool} uses ${pinned.account.label} while it has room.${desktop} Unpin it to go back to automatic.`;
  }
  const desktop = !app
    ? ""
    : typedSwitch(app.mode, {
        pool: () => " Claude Desktop shares your subscriptions in its Code tab.",
        "other-gateway": () => " Claude Desktop uses another gateway.",
        "signed-in": () =>
          app.current ? ` Claude Desktop stays on ${nameOf(app.current)}.` : " Claude Desktop isn't signed in.",
      });
  return `Automatic: ${tool} uses the account with the most room left. Pin an account to prefer it.${desktop}`;
}

export function Accounts({ data, connection, perform, local, desktop }: ViewProps) {
  const [add, setAdd] = useState(false);
  const [mode, setMode] = useState<"login" | "import">("login");
  const [folder, setFolder] = useState("");
  const [edit, setEdit] = useState<AccountStatus>();
  const pending = usePending();
  const refreshUsage = (id: string) =>
    void perform(
      async () => {
        const [result] = await request<BatchResult[]>(connection, "/accounts/batch", "POST", {
          ids: [id],
          action: "quota",
        });
        if (!result?.ok) throw new Error(result?.error ?? "Couldn't refresh usage");
      },
      "Usage refreshed",
      `quota:${id}`,
    );
  const [help, setHelp] = useState(false);
  const { start: begin, dialog: login } = useAccountLogin(connection, perform);
  const localLogin = data.localClaudeLogin;
  const claudeCode = useClaudeCodeLogin(connection, perform, localLogin);
  const localAccount =
    localLogin?.email &&
    data.accounts.find(
      (a) => a.account.provider === "claude" && a.account.email?.toLowerCase() === localLogin.email?.toLowerCase(),
    );
  const localLoginFor = (a: AccountStatus) => !!localAccount && localAccount.account.id === a.account.id;
  const claudeCodeSignIn = localLogin && (
    <Button size="sm" variant="tertiary" isDisabled={!local} onPress={() => void claudeCode.start()}>
      {localLogin.state === "signing-in" ? "Continue Claude Code sign-in" : "Sign in to Claude Code"}
    </Button>
  );
  // Claude Desktop is on this Mac only; its parts of the page appear when it's installed.
  const app = desktop?.available ? desktop : undefined;
  const act = desktopActions(connection, perform);
  const loginFor = (id: string) => app?.logins.find((l) => l.accountId === id);
  const desktopOnly = app?.logins.filter((l) => !l.accountId) ?? [];
  // A login Desktop runs that Agentgate hasn't saved yet: it shows on its account's row, or as its own row.
  const unsaved = app?.mode === "signed-in" && app.current && !app.current.saved ? app.current : undefined;
  /** An expired token is not a missing login: this machine refreshes it on the next request, or the machine holding it
   * does and sync brings it here. */
  const needsLogin = (a: AccountStatus) => accountState(a).kind === "needs-login";
  /** Only states that need attention get a badge; a working account needs none, and a missing login shows Sign in again instead. */
  const problem = (a: AccountStatus) => (needsLogin(a) ? undefined : accountProblem(a));
  const pinnable = (a: AccountStatus) => a.account.enabled && !needsLogin(a);
  const pinTitle = (a: AccountStatus) =>
    a.account.pinned
      ? "Pinned. Click to go back to automatic."
      : !a.account.enabled
        ? "Enable this account to pin it"
        : needsLogin(a)
          ? "Sign in again to pin this account"
          : `Pin: ${toolName(a.account.provider)} prefers this account while it has room`;
  const setPin = async (a: AccountStatus, pinned: boolean) => {
    let saved = false;
    await perform(
      async () => {
        await control(connection, pinned ? "accounts pin" : "accounts unpin", { id: a.account.id });
        saved = true;
      },
      pinned ? `${a.account.label} pinned` : `${providerName(a.account.provider)} is back on automatic`,
    );
    // Desktop follows once the pin is saved; its own confirmation covers the restart.
    const login = saved && pinned ? loginFor(a.account.id) : undefined;
    const current = app?.mode === "signed-in" ? app.current : undefined;
    if (usable(login) && current?.accountUuid !== login!.accountUuid) await act.use(login!);
  };
  // A provider gets a panel once it has an account, and Claude whenever Claude Desktop is here; the others are a
  // choice in Add account.
  const providers = (["claude", "codex", "cursor"] as const).filter(
    (p) => data.accounts.some((a) => a.account.provider === p) || (p === "claude" && !!app),
  );
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
      {app && (
        <DesktopAlerts data={data} connection={connection} perform={perform} local={local} desktop={app} act={act} />
      )}
      {localLogin && !localAccount && (
        <Panel
          title="Claude Code needs sign-in"
          detail={
            local
              ? "Your local Claude Code login needs attention before it can start a session."
              : `Sign in on ${data.node} with agentgate accounts claude-code login.`
          }
        >
          <div className="item">
            <div className="grow">
              <strong>{localLogin.email ?? "Claude Code"}</strong>
              {localLogin.error && <small>{localLogin.error}</small>}
            </div>
            {claudeCodeSignIn}
          </div>
        </Panel>
      )}
      {data.detected.length > 0 && (
        <Panel
          title={local ? "Signed in on this Mac" : `Signed in on ${data.node}`}
          detail="Add these accounts to the pool. You confirm once in the browser, so Claude Code and Codex keep their own logins."
        >
          {data.detected.map((d) => (
            <div className="item" key={d.provider}>
              <div className={`provider-icon ${d.provider}`}>{providerIcon(d.provider)}</div>
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
      {!providers.length && (
        <Panel>
          <Empty>
            <strong>No accounts yet.</strong>
            <p>Add a Claude, Codex or Cursor subscription to share it across your sessions.</p>
          </Empty>
        </Panel>
      )}
      {providers.map((provider) => (
        <Panel
          key={provider}
          title={providerName(provider)}
          detail={
            data.accounts.some((a) => a.account.provider === provider)
              ? poolSummary(
                  data.accounts.filter((a) => a.account.provider === provider),
                  provider,
                  provider === "claude" ? app : undefined,
                )
              : typedSwitch(provider, {
                  claude: () => "Claude subscriptions, shared across your sessions.",
                  codex: () => "ChatGPT subscriptions for your Codex sessions.",
                  cursor: () => "Cursor subscriptions, shared across sessions pointed at this daemon.",
                })
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
                    <div className={`provider-icon ${provider}`}>{providerIcon(provider)}</div>
                    <div className="grow">
                      <strong>{a.account.label}</strong>
                      <small>
                        {[
                          a.account.email && a.account.email !== a.account.label && a.account.email,
                          a.account.plan && planName(a.account.plan),
                          app && desktopNote(app, loginFor(a.account.id)),
                          unsaved?.accountId === a.account.id && "Claude Desktop login not saved",
                          localLoginFor(a) &&
                            (localLogin?.error ??
                              (local
                                ? "Claude Code needs sign-in on this machine"
                                : `Claude Code needs sign-in on ${data.node}: agentgate accounts claude-code login`)),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </div>
                    {a.active && a.account.enabled && !localLoginFor(a) && <Badge good>In {toolName(provider)}</Badge>}
                    {app?.mode === "signed-in" && app.current?.accountId === a.account.id && (
                      <Badge good>In Claude Desktop</Badge>
                    )}
                    {problem(a) && <Badge>{problem(a)}</Badge>}
                    {unsaved?.accountId === a.account.id && (
                      <Button size="sm" variant="tertiary" onPress={() => void act.save()}>
                        Save login
                      </Button>
                    )}
                    <AccountQuota
                      account={a}
                      refreshing={pending.has(`quota:${a.account.id}`)}
                      onRefresh={data.daemon?.providers[provider].quota ? () => refreshUsage(a.account.id) : undefined}
                    />
                    {localLoginFor(a) && claudeCodeSignIn}
                    {needsLogin(a) && (
                      <Button
                        size="sm"
                        variant="tertiary"
                        onPress={() => void start(provider, a.account.label, a.account.email)}
                      >
                        {localLoginFor(a) ? "Sign in to pool" : "Sign in again"}
                      </Button>
                    )}
                    <button
                      type="button"
                      className={a.account.pinned ? "pin-account pinned" : "pin-account"}
                      title={pinTitle(a)}
                      aria-label={pinTitle(a)}
                      aria-pressed={a.account.pinned}
                      disabled={!a.account.pinned && !pinnable(a)}
                      onClick={() => void setPin(a, !a.account.pinned)}
                    >
                      <Pin size={14} fill={a.account.pinned ? "currentColor" : "none"} />
                    </button>
                    <RowMenu
                      label={`More for ${a.account.label}`}
                      items={[
                        { label: "Edit policy", onAction: () => setEdit(a) },
                        // Verify, model discovery, login refresh, backoff reset and probes live in `agentgate accounts`.
                        !!data.daemon?.providers[provider].quota && {
                          label: "Refresh usage",
                          onAction: () => refreshUsage(a.account.id),
                        },
                        !!app &&
                          provider === "claude" &&
                          !usable(loginFor(a.account.id)) && {
                            label: loginFor(a.account.id)
                              ? "Connect Claude Desktop again"
                              : "Connect to Claude Desktop",
                            onAction: () => void act.connect(a.account.email),
                          },
                        {
                          label: a.account.enabled ? "Disable" : "Enable",
                          onAction: () =>
                            void perform(() =>
                              control(connection, a.account.enabled ? "accounts disable" : "accounts enable", {
                                id: a.account.id,
                              }),
                            ),
                        },
                        !!app &&
                          !!loginFor(a.account.id) &&
                          !(app.mode === "signed-in" && app.current?.accountId === a.account.id) && {
                            label: "Forget Claude Desktop login",
                            onAction: () => void forgetLogin(connection, perform, loginFor(a.account.id)!)(),
                          },
                        {
                          label: "Delete",
                          danger: true,
                          onAction: async () => {
                            if (await confirmDelete(a.account.label))
                              void perform(
                                () => control(connection, "accounts rm", { id: a.account.id }),
                                "Account deleted",
                              );
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
                {app.mode === "signed-in" && app.current?.accountUuid === l.accountUuid && (
                  <Badge good>In Claude Desktop</Badge>
                )}
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
          <Segmented
            label="How to add the account"
            value={mode}
            onChange={setMode}
            options={[{ id: "login", label: "Sign in" }, local && { id: "import", label: "Import login" }]}
          />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const provider = field(f, "provider") as Provider;
              if (mode === "login") void start(provider, field(f, "label"));
              else
                void perform(async () => {
                  await control(connection, "import", {
                    provider,
                    dir: folder,
                    label: field(f, "label") || undefined,
                  });
                  setAdd(false);
                }, "Account imported");
            }}
          >
            <Choice label="Provider" name="provider" defaultValue="claude" options={providerOptions} />
            <Field label="Label" name="label" placeholder="e.g. Personal or Work" />
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
                  Agentgate takes ownership of this login. Stop using the original CLI login after importing it.
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
      {claudeCode.dialog}
      {login}
      {help && <DesktopHelp close={() => setHelp(false)} />}
      {edit && (
        <AccountPolicy account={edit} connection={connection} perform={perform} close={() => setEdit(undefined)} />
      )}
    </>
  );
}
