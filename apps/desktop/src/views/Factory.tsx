import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Card, Tabs } from "@heroui/react";
import { ExternalLink, GitPullRequest, Pause, Play, Plus, RefreshCw, SquareTerminal } from "lucide-react";
import {
  itemPhases,
  type BoardItem,
  type FactoryBoard,
  type ItemAction,
  type ItemPhase,
  type NeedsYou,
} from "@agentgate/protocol";
import type { ViewProps } from "../types.ts";
import { openExternal, request } from "../api.ts";
import { ActionButton, Badge, Empty, Field, HeaderActions, Modal, Panel } from "../components/ui.tsx";
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
  approval: "Asks you in T3 Code",
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
          ? `${waitingForYou} wait for you; intake pauses at ${waitingForYouLimit}.`
          : "Nothing waits for you."
      }
    >
      {waiting.length ? (
        waiting.map((item) => (
          <div className="item factory-waiting" key={item.id}>
            <div className="grow">
              <div className="row">
                <Badge>{item.needsYou ? REASONS[item.needsYou.reason] : "Ready for your review"}</Badge>
                <button type="button" className="factory-link" onClick={() => open(item.id)}>
                  <strong>{item.key}</strong> {item.title}
                </button>
                <small className="muted">{PHASE_TITLES[item.phase]}</small>
              </div>
              {item.needsYou?.question && <p className="factory-question">{item.needsYou.question}</p>}
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

function ItemCard({ item, here, open }: { item: BoardItem; here?: string; open: (id: string) => void }) {
  const link = threadOf(item);
  return (
    <Card className="factory-card" onClick={() => open(item.id)}>
      <div className="factory-card-key">
        {item.key} · {item.repo}
      </div>
      <strong>{item.title}</strong>
      <div className="factory-card-meta">
        {item.needsYou && <Badge>{REASONS[item.needsYou.reason]}</Badge>}
        {item.run && (
          <small>
            {item.run.kind} {item.run.state}
            {item.run.node && item.run.node !== item.heldBy ? ` on ${item.run.node}` : ""}
          </small>
        )}
        {item.pr && (
          <small>
            PR
            {item.pr.reviewRound ? `, round ${item.pr.reviewRound}` : ""}
            {item.pr.openFindings ? `, ${item.pr.openFindings} open` : ""}
          </small>
        )}
        {here && item.heldBy !== here && <small>held by {item.heldBy}</small>}
        {item.tokensUnknown ? (
          <small>tokens unknown</small>
        ) : (
          item.tokens > 0 && <small>{tokens(item.tokens)} tokens</small>
        )}
        {item.inPhaseSince > 0 && <small>{ago(item.inPhaseSince)}</small>}
      </div>
      <div className="factory-card-links" onClick={(e) => e.stopPropagation()}>
        {link && (
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={`Open ${item.key} in T3 Code`}
            onPress={() => void openExternal(link)}
          >
            <SquareTerminal size={14} />
          </Button>
        )}
        {item.pr && (
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={`Open ${item.key}'s PR`}
            onPress={() => void openExternal(item.pr!.url)}
          >
            <GitPullRequest size={14} />
          </Button>
        )}
        {item.url && (
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={`Open ${item.key}'s issue`}
            onPress={() => void openExternal(item.url!)}
          >
            <ExternalLink size={14} />
          </Button>
        )}
      </div>
    </Card>
  );
}

const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

function Stages({ board, open }: { board: FactoryBoard; open: (id: string) => void }) {
  const phases = itemPhases.filter((p) => OPEN_PHASES.includes(p) || board.items.some((i) => i.phase === p));
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>Stages</h2>
          <p>Every open item, and those that finished in the last 7 days.</p>
        </div>
      </div>
      <div className="factory-stages">
        {phases.map((phase) => {
          const here = board.items.filter((i) => i.phase === phase);
          return (
            <div className="factory-stage" key={phase}>
              <h3>
                {PHASE_TITLES[phase]} <span className="muted">{here.length}</span>
              </h3>
              {here.map((item) => (
                <ItemCard key={item.id} item={item} here={board.factory?.node} open={open} />
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Status({ board }: { board: FactoryBoard }) {
  const c = board.capacity;
  const rows: [string, ReactNode][] = [
    [
      "Folder",
      board.factory &&
        `${board.factory.repo}${board.factory.path ? `:${board.factory.path}` : ""}${board.factory.ref ? ` at ${board.factory.ref}` : ""}`,
    ],
    ["Runs on", board.factory && `${board.factory.node}${board.factory.online ? "" : " (offline)"}`],
    [
      "Loaded",
      board.config
        ? `${board.config.name} at ${board.config.commit.slice(0, 7)}${board.config.error ? `: ${board.config.error}` : ""}`
        : "Not loaded yet",
    ],
    ["T3 Code", `stream ${board.t3.stream}, MCP ${board.t3.mcp}${board.t3.error ? `: ${board.t3.error}` : ""}`],
    ["Threads", `${c.working} of ${c.threads} working`],
    ["Intake", c.paused ? "paused" : c.intake],
    ["Waiting for you", `${c.waitingForYou} of ${c.waitingForYouLimit}`],
    [
      "Quota",
      c.quota === "ok"
        ? "ok"
        : `waiting${c.quota.waitingUntil ? ` until ${new Date(c.quota.waitingUntil).toLocaleTimeString()}` : ""}`,
    ],
    ["Default branch CI", c.mainRed.length ? `red in ${c.mainRed.join(", ")}` : "green"],
  ];
  return (
    <Panel title="Status">
      {rows.map(([label, value]) => (
        <div className="item" key={label}>
          <span className="grow">{label}</span>
          <span className="muted">{value}</span>
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
          title={`${m.node}${m.node === board.node ? " (this machine)" : ""}`}
          detail={m.online ? `${m.threads.length} active threads` : "Offline"}
        >
          {m.threads.length ? (
            m.threads.map((t) => (
              <div className="item" key={t.id}>
                <div className="grow">
                  <strong>{t.title}</strong>
                  <small className="muted">
                    {t.needsYou ? "needs you" : t.status}
                    {t.project ? ` · ${t.project}` : ""}
                    {t.item ? ` · ${t.item}` : ""}
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
  const rows: [string, string][] = [
    ["PRs merged", String(m.merged)],
    ["Merge rate", pct(m.mergeRate)],
    ["Reverts within 14 days", String(m.reverts14d)],
    ["Median hours to merge", m.medianHoursToMerge === undefined ? "–" : m.medianHoursToMerge.toFixed(1)],
    [
      "Times a person stepped in, per item",
      m.humanTouchesPerItem === undefined ? "–" : m.humanTouchesPerItem.toFixed(2),
    ],
    ["Tokens per merged PR", m.tokensPerMergedPr === undefined ? "–" : tokens(m.tokensPerMergedPr)],
  ];
  return (
    <>
      <Panel title="Last 7 days">
        {rows.map(([label, value]) => (
          <div className="item" key={label}>
            <span className="grow">{label}</span>
            <span>{value}</span>
          </div>
        ))}
      </Panel>
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
    <Panel title="Recent events">
      {board.events.length ? (
        board.events.map((e) => (
          <div className="item" key={e.seq}>
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
        <Field
          label="Repository"
          name="repo"
          isRequired
          defaultValue={repos[0]}
          description={repos.length ? `One of ${repos.join(", ")}` : undefined}
        />
        <Field label="Title" name="title" isRequired />
        <Field label="Details" name="body" multiline />
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
  const loading = useRef(false);

  const load = async () => {
    if (loading.current) return;
    loading.current = true;
    const current = capture();
    try {
      const next = await request<FactoryBoard>(connection, "/factory");
      if (current()) {
        setBoard(next);
        setError("");
      }
    } catch (e) {
      if (current()) setError(String(e));
    } finally {
      loading.current = false;
    }
  };
  useEffect(() => {
    setBoard(undefined);
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [connection]);

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
        <Button isIconOnly size="sm" variant="ghost" aria-label="Refresh" onPress={() => void load()}>
          <RefreshCw size={14} />
        </Button>
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
              ["machines", "Machines"],
              ["metrics", "Metrics"],
              ["events", "Events"],
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
        </>
      )}
      {tab === "machines" && <Machines board={board} />}
      {tab === "metrics" && <Metrics board={board} />}
      {tab === "events" && <Events board={board} />}
      {tab === "settings" && <FactorySettings {...props} board={board} run={run} />}
      {selected && (
        <ItemDrawer
          connection={connection}
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
