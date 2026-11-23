import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Spinner } from "@heroui/react";
import {
  ArrowRight,
  CheckCircle2,
  GitPullRequest,
  Layers,
  Monitor,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import type { ViewProps } from "../types.ts";
import { factoryEmbedUrl, factoryHealth, openExternal, type FactoryHealth } from "../api.ts";
import { Badge, HeaderActions, Panel } from "../components/ui.tsx";

export type FactorySection = "board" | "dashboard" | "intake" | "done" | "settings";

export const FACTORY_SECTIONS: readonly { id: FactorySection; label: string; hash: string }[] = [
  { id: "board", label: "Board", hash: "#/" },
  { id: "dashboard", label: "Dashboard", hash: "#/dashboard" },
  { id: "intake", label: "Intake", hash: "#/intake" },
  { id: "done", label: "Done", hash: "#/done" },
  { id: "settings", label: "Settings", hash: "#/settings" },
];

export type FactoryLiveState = {
  section: FactorySection;
  hash: string;
  open: number;
  needsYou: number;
  repos: string[];
  repoScope: string;
  connected: boolean;
  issueTitle: string | null;
};

const STORAGE_MACHINE = "agentgate-factory-machine";

function systemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function sectionFromPage(page: unknown): FactorySection {
  if (page === "dashboard" || page === "intake" || page === "done" || page === "settings") return page;
  return "board";
}

function isAllowedExternalUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "t3:";
  } catch {
    return false;
  }
}

export function Factory({
  data,
  connection,
  machine,
  onMachineChange,
  targetHash,
  onStateChange,
  onOpenSkills,
}: ViewProps & {
  machine: string;
  onMachineChange: (node: string) => void;
  targetHash: string;
  onStateChange: (state: FactoryLiveState) => void;
  onOpenSkills: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const loadedFrameRef = useRef<HTMLIFrameElement | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(systemTheme);
  const [probeSeq, setProbeSeq] = useState(0);
  const [probe, setProbe] = useState<{
    machine: string;
    status: "checking" | "ready" | "error";
    health?: FactoryHealth;
    error?: string;
  }>({ machine, status: "checking" });
  const [live, setLive] = useState<FactoryLiveState>({
    section: "board",
    hash: targetHash,
    open: 0,
    needsYou: 0,
    repos: [],
    repoScope: "",
    connected: false,
    issueTitle: null,
  });

  // Sort machines with the connected daemon first, then online machines, then alphabetically.
  const machines = useMemo(() => {
    const list = data.nodes.slice();
    list.sort((a, b) => {
      if (a.id === data.node) return -1;
      if (b.id === data.node) return 1;
      return a.id.localeCompare(b.id);
    });
    return list;
  }, [data.nodes, data.node]);

  // If the saved machine is no longer in the group, fall back to the connected node.
  useEffect(() => {
    if (!machines.some((m) => m.id === machine) && data.node) {
      onMachineChange(data.node);
    }
  }, [machines, machine, data.node, onMachineChange]);

  // Track macOS appearance changes and push them into the embedded Factory.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      const next = mq.matches ? "dark" : "light";
      setTheme(next);
      iframeRef.current?.contentWindow?.postMessage({ type: "factory:theme", theme: next }, "*");
    };
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Probe the selected machine's Factory over the connected daemon (locally, Tailscale, or relay).
  useEffect(() => {
    if (!machine) return;
    let cancelled = false;
    setProbe({ machine, status: "checking" });
    void factoryHealth(connection, machine)
      .then((health) => {
        if (!cancelled) setProbe({ machine, status: "ready", health });
      })
      .catch((e) => {
        if (!cancelled) setProbe({ machine, status: "error", error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [connection, machine, probeSeq]);

  const postToFrame = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  // Navigate inside the already-loaded Factory iframe when the user clicks a sidebar sub-item.
  useEffect(() => {
    if (probe.status === "ready" && probe.machine === machine) {
      postToFrame({ type: "factory:navigate", hash: targetHash });
    }
  }, [targetHash, probe.status, probe.machine, machine, postToFrame]);

  // Listen to state updates and external link opens from the embedded Factory page.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const msg = e.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "factory:open" && typeof msg.url === "string") {
        if (isAllowedExternalUrl(msg.url)) void openExternal(msg.url);
        return;
      }
      if (msg.type === "factory:state") {
        const next: FactoryLiveState = {
          section: sectionFromPage(msg.page),
          hash: typeof msg.hash === "string" ? msg.hash : "#/",
          open: typeof msg.open === "number" ? msg.open : 0,
          needsYou: typeof msg.needsYou === "number" ? msg.needsYou : 0,
          repos: Array.isArray(msg.repos) ? msg.repos.filter((r: unknown): r is string => typeof r === "string") : [],
          repoScope: typeof msg.repoScope === "string" ? msg.repoScope : "",
          connected: !!msg.connected,
          issueTitle: typeof msg.title === "string" ? msg.title : null,
        };
        setLive(next);
        onStateChange(next);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onStateChange]);

  // Initial embed URL is keyed by machine + probeSeq; sub-navigation uses postMessage so the iframe never reloads.
  const initialHashRef = useRef(targetHash);
  const initialThemeRef = useRef(theme);
  const frameSrc = useMemo(() => {
    initialHashRef.current = targetHash;
    initialThemeRef.current = theme;
    return factoryEmbedUrl(machine, initialHashRef.current, initialThemeRef.current);
    // Intentionally only rebuild src when machine or explicit retry changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine, probeSeq]);

  const ready = probe.status === "ready" && probe.machine === machine;
  const hasFactorySkill = data.skills.some((s) => s.id === "factory");
  const isLocalMachine = machine === data.node;
  const otherMachines = machines.filter((m) => m.id !== machine);

  return (
    <>
      <HeaderActions>
        <label className="factory-select-wrap" aria-label="Factory machine">
          <Monitor size={14} className="muted" />
          <select
            className="factory-select"
            value={machine}
            onChange={(e) => {
              const next = e.target.value;
              try {
                localStorage.setItem(STORAGE_MACHINE, next);
              } catch {
                // Ignore storage errors.
              }
              onMachineChange(next);
            }}
          >
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
                {m.id === data.node ? " (this machine)" : ""}
              </option>
            ))}
          </select>
        </label>
        {ready && live.repos.length > 1 && (
          <select
            className="factory-select"
            aria-label="Repository scope"
            value={live.repoScope}
            onChange={(e) => postToFrame({ type: "factory:scope", repo: e.target.value })}
          >
            <option value="">All repos</option>
            {live.repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        )}
        {ready && (
          <>
            <Button
              size="sm"
              variant="tertiary"
              isIconOnly
              aria-label="Search Factory"
              onPress={() => postToFrame({ type: "factory:action", action: "cmdk" })}
            >
              <Search size={14} />
            </Button>
            <Button size="sm" variant="primary" onPress={() => postToFrame({ type: "factory:action", action: "new" })}>
              <Plus size={14} />
              New issue
            </Button>
          </>
        )}
      </HeaderActions>

      {probe.status === "checking" && (
        <div className="factory-state-pane">
          <Spinner size="md" color="current" aria-label={`Connecting to Factory on ${machine}`} />
          <p className="muted">Connecting to Factory on {machine}...</p>
        </div>
      )}

      {probe.status === "error" && (
        <div className="factory-guide-scroll">
          <div className="factory-guide">
            <Panel
              title={`Factory is not reachable on ${machine}`}
              detail={probe.error || "Start the factory service on that machine, or pick another machine above."}
              action={
                <Button size="sm" variant="primary" onPress={() => setProbeSeq((n) => n + 1)}>
                  <RefreshCw size={14} />
                  Retry
                </Button>
              }
            >
              <div className="item">
                <div className="grow">
                  <strong>Expected service address</strong>
                  <small>
                    Listens on <code>http://127.0.0.1:4400</code> on {machine} (override with <code>FACTORY_PORT</code>
                    ).
                    {!isLocalMachine &&
                      " Agentgate tunnels directly over Tailscale or through your encrypted relay when it is running."}
                  </small>
                </div>
                {otherMachines.length > 0 && (
                  <Button
                    size="sm"
                    variant="tertiary"
                    onPress={() => {
                      const next = otherMachines[0]!.id;
                      try {
                        localStorage.setItem(STORAGE_MACHINE, next);
                      } catch {
                        // Ignore storage errors.
                      }
                      onMachineChange(next);
                    }}
                  >
                    Try {otherMachines[0]!.id}
                  </Button>
                )}
              </div>
            </Panel>

            <Panel
              title={`Set up Factory on ${machine}`}
              detail="Factory runs as a skill-backed local service. No extra ports or tunnels are needed."
            >
              <div className="item">
                <span className="factory-step-num">1</span>
                <div className="grow">
                  <div className="row">
                    <strong>Install the factory skill</strong>
                    {hasFactorySkill && <Badge good>Installed</Badge>}
                  </div>
                  <small>
                    {hasFactorySkill
                      ? "The factory skill is already in Agentgate and synced to your machines. Make sure it is linked to your projects or global defaults."
                      : "Add the HansKristoffer/hanzio-skills repository (or the factory skill) in Skills so Agentgate links it into your coding sessions on every machine."}
                  </small>
                </div>
                <Button size="sm" variant="tertiary" onPress={onOpenSkills}>
                  <Sparkles size={14} />
                  {hasFactorySkill ? "View in Skills" : "Open Skills"}
                  <ArrowRight size={13} />
                </Button>
              </div>
              <div className="item">
                <span className="factory-step-num">2</span>
                <div className="grow">
                  <strong>Start your first Factory issue in T3 Code</strong>
                  <small>
                    Open a T3 Code thread on {machine} and ask it to work an issue with the <code>factory</code> skill.
                    The first command starts the local Factory service automatically and keeps it running in the
                    background.
                  </small>
                </div>
              </div>
              <div className="item">
                <span className="factory-step-num">3</span>
                <div className="grow">
                  <strong>Come back here and press Retry</strong>
                  <small>
                    Once running on {machine}, this view shows live issues, approvals, visual proof, and settings right
                    inside Agentgate. You can switch between machines any time from the selector above.
                  </small>
                </div>
              </div>
            </Panel>

            <Panel
              title="How the Factory works"
              detail="Each issue runs as one T3 Code orchestrator thread with staged subagents."
            >
              <div className="item">
                <Layers size={16} className="muted shrink-0" />
                <div className="grow">
                  <strong>Research & Plan</strong>
                  <small>
                    Reproduces bugs, sizes the change, drafts an implementation plan, and collects only the open
                    decisions that need your answer.
                  </small>
                </div>
              </div>
              <div className="item">
                <GitPullRequest size={16} className="muted shrink-0" />
                <div className="grow">
                  <strong>Implement & Blind Review</strong>
                  <small>
                    Runs each stage on the model your settings pick, reviews the diff in an isolated worktree, and
                    attaches screenshots, benchmarks, and a PR overview.
                  </small>
                </div>
              </div>
              <div className="item">
                <CheckCircle2 size={16} className="muted shrink-0" />
                <div className="grow">
                  <strong>Decide & Ship from anywhere</strong>
                  <small>
                    Approve plans, answer questions, spin up a preview, and decide merges from this window, whether the
                    factory runs on this Mac or a remote server behind the relay.
                  </small>
                </div>
              </div>
            </Panel>
          </div>
        </div>
      )}

      {ready && (
        <iframe
          key={`${machine}:${probeSeq}`}
          ref={iframeRef}
          className="factory-frame"
          src={frameSrc}
          title={`Factory on ${machine}`}
          onLoad={(e) => {
            postToFrame({ type: "factory:theme", theme });
            // WebKit fires `load` on the iframe for in-page hash changes too, so navigating on every load would send
            // each click inside Factory straight back to the sidebar's section. Only a new frame needs it.
            if (loadedFrameRef.current === e.currentTarget) return;
            loadedFrameRef.current = e.currentTarget;
            postToFrame({ type: "factory:navigate", hash: targetHash });
          }}
        />
      )}
    </>
  );
}

export function loadSavedFactoryMachine(fallback: string): string {
  try {
    return localStorage.getItem(STORAGE_MACHINE) || fallback;
  } catch {
    return fallback;
  }
}
