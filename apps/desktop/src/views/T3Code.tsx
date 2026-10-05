import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@heroui/react";
import { ArrowLeftRight, GitBranch, LoaderCircle, Monitor, SquareTerminal } from "lucide-react";
import { firstServer, handoffJobSchema, handoffTargets, nodeThreadsSchema, type HandoffJob, type NodeThreads, type T3Thread } from "@agentgate/protocol";
import { Badge, Empty, Field, HeaderActions, Modal, Panel, RowMenu } from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { request } from "../api.ts";
import { ago, elapsed, field, since } from "./utils.ts";

const STEPS: Record<string, string> = {
  resolve: "Starting",
  stop: "Stopping agent",
  package: "Packing code and session",
  send: "Sending",
  finish: "Archiving here",
};
const TIMINGS: Record<string, string> = {
  resolve: "Resolve", stop: "Stop", package: "Pack", send: "Send",
  prepare: "Prepare", apply: "Apply code", place: "Place session", import: "Import", setup: "Setup", continue: "Continue",
};
const SHOW_FINISHED = 60_000;

const timings = (job: HandoffJob) => job.timings
  .filter((t) => TIMINGS[t.step])
  .map((t) => `${TIMINGS[t.step]}${t.node === job.from ? "" : ` on ${t.node}`} ${(t.ms / 1000).toFixed(1)} s`)
  .join(" · ");

/** What a handoff is doing, or how it ended. B prepares while A stops and packs, so those steps mention it. */
function progress(j: HandoffJob) {
  if (j.status === "failed") return `Failed: ${j.error}`;
  if (j.status !== "running") return `Running on ${j.to} · ${ago(j.updatedAt)}`;
  const step = j.step === "await" ? `Importing on ${j.to}` : STEPS[j.step] ?? j.step;
  return ["resolve", "stop", "package"].includes(j.step) ? `${step} · Preparing ${j.to}` : step;
}

function connection(v: NodeThreads) {
  if (v.error) return v.error;
  if (!v.t3?.url) return "Not connected";
  if (!v.t3.connected) return "Re-pair needed";
  if (v.t3.error) return v.t3.error;
  const days = Math.max(0, Math.floor(((v.t3.expiresAt ?? 0) - Date.now()) / 86_400_000));
  return v.t3.repair ? `Token expires in ${days} days, pair again` : "Connected";
}

const needsT3 = (v: NodeThreads) => !v.t3?.connected || !!v.t3.repair;

/** Why a machine's T3 Code can't be connected from here. Connecting sends a pairing token, so only the app on this
 * machine offers it (the API refuses remote callers too), and only to a machine whose daemon answers. */
function cannotConnect(v: NodeThreads, local: boolean) {
  if (!local) return "Connect T3 Code from the app on this machine; a remote connection can't send pairing links";
  return v.error ? `${v.error}. Pair it with this machine first (Machines page).` : undefined;
}

/** Each machine's T3 Code connection, and connecting it, from here or for another machine. */
function MachinesDialog({ views, here, local, conn, perform, initial, connected, close }: Pick<ViewProps, "local" | "perform"> & {
  views: NodeThreads[];
  here: string;
  conn: ViewProps["connection"];
  /** The machine whose connect form is open first. */
  initial?: string;
  connected: () => Promise<void>;
  close: () => void;
}) {
  const [pairingNode, setPairingNode] = useState(initial);
  const elsewhere = pairingNode !== here;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const pairingUrl = field(new FormData(e.currentTarget), "pairingUrl");
    const node = pairingNode!;
    void perform(async () => {
      await request(conn, `/t3/connect?node=${encodeURIComponent(node)}`, "POST", { pairingUrl });
      await connected();
      close();
    }, `T3 Code connected on ${node}`);
  };
  const disconnect = (node: string) => perform(
    () => request(conn, `/t3?node=${encodeURIComponent(node)}`, "DELETE"),
    `T3 Code disconnected on ${node}`,
  );

  return (
    <Modal title="Machines" close={close}>
      <p className="muted">Each machine's agentgate talks to the T3 Code running next to it. Set up any of them from here.</p>
      <Panel>
        {views.map((v) => (
          <div className="item" key={v.node}>
            <div className="machine-icon"><Monitor size={16} /></div>
            <div className="grow">
              <div className="row">
                <strong>{v.node}</strong>
                {v.node === here && <Badge>This node</Badge>}
                {v.server && <Badge>Server</Badge>}
              </div>
              <small>{connection(v)}{v.t3?.label ? ` · ${v.t3.label}` : ""}</small>
            </div>
            {needsT3(v) ? (
              <span title={cannotConnect(v, local)}>
                <Button size="sm" variant="tertiary" isDisabled={!!cannotConnect(v, local) || pairingNode === v.node} onPress={() => setPairingNode(v.node)}>
                  Connect T3 Code
                </Button>
              </span>
            ) : (
              <Badge good={!v.error}>{v.error ? "Unavailable" : "Connected"}</Badge>
            )}
            {v.t3?.url && !v.error && (
              <RowMenu label={`More for ${v.node}`} items={[{ label: "Disconnect T3 Code", danger: true, onAction: () => void disconnect(v.node) }]} />
            )}
          </div>
        ))}
      </Panel>
      {pairingNode && (
        <>
          <ol className="steps">
            <li>
              <strong>Turn on Network access in T3 Code{elsewhere ? ` on ${pairingNode}` : ""}</strong>
              <p>Settings → Connections. T3 Code only offers pairing links while it is on. agentgate itself connects on that machine only.</p>
            </li>
            <li>
              <strong>Create a pairing link there</strong>
              <p>Authorized clients → Create link. Name it Agentgate and choose Standard: agentgate needs to view and operate threads, not to manage access or the relay.</p>
            </li>
            <li>
              <strong>Paste it below within five minutes</strong>
              <p>
                Any of the links works{elsewhere ? `; agentgate sends it to ${pairingNode} over your paired connection` : ""}.
                Then you can turn Network access off again; agentgate keeps working for 30 days and tells you when to pair again.
              </p>
            </li>
          </ol>
          <Panel>
            <form className="item" onSubmit={submit}>
              <Field className="field grow" label={`Pairing link from ${pairingNode}`} name="pairingUrl" isRequired placeholder="http://192.168.1.10:3773/pair#token=…" />
              <Button type="submit" size="sm">Connect</Button>
            </form>
          </Panel>
        </>
      )}
    </Modal>
  );
}

/** A thread laid out like T3 Code's sidebar row, so the same thread is easy to find in both apps. */
function ThreadRow({ thread: t, machine, here, action }: { thread: T3Thread; machine: NodeThreads; here: string; action: ReactNode }) {
  const where = machine.node === here ? " (this machine)" : machine.server ? " (server)" : "";
  return (
    <div className="item">
      <div className="grow thread">
        <div className="thread-line">
          <span><span>{t.project}</span></span>
          {t.running ? (
            <span className="working">
              <LoaderCircle size={12} />
              Working{t.workingSince ? ` ${elapsed(t.workingSince)}` : ""}
            </span>
          ) : (
            <span>{since(t.lastActivity)}</span>
          )}
        </div>
        <strong>{t.title}</strong>
        <div className="thread-line">
          <span>
            <GitBranch size={12} />
            <span>{t.branch ?? "Main checkout"}</span>
          </span>
        </div>
        <div className="thread-line">
          <span>
            <Monitor size={12} />
            <span>{machine.node}{where}</span>
          </span>
        </div>
      </div>
      {action}
    </div>
  );
}

/** Threads on every machine with one action each: "To here" for a thread elsewhere, "To server" for one here. */
export function T3Code({ data, connection: conn, perform, local }: ViewProps) {
  const [nodes, setNodes] = useState<NodeThreads[]>();
  const [started, setStarted] = useState<{ handoffId: string; node: string }[]>([]);
  const [jobs, setJobs] = useState<Record<string, HandoffJob>>({});
  const [error, setError] = useState("");
  const [machinesOpen, setMachinesOpen] = useState(false);
  const live = useRef(true);
  const here = data.node;
  const load = async () => {
    try {
      // Validated like status: the daemon may be another machine's, on another version.
      const parsed = nodeThreadsSchema.array().safeParse(await request(conn, "/threads"));
      if (!parsed.success) throw new Error("A machine returned incompatible thread data. Update Agentgate on every machine.");
      const next = parsed.data;
      // Jobs started from this app, until they finish: the node driving one may stop listing it while it runs.
      const job = async (s: (typeof started)[number]) => {
        const answer = await request(conn, `/handoffs/${s.handoffId}?node=${encodeURIComponent(s.node)}`).catch(() => undefined);
        return handoffJobSchema.safeParse(answer).data;
      };
      const tracked = await Promise.all(started.map(job));

      if (!live.current) return;
      setNodes(next);
      const found = tracked.filter((j): j is HandoffJob => !!j);
      setJobs((old) => ({ ...old, ...Object.fromEntries(found.map((j) => [j.id, j])) }));
      const finished = new Set(found.filter((j) => j.status !== "running").map((j) => j.id));
      if (finished.size) setStarted((old) => old.filter((s) => !finished.has(s.handoffId)));
      setError("");
    } catch (e) {
      if (live.current) setError(String(e));
    }
  };
  useEffect(() => {
    live.current = true;
    void load();
    const timer = setInterval(() => void load(), started.length ? 1500 : 5000);
    // Like the rest of the app: coming back to the window shows current threads, not the last poll.
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => {
      live.current = false;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [conn, started]);

  const views = nodes ?? [];
  // A job may come from the listing and from this app's own tracking; the newer copy wins.
  const all = new Map<string, HandoffJob>();
  for (const j of [...views.flatMap((v) => v.jobs), ...Object.values(jobs)]) {
    if ((all.get(j.id)?.updatedAt ?? 0) <= j.updatedAt) all.set(j.id, j);
  }
  const recent = [...all.values()].filter((j) => j.role === "source" && (j.status === "running" || Date.now() - j.updatedAt < SHOW_FINISHED));
  const runningFor = (t: T3Thread) => recent.find((j) => j.thread === t.id && j.from === t.node && j.status === "running");
  const servers = views.filter((v) => v.server);
  const self = views.find((v) => v.node === here);
  const online = views.filter((v) => v.online).length;
  const canConnect = !!self && !cannotConnect(self, local) && needsT3(self);

  const action = (t: T3Thread) => {
    const list = handoffTargets(views, t.node);
    const toHere = t.node !== here;
    const target = toHere ? list.find((x) => x.node === here) : firstServer(list);
    if (!toHere && !list.some((x) => x.server)) return null; // no other server: nothing to offer
    const job = runningFor(t);
    const reason = !t.claude ? "Only Claude Code threads can be handed off"
      : job ? "A handoff of this thread is already running"
        : !target ? list.filter((x) => x.server).map((x) => `${x.node}: ${x.reason}`).join("; ")
          : !target.available ? target.reason : undefined;
    return (
      <span title={reason}>
        <Button size="sm" variant="tertiary" isDisabled={!!reason} onPress={() => void perform(async () => {
          const body = { threadId: t.id, node: t.node, to: toHere ? "here" : "server" };
          const r = await request<{ handoffId: string; node: string }>(conn, "/handoffs", "POST", body);
          setStarted((old) => [...old, { handoffId: r.handoffId, node: r.node }]);
        }, `Handing ${t.title} to ${toHere ? here : target!.node}`)}>
          <ArrowLeftRight size={14} />
          {toHere ? "To here" : "To server"}
        </Button>
      </span>
    );
  };

  return (
    <>
      <HeaderActions>
        <Button size="sm" variant="tertiary" onPress={() => setMachinesOpen(true)}>
          <Monitor size={15} />
          Machines ({online}/{views.length})
        </Button>
      </HeaderActions>
      {machinesOpen && (
        <MachinesDialog
          views={views} here={here} local={local} conn={conn} perform={perform}
          initial={canConnect ? here : undefined}
          connected={load}
          close={() => setMachinesOpen(false)}
        />
      )}
      {recent.length > 0 && (
        <Panel title="Handoffs">
          {recent.map((j) => (
            <div className="item" key={j.id}>
              <div className="grow">
                <strong>{j.title ?? j.thread}</strong>
                <small>{j.from} → {j.to} · {progress(j)}</small>
                {j.status !== "running" && j.status !== "failed" && <small>{timings(j)}</small>}
                {j.warnings.map((w) => <small key={w}>{w}</small>)}
              </div>
              <Badge good={j.status === "imported" || j.status === "done"}>{j.status === "running" ? "Moving" : j.status === "failed" ? "Failed" : "Done"}</Badge>
            </div>
          ))}
        </Panel>
      )}
      <Panel title="Active threads" foot={!servers.length ? "Mark a machine as a server (Always on, on the Machines page) to use To server." : undefined}>
        {error && <div className="item"><small>{error}</small></div>}
        {!views.some((v) => v.threads.length) ? (
          <Empty>
            <SquareTerminal size={22} />
            <strong>{self?.t3?.connected ? "No active threads." : "Connect T3 Code on this machine to see its threads."}</strong>
            {canConnect && (
              <Button size="sm" variant="tertiary" onPress={() => setMachinesOpen(true)}>
                Connect T3 Code
              </Button>
            )}
          </Empty>
        ) : views.filter((v) => v.threads.length).map((v) => v.threads.map((t) => (
          <ThreadRow key={`${v.node}:${t.id}`} thread={t} machine={v} here={here} action={action(t)} />
        )))}
      </Panel>
    </>
  );
}
