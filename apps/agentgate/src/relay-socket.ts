/** Deadlines for every relay socket; tests shorten them. */
export const relaySocket = { openMs: 15_000, pingMs: 30_000 };

interface Options {
  /** Opens the socket for the next attempt. A throw counts as a failed attempt and reaches `onDown` as `error`. */
  dial: () => WebSocket | Promise<WebSocket>;
  onOpen?: () => void;
  /** Every message except the relay's pongs, with the socket it came on so an answer goes back the same way. */
  onMessage: (data: string, ws: WebSocket) => void;
  /** After a close or a failed attempt, before the retry is scheduled. `upFor` is unset for a socket that never opened.
   * A returned number is the least the next retry waits. */
  onDown?: (down: { code?: number; upFor?: number; error?: unknown }) => number | void;
}

/**
 * One WebSocket to the relay (remote endpoints in remote.ts, the node channel in channel.ts), kept open until `stop`:
 * a deadline for opening, since a socket that never opens never closes and so never reconnects; a ping that closes a
 * socket the relay stopped answering; and jittered backoff that resets once a socket stays up for a minute. Calls in
 * `inflight` are aborted when the socket goes down, as the relay fails them then.
 */
export class RelaySocket {
  readonly inflight = new Map<string, AbortController>();
  private ws?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private ping?: ReturnType<typeof setInterval>;
  private backoff = 1000;
  private lastPong = 0;
  private openedAt?: number;
  private stopped = false;

  constructor(private o: Options) {
    void this.connect();
  }

  stop(reason: string) {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.ping);
    this.abortAll(reason);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
  }

  private abortAll(reason: string) {
    for (const a of this.inflight.values()) a.abort(new Error(reason));
  }

  private down(down: { code?: number; upFor?: number; error?: unknown }) {
    if (this.stopped) return;
    clearInterval(this.ping);
    const least = this.o.onDown?.(down);
    if (typeof least === "number") this.backoff = Math.max(this.backoff, least);
    const delay = this.backoff * (0.5 + Math.random());
    this.backoff = Math.min(this.backoff * 2, 60_000);
    this.retry = setTimeout(() => void this.connect(), delay);
    this.retry.unref?.();
  }

  private async connect() {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = await this.o.dial();
    } catch (error) {
      return this.down({ error });
    }
    if (this.stopped) return ws.close();
    this.ws = ws;
    const deadline = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) ws.close();
    }, relaySocket.openMs);
    deadline.unref?.();
    ws.onopen = () => {
      clearTimeout(deadline);
      this.openedAt = this.lastPong = Date.now();
      const { pingMs } = relaySocket;
      this.ping = setInterval(() => {
        if (Date.now() - this.lastPong > pingMs * 2) return ws.close();
        try {
          ws.send("ping");
        } catch {
          // Closing; onclose reconnects.
        }
      }, pingMs);
      this.ping.unref?.();
      this.o.onOpen?.();
    };
    ws.onmessage = (e) => {
      if (e.data === "pong") this.lastPong = Date.now();
      else this.o.onMessage(String(e.data), ws);
    };
    ws.onclose = (e) => {
      clearTimeout(deadline);
      // A stopped socket's calls were aborted by stop(), and nothing is retried or reported.
      if (this.ws !== ws || this.stopped) return;
      this.abortAll("relay connection closed");
      const upFor = this.openedAt === undefined ? undefined : Date.now() - this.openedAt;
      this.openedAt = undefined;
      if (upFor !== undefined && upFor > 60_000) this.backoff = 1000;
      this.down({ code: e.code, upFor });
    };
    ws.onerror = () => {
      // onclose follows.
    };
  }
}
