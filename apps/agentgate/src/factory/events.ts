import type { ItemPhase, NeedsYouCause, RunState } from "@agentgate/protocol";
import type { Store } from "../store.ts";
import { logError, type PostResult } from "./runtime.ts";

/** What happened in the factory, for the board's event list, and for features that react to each other's changes. */
export type FactoryEvent =
  | { kind: "item.created"; item: string; text: string }
  | { kind: "item.phase"; item: string; from: ItemPhase | null; to: ItemPhase; text: string }
  /** The item started waiting for the maintainer (`ask` in controller.ts). */
  | { kind: "item.needs-you"; item: string; cause: NeedsYouCause; text: string }
  | { kind: "run.queued"; run: string; item?: string; text: string }
  | { kind: "run.started"; run: string; item?: string; text: string }
  /** A reported run's thread goes on with the person's answer (actions.ts), and takes a report again. */
  | { kind: "run.resumed"; run: string; item: string; text: string }
  | { kind: "run.ended"; run: string; item?: string; state: RunState; text: string }
  | { kind: "writeback"; item: string; moment: string; status: PostResult["status"]; text: string }
  | { kind: "config"; commit?: string; error?: string; text: string }
  | { kind: "factory.off"; text: string }
  | { kind: "note"; item?: string; run?: string; text: string }
  /** Something a person did to the item; `touched` in controller.ts also counts it on the item as a human touch. */
  | { kind: "human"; item: string; act: HumanAct; text: string };

export type HumanAct = "approve" | "reject" | "retry" | "answer" | "add";

/** `seq` is the event's place in the log, which a webhook receiver dedupes by. */
type Listener = (event: FactoryEvent, seq: number) => void | Promise<void>;

export class FactoryEvents {
  private listeners = new Map<FactoryEvent["kind"], Set<Listener>>();
  constructor(private s: Store) {}

  /** Records the event, then tells its listeners. A listener's failure is logged and never reaches the emitter. */
  emit(event: FactoryEvent) {
    // A late event after shutdown, such as a thread's answer arriving as the daemon stops, has nowhere to go.
    if (this.s.closed) return;
    const kind = event.kind === "writeback" ? `writeback:${event.moment}` : event.kind;
    const { lastInsertRowid } = this.s.db.run(
      "insert into factory_events (at, item, run, kind, text) values (?, ?, ?, ?, ?)",
      [this.s.now(), ("item" in event && event.item) || null, ("run" in event && event.run) || null, kind, event.text],
    );
    this.s.bump("factory");
    const failed = (e: unknown) => console.error(`factory: ${event.kind} listener failed: ${logError(e)}`);
    for (const listener of this.listeners.get(event.kind) ?? []) {
      try {
        const result = listener(event, Number(lastInsertRowid));
        if (result) result.catch(failed);
      } catch (e) {
        failed(e);
      }
    }
  }

  /** Returns a function that removes the listener. */
  on<K extends FactoryEvent["kind"]>(
    kind: K,
    listener: (event: Extract<FactoryEvent, { kind: K }>, seq: number) => void | Promise<void>,
  ): () => void {
    const set = this.listeners.get(kind) ?? new Set();
    this.listeners.set(kind, set);
    set.add(listener as Listener);
    return () => set.delete(listener as Listener);
  }

  recent(limit: number) {
    const rows = this.s.db
      .query("select seq, at, item, kind, text from factory_events order by seq desc limit ?")
      .all(limit) as { seq: number; at: number; item: string | null; kind: string; text: string }[];
    return rows.map(({ item, ...r }) => ({ ...r, ...(item !== null && { item }) }));
  }
}
