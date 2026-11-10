import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button, Card, Tabs } from "@heroui/react";
import { ExternalLink, GitPullRequest, Pause, Play, Plus, SquareTerminal } from "lucide-react";
import {
  folderLabel,
  type BoardItem,
  type FactoryBoard,
  type ItemAction,
  type ItemPhase,
  type NeedsYou,
} from "@agentgate/protocol";
import type { ViewProps } from "../types.ts";
import { openExternal, request } from "../api.ts";
import { ActionButton, Choice, Empty, Field, HeaderActions, Modal, Panel } from "../components/ui.tsx";
import { useGeneration } from "../features/proxy/useGeneration.ts";
import { ago, field } from "./utils.ts";
import { ItemDrawer } from "./factory/ItemDrawer.tsx";
import { FactoryOff } from "./factory/Init.tsx";
import { FactorySettings } from "./factory/Settings.tsx";
import { Sources } from "./factory/Sources.tsx";

/**
 * The software factory: what waits for you first, then every stage. Everything here goes through
 * `/api/factory`, which reaches the factory machine from whichever machine the app is connected to.
 */

/** What the view does to an item, for the queue, the cards and the drawer. */
export type Act = (item: Pick<BoardItem, "id" | "key">, action: ItemAction, reason?: string) => Promise<void>;
/** Asks for a reason, then acts. */
export type AskReason = (item: Pick<BoardItem, "id" | "key">, action: ItemAction, title: string) => void;

const OPEN_PHASES: readonly ItemPhase[] = ["held", "triage", "spec", "implement", "pr", "review", "ready"];
const PHASE_TITLES: Record<ItemPhase, string> = {
  held: "Held",
  triage: "Triage",
  spec: "Spec",
  implement: "Implement",
  pr: "PR",
  review: "Review",
  ready: "Ready",
  shipped: "Shipped",
  closed: "Closed",
};
const REASONS: Record<NeedsYou["reason"], string> = {
  held: "Waiting for approval",
  approval: "Asks you",
  decision: "Needs a decision",
  blocked: "Blocked",
  budget: "Over its token budget",
  stalled: "Stalled on its PR",
  failed: "Failed",
  orphaned: "Its machine is unreachable",
  stuck: "Stuck",
  "handed-off": "Handed to another machine",
  stopped: "Stopped in T3 Code",
};

/** The colour family of a state, defined in styles.css for light and dark: the stages run from understanding (think)
 * through building and checking to ready, and anything that waits for you, or failed, stands out from all of them. */
export type Tone = "held" | "think" | "build" | "check" | "ready" | "you" | "bad";
const STAGE_TONES: Record<ItemPhase, Tone> = {
  held: "held",
  triage: "think",
  spec: "think",
  implement: "build",
  pr: "build",
  review: "check",
  ready: "ready",
  shipped: "ready",
  closed: "held",
};
export const toneStyle = (tone: Tone) => ({ "--tone": `var(--tone-${tone})` }) as CSSProperties;
/** An item's colour: what waits for you, or failed, before the stage it is in. */
export const toneOf = (item: BoardItem): Tone =>
  item.needsYou ? (["failed", "stuck"].includes(item.needsYou.reason) ? "bad" : "you") : STAGE_TONES[item.phase];
/** A state in its colour, with a dot, so the eye finds what waits for you before reading. */
export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="pill" style={toneStyle(tone)}>
      {children}
    </span>
  );
}

/** The T3 Code thread an item points at: the one asking, else its newest run's. */
export const threadOf = (item: BoardItem) => item.needsYou?.link ?? item.run?.threadLink;

export function OpenInT3({ link, label = "Open in T3 Code" }: { link?: string; label?: string }) {
  if (!link) return null;
  return (
    <Button size="sm" variant="tertiary" onPress={() => void openExternal(link)}>
      <SquareTerminal size={14} />
      {label}
    </Button>
  );
}

/** The buttons an item that waits for you gets: labelled by why it waits, and only for the actions the daemon says it
 * takes now. */
export function NeedsYouActions({ item, act, ask }: { item: BoardItem; act: Act; ask: AskReason }) {
  const reason = item.needsYou?.reason;
  const key = (a: string) => `factory:${a}:${item.id}`;
  const button = (action: ItemAction, label: string, run = () => act(item, action)) =>
    item.actions.includes(action) && (
      <ActionButton
        key={action + label}
        size="sm"
        variant="tertiary"
        pendingKey={key(action)}
        onPress={() => void run()}
      >
        {label}
      </ActionButton>
    );
  const buttons: ReactNode[] = [];
  if (reason === "held") buttons.push(button("approve", "Approve"), button("reject", "Reject"));
  if (reason === "approval")
    buttons.push(
      button("approve", "Approve"),
      button("reject", "Ask for changes…", async () => ask(item, "reject", `Changes for ${item.key}`)),
    );
  if (reason === "decision")
    buttons.push(
      button("approve", "Take the recommendation"),
      button("approve", "Answer…", async () => ask(item, "approve", `Answer ${item.key}`)),
      button("reject", "Reject"),
    );
  if (reason === "blocked")
    buttons.push(button("approve", "Unblock…", async () => ask(item, "approve", `What changed for ${item.key}`)));
  buttons.push(button("retry", reason === "orphaned" ? "Take over here" : "Retry"));
  if (reason) buttons.push(button("drop", "Drop…", async () => ask(item, "drop", `Drop ${item.key}`)));
  return <>{buttons}</>;
}

function NeedsYouQueue({
  board,
  act,
  ask,
  open,
}: {
  board: FactoryBoard;
  act: Act;
  ask: AskReason;
  open: (id: string) => void;
}) {
  // The daemon's definition: a question, or a PR ready for your review. Intake pauses on the same count.
  const waiting = board.items.filter((i) => i.needsYou || i.phase === "ready");
  const { waitingForYou, waitingForYouLimit } = board.capacity;
  return (
    <Panel
      title="Needs you"
      detail={
        waiting.length
          ? `${waitingForYou} waiting for you. New items pause at ${waitingForYouLimit}.`
          : "Nothing waits for you."
      }
    >
      {waiting.length ? (
        waiting.map((item) => (
          <div className="item factory-waiting factory-toned" key={item.id} style={toneStyle(toneOf(item))}>
            <div className="grow">
              <div className="row">
                <Pill tone={toneOf(item)}>
                  {item.needsYou ? REASONS[item.needsYou.reason] : "Ready for your review"}
                </Pill>
                <button type="button" className="factory-link" onClick={() => open(item.id)}>
                  <strong>{item.key}</strong> {item.title}
                </button>
                {item.phase !== "ready" && <small className="muted">{PHASE_TITLES[item.phase]}</small>}
              </div>
              {item.needsYou?.question && <p className="factory-question">{item.needsYou.question}</p>}
              {item.needsYou?.detail && (
                <details>
                  <summary className="muted">Read it here</summary>
                  <div className="factory-detail">{item.needsYou.detail}</div>
                </details>
              )}
              {item.needsYou?.recommendation && <p className="muted">Recommended: {item.needsYou.recommendation}</p>}
              <div className="row factory-actions">
                <NeedsYouActions item={item} act={act} ask={ask} />
                {!item.needsYou && item.pr && (
                  <Button size="sm" variant="tertiary" onPress={() => void openExternal(item.pr!.url)}>
                    <GitPullRequest size={14} />
                    Pull request
                  </Button>
                )}
                <OpenInT3 link={threadOf(item)} />
              </div>
            </div>
          </div>
        ))
      ) : (
        <Empty>
          <p>When a thread asks something, a stage reports a question, or a PR is ready for you, it shows here.</p>
        </Empty>
      )}
    </Panel>
  );
}

/** What is happening to an item, in words: the stage's work while its run goes, else where it stands. */
export function statusOf(item: BoardItem): string {
  const run = item.run;
  const working = run && ["starting", "running", "waiting"].includes(run.state);
  const queued = run?.state === "queued";
  switch (item.phase) {
    case "held":
      return "Waits for your go-ahead";
    case "triage":
      return queued ? "Waiting to triage" : "Triaging";
    case "spec":
      return queued ? "Waiting to write the spec" : "Writing the spec";
    case "implement":
      return queued ? "Waiting to implement" : "Implementing";
    case "pr":
      return working ? "Fixing the PR" : "PR open, waiting for its checks";
    case "review":
      return item.pr?.reviewRound ? `Review round ${item.pr.reviewRound + (working ? 1 : 0)}` : "Reviewing the PR";
    case "ready":
      return item.pr?.openFindings
        ? `Ready for your review, ${item.pr.openFindings} findings open`
        : "Ready for your review";
    case "shipped":
      return "Merged";
    case "closed":
      return "Closed";
  }
}

function ItemCard({
  item,
  here,
  showRepo,
  open,
}: {
  item: BoardItem;
  here?: string;
  showRepo: boolean;
  open: (id: string) => void;
}) {
  const link = threadOf(item);
  return (
    <Card className="factory-card factory-toned" style={toneStyle(toneOf(item))} onClick={() => open(item.id)}>
      <div className="factory-card-key">
        {item.key}
        {showRepo ? ` · ${item.repo}` : ""}
      </div>
      <strong>{item.title}</strong>
      <div className="factory-card-meta">
        <Pill tone={toneOf(item)}>{item.needsYou ? REASONS[item.needsYou.reason] : statusOf(item)}</Pill>
        {here && item.heldBy !== here && <small>on {item.heldBy}</small>}
        {item.tokens > 0 && <small>{tokens(item.tokens)} tokens</small>}
        {item.inPhaseSince > 0 && <small>{ago(item.inPhaseSince)}</small>}
      </div>
      <div className="factory-card-links" onClick={(e) => e.stopPropagation()}>
        {link && (
          <span title="Open its thread in T3 Code">
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label={`Open ${item.key} in T3 Code`}
              onPress={() => void openExternal(link)}
            >
              <SquareTerminal size={14} />
            </Button>
          </span>
        )}
        {item.pr && (
          <span title="Open the pull request">
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label={`Open ${item.key}'s PR`}
              onPress={() => void openExternal(item.pr!.url)}
            >
              <GitPullRequest size={14} />
            </Button>
          </span>
        )}
        {item.url && (
          <span title="Open the issue">
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label={`Open ${item.key}'s issue`}
              onPress={() => void openExternal(item.url!)}
            >
              <ExternalLink size={14} />
            </Button>
          </span>
        )}
      </div>
    </Card>
  );
}

const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

function Stages({ board, open }: { board: FactoryBoard; open: (id: string) => void }) {
  const showRepo = new Set(board.items.map((i) => i.repo)).size > 1;
  const finished = board.items
    .filter((i) => !OPEN_PHASES.includes(i.phase))
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
  const inPhase = (phase: ItemPhase) => board.items.filter((i) => i.phase === phase);
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>Stages</h2>
          <p>Every open item, where it is now.</p>
        </div>
      </div>
      {/* Every stage in one line, and a column only for those that hold items: seven columns at a card's width
          do not fit the page, and the ones out of view were the ones waiting for you. */}
      <div className="factory-pipeline">
        {OPEN_PHASES.map((phase) => {
          const count = inPhase(phase).length;
          return (
            <span key={phase} className={count ? "pipe on" : "pipe"} style={toneStyle(STAGE_TONES[phase])}>
              {PHASE_TITLES[phase]} <strong>{count}</strong>
            </span>
          );
        })}
      </div>
      {OPEN_PHASES.some((p) => inPhase(p).length) ? (
        <div className="factory-stages">
          {OPEN_PHASES.map((phase) => {
            const here = inPhase(phase);
            if (!here.length) return null;
            return (
              <div className="factory-stage" key={phase} style={toneStyle(STAGE_TONES[phase])}>
                <h3>
                  {PHASE_TITLES[phase]} <span className="muted">{here.length}</span>
                </h3>
                {here.map((item) => (
                  <ItemCard key={item.id} item={item} here={board.factory?.node} showRepo={showRepo} open={open} />
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        <Empty>
          <p>Nothing is in the works. Label an issue, or add an item.</p>
        </Empty>
      )}
      {finished.length > 0 && (
        <Panel title="Finished" detail="Merged or closed in the last 7 days.">
          {finished.map((item) => (
            <button type="button" className="item factory-finished" key={item.id} onClick={() => open(item.id)}>
              <span className="factory-card-key">{item.key}</span>
              <span className="grow">{item.title}</span>
              <Pill tone={STAGE_TONES[item.phase]}>{statusOf(item)}</Pill>
              <small className="muted">{ago(item.updatedAt)}</small>
            </button>
          ))}
        </Panel>
      )}
    </section>
  );
}

function Status({ board }: { board: FactoryBoard }) {
  const c = board.capacity;
  const t3 = board.t3.stream === "live" && board.t3.mcp === "signed-in";
  // A row's tone says at a glance whether it is fine; rows that only inform have none.
  const rows: [string, ReactNode, Tone?][] = [
    [
      "Folder",
      board.config
        ? `${board.config.name} at ${board.config.commit.slice(0, 7)}${board.config.error ? `: ${board.config.error}` : ""}${board.factory ? `, ${folderLabel(board.factory)}` : ""}`
        : "Not loaded yet",
    ],
    ["Runs on", board.factory && `${board.factory.node}${board.factory.online ? "" : " (offline)"}`],
    [
      "T3 Code",
      t3 ? "Connected" : `Stream ${board.t3.stream}, MCP ${board.t3.mcp}${board.t3.error ? `: ${board.t3.error}` : ""}`,
      t3 ? "ready" : "bad",
    ],
    ["Threads working", `${c.working} of ${c.threads}`, c.working ? "build" : "held"],
    [
      "New items",
      c.paused
        ? "Paused"
        : c.intake === "on"
          ? "Taken in"
          : c.intake === "paused-for-you"
            ? "Paused until fewer wait for you"
            : "Off",
      !c.paused && c.intake === "on" ? "ready" : "you",
    ],
    [
      "Waiting for you",
      `${c.waitingForYou}; new items pause at ${c.waitingForYouLimit}`,
      c.waitingForYou ? "you" : "held",
    ],
    [
      "Subscriptions",
      c.quota === "ok"
        ? "Have room"
        : `Full${c.quota.waitingUntil ? ` until ${new Date(c.quota.waitingUntil).toLocaleTimeString()}` : ""}`,
      c.quota === "ok" ? "ready" : "you",
    ],
    [
      "Default branch CI",
      c.mainRed.length ? `Failing in ${c.mainRed.join(", ")}` : "Passing",
      c.mainRed.length ? "bad" : "ready",
    ],
  ];
  return (
    <Panel title="Status">
      {rows.map(([label, value, tone]) => (
        <div className="item" key={label}>
          <span className="grow">{label}</span>
          {tone ? <Pill tone={tone}>{value}</Pill> : <span className="muted">{value}</span>}
        </div>
      ))}
    </Panel>
  );
}

function Machines({ board }: { board: FactoryBoard }) {
  return (
    <>
      {board.machines.map((m) => (
        <Panel
          key={m.node}
          title={`T3 Code threads on ${m.node}${m.node === board.node ? " (this machine)" : ""}`}
          detail={m.online ? `${m.threads.length} open in T3 Code` : "Offline"}
        >
          {m.threads.length ? (
            m.threads.map((t) => (
              <div className="item" key={t.id}>
                <div className="grow">
                  <strong>{t.title}</strong>
                  <small className="muted">
                    {t.needsYou ? "needs you" : t.status}
                    {t.project ? ` · ${t.project}` : ""}
                  </small>
                </div>
                <OpenInT3 link={t.link} label="Open" />
              </div>
            ))
          ) : (
            <Empty>
              <p>{m.online ? "No active threads." : "This machine does not answer."}</p>
            </Empty>
          )}
        </Panel>
      ))}
    </>
  );
}

function Metrics({ board }: { board: FactoryBoard }) {
  const m = board.metrics;
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const rows: [string, string, Tone?][] = [
    ["PRs merged", String(m.merged), m.merged ? "ready" : undefined],
    ["Merge rate", m.merged ? pct(m.mergeRate) : "–"],
    ["Reverted within 14 days", String(m.reverts14d), m.reverts14d ? "bad" : undefined],
    ["Hours to merge, median", m.medianHoursToMerge === undefined ? "–" : m.medianHoursToMerge.toFixed(1)],
    ["Times you stepped in, per item", m.humanTouchesPerItem === undefined ? "–" : m.humanTouchesPerItem.toFixed(1)],
    ["Tokens per merged PR", m.tokensPerMergedPr === undefined ? "–" : tokens(m.tokensPerMergedPr)],
  ];
  return (
    <>
      <section className="section">
        <div className="section-head">
          <div>
            <h2>Last 7 days</h2>
          </div>
        </div>
        <div className="stats">
          {rows.map(([label, value, tone]) => (
            <div className={tone ? "stat toned" : "stat"} key={label} style={tone && toneStyle(tone)}>
              <strong>{value}</strong>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </section>
      {m.scorers.length > 0 && (
        <Panel title="Judges" detail="Pass rate of each judge's graded runs, by factory commit.">
          {m.scorers.map((s) => (
            <div className="item" key={s.name}>
              <span className="grow">{s.name}</span>
              <span>
                {pct(s.passRate)} of {s.runs}
              </span>
            </div>
          ))}
        </Panel>
      )}
    </>
  );
}

function Events({ board }: { board: FactoryBoard }) {
  return (
    <Panel title="History" detail="What the factory did lately, newest first.">
      {board.events.length ? (
        board.events.map((e) => (
          <div className="item factory-event" key={e.seq}>
            <span className="grow">{e.text}</span>
            <small className="muted">{ago(e.at)}</small>
          </div>
        ))
      ) : (
        <Empty>
          <p>Nothing happened yet.</p>
        </Empty>
      )}
    </Panel>
  );
}

function AddItem({
  repos,
  close,
  add,
}: {
  repos: string[];
  close: () => void;
  add: (input: { repo: string; title: string; body?: string }) => void;
}) {
  return (
    <Modal title="Add an item" close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const body = field(form, "body");
          add({ repo: field(form, "repo"), title: field(form, "title"), ...(body && { body }) });
        }}
      >
        {/* The factory works only the folder's repositories: one needs no choosing, several a list to pick from. */}
        {repos.length > 1 ? (
          <Choice
            label="Repository"
            name="repo"
            defaultValue={repos[0]}
            options={repos.map((r) => ({ id: r, label: r }))}
          />
        ) : (
          <>
            <input type="hidden" name="repo" value={repos[0] ?? ""} />
            {repos[0] && <p className="muted">For {repos[0]}. Triage starts at once.</p>}
          </>
        )}
        <Field label="Title" name="title" isRequired />
        <Field label="Details" name="body" multiline description="What happens, and what should happen instead." />
        <Button type="submit" size="sm">
          Add and triage
        </Button>
      </form>
    </Modal>
  );
}

function Reason({ title, close, submit }: { title: string; close: () => void; submit: (reason: string) => void }) {
  return (
    <Modal title={title} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(field(new FormData(e.currentTarget), "reason"));
        }}
      >
        <Field label="Reason" name="reason" multiline isRequired />
        <Button type="submit" size="sm">
          Send
        </Button>
      </form>
    </Modal>
  );
}

export function Factory(props: ViewProps) {
  const { connection, perform } = props;
  const [board, setBoard] = useState<FactoryBoard>();
  const [error, setError] = useState("");
  const [tab, setTab] = useState("items");
  const [selected, setSelected] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [asking, setAsking] = useState<{ item: Pick<BoardItem, "id" | "key">; action: ItemAction; title: string }>();
  const capture = useGeneration(connection);
  // One read at a time, for the connection shown: a read whose answer would be dropped (another connection, or the
  // first of StrictMode's two mounts) must not hold back the next for five seconds.
  const loading = useRef<() => boolean>(undefined);

  const load = async () => {
    if (loading.current?.()) return;
    const current = capture();
    loading.current = current;
    try {
      const next = await request<FactoryBoard>(connection, "/factory");
      if (current()) {
        setBoard(next);
        setError("");
      }
    } catch (e) {
      if (current()) setError(String(e));
    } finally {
      if (loading.current === current) loading.current = undefined;
    }
  };
  useEffect(() => {
    setBoard(undefined);
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [connection]);
  useEffect(() => {
    if (props.changes) void load();
  }, [props.changes]);

  /** An action, then the board as it is after it. */
  const run = (task: () => Promise<unknown>, message?: string, key?: string) =>
    perform(
      async () => {
        await task();
        await load();
      },
      message,
      key,
    );
  const act: Act = (item, action, reason) =>
    run(
      async () => {
        const r = await request<{ message: string }>(
          connection,
          `/factory/items/${encodeURIComponent(item.id)}/${action}`,
          "POST",
          reason ? { reason } : {},
        );
        return r.message;
      },
      {
        approve: `Approved ${item.key}`,
        reject: `Rejected ${item.key}`,
        retry: `Retrying ${item.key}`,
        drop: `Dropped ${item.key}`,
      }[action],
      `factory:${action}:${item.id}`,
    );
  const ask: AskReason = (item, action, title) => setAsking({ item, action, title });

  if (!board) return error ? <Empty>{error}</Empty> : <Empty>Loading the factory…</Empty>;
  if (!board.factory) return <FactoryOff {...props} board={board} refresh={load} />;
  const paused = !!board.capacity.paused;
  const repos = board.config ? [...new Set(board.sources.map((s) => s.repo))] : [];

  return (
    <div className="workspace">
      <HeaderActions>
        <Button size="sm" variant="tertiary" onPress={() => setAdding(true)}>
          <Plus size={14} />
          Add item
        </Button>
        <ActionButton
          size="sm"
          variant="tertiary"
          pendingKey="factory:pause"
          onPress={() =>
            void run(
              () => request(connection, paused ? "/factory/resume" : "/factory/pause", "POST"),
              paused ? "The factory resumed" : "The factory is paused",
              "factory:pause",
            )
          }
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
          {paused ? "Resume" : "Pause"}
        </ActionButton>
      </HeaderActions>
      {error && <p className="danger">{error}</p>}
      {paused && (
        <p className="muted">
          Paused: no intake, new threads or nudges until you resume. Running threads finish their turn.
        </p>
      )}
      <Tabs className="segmented" selectedKey={tab} onSelectionChange={(key) => setTab(String(key))}>
        <Tabs.ListContainer>
          <Tabs.List aria-label="Factory sections">
            {[
              ["items", "Items"],
              ["status", "Status"],
              ["history", "History"],
              ["settings", "Settings"],
            ].map(([id, title]) => (
              <Tabs.Tab key={id} id={id!}>
                {title}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>
      {tab === "items" && (
        <>
          <NeedsYouQueue board={board} act={act} ask={ask} open={setSelected} />
          <Stages board={board} open={setSelected} />
        </>
      )}
      {tab === "status" && (
        <>
          <Status board={board} />
          <Sources {...props} board={board} run={run} />
          <Metrics board={board} />
          <Machines board={board} />
        </>
      )}
      {tab === "history" && <Events board={board} />}
      {tab === "settings" && <FactorySettings {...props} board={board} run={run} />}
      {selected && (
        <ItemDrawer
          connection={connection}
          changes={props.changes ?? 0}
          id={selected}
          board={board}
          act={act}
          ask={ask}
          close={() => setSelected(undefined)}
        />
      )}
      {adding && (
        <AddItem
          repos={repos}
          close={() => setAdding(false)}
          add={(input) =>
            void run(async () => {
              const added = await request<{ key: string }>(connection, "/factory/items", "POST", input);
              setAdding(false);
              return added;
            }, "Item added")
          }
        />
      )}
      {asking && (
        <Reason
          title={asking.title}
          close={() => setAsking(undefined)}
          submit={(reason) => {
            const { item, action } = asking;
            setAsking(undefined);
            void act(item, action, reason);
          }}
        />
      )}
    </div>
  );
}
