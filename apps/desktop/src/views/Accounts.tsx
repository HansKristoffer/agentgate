import { useState } from "react";
import { Check, Copy, ExternalLink, Plus, Trash2 } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import type { LoginStart, Provider } from "@agentgate/protocol";
import { Badge, Empty, Modal, Panel } from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { openExternal, request } from "../api.ts";
import {
  field,
  idPath,
  providerName,
  relative,
  confirmDelete,
} from "./utils.ts";

export function Accounts({ data, connection, perform, local }: ViewProps) {
  const [login, setLogin] = useState<LoginStart>();
  const [add, setAdd] = useState(false);
  const [mode, setMode] = useState<"login" | "import">("login");
  const [folder, setFolder] = useState("");
  const [edit, setEdit] = useState<string>();
  const start = (provider: Provider, label: string) =>
    perform(async () => {
      const result = await request<LoginStart>(
        connection,
        "/accounts/login",
        "POST",
        { provider, label: label || undefined },
      );
      setLogin(result);
      setAdd(false);
      await openExternal(result.url);
    });
  return (
    <>
      <div className="section-toolbar">
        <span className="muted">
          {data.accounts.length} accounts in your pool
        </span>
        <button
          className="button primary"
          onClick={() => {
            setMode("login");
            setAdd(true);
          }}
        >
          <Plus size={15} />
          Add account
        </button>
      </div>
      {(["claude", "codex"] as const).map((provider) => (
        <Panel
          key={provider}
          title={providerName(provider)}
          detail={
            provider === "claude"
              ? "Claude subscriptions, shared across your sessions."
              : "ChatGPT subscriptions for your Codex sessions."
          }
        >
          {!data.accounts.some((a) => a.account.provider === provider) ? (
            <Empty>No {providerName(provider)} accounts yet.</Empty>
          ) : (
            data.accounts
              .filter((a) => a.account.provider === provider)
              .map((a) => (
                <div className="account-card" key={a.account.id}>
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
                          <progress max={100} value={w.usedPct} />
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
                    <span className="muted">
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
                        <button
                          className="button"
                          onClick={() => void start(provider, a.account.label)}
                        >
                          Sign in again
                        </button>
                      )}
                      <button
                        className="button quiet"
                        onClick={() => setEdit(a.account.id)}
                      >
                        Edit
                      </button>
                      <button
                        className="button quiet"
                        onClick={() =>
                          void perform(() =>
                            request(
                              connection,
                              `/accounts/${idPath(a.account.id)}`,
                              "PATCH",
                              { pinned: !a.account.pinned },
                            ),
                          )
                        }
                      >
                        {a.account.pinned ? "Unpin" : "Pin"}
                      </button>
                      <button
                        className="button quiet"
                        onClick={() =>
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
                      </button>
                      <button
                        className="icon-button danger"
                        aria-label={`Delete ${a.account.label}`}
                        onClick={() => {
                          if (confirmDelete(a.account.label))
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
                      </button>
                    </div>
                  </div>
                </div>
              ))
          )}
          {data.unknownQuota[provider] && (
            <p className="note">
              Quota headers were not recognized for {providerName(provider)}.
              Routing still uses provider limit responses.
            </p>
          )}
        </Panel>
      ))}
      {add && (
        <Modal title="Add an account" close={() => setAdd(false)}>
          <div className="segmented">
            <button
              className={mode === "login" ? "selected" : ""}
              onClick={() => setMode("login")}
            >
              Sign in
            </button>
            {local && (
              <button
                className={mode === "import" ? "selected" : ""}
                onClick={() => setMode("import")}
              >
                Import login
              </button>
            )}
          </div>
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
            <label>
              Provider
              <select name="provider">
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label>
              Label
              <input name="label" placeholder="e.g. Personal or Work" />
            </label>
            {mode === "import" && (
              <>
                <label>
                  Login folder
                  <div className="row">
                    <input
                      required
                      value={folder}
                      onChange={(e) => setFolder(e.target.value)}
                      placeholder="~/.claude or ~/.codex"
                    />
                    <button
                      type="button"
                      className="button"
                      onClick={() =>
                        void perform(async () => {
                          const path = await open({ directory: true });
                          if (typeof path === "string") setFolder(path);
                        })
                      }
                    >
                      Choose…
                    </button>
                  </div>
                </label>
                <p className="note">
                  Agentgate takes ownership of this login. Stop using the
                  original CLI login after importing it.
                </p>
              </>
            )}
            <button className="button primary">
              {mode === "login" ? "Continue in browser" : "Import account"}
              <ExternalLink size={15} />
            </button>
          </form>
        </Modal>
      )}
      {login && (
        <Modal
          title={`Sign in to ${providerName(login.provider)}`}
          close={() => setLogin(undefined)}
        >
          <p>Your browser has opened the provider's login page.</p>
          <button
            className="button"
            onClick={() => void perform(() => openExternal(login.url))}
          >
            Open login page again
            <ExternalLink size={14} />
          </button>
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
            <label>
              {login.provider === "claude"
                ? "Paste the code shown after signing in"
                : "Paste the full localhost:1455 callback address"}
              <textarea
                name="code"
                required
                autoFocus
                placeholder={
                  login.provider === "claude"
                    ? "code#state"
                    : "http://localhost:1455/auth/callback?code=…"
                }
              />
            </label>
            <p className="note">
              {login.provider === "codex"
                ? "The browser may show a page that cannot load. Copy its full address from the address bar."
                : "This login belongs to Agentgate and leaves your current CLI login untouched."}
            </p>
            <button className="button primary">
              Finish sign in
              <Check size={15} />
            </button>
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
            <label>
              Label
              <input
                name="label"
                required
                defaultValue={
                  data.accounts.find((a) => a.account.id === edit)?.account
                    .label
                }
              />
            </label>
            <label>
              Priority
              <input
                name="priority"
                type="number"
                required
                defaultValue={
                  data.accounts.find((a) => a.account.id === edit)?.account
                    .priority
                }
              />
            </label>
            <p className="note">
              Higher priority wins when multiple accounts are available.
            </p>
            <button className="button primary">Save changes</button>
          </form>
        </Modal>
      )}
    </>
  );
}
