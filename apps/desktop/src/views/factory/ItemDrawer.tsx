import { useEffect, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { ExternalLink, GitPullRequest } from "lucide-react";
import type { Connection, FactoryBoard, FactoryItemDetail } from "@agentgate/protocol";
import { openExternal, request } from "../../api.ts";
import { Badge, Empty, Modal, Panel } from "../../components/ui.tsx";
import { useGeneration } from "../../features/proxy/useGeneration.ts";
import { ago } from "../utils.ts";
import { NeedsYouActions, OpenInT3, Pill, statusOf, toneOf, type Act, type AskReason, type Tone } from "../Factory.tsx";

const STAGES: Record<string, string> = {
  triage: "Triage",
  spec: "Spec",
  implement: "Implement",
  review: "Review",
  judge: "Judge",
  learn: "Learning",
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
const WRITES: Record<string, string> = {
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
};

/** One item: its runs with their T3 Code threads and errors, what the factory posted for it, and its events. Read from
 * `GET /api/factory/items/:id`, which reaches the machine that holds the item. */
export function ItemDrawer({
  connection,
  changes,
  id,
  board,
  act,
  ask,
  close,
}: {
  connection: Connection;
  /** useChanges: the item is read again when it goes up. */
  changes: number;
  id: string;
  board: FactoryBoard;
  act: Act;
  ask: AskReason;
  close: () => void;
}) {
  const [detail, setDetail] = useState<FactoryItemDetail>();
  const [error, setError] = useState("");
  const capture = useGeneration(connection);
  // A forwarded read can take longer than the poll; like the board, one at a time for the item shown. A read for
  // another item or connection neither holds back this one nor lands in it.
  const loading = useRef<() => boolean>(undefined);
  useEffect(() => {
    let live = true;
    const load = async () => {
      if (loading.current?.()) return;
      const generation = capture();
      const current = () => live && generation();
      loading.current = current;
      try {
        const next = await request<FactoryItemDetail>(connection, `/factory/items/${encodeURIComponent(id)}`);
        if (current()) {
          setDetail(next);
          setError("");
        }
      } catch (e) {
        if (current()) setError(String(e));
      } finally {
        if (loading.current === current) loading.current = undefined;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [connection, id, changes]);

  // The board's row shows at once; the detail fills in.
  const item = detail?.item ?? board.items.find((i) => i.id === id);
  if (!item) return null;
  return (
    <Modal title={`${item.key} ${item.title}`} close={close} size="lg">
      <div className="row factory-actions">
        <Pill tone={toneOf(item)}>{item.needsYou ? "Needs you" : statusOf(item)}</Pill>
        {item.heldBy !== board.factory?.node && <Badge>on {item.heldBy}</Badge>}
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
        {item.actions.includes("drop") && !item.needsYou && (
          <Button size="sm" variant="tertiary" onPress={() => ask(item, "drop", `Drop ${item.key}`)}>
            Drop…
          </Button>
        )}
      </div>
      {item.needsYou && (
        <Panel title="Needs you" detail={item.needsYou.question}>
          {item.needsYou.detail && <div className="factory-detail">{item.needsYou.detail}</div>}
          <div className="item">
            <div className="row factory-actions">
              <NeedsYouActions item={item} act={act} ask={ask} />
              <OpenInT3 link={item.needsYou.link ?? item.run?.threadLink} />
            </div>
          </div>
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
                  {r.node && r.node !== item.heldBy && <small className="muted">on {r.node}</small>}
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
        Actions reach the machine that holds the item. <code>agentgate factory show {item.key}</code> shows the same.
      </p>
    </Modal>
  );
}
