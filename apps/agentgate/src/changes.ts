import { TOPICS, type Topic } from "@agentgate/protocol";
import { recordFromKeys } from "hanzio";
import { topicsOf, type Kind, type Store } from "./store.ts";

/** The topics paired machines follow from each other (`/peer/topics`), so an app on one machine shows the factory and
 * the threads of the others as they change. */
export const PEER_TOPICS = ["factory", "threads"] as const;
export type PeerTopic = (typeof PEER_TOPICS)[number];

interface Waiter {
  token: () => string;
  after: string | undefined;
  done: () => void;
}

/** What changed in this daemon, per topic, so `/api/changes` waiters wake the moment it changes. The daemon's own writes
 * arrive through `Store.onChange`; the CLI writes the store from its own process, which only `pragma data_version`
 * notices. */
export class Changes {
  /** Random per start, so a client holding a token from before a restart sees everything as changed. */
  private readonly bootId = crypto.randomUUID().slice(0, 8);
  private readonly versions = recordFromKeys(TOPICS, () => 0);
  /** This machine's own changes: one heard from a peer and served on to it would bounce between the two forever. */
  private readonly own = recordFromKeys(PEER_TOPICS, () => 0);
  private readonly waiters = new Set<Waiter>();
  private apps = 0;
  /** Called each time an app starts waiting on `/api/changes`: the peer feed runs only while one does. */
  onAppWaiting?: () => void;
  private readonly listeners = new Set<(kinds: Set<Kind>) => void>();
  private readonly kinds = new Set<Kind>();
  private seq: number;
  private dataVersion = 0;
  private scheduled = false;
  private readonly timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly s: Store,
    opts: { externalMs?: number } = {},
  ) {
    this.seq = s.seq();
    s.onChange = (topic) => this.bump(topic);
    // No other connection can open an in-memory store.
    if (s.db.filename !== ":memory:") {
      this.dataVersion = this.readDataVersion();
      this.timer = setInterval(() => this.watch(), opts.externalMs ?? 250);
      this.timer.unref();
    }
  }

  /** Marks a topic changed. Bumps in one tick wake waiters once (queueMicrotask). */
  bump(topic: Topic) {
    if (topic === "factory" || topic === "threads") this.own[topic]++;
    this.move(topic);
  }

  /** A paired machine's factory or threads changed, which this machine's app shows too. */
  bumpFromPeer(topic: PeerTopic) {
    this.move(topic);
  }

  /** Token = `${bootId}.${sum of versions}`; versions per topic. */
  snapshot() {
    const sum = TOPICS.reduce((n, t) => n + this.versions[t], 0);
    return { token: `${this.bootId}.${sum}`, versions: { ...this.versions } };
  }

  /** What `/peer/topics` serves: this machine's own factory and thread changes. */
  peerSnapshot() {
    return { token: `${this.bootId}.${this.own.factory + this.own.threads}`, versions: { ...this.own } };
  }

  /** An app waits: resolves when the token differs from `after`, after `ms`, or when the signal aborts. No polling. */
  wait(after: string | undefined, ms: number, signal: AbortSignal): Promise<void> {
    return this.park(() => this.snapshot().token, after, ms, signal, true);
  }

  /** A peer waits on `peerSnapshot`. It never counts as an app, or two machines would keep each other polling. */
  waitPeer(after: string | undefined, ms: number, signal: AbortSignal): Promise<void> {
    return this.park(() => this.peerSnapshot().token, after, ms, signal, false);
  }

  get appWaiting() {
    return this.apps > 0;
  }

  /** Record kinds changed since the last call, for the daemon's reactions. Called after the writes commit. */
  onRecords(fn: (kinds: Set<Kind>) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    clearInterval(this.timer);
    this.s.onChange = undefined;
    this.onAppWaiting = undefined;
    this.listeners.clear();
    for (const w of [...this.waiters]) w.done();
  }

  private move(topic: Topic) {
    this.versions[topic]++;
    if (this.scheduled) return;
    this.scheduled = true;
    // The store calls onChange inside its transactions; read the records and wake waiters after they commit.
    queueMicrotask(() => this.flush());
  }

  private park(token: () => string, after: string | undefined, ms: number, signal: AbortSignal, app: boolean) {
    if (after !== token() || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiter: Waiter = {
        token,
        after,
        done: () => {
          if (!this.waiters.delete(waiter)) return;
          if (app) this.apps--;
          clearTimeout(timeout);
          signal.removeEventListener("abort", waiter.done);
          resolve();
        },
      };
      const timeout = setTimeout(waiter.done, ms);
      signal.addEventListener("abort", waiter.done, { once: true });
      this.waiters.add(waiter);
      if (app) {
        this.apps++;
        this.onAppWaiting?.();
      }
    });
  }

  private flush() {
    this.scheduled = false;
    for (const w of [...this.waiters]) if (w.token() !== w.after) w.done();
    if (this.s.closed) return;
    try {
      this.readKinds();
    } catch (e) {
      console.error(`change hub: ${e instanceof Error ? e.name : "failed"}`);
      return;
    }
    if (!this.kinds.size) return;
    const kinds = new Set(this.kinds);
    this.kinds.clear();
    for (const fn of this.listeners)
      try {
        fn(kinds);
      } catch (e) {
        console.error(`background task: ${e instanceof Error ? e.name : "failed"}`);
      }
  }

  /** Adds the kinds of records written since the last read; never loads row data (a skill can be megabytes). */
  private readKinds() {
    const { rows, high } = this.s.db.transaction(() => {
      const high = this.s.seq();
      const rows = this.s.db
        .query("select distinct kind from records where seq > ? and seq <= ?")
        .all(this.seq, high) as { kind: Kind }[];
      return { rows, high };
    })();
    this.seq = high;
    for (const { kind } of rows) this.kinds.add(kind);
  }

  private readDataVersion() {
    return (this.s.db.query("pragma data_version").get() as { data_version: number }).data_version;
  }

  /** Another connection (the CLI) committed: its writes reach no onChange here. */
  private watch() {
    if (this.s.closed) return clearInterval(this.timer);
    try {
      const version = this.readDataVersion();
      if (version === this.dataVersion) return;
      this.dataVersion = version;
      this.readKinds();
      for (const kind of this.kinds) for (const topic of topicsOf(kind)) this.bump(topic);
      // The CLI may also have written factory events or node-local state, which have no record kind.
      this.bump("status");
      this.bump("factory");
    } catch (e) {
      console.error(`change hub: ${e instanceof Error ? e.name : "failed"}`);
    }
  }
}
