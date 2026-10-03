import { useState } from "react";
import { CircleHelp, ExternalLink, Plus } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Tabs } from "@heroui/react";
import type { AccountStatus, Provider } from "@agentgate/protocol";
import { useAccountLogin } from "../components/Login.tsx";
import {
  Badge,
  Choice,
  Empty,
  Field,
  Modal,
  NumberInput,
  Panel,
  Quota,
  HeaderActions,
  RowMenu,
} from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { DesktopAlerts, DesktopButton, DesktopHelp, DesktopPanel, desktopActions, desktopNote, forgetLogin, nameOf } from "./ClaudeDesktop.tsx";
import { request } from "../api.ts";
import {
  field,
  idPath,
  providerName,
  confirmDelete,
  ago,
  planName,
  resetIn,
  windowName,
} from "./utils.ts";

export function Accounts({ data, connection, perform, local, desktop }: ViewProps) {
  const [add, setAdd] = useState(false);
  const [mode, setMode] = useState<"login" | "import">("login");
  const [folder, setFolder] = useState("");
  const [edit, setEdit] = useState<string>();
  const [help, setHelp] = useState(false);
  const { start: begin, dialog: login } = useAccountLogin(connection, perform);
  // Claude Desktop is on this Mac only; its parts of the page appear when it's installed.
  const app = desktop?.available ? desktop : undefined;
  const act = desktopActions(connection, perform);
  const loginFor = (id: string) => app?.logins.find((l) => l.accountId === id);
  const desktopOnly = app?.logins.filter((l) => !l.accountId) ?? [];
  // Windows that have already reset say nothing; hide them.
  const shown = (a: AccountStatus) => a.windows.filter((w) => !w.resetsAt || w.resetsAt > Date.now());
  /** Only states that need attention get a badge; a working account needs none, and a missing login shows Sign in again instead. */
  const problem = (a: AccountStatus) =>
    a.needsLogin || a.expired ? undefined : a.refreshError ? "Refresh failed" : !a.account.enabled ? "Disabled" : a.exhausted ? "Limit reached" : undefined;
  const start = (provider: Provider, label: string) => {
    setAdd(false);
    return begin(provider, label);
  };
  return (
    <>
      <HeaderActions>
        {app && (
          <Button size="sm" variant="ghost" onPress={() => setHelp(true)}>
            <CircleHelp size={15} /> Claude Desktop help
          </Button>
        )}
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
        <>
          <DesktopAlerts data={data} connection={connection} perform={perform} local={local} desktop={app} act={act} />
          <DesktopPanel data={data} connection={connection} perform={perform} local={local} desktop={app} act={act} />
        </>
      )}
      {(["claude", "codex"] as const).map((provider) => (
        <Panel
          key={provider}
          title={providerName(provider)}
          detail={
            provider === "claude"
              ? "Claude subscriptions, shared across your sessions."
              : "ChatGPT subscriptions for your Codex sessions."
          }
          foot={
            data.unknownQuota[provider] &&
            `Quota headers were not recognized for ${providerName(provider)}. Routing still uses provider limit responses.`
          }
        >
          {!data.accounts.some((a) => a.account.provider === provider) &&
          !(provider === "claude" && desktopOnly.length) ? (
            <Empty>No {providerName(provider)} accounts yet.</Empty>
          ) : (
            data.accounts
              .filter((a) => a.account.provider === provider)
              .map((a) => (
                <div className="item stack" key={a.account.id}>
                  <div className="row">
                    <div className={`provider-icon ${provider}`}>
                      {provider === "claude" ? "✳" : "◎"}
                    </div>
                    <div className="grow">
                      <strong>{a.account.label}</strong>
                      <small>
                        {[
                          a.account.email && a.account.email !== a.account.label && a.account.email,
                          a.account.plan && planName(a.account.plan),
                          a.active && a.account.enabled && "Used by your sessions now",
                          a.account.pinned && "Pinned",
                          app && desktopNote(app, loginFor(a.account.id)),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </div>
                    {problem(a) && <Badge>{problem(a)}</Badge>}
                    {(a.needsLogin || a.expired) && (
                      <Button size="sm" variant="tertiary" onPress={() => void start(provider, a.account.label)}>
                        Sign in again
                      </Button>
                    )}
                    {app?.mode === "signed-in" && app.current?.accountId === a.account.id ? (
                      <Badge good>In Claude Desktop</Badge>
                    ) : (
                      app &&
                      provider === "claude" && (
                        <DesktopButton desktop={app} act={act} login={loginFor(a.account.id)} email={a.account.email} />
                      )
                    )}
                    <RowMenu
                      label={`More for ${a.account.label}`}
                      items={[
                        { label: "Edit", onAction: () => setEdit(a.account.id) },
                        { label: a.account.pinned ? "Unpin" : "Pin", onAction: () => void perform(() => request(connection, `/accounts/${idPath(a.account.id)}`, "PATCH", { pinned: !a.account.pinned })) },
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
                  <div className="usage" title={a.observedAt ? `Usage checked ${ago(a.observedAt)}` : undefined}>
                    {shown(a).length ? (
                      shown(a).map((w) => (
                        <div key={w.name}>
                          <span>{windowName(w.name)}</span>
                          <Quota value={w.usedPct} />
                          <strong>{Math.round(w.usedPct)}%</strong>
                          <small>{resetIn(w.resetsAt) && `resets ${resetIn(w.resetsAt)}`}</small>
                        </div>
                      ))
                    ) : (
                      <small className="muted">
                        {provider === "claude" ? "Usage appears within a few minutes." : "Usage appears after the first request."}
                      </small>
                    )}
                  </div>
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
                <DesktopButton desktop={app} act={act} login={l} email={l.email} />
                <RowMenu
                  label={`More for ${nameOf(l)}`}
                  items={[
                    { label: "Add to subscriptions", onAction: () => void start("claude", nameOf(l)) },
                    { label: "Forget login", danger: true, onAction: () => void forgetLogin(connection, perform, l)() },
                  ]}
                />
              </div>
            ))}
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
              ]}
            />
            <Field
              label="Label"
              name="label"
              placeholder="e.g. Personal or Work"
            />
            {mode === "import" && (
              <>
                <div className="row items-end">
                  <Field
                    label="Login folder"
                    isRequired
                    value={folder}
                    onChange={setFolder}
                    placeholder="~/.claude or ~/.codex"
                  />
                  <Button
                    size="sm"
                    variant="tertiary"
                    className="mb-3.5"
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
      {edit && (
        <Modal title="Edit account" close={() => setEdit(undefined)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void perform(async () => {
                await request(
                  connection,
                  `/accounts/${idPath(edit)}`,
                  "PATCH",
                  {
                    label: field(f, "label"),
                    priority: Number(f.get("priority")),
                  },
                );
                setEdit(undefined);
              }, "Account updated");
            }}
          >
            <Field
              label="Label"
              name="label"
              isRequired
              defaultValue={
                data.accounts.find((a) => a.account.id === edit)?.account.label
              }
            />
            <NumberInput
              label="Priority"
              name="priority"
              isRequired
              defaultValue={
                data.accounts.find((a) => a.account.id === edit)?.account
                  .priority
              }
            />
            <p className="note">
              Higher priority wins when multiple accounts are available.
            </p>
            <Button type="submit" size="sm">
              Save changes
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
