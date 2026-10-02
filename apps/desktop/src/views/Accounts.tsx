import { useState } from "react";
import { Check, ExternalLink, Plus, Trash2 } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Tabs } from "@heroui/react";
import type { LoginStart, Provider } from "@agentgate/protocol";
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
} from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { openExternal, request } from "../api.ts";
import {
  field,
  idPath,
  providerName,
  relative,
  confirmDelete,
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

export function Accounts({ data, connection, perform, local }: ViewProps) {
  const [login, setLogin] = useState<LoginStart>();
  const [add, setAdd] = useState(false);
  const [mode, setMode] = useState<"login" | "import">("login");
  const [folder, setFolder] = useState("");
  const [edit, setEdit] = useState<string>();
  const start = (provider: Provider, label: string, email?: string) =>
    perform(async () => {
      const result = await request<LoginStart>(
        connection,
        "/accounts/login",
        "POST",
        { provider, label: label || undefined, email },
      );
      setLogin(result);
      setAdd(false);
      await openExternal(result.url);
    });
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
          foot={
            data.unknownQuota[provider] &&
            `Quota headers were not recognized for ${providerName(provider)}. Routing still uses provider limit responses.`
          }
        >
          {data.accounts.some((a) => a.account.provider === provider) && (
            <SubscriptionSelector
              data={data}
              connection={connection}
              perform={perform}
              provider={provider}
            />
          )}
          {!data.accounts.some((a) => a.account.provider === provider) ? (
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
                      <small>{a.account.email ?? a.account.id}</small>
                    </div>
                    {a.account.plan && (
                      <Badge>{a.account.plan.replace(/^claude_/, "")}</Badge>
                    )}
                    {a.account.pinned && <Badge>Selected</Badge>}
                    <Badge
                      good={
                        a.active &&
                        !a.needsLogin &&
                        !a.expired &&
                        !a.refreshError
                      }
                    >
                      {a.needsLogin
                        ? "Needs login"
                        : a.expired
                          ? "Token expired"
                          : a.refreshError
                            ? "Refresh failed"
                            : !a.account.enabled
                              ? "Disabled"
                              : a.exhausted
                                ? "Exhausted"
                                : a.active
                                  ? "Active"
                                  : "Standby"}
                    </Badge>
                  </div>
                  <div className="quota-grid">
                    {a.windows.length ? (
                      a.windows.map((w) => (
                        <div className="quota" key={w.name}>
                          <div>
                            <span>{w.name}</span>
                            <strong>{Math.round(w.usedPct)}%</strong>
                          </div>
                          <Quota value={w.usedPct} />
                          <small>Resets {relative(w.resetsAt)}</small>
                        </div>
                      ))
                    ) : (
                      <p className="muted">
                        Quota appears after the first provider request.
                      </p>
                    )}
                  </div>
                  <div className="account-footer">
                    <span>
                      {a.needsLogin
                        ? "Sign in again to use this account."
                        : a.expired
                          ? "Token expired"
                          : (a.refreshError ??
                            `Refreshed by ${a.holder ?? "—"}`)}{" "}
                      · Priority {a.account.priority}
                    </span>
                    <div className="row wrap">
                      {(a.needsLogin || a.expired) && (
                        <Button
                          size="sm"
                          variant="tertiary"
                          onPress={() => void start(provider, a.account.label)}
                        >
                          Sign in again
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onPress={() => setEdit(a.account.id)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        isDisabled={
                          !a.account.pinned &&
                          (!a.account.enabled || a.needsLogin)
                        }
                        onPress={() =>
                          void perform(() =>
                            request(
                              connection,
                              `/accounts/${idPath(a.account.id)}`,
                              "PATCH",
                              { pinned: !a.account.pinned },
                            ),
                            a.account.pinned
                              ? `${providerName(provider)} uses automatic selection`
                              : `${providerName(provider)} subscription selected`,
                          )
                        }
                      >
                        {a.account.pinned ? "Use automatic" : "Use subscription"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onPress={() =>
                          void perform(() =>
                            request(
                              connection,
                              `/accounts/${idPath(a.account.id)}`,
                              "PATCH",
                              { enabled: !a.account.enabled },
                            ),
                          )
                        }
                      >
                        {a.account.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        className="delete"
                        aria-label={`Delete ${a.account.label}`}
                        onPress={async () => {
                          if (await confirmDelete(a.account.label))
                            void perform(
                              () =>
                                request(
                                  connection,
                                  `/accounts/${idPath(a.account.id)}`,
                                  "DELETE",
                                ),
                              "Account deleted",
                            );
                        }}
                      >
                        <Trash2 size={15} />
                      </Button>
                    </div>
                  </div>
                </div>
              ))
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
      {login && (
        <Modal
          title={`Sign in to ${providerName(login.provider)}`}
          close={() => setLogin(undefined)}
        >
          <p>Your browser has opened the provider's login page.</p>
          <Button
            size="sm"
            variant="tertiary"
            onPress={() => void perform(() => openExternal(login.url))}
          >
            Open login page again
            <ExternalLink size={14} />
          </Button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void perform(async () => {
                await request(connection, "/accounts/login/finish", "POST", {
                  state: login.state,
                  code: field(f, "code"),
                });
                setLogin(undefined);
              }, "Account added");
            }}
          >
            <Field
              multiline
              label={
                login.provider === "claude"
                  ? "Paste the code shown after signing in"
                  : "Paste the full localhost:1455 callback address"
              }
              name="code"
              isRequired
              autoFocus
              placeholder={
                login.provider === "claude"
                  ? "code#state"
                  : "http://localhost:1455/auth/callback?code=…"
              }
            />
            <p className="note">
              {login.provider === "codex"
                ? "The browser may show a page that cannot load. Copy its full address from the address bar."
                : "This login belongs to Agentgate and leaves your current CLI login untouched."}
            </p>
            <Button type="submit" size="sm">
              Finish sign in
              <Check size={15} />
            </Button>
          </form>
        </Modal>
      )}
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
