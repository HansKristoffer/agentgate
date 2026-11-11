import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { messageOf } from "@hanskristoffer/taurio/runtime";
import type { Connection, Topic } from "@agentgate/protocol";
import { useFeed } from "./AppContext.tsx";

/** How often a read asks again when nothing told it to. */
const SAFETY = 30_000;

/** `next`, with every part that is deep-equal to the same part of `prev` replaced by `prev`'s, so an unchanged answer
 * keeps its identity and React renders nothing for it. For JSON answers. */
export function reuse<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next) || !prev || !next || typeof prev !== "object" || typeof next !== "object") return next;
  if (Array.isArray(prev) !== Array.isArray(next)) return next;
  const before = prev as Record<string, unknown>;
  const out = (Array.isArray(next) ? [] : {}) as Record<string, unknown>;
  let same = Object.keys(before).length === Object.keys(next).length;
  for (const [k, v] of Object.entries(next)) {
    out[k] = reuse(before[k], v);
    if (out[k] !== before[k] || !(k in before)) same = false;
  }
  return (same ? prev : out) as T;
}

const onVisibility = (change: () => void) => {
  document.addEventListener("visibilitychange", change);
  return () => document.removeEventListener("visibilitychange", change);
};
const isVisible = () => document.visibilityState !== "hidden";

type Answer<T> = { data?: T; error: string; failures: number; at?: number; connection?: Connection };
const none: Answer<never> = { error: "", failures: 0 };

/** One read. One request in flight; a reload asked meanwhile runs once after it. Answers for older deps or an
 * unmounted view are dropped. Data is kept on error, and `failures` counts the errors since the last answer. Reloads when a named topic changes, when the window regains
 * focus, and on a slow safety interval. With `key`, the last answer is kept for the connection and shown at once
 * when the view mounts again. Stops while the window is hidden, unless `hidden` gives an interval for that. */
export function useDaemon<T>(
  read: (() => Promise<T>) | false,
  opts: { topics: Topic[]; deps?: unknown[]; every?: number; key?: string; hidden?: number },
): { data?: T; error: string; failures: number; at?: number; stale: boolean; reload(): Promise<void> } {
  const { topics, deps = [], every = SAFETY, key, hidden } = opts;
  const { connection, versions, cache } = useFeed();
  const period = useSyncExternalStore(onVisibility, isVisible) ? every : hidden;
  const enabled = read !== false;
  const tick = topics.map((t) => versions[t]).join();
  const [state, setState] = useState<Answer<T>>(() => ((key && cache.get(key)) as Answer<T> | undefined) ?? none);
  // A switch to another daemon hides this one's answer at once; the new daemon's cache starts empty.
  const own = state.connection === connection ? state : none;

  const latest = useRef({ read, connection, cache, key });
  latest.current = { read, connection, cache, key };
  // Bumped when deps change or the view unmounts, which drops the answers still on their way.
  const generation = useRef(0);
  const flight = useRef<{ now?: Promise<void>; next?: Promise<void> }>({});
  useEffect(
    () => () => {
      generation.current++;
      flight.current = {};
    },
    [connection, ...deps],
  );

  const reload = useCallback((): Promise<void> => {
    const f = flight.current;
    if (f.next) return f.next;
    if (f.now)
      return (f.next = f.now.then(() => {
        f.next = undefined;
        return f === flight.current ? reload() : undefined;
      }));
    const { read, connection, cache, key } = latest.current;
    if (!read) return Promise.resolve();
    const g = generation.current;
    const ours = (prev: Answer<T>) => (prev.connection === connection ? prev : none);
    f.now = Promise.resolve()
      .then(read)
      .then(
        (next) => {
          if (g !== generation.current) return;
          setState((prev) => {
            const answer = { data: reuse(ours(prev).data, next), error: "", failures: 0, at: Date.now(), connection };
            if (key) cache.set(key, answer);
            return answer;
          });
        },
        (e) => {
          if (g !== generation.current) return;
          setState((prev) => {
            const own = ours(prev);
            return { ...own, connection, error: messageOf(e), failures: own.failures + 1 };
          });
        },
      )
      .finally(() => {
        f.now = undefined;
      });
    return f.now;
  }, []);

  useEffect(() => {
    if (enabled && period !== undefined) void reload();
  }, [enabled, period !== undefined, tick, connection, reload, ...deps]);
  useEffect(() => {
    if (!enabled || period === undefined) return;
    const timer = setInterval(() => void reload(), period);
    const focus = () => void reload();
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [enabled, period, reload]);

  if (!enabled) return { error: "", failures: 0, stale: false, reload };
  const stale = own.at !== undefined && Date.now() - own.at > 2 * (period ?? every);
  return { data: own.data, error: own.error, failures: own.failures, at: own.at, stale, reload };
}
