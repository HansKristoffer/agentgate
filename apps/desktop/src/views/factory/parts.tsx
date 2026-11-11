import type { CSSProperties, ReactNode } from "react";
import { Button } from "@heroui/react";
import { SquareTerminal } from "lucide-react";
import type { BoardItem, ItemAction, ItemPhase } from "@agentgate/protocol";
import { openExternal } from "../../api.ts";
import { ActionButton } from "../../components/ui.tsx";

/** The pieces the factory view, its drawer, its settings and the T3 Code view share. */

/** An action, then the board as it is after it. */
export type Run = (task: () => Promise<unknown>, message?: string, key?: string) => Promise<void>;
/** What the view does to an item, for the queue, the cards and the drawer. */
export type Act = (item: Pick<BoardItem, "id" | "key">, action: ItemAction, reason?: string) => Promise<void>;
/** Asks for a reason, then acts. */
export type AskReason = (item: Pick<BoardItem, "id" | "key">, action: ItemAction, title: string) => void;
/** What an action on an item is pending under, for its button and for `perform`. */
export const pendingKey = (action: ItemAction, item: Pick<BoardItem, "id">) => `factory:${action}:${item.id}`;

/** The colour family of a state, defined in styles.css for light and dark: the stages run from understanding (think)
 * through building and checking to ready, and anything that waits for you, or failed, stands out from all of them. */
export type Tone = "held" | "think" | "build" | "check" | "ready" | "you" | "bad";
export const STAGE_TONES: Record<ItemPhase, Tone> = {
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
/** An item's colour: what waits for you, or stopped, before the stage it is in. */
export const toneOf = (item: BoardItem): Tone =>
  item.needsYou ? (item.needsYou.kind === "stopped" ? "bad" : "you") : STAGE_TONES[item.phase];
/** A state in its colour, with a dot, so the eye finds what waits for you before reading. */
export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="pill" style={toneStyle(tone)}>
      {children}
    </span>
  );
}

export function OpenInT3({ link, label = "Open in T3 Code" }: { link?: string; label?: string }) {
  if (!link) return null;
  return (
    <Button size="sm" variant="tertiary" onPress={() => void openExternal(link)}>
      <SquareTerminal size={14} />
      {label}
    </Button>
  );
}

/** What a panel shows when its read failed, in place of "Loading…" that would never end. */
export function ReadFailed({ error, retry }: { error: string; retry: () => unknown }) {
  return (
    <>
      <p className="danger">{error}</p>
      <Button size="sm" variant="tertiary" onPress={retry}>
        Try again
      </Button>
    </>
  );
}

/** The daemon's actions for an item, as it labels them: one that takes text asks for it first. The button's tooltip
 * says what it will do. */
export function ItemActions({ item, act, ask }: { item: BoardItem; act: Act; ask: AskReason }) {
  return (
    <>
      {item.actions.map((a) => (
        <span key={a.name + a.label} title={a.effect}>
          <ActionButton
            size="sm"
            variant="tertiary"
            pendingKey={pendingKey(a.name, item)}
            onPress={() =>
              a.takesText ? ask(item, a.name, `${a.label.replace(/…$/, "")}: ${item.key}`) : void act(item, a.name)
            }
          >
            {a.label}
          </ActionButton>
        </span>
      ))}
    </>
  );
}

/** What an item waits for you to do, as the daemon renders it everywhere: what happened, the question, the
 * recommendation and the options. */
export function NeedsYouText({ item }: { item: BoardItem }) {
  const n = item.needsYou;
  if (!n) return null;
  return (
    <>
      <p className="factory-question">{n.question}</p>
      {n.detail && (
        <details>
          <summary className="muted">Read it here</summary>
          <div className="factory-detail">{n.detail}</div>
        </details>
      )}
      {n.recommendation && <p className="muted">Recommended: {n.recommendation}</p>}
      {n.options && (
        <ul className="muted">
          {n.options.map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/** What is happening to an item, in words: what it waits for, as the daemon says, else the stage's work while its run
 * goes, else where it stands. */
export function statusOf(item: BoardItem): string {
  if (item.waiting) return item.waiting.text;
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
      return working ? "Fixing the PR" : "PR open";
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
