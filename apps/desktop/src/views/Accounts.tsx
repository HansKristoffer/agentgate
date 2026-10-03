import { useState } from "react";
import { CircleHelp, ExternalLink, Plus } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Tabs } from "@heroui/react";
import type { AccountStatus, Provider } from "@agentgate/protocol";
import { useAccountLogin } from "../components/Login.tsx";
import {
  Badge,
  Check,
  Choice,
  Empty,
  Field,
  Modal,
  Panel,
  HeaderActions,
  RowMenu,
} from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { DesktopAlerts, DesktopButton, DesktopHelp, DesktopPanel, desktopActions, desktopNote, forgetLogin, nameOf } from "./ClaudeDesktop.tsx";
import { request } from "../api.ts";
import { AccountQuota } from "../features/proxy/AccountQuota.tsx";
import { AccountPolicy } from "../features/proxy/AccountPolicy.tsx";
import { useAccountActions } from "../features/proxy/AccountActions.tsx";
import {
  field,
  idPath,
  providerName,
  confirmDelete,
  planName,
} from "./utils.ts";

function SubscriptionSelector({
  data,
  connection,
  perform,
  provider,
}: Pick<ViewProps, "data" | "connection" | "perform"> & { provider: Provider }) {
  const accounts = data.accounts.filter((a) => a.account.provider === provider);
  const selected = accounts.find((a) => a.account.pinned);
  return (
    <Choice
      className="item"
      label={`Active ${providerName(provider)} subscription`}
      description="Applies to the next request in all routed sessions. Falls back if unavailable."
      value={selected ? `account:${selected.account.id}` : "automatic"}
      disabledKeys={accounts
        .filter((a) => !a.account.enabled || a.needsLogin)
        .map((a) => `account:${a.account.id}`)}
      onChange={(key) => {
        if (!key) return;
        const value = String(key);
        void perform(
          async () => {
            if (value === "automatic") {
              for (const a of accounts.filter((a) => a.account.pinned))
                await request(
                  connection,
                  `/accounts/${idPath(a.account.id)}`,
                  "PATCH",
                  { pinned: false },
                );
            } else {
              await request(
                connection,
                `/accounts/${idPath(value.slice("account:".length))}`,
                "PATCH",
                { pinned: true },
              );
            }
          },
          value === "automatic"
            ? `${providerName(provider)} uses automatic selection`
            : `${providerName(provider)} subscription selected`,
        );
      }}
      options={[
        { id: "automatic", label: "Automatic" },
        ...accounts.map((a) => {
          const unavailable = !a.account.enabled
            ? "Disabled"
            : a.needsLogin
              ? "Needs login"
              : a.exhausted
                ? "Exhausted"
                : undefined;
          return {
            id: `account:${a.account.id}`,
            label: [a.account.label, a.account.email, unavailable]
              .filter(Boolean)
              .join(" · "),
          };
        }),
      ]}
    />
  );
}

export function Accounts({ data, connection, perform, local, desktop }: ViewProps) {
  const [add, setAdd] = useState(false);
  const [mode, setMode] = useState<"login" | "import">("login");
  const [folder, setFolder] = useState("");
  const [edit, setEdit] = useState<AccountStatus>();
  const [selected, setSelected] = useState(new Set<string>());
  const [models, setModels] = useState({ claude: "", codex: "" });
  const actions = useAccountActions({ data, connection, perform, local, desktop }, selected, setSelected);
  const [help, setHelp] = useState(false);
  const { start: begin, dialog: login } = useAccountLogin(connection, perform);
  // Claude Desktop is on this Mac only; its parts of the page appear when it's installed.
  const app = desktop?.available ? desktop : undefined;
  const act = desktopActions(connection, perform);
  const loginFor = (id: string) => app?.logins.find((l) => l.accountId === id);
  const desktopOnly = app?.logins.filter((l) => !l.accountId) ?? [];
  /** Only states that need attention get a badge; a working account needs none, and a missing login shows Sign in again instead. */
  const problem = (a: AccountStatus) =>
    a.needsLogin || a.expired ? undefined : a.refreshError ? "Refresh failed" : !a.account.enabled ? "Disabled" : a.exhausted ? "Limit reached" : undefined;
  const start = (provider: Provider, label: string, email?: string) => {
    setAdd(false);
    return begin(provider, label, email);
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
      {actions.controls}
      {app && (
        <>
          <DesktopAlerts data={data} connection={connection} perform={perform} local={local} desktop={app} act={act} />
          <DesktopPanel data={data} connection={connection} perform={perform} local={local} desktop={app} act={act} />
        </>
      )}
      {data.detected.length > 0 && (
        <Panel
          title={local ? "Signed in on this Mac" : `Signed in on ${data.node}`}
          detail="Add these accounts to the pool. You confirm once in the browser, so Claude Code and Codex keep their own logins."
        >
          {data.detected.map((d) => (
            <div className="item" key={d.provider}>
              <div className={`provider-icon ${d.provider}`}>
                {d.provider === "claude" ? "✳" : "◎"}
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
      {(["claude", "codex"] as const).map((provider) => (
        <Panel
          key={provider}
          title={providerName(provider)}
          detail={
            provider === "claude"
              ? "Claude subscriptions, shared across your sessions."
              : "ChatGPT subscriptions for your Codex sessions."
          }
          action={<Button size="sm" variant="ghost" isDisabled={!data.accounts.some(a => a.account.provider === provider)} onPress={() => { setSelected(new Set(data.accounts.filter(a => a.account.provider === provider).slice(0, 100).map(a => a.account.id))); }}>Select all</Button>}
          foot={
            data.unknownQuota[provider] &&
            `Quota headers were not recognized for ${providerName(provider)}. Routing still uses provider limit responses.`
          }
        >
          {data.accounts.some((a) => a.account.provider === provider) && (
            <>
              <SubscriptionSelector
                data={data}
                connection={connection}
                perform={perform}
                provider={provider}
              />
              <Field
                className="item"
                label="Usage for model"
                description="Show only the limits that apply to one model."
                placeholder="All models"
                value={models[provider]}
                onChange={(value) => setModels((old) => ({ ...old, [provider]: value }))}
              />
            </>
          )}
          {!data.accounts.some((a) => a.account.provider === provider) &&
          !(provider === "claude" && desktopOnly.length) ? (
            <Empty>No {providerName(provider)} accounts yet.</Empty>
          ) : (
            data.accounts
              .filter((a) => a.account.provider === provider)
              .map((a) => (
                <div className="item stack account" key={a.account.id}>
                  <div className="row">
                    <Check
                      aria-label={`Select ${a.account.label}`}
                      isSelected={selected.has(a.account.id)}
                      onChange={(on) =>
                        setSelected((old) => {
                          const next = new Set(old);
                          if (on && next.size < 100) next.add(a.account.id);
                          else next.delete(a.account.id);
                          return next;
                        })
                      }
                    />
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
                          a.account.pinned && "Selected",
                          app && desktopNote(app, loginFor(a.account.id)),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </div>
                    {problem(a) && <Badge>{problem(a)}</Badge>}
                    {(a.needsLogin || a.expired) && (
                      <Button size="sm" variant="tertiary" onPress={() => void start(provider, a.account.label, a.account.email)}>
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
                        { label: "Edit policy", onAction: () => setEdit(a) },
                        actions.supported(a, "quota") && { label: "Refresh usage", onAction: () => void actions.run(a.account.id, "quota") },
                        { label: "Verify (read-only)", onAction: () => void actions.run(a.account.id, "verify") },
                        actions.supported(a, "models") && { label: "Discover models", onAction: () => void actions.run(a.account.id, "models") },
                        { label: "Refresh login", onAction: () => void actions.run(a.account.id, "refresh") },
                        { label: "Reset local backoff", onAction: () => void actions.run(a.account.id, "reset-cooldown") },
                        actions.supported(a, "probe") && { label: "Inference probe…", onAction: () => actions.probe(a) },
                        (a.account.pinned || (a.account.enabled && !a.needsLogin)) && {
                          label: a.account.pinned ? "Use automatic" : "Use this subscription",
                          onAction: () =>
                            void perform(
                              () => request(connection, `/accounts/${idPath(a.account.id)}`, "PATCH", { pinned: !a.account.pinned }),
                              a.account.pinned ? `${providerName(provider)} uses automatic selection` : `${providerName(provider)} subscription selected`,
                            ),
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
                  <AccountQuota account={a} model={models[provider].trim() || undefined} />
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
      {edit && <AccountPolicy account={edit} connection={connection} perform={perform} close={() => setEdit(undefined)} />}
    </>
  );
}
