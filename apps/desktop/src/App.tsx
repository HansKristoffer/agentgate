import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  Activity,
  ArrowUpRight,
  Boxes,
  ChevronRight,
  CircleHelp,
  Command,
  Cpu,
  FolderGit2,
  LayoutDashboard,
  Monitor,
  PanelLeft,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import type { Connection, Status } from "@agentgate/protocol";
import {
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
  { id: "settings", title: "Settings", icon: Settings2 },
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
  const [sidebar, setSidebar] = useState(true);
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
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebar((s) => !s);
      }
      if (e.metaKey && e.key === ",") {
        e.preventDefault();
        setView("settings");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
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
    <div className={`app ${sidebar ? "" : "sidebar-closed"}`}>
      <div className="titlebar" data-tauri-drag-region>
        <button
          className="icon-button"
          aria-label="Toggle sidebar"
          onClick={() => setSidebar((s) => !s)}
        >
          <PanelLeft size={17} />
        </button>
        <span data-tauri-drag-region>Agentgate</span>
      </div>
      {sidebar && (
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">
              <Command size={22} />
            </div>
            <div>
              <strong>Agentgate</strong>
              <small>Your agent infrastructure</small>
            </div>
          </div>
          <div className="nav-label">WORKSPACE</div>
          <nav>
            {navigation.slice(0, 5).map((n) => (
              <button
                key={n.id}
                className={`nav-item ${view === n.id ? "selected" : ""}`}
                onClick={() => setView(n.id)}
              >
                <n.icon size={18} />
                {n.title}
                {data && n.id === "accounts" && (
                  <span className="count">{data.accounts.length}</span>
                )}
                {data && n.id === "servers" && (
                  <span className="count">{data.servers.length}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <button
              className={`nav-item ${view === "settings" ? "selected" : ""}`}
              onClick={() => setView("settings")}
            >
              <Settings2 size={18} />
              Settings<span className="key">⌘,</span>
            </button>
            <button className="nav-item" onClick={() => setHelp(true)}>
              <CircleHelp size={18} />
              Getting started
              <ArrowUpRight size={14} className="end" />
            </button>
            <button className="connection" onClick={() => setConnectOpen(true)}>
              <span className={`dot ${data && !error ? "online" : ""}`} />
              <div>
                <strong>{data?.node ?? "This machine"}</strong>
                <small>
                  {data && !error ? "Daemon connected" : "Daemon disconnected"}
                </small>
              </div>
              <ChevronRight size={15} />
            </button>
          </div>
        </aside>
      )}
      <main>
        <header className="page-heading">
          <div>
            <div className="eyebrow">
              AGENTGATE <span>/</span> {local ? "LOCAL SETUP" : "REMOTE SETUP"}
            </div>
            <h1>{selected.title}</h1>
            <p>{descriptions[view]}</p>
          </div>
          <button
            className="button quiet"
            disabled={busy || !native}
            onClick={() => void refresh()}
          >
            <RefreshCw size={15} className={busy ? "spin" : ""} />
            Refresh
          </button>
        </header>
        {notice && (
          <div
            className={`notice ${notice.startsWith("Error:") ? "error" : ""}`}
            role="status"
          >
            <span>{notice}</span>
            <button
              className="icon-button"
              aria-label="Dismiss notification"
              onClick={() => setNotice("")}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {error && (
          <div className="notice error" role="alert">
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
              <button className="button" onClick={() => setConnectOpen(true)}>
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
          </fieldset>
        ) : (
          <div className="welcome">
            <div className="welcome-mark">
              <ShieldCheck size={36} />
            </div>
            <Badge>RUNS INDEPENDENTLY</Badge>
            <h2>A home for your agent setup.</h2>
            <p>
              Pool your subscriptions, connect your tools, and keep every
              machine in sync. The app gives you a window into Agentgate. The
              daemon keeps things running.
            </p>
            <div className="welcome-features">
              <span>
                <Users size={18} />
                Claude & Codex accounts
              </span>
              <span>
                <Boxes size={18} />
                Tools per repository
              </span>
              <span>
                <Monitor size={18} />
                Your Tailscale machines
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
                <ChevronRight size={16} />
              </button>
              <button className="button" onClick={() => setConnectOpen(true)}>
                Connect to a daemon
              </button>
            </div>
            <small>
              Already using the CLI? Connect to your existing daemon.
            </small>
          </div>
        )}
        <footer>
          <span>
            <Cpu size={13} />
            The daemon keeps running when you close this app.
          </span>
          <span>Agentgate{version ? ` ${version}` : ""}</span>
        </footer>
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
