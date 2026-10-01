import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  Activity,
  Boxes,
  ChevronRight,
  CircleHelp,
  FolderGit2,
  LayoutDashboard,
  Monitor,
  RefreshCw,
  Settings as Gear,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import type { Connection, Status } from "@agentgate/protocol";
import {
  checkForUpdate,
  loadConnection,
  localAction,
  localConnection,
  native,
  saveConnection,
  status,
} from "./api.ts";
import {
  Accounts,
  Dashboard,
  Nodes,
  Projects,
  Servers,
  Settings,
} from "./views/index.ts";

import type { Perform } from "./types.ts";
import { Badge, Modal } from "./components/ui.tsx";

const navigation = [
  { id: "overview", title: "Overview", icon: LayoutDashboard },
  { id: "accounts", title: "Accounts", icon: Users },
  { id: "servers", title: "MCP servers", icon: Boxes },
  { id: "projects", title: "Projects", icon: FolderGit2 },
  { id: "nodes", title: "Machines", icon: Monitor },
  { id: "settings", title: "Settings", icon: Gear },
] as const;
type View = (typeof navigation)[number]["id"];
const descriptions: Record<View, string> = {
  overview: "Your agents, connected.",
  accounts: "One pool for every Claude and Codex session.",
  servers: "Connect tools once. Use them across your projects.",
  projects: "Give each repository the tools it needs.",
  nodes: "Your setup, shared across your Tailscale network.",
  settings: "Make Agentgate work the way you do.",
};

export function App() {
  const [view, setView] = useState<View>("overview");
  const [connection, setConnection] = useState<Connection>({
    url: "http://127.0.0.1:7878",
  });
  const [localUrl, setLocalUrl] = useState("http://127.0.0.1:7878");
  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState("");
  const [data, setData] = useState<Status>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [update, setUpdate] =
    useState<Awaited<ReturnType<typeof checkForUpdate>>>(null);
  const [installing, setInstalling] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const current = useRef(connection);
  const actionLock = useRef(false);
  const local =
    connection.url.replace("localhost", "127.0.0.1").replace(/\/$/, "") ===
    localUrl;
  const selected = navigation.find((n) => n.id === view)!;

  useEffect(() => {
    if (!native) {
      setReady(true);
      setError("Open the Agentgate native app to connect to your setup.");
      return;
    }
    let cancelled = false;
    void getVersion()
      .then((v) => {
        if (!cancelled) setVersion(v);
      })
      .catch(() => {});
    void Promise.all([loadConnection(), localConnection()])
      .then(([c, own]) => {
        if (!cancelled) {
          current.current = c;
          setConnection(c);
          setLocalUrl(own.url);
          setReady(true);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          setReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const refresh = useCallback(async () => {
    const c = current.current;
    try {
      const next = await status(c);
      if (current.current === c) {
        setData(next);
        setError("");
      }
    } catch (e) {
      if (current.current === c) setError(String(e));
    }
  }, []);
  useEffect(() => {
    if (!ready || !native) return;
    void refresh();
    const timer = setInterval(() => {
      if (!actionLock.current) void refresh();
    }, 5000);
    const focus = () => {
      void refresh();
    };
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [ready, connection, refresh]);
  // Checked on launch and every four hours, since the app is left open for days.
  // Nothing downloads until the user chooses to install; offline is not an error.
  useEffect(() => {
    if (!native) return;
    const run = () =>
      void checkForUpdate()
        .then((u) => u && setUpdate(u))
        .catch(() => {});
    run();
    const timer = setInterval(run, 4 * 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === ",") {
        e.preventDefault();
        setView("settings");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  // Confirmations fade on their own; errors stay until dismissed.
  useEffect(() => {
    if (!notice || notice.startsWith("Error:")) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const perform: Perform = async (task, message) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setNotice("");
    try {
      await task();
      await refresh();
      if (message) setNotice(message);
    } catch (e) {
      setNotice(`Error: ${String(e)}`);
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  };
  const props = data && { data, connection, perform, local };
  const views = props && {
    overview: <Dashboard {...props} navigate={setView} />,
    accounts: <Accounts {...props} />,
    servers: <Servers {...props} />,
    projects: <Projects {...props} />,
    nodes: <Nodes {...props} />,
    settings: <Settings {...props} />,
  };
  return (
    <div className="app" data-tauri-drag-region>
      <aside
        className="sidebar"
        data-tauri-drag-region="deep"
      >
        <div className="drag-strip" />
        <nav className="nav">
          {navigation.slice(0, 5).map((n) => (
            <button
              key={n.id}
              className={`nav-item ${view === n.id ? "active" : ""}`}
              onClick={() => setView(n.id)}
            >
              <n.icon size={16} />
              {n.title}
              {data && n.id === "accounts" && (
                <span className="count">{data.accounts.length}</span>
              )}
              {data && n.id === "servers" && (
                <span className="count">{data.servers.length}</span>
              )}
              {data && n.id === "projects" && (
                <span className="count">
                  {data.projects.filter((p) => p.id !== "*").length}
                </span>
              )}
              {data && n.id === "nodes" && (
                <span className="count">{data.nodes.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={`icon-btn ${view === "settings" ? "active" : ""}`}
            title="Settings (⌘,)"
            aria-label="Settings"
            onClick={() => setView("settings")}
          >
            <Gear size={16} />
          </button>
          <button
            className="icon-btn"
            title="Getting started"
            aria-label="Getting started"
            onClick={() => setHelp(true)}
          >
            <CircleHelp size={16} />
          </button>
          <button
            className="connection"
            title={
              data && !error
                ? `Connected to ${connection.url}`
                : "Daemon disconnected"
            }
            onClick={() => setConnectOpen(true)}
          >
            <span className={`dot ${data && !error ? "online" : ""}`} />
            <span>
              {data && !error ? (data.node ?? "This machine") : "Offline"}
            </span>
            <ChevronRight size={14} />
          </button>
        </div>
      </aside>
      <main className="main">
        <div className="drag-strip" data-tauri-drag-region="deep" />
        <header className="card-header" data-tauri-drag-region="deep">
          <div className="card-title-row">
            <h1>{selected.title}</h1>
            {!local && <Badge>Remote</Badge>}
            <button
              className="tool-btn"
              title="Refresh"
              aria-label="Refresh"
              disabled={busy || !native}
              onClick={() => void refresh()}
            >
              <RefreshCw size={15} className={busy ? "spin" : ""} />
            </button>
          </div>
          <p className="card-sub">{descriptions[view]}</p>
        </header>
        <div className="pane">
          <div className="pane-inner">
            {error && (
              <div className="callout error" role="alert">
                <span>{error}</span>
                <div className="row">
                  {native && local && data && (
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() =>
                        void perform(
                          () => localAction("start", connection),
                          "Service started",
                        )
                      }
                    >
                      Start service
                    </button>
                  )}
                  <button
                    className="button"
                    onClick={() => setConnectOpen(true)}
                  >
                    Connection settings
                  </button>
                </div>
              </div>
            )}
            {props && views ? (
              <fieldset
                key={connection.url}
                disabled={busy || !!error}
                className="workspace"
              >
                {views[view]}
                {view === "settings" && (
                  <p className="version-line">
                    Agentgate{version ? ` ${version}` : ""} · The daemon keeps
                    running when you close this app.
                  </p>
                )}
              </fieldset>
            ) : (
              <div className="welcome">
                <div className="welcome-mark">
                  <ShieldCheck size={26} />
                </div>
                <h2>A home for your agent setup</h2>
                <p>
                  Pool your subscriptions, connect your tools, and keep every
                  machine in sync. The app is a window into Agentgate; the
                  daemon keeps things running.
                </p>
                <div className="welcome-features">
                  <span>
                    <Users size={14} />
                    Claude & Codex accounts
                  </span>
                  <span>
                    <Boxes size={14} />
                    Tools per repository
                  </span>
                  <span>
                    <Monitor size={14} />
                    Tailscale machines
                  </span>
                </div>
                <div className="row">
                  <button
                    className="button primary"
                    disabled={busy || !native || !local}
                    onClick={() =>
                      void perform(async () => {
                        await localAction("install", connection);
                      }, "Agentgate installed and running. Add an account to get started.")
                    }
                  >
                    {busy ? "Starting Agentgate…" : "Set up this machine"}
                  </button>
                  <button
                    className="button"
                    onClick={() => setConnectOpen(true)}
                  >
                    Connect to a daemon
                  </button>
                </div>
                <small>
                  Already using the CLI? Connect to your existing daemon.
                </small>
              </div>
            )}
          </div>
        </div>
        {(notice || update) && (
          <div className="toasts">
            {update && (
              <div className="toast" role="status">
                <span>Agentgate {update.version} is available.</span>
                <button
                  className="toast-action"
                  disabled={installing}
                  onClick={() => {
                    setInstalling(true);
                    update.install().catch((e) => {
                      setInstalling(false);
                      setNotice(`Error: ${String(e)}`);
                    });
                  }}
                >
                  {installing ? "Installing…" : "Restart to update"}
                </button>
                <button
                  aria-label="Dismiss notification"
                  onClick={() => setUpdate(null)}
                >
                  <X size={14} />
                </button>
              </div>
            )}
            {notice && (
              <div
                className={`toast ${notice.startsWith("Error:") ? "err" : ""}`}
                role="status"
              >
                <span>{notice}</span>
                <button
                  aria-label="Dismiss notification"
                  onClick={() => setNotice("")}
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>
        )}
      </main>
      {connectOpen && (
        <Modal title="Connect to Agentgate" close={() => setConnectOpen(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const c: Connection = {
                url: String(f.get("url")).trim().replace(/\/$/, ""),
                token: String(f.get("token")).trim() || undefined,
              };
              void perform(async () => {
                const next = await status(c);
                await saveConnection(c);
                current.current = c;
                setConnection(c);
                setData(next);
                setError("");
                setConnectOpen(false);
              }, "Connected");
            }}
          >
            <p className="muted">
              Connect to this machine or a node on your Tailscale network.
            </p>
            <label>
              Daemon address
              <input
                name="url"
                type="url"
                required
                defaultValue={connection.url}
                placeholder="http://127.0.0.1:7878"
              />
            </label>
            <label>
              Admin token
              <input
                name="token"
                type="password"
                autoComplete="off"
                defaultValue={connection.token}
                placeholder="Required for remote machines"
              />
            </label>
            <p className="note">
              On the remote machine, run <code>agentgate admin-token</code>.
              Your connection is saved locally.
            </p>
            <button disabled={busy || !native} className="button primary">
              Connect
            </button>
          </form>
        </Modal>
      )}
      {help && (
        <Modal title="Getting started" close={() => setHelp(false)}>
          <p>
            Agentgate runs as an independent background service. Install it here
            or use the CLI on macOS and Linux.
          </p>
          <ol className="steps">
            <li>
              <strong>Start your daemon</strong>
              <p>
                Use “Set up this machine”, or run <code>agentgate init</code>{" "}
                and <code>agentgate service install</code>.
              </p>
            </li>
            <li>
              <strong>Add your accounts and tools</strong>
              <p>
                Sign in to Claude or Codex in Accounts. Connect MCP servers,
                then assign them to Projects.
              </p>
            </li>
            <li>
              <strong>Connect your coding tools</strong>
              <p>
                Open Settings → Configure coding tools. Add the generated Claude
                and Codex paths to T3 Code.
              </p>
            </li>
            <li>
              <strong>Share across machines</strong>
              <p>
                Start Tailscale on each machine, then open Machines to pair
                them.
              </p>
            </li>
          </ol>
          <div className="note">
            <Activity size={15} /> Closing this app leaves the service, provider
            proxies, and MCP servers running.
          </div>
        </Modal>
      )}
    </div>
  );
}
