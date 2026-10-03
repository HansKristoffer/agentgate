import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, ScrollShadow, Toast, toast } from "@heroui/react";
import { messageOf } from "@hanskristoffer/taurio/runtime";
import {
  AppShell,
  useAppShortcuts,
  useAppUpdate,
  useAppVersion,
} from "@hanskristoffer/taurio/react";
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
  Sparkles,
  Users,
} from "lucide-react";
import type { Connection, DesktopStatus, Status } from "@agentgate/protocol";
import {
  desktopStatus,
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
  Skills,
} from "./views/index.ts";
import { desktopActions } from "./views/ClaudeDesktop.tsx";
import { useDesktopNotifications, useDesktopTray } from "./desktopTray.ts";

import type { Perform } from "./types.ts";
import {
  Badge,
  BusyContext,
  Field,
  HeaderSlot,
  Modal,
} from "./components/ui.tsx";

const navigation = [
  { id: "overview", title: "Overview", icon: LayoutDashboard },
  { id: "accounts", title: "Accounts", icon: Users },
  { id: "servers", title: "MCP servers", icon: Boxes },
  { id: "skills", title: "Skills", icon: Sparkles },
  { id: "projects", title: "Projects", icon: FolderGit2 },
  { id: "nodes", title: "Machines", icon: Monitor },
  { id: "settings", title: "Settings", icon: Gear },
] as const;
type View = (typeof navigation)[number]["id"];
const descriptions: Record<View, string> = {
  overview: "Your agents, connected.",
  accounts: "One pool for every Claude and Codex session, Claude Desktop included.",
  servers: "Connect tools once. Use them across your projects.",
  skills: "Install skills once. Choose which projects use them.",
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
  const version = useAppVersion();
  const [data, setData] = useState<Status>();
  const [desktop, setDesktop] = useState<DesktopStatus>();
  const [welcome, setWelcome] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Checked on launch and every four hours, since the app is left open for days.
  // Nothing downloads until the user chooses to install; offline is not an error.
  const updater = useAppUpdate({ enabled: native });
  const [connectOpen, setConnectOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const current = useRef(connection);
  const isLocal = useRef(false);
  const actionLock = useRef(false);
  const local =
    connection.url.replace("localhost", "127.0.0.1").replace(/\/$/, "") ===
    localUrl;
  isLocal.current = local;
  const selected = navigation.find((n) => n.id === view)!;

  useEffect(() => {
    if (!native) {
      setReady(true);
      setError("Open the Agentgate native app to connect to your setup.");
      return;
    }
    let cancelled = false;
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
      // Claude Desktop is per Mac: only the local daemon reports it.
      const desk = isLocal.current
        ? await desktopStatus(c).catch(() => undefined)
        : undefined;
      if (current.current === c) {
        setData(next);
        setDesktop(desk);
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
    if (!updater.update) return;
    const id = toast(`Agentgate ${updater.update.version} is available.`, {
      timeout: 0,
      onClose: updater.dismiss,
      actionProps: {
        children: "Restart to update",
        onPress: () =>
          void updater
            .install()
            .catch((e) => toast.danger(messageOf(e), { timeout: 0 })),
      },
    });
    return () => toast.close(id);
  }, [updater.update, updater.install, updater.dismiss]);
  useAppShortcuts({ ",": () => setView("settings") });
  // First run on this Mac: ask where Claude is used, so Claude Desktop users land on their screen.
  useEffect(() => {
    if (local && data && !data.accounts.length && !localStorage.getItem("onboarding"))
      setWelcome(true);
  }, [local, data]);
  const perform: Perform = async (task, message) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    try {
      await task();
      await refresh();
      // Confirmations fade on their own; errors stay until dismissed.
      if (message) toast(message);
    } catch (e) {
      toast.danger(messageOf(e), { timeout: 0 });
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  };
  const desktopAct = desktopActions(connection, perform);
  useDesktopTray(local ? data : undefined, desktop, desktopAct.use, desktopAct.pool);
  useDesktopNotifications(local ? data : undefined, desktop, local && !!error);
  const props = data && { data, connection, perform, local, desktop };
  const views = props && {
    overview: <Dashboard {...props} navigate={setView} />,
    accounts: <Accounts {...props} />,
    servers: <Servers {...props} />,
    skills: <Skills {...props} />,
    projects: <Projects {...props} />,
    nodes: <Nodes {...props} />,
    settings: <Settings {...props} />,
  };
  const counts: Partial<Record<View, number>> = data
    ? {
        accounts: data.accounts.length,
        servers: data.servers.length,
        skills: data.skills.length,
        projects: data.projects.filter((p) => p.id !== "*").length,
        nodes: data.nodes.length,
      }
    : {};
  return (
    <BusyContext value={busy}>
      <HeaderSlot value={actions}>
        <AppShell
          sidebar={
            <>
              <div className="tau-drag-strip" />
              <nav className="flex flex-1 flex-col gap-0.5 overflow-x-hidden overflow-y-auto px-2 pb-2">
                {navigation.slice(0, 6).map((n) => (
                  <button
                    key={n.id}
                    aria-current={view === n.id ? "page" : undefined}
                    className="group flex h-[34px] cursor-pointer w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left text-sm font-medium whitespace-nowrap text-(--tau-side-fg) hover:bg-(--tau-side-row-hover) aria-[current=page]:bg-(--tau-side-row)"
                    onClick={() => setView(n.id)}
                  >
                    <n.icon
                      size={16}
                      className="shrink-0 text-(--tau-side-fg-2) group-aria-[current=page]:text-(--tau-side-fg)"
                    />
                    {n.title}
                    {counts[n.id] !== undefined && (
                      <span className="ml-auto text-xs font-normal text-(--tau-side-fg-2)">
                        {counts[n.id]}
                      </span>
                    )}
                  </button>
                ))}
              </nav>
              <div className="flex items-center gap-2 px-3 pt-2.5 pb-3.5">
                <Button
                  isIconOnly
                  variant="tertiary"
                  aria-label="Settings"
                  aria-current={view === "settings" ? "page" : undefined}
                  className="aria-[current=page]:bg-(--tau-side-row)"
                  onPress={() => setView("settings")}
                >
                  <Gear size={16} />
                </Button>
                <Button
                  isIconOnly
                  variant="tertiary"
                  aria-label="Getting started"
                  onPress={() => setHelp(true)}
                >
                  <CircleHelp size={16} />
                </Button>
                <Button
                  variant="tertiary"
                  className="min-w-0 flex-1 justify-start"
                  onPress={() => setConnectOpen(true)}
                >
                  <span className={`dot ${data && !error ? "online" : ""}`} />
                  <span
                    className="min-w-0 flex-1 truncate text-left"
                    title={
                      data && !error
                        ? `Connected to ${connection.url}`
                        : "Daemon disconnected"
                    }
                  >
                    {data && !error ? (data.node ?? "This machine") : "Offline"}
                  </span>
                  <ChevronRight size={14} className="text-(--tau-side-fg-2)" />
                </Button>
              </div>
            </>
          }
        >
          <header className="card-header" data-tauri-drag-region="deep">
            <div className="card-title-row">
              <h1>{selected.title}</h1>
              {!local && <Badge>Remote</Badge>}
              {/* Views portal their actions here; blocked like the workspace below. */}
              <div
                ref={setActions}
                className="header-actions"
                inert={busy || !!error}
              />
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label="Refresh"
                isDisabled={busy || !native}
                onPress={() => void refresh()}
              >
                <RefreshCw size={15} className={busy ? "spin" : ""} />
              </Button>
            </div>
            <p className="card-sub">{descriptions[view]}</p>
          </header>
          <ScrollShadow className="pane">
            <div className="pane-inner">
              {error && (
                <Alert status="danger" className="callout" role="alert">
                  <Alert.Content>
                    <Alert.Description>{error}</Alert.Description>
                  </Alert.Content>
                  <div className="row">
                    {native && local && data && (
                      <Button
                        size="sm"
                        variant="tertiary"
                        isDisabled={busy}
                        onPress={() =>
                          void perform(
                            () => localAction("start", connection),
                            "Service started",
                          )
                        }
                      >
                        Start service
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="tertiary"
                      onPress={() => setConnectOpen(true)}
                    >
                      Connection settings
                    </Button>
                  </div>
                </Alert>
              )}
              {props && views ? (
                <fieldset
                  key={connection.url}
                  disabled={busy || !!error}
                  inert={busy || !!error}
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
                    <Button
                      size="sm"
                      isDisabled={busy || !native || !local}
                      onPress={() =>
                        void perform(async () => {
                          await localAction("install", connection);
                        }, "Agentgate installed and running. Add an account to get started.")
                      }
                    >
                      {busy ? "Starting Agentgate…" : "Set up this machine"}
                    </Button>
                    <Button
                      size="sm"
                      variant="tertiary"
                      onPress={() => setConnectOpen(true)}
                    >
                      Connect to a daemon
                    </Button>
                  </div>
                  <small>
                    Already using the CLI? Connect to your existing daemon.
                  </small>
                </div>
              )}
            </div>
          </ScrollShadow>
          <Toast.Provider placement="bottom end" />
        </AppShell>
        {connectOpen && (
          <Modal
            title="Connect to Agentgate"
            close={() => setConnectOpen(false)}
          >
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
              <Field
                label="Daemon address"
                name="url"
                type="url"
                isRequired
                defaultValue={connection.url}
                placeholder="http://127.0.0.1:7878"
              />
              <Field
                label="Admin token"
                name="token"
                type="password"
                autoComplete="off"
                defaultValue={connection.token}
                placeholder="Required for remote machines"
              />
              <p className="note">
                On the remote machine, run <code>agentgate admin-token</code>.
                Your connection is saved locally.
              </p>
              <Button type="submit" size="sm" isDisabled={busy || !native}>
                Connect
              </Button>
            </form>
          </Modal>
        )}
        {welcome && (
          <Modal
            title="Where do you use Claude?"
            close={() => {
              localStorage.setItem("onboarding", "skipped");
              setWelcome(false);
            }}
          >
            <p>
              Agentgate shows you the right setup. Everything stays available
              later.
            </p>
            <div className="choice-list">
              {[
                ...(desktop?.available
                  ? [
                      {
                        id: "desktop",
                        title: "The Claude Desktop app",
                        body: "Chat, Cowork or the Code tab in Claude Desktop.",
                      },
                    ]
                  : []),
                {
                  id: "terminal",
                  title: "Terminal, T3 Code or Codex",
                  body: "Claude Code or Codex sessions on this or other machines.",
                },
                ...(desktop?.available
                  ? [
                      {
                        id: "both",
                        title: "Both",
                        body: "Start with Claude Desktop; the terminal setup is in Settings.",
                      },
                    ]
                  : []),
              ].map((o) => (
                <button
                  key={o.id}
                  className="choice"
                  onClick={() => {
                    localStorage.setItem("onboarding", o.id);
                    setWelcome(false);
                    if (o.id === "terminal") setHelp(true);
                    else setView("accounts");
                  }}
                >
                  <strong>{o.title}</strong>
                  <span>{o.body}</span>
                </button>
              ))}
            </div>
          </Modal>
        )}
        {help && (
          <Modal title="Getting started" close={() => setHelp(false)}>
            <p>
              Agentgate runs as an independent background service. Install it
              here or use the CLI on macOS and Linux.
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
                  Sign in to Claude or Codex in Accounts. Connect MCP servers
                  and install skills, then assign them to Projects.
                </p>
              </li>
              <li>
                <strong>Connect your coding tools</strong>
                <p>
                  Open Settings → Configure coding tools. Add the generated
                  Claude and Codex paths to T3 Code.
                </p>
              </li>
              <li>
                <strong>Using the Claude Desktop app?</strong>
                <p>
                  Open Accounts. Its Claude Desktop panel lets you switch
                  accounts in Desktop, or share your subscriptions in its Code
                  tab.
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
              <Activity size={15} /> Closing this app leaves the service,
              provider proxies, and MCP servers running.
            </div>
          </Modal>
        )}
      </HeaderSlot>
    </BusyContext>
  );
}
