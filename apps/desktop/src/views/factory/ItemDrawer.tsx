import { Button } from "@heroui/react";
import { ExternalLink, GitPullRequest } from "lucide-react";
import type { Connection, FactoryBoard, WriteMoment } from "@agentgate/protocol";
import { factoryOp, openExternal } from "../../api.ts";
import { Badge, Empty, Modal, Panel } from "../../components/ui.tsx";
import { useDaemon } from "../../useDaemon.ts";
import { ago } from "../utils.ts";
import {
  ItemActions,
  NeedsYouText,
  OpenInT3,
  Pill,
  statusOf,
  toneOf,
  type Act,
  type AskReason,
  type Tone,
} from "./parts.tsx";

const STAGES: Record<string, string> = {
  triage: "Triage",
  spec: "Spec",
  implement: "Implement",
  review: "Review",
  scout: "Scout",
};
const RUN_TONES: Record<string, Tone> = {
  queued: "held",
  starting: "build",
  running: "build",
  waiting: "you",
  reported: "ready",
  silent: "bad",
  failed: "bad",
  cancelled: "held",
};
const RUN_STATES: Record<string, string> = {
  queued: "queued",
  starting: "starting",
  running: "working",
  waiting: "asks you",
  reported: "done",
  silent: "ended without a report",
  failed: "failed",
  cancelled: "stopped",
};
/** What each write-back is, for a person: the moment's comment on the issue, or the other things the outbox writes. */
const WRITES: Record<WriteMoment, string> = {
  taken: "Said the factory took it",
  triaged: "Posted the triage result",
  "spec-approved": "Posted the approved spec",
  "pr-opened": "Opened the draft pull request",
  ready: "Marked the pull request ready",
  shipped: "Said it was merged",
  closed: "Said why it closed",
  waiting: "Asked you on the issue",
  reply: "Replied in a review conversation",
  issue: "Filed a follow-up issue",
  notify: "Sent a notification",
};

/** One item: its runs with their T3 Code threads and errors, what the factory posted for it, and its events. Read with
 * the `show` operation, which reaches the factory machine. */
export function ItemDrawer({
  connection,
  every,
  id,
  board,
  act,
  ask,
  close,
}: {
  connection: Connection;
  /** How often the detail is asked again with no change reported; the board's own interval. */
  every?: number;
  id: string;
  board: FactoryBoard;
  act: Act;
  ask: AskReason;
  close: () => void;
}) {
  const { data: detail, error } = useDaemon(() => factoryOp(connection, "show", { item: id }), {
    topics: ["factory"],
    deps: [id],
    every,
  });

  // The item from the board the cards behind it show, so the header never lags them; the detail adds its runs,
  // write-backs and events.
  const item = board.items.find((i) => i.id === id);
  if (!item) return null;
  return (
    <Modal title={`${item.key} ${item.title}`} close={close} size="lg">
      <div className="row factory-actions">
        <Pill tone={toneOf(item)}>{item.needsYou?.title ?? statusOf(item)}</Pill>
        {item.url && (
          <Button size="sm" variant="tertiary" onPress={() => void openExternal(item.url!)}>
            <ExternalLink size={14} />
            Issue
          </Button>
        )}
        {item.pr && (
          <Button size="sm" variant="tertiary" onPress={() => void openExternal(item.pr!.url)}>
            <GitPullRequest size={14} />
            Pull request
          </Button>
        )}
        {/* One that waits for you has its actions with what each does below. */}
        {!item.needsYou && <ItemActions item={item} act={act} ask={ask} />}
      </div>
      {item.needsYou && (
        <Panel title="Needs you" detail={item.needsYou.title}>
          <div className="item">
            <div className="grow">
              <NeedsYouText item={item} />
            </div>
            <OpenInT3 link={item.needsYou.link ?? item.run?.threadLink} />
          </div>
          {item.actions.map((a) => (
            <div className="item" key={a.name + a.label}>
              <span className="grow">{a.effect}</span>
              <ItemActions item={{ ...item, actions: [a] }} act={act} ask={ask} />
            </div>
          ))}
        </Panel>
      )}
      {error && <p className="danger">{error}</p>}
      <Panel
        title="Threads"
        detail={
          item.tokensUnknown
            ? "Each stage works in a T3 Code thread. Tokens unknown: some of their sessions bypass agentgate."
            : `Each stage works in a T3 Code thread${item.tokens ? `; ${item.tokens.toLocaleString()} tokens in all` : ""}.`
        }
      >
        {detail?.runs.length ? (
          detail.runs.map((r) => (
            <div className="item" key={r.id}>
              <div className="grow">
                <div className="row">
                  <strong>
                    {STAGES[r.kind] ?? r.kind}
                    {r.attempt > 1 ? ` (attempt ${r.attempt})` : ""}
                  </strong>
                  <Pill tone={RUN_TONES[r.state] ?? "held"}>{RUN_STATES[r.state] ?? r.state}</Pill>
                </div>
                {/* An error on a run that reported is housekeeping, not why it stopped. */}
                <small className={r.error && r.state !== "reported" ? "danger" : "muted"}>
                  {(r.state !== "reported" && r.error) ||
                    `${r.startedAt ? "started" : "queued"} ${ago(r.startedAt ?? r.queuedAt)}${r.tokens ? ` · ${r.tokens.toLocaleString()} tokens` : ""}`}
                </small>
              </div>
              <OpenInT3 link={r.threadLink} label="Open" />
            </div>
          ))
        ) : (
          <Empty>
            <p>{detail ? "No runs yet." : "Loading…"}</p>
          </Empty>
        )}
      </Panel>
      {!!detail?.writebacks.length && (
        <Panel title="Written on GitHub or Linear" detail="Each at most once.">
          {detail.writebacks.map((w) => (
            <div className="item" key={`${w.moment}${w.at}`}>
              <span className="grow">{WRITES[w.moment] ?? w.moment}</span>
              <Badge good={w.status === "posted"}>{w.status}</Badge>
              <small className="muted">{ago(w.at)}</small>
            </div>
          ))}
        </Panel>
      )}
      {!!detail?.events.length && (
        <details className="factory-history">
          <summary className="muted">History ({detail.events.length})</summary>
          <Panel title="History">
            {detail.events.map((e) => (
              <div className="item factory-event" key={e.seq}>
                <span className="grow">{e.text}</span>
                <small className="muted">{ago(e.at)}</small>
              </div>
            ))}
          </Panel>
        </details>
      )}
      <p className="muted">
        Actions reach the factory machine. <code>agentgate factory show {item.key}</code> shows the same.
      </p>
    </Modal>
  );
}
