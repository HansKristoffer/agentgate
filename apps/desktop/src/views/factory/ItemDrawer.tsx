import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { ExternalLink, GitPullRequest } from "lucide-react";
import type { Connection, FactoryBoard, FactoryItemDetail } from "@agentgate/protocol";
import { openExternal, request } from "../../api.ts";
import { Badge, Empty, Modal, Panel } from "../../components/ui.tsx";
import { useGeneration } from "../../features/proxy/useGeneration.ts";
import { ago } from "../utils.ts";
import { NeedsYouActions, OpenInT3, type Act, type AskReason } from "../Factory.tsx";

/** One item: its runs with their T3 Code threads and errors, what the factory posted for it, and its events. Read from
 * `GET /api/factory/items/:id`, which reaches the machine that holds the item. */
export function ItemDrawer({
  connection,
  id,
  board,
  act,
  ask,
  close,
}: {
  connection: Connection;
  id: string;
  board: FactoryBoard;
  act: Act;
  ask: AskReason;
  close: () => void;
}) {
  const [detail, setDetail] = useState<FactoryItemDetail>();
  const [error, setError] = useState("");
  const capture = useGeneration(connection);
  useEffect(() => {
    const load = async () => {
      const current = capture();
      try {
        const next = await request<FactoryItemDetail>(connection, `/factory/items/${encodeURIComponent(id)}`);
        if (current()) {
          setDetail(next);
          setError("");
        }
      } catch (e) {
        if (current()) setError(String(e));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [connection, id]);

  // The board's row shows at once; the detail fills in.
  const item = detail?.item ?? board.items.find((i) => i.id === id);
  if (!item) return null;
  const open = item.phase !== "shipped" && item.phase !== "closed";
  return (
    <Modal title={`${item.key} ${item.title}`} close={close} size="lg">
      <div className="row factory-actions">
        <Badge>{item.phase}</Badge>
        {item.heldBy !== board.factory?.node && <Badge>held by {item.heldBy}</Badge>}
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
      </div>
      {item.needsYou && (
        <Panel title="Needs you" detail={item.needsYou.question}>
          <div className="item">
            <div className="row factory-actions">
              <NeedsYouActions item={item} act={act} ask={ask} />
              <OpenInT3 link={item.needsYou.link ?? item.run?.threadLink} />
            </div>
          </div>
        </Panel>
      )}
      {open && !item.needsYou && (
        <div className="row factory-actions">
          <Button size="sm" variant="tertiary" onPress={() => ask(item, "drop", `Drop ${item.key}`)}>
            Drop…
          </Button>
        </div>
      )}
      {error && <p className="danger">{error}</p>}
      <Panel
        title="Runs"
        detail={
          item.tokensUnknown
            ? "Tokens unknown: some sessions bypass agentgate."
            : `${item.tokens.toLocaleString()} tokens`
        }
      >
        {detail?.runs.length ? (
          detail.runs.map((r) => (
            <div className="item" key={r.id}>
              <div className="grow">
                <div className="row">
                  <strong>
                    {r.kind}
                    {r.attempt > 1 ? ` (attempt ${r.attempt})` : ""}
                  </strong>
                  <Badge good={r.state === "reported"}>{r.state}</Badge>
                  {r.node && <small className="muted">on {r.node}</small>}
                </div>
                <small className={r.error ? "danger" : "muted"}>
                  {r.error ?? `${r.tokens.toLocaleString()} tokens · queued ${ago(r.queuedAt)}`}
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
        <Panel title="Comments" detail="What the factory posted on the issue, at most once each.">
          {detail.writebacks.map((w) => (
            <div className="item" key={`${w.moment}${w.at}`}>
              <span className="grow">{w.moment}</span>
              <Badge good={w.status === "posted"}>{w.status}</Badge>
              <small className="muted">{ago(w.at)}</small>
            </div>
          ))}
        </Panel>
      )}
      {!!detail?.events.length && (
        <Panel title="Events">
          {detail.events.map((e) => (
            <div className="item" key={e.seq}>
              <span className="grow">{e.text}</span>
              <small className="muted">{ago(e.at)}</small>
            </div>
          ))}
        </Panel>
      )}
      <p className="muted">
        Actions reach the machine that holds the item. <code>agentgate factory show {item.key}</code> shows the same.
      </p>
    </Modal>
  );
}
