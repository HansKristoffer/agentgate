import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { messageOf } from "@hanskristoffer/taurio/runtime";
import type { Connection, Topic } from "@agentgate/protocol";
import { useFeed } from "./AppContext.tsx";

/** How often a read asks again when nothing told it to. */
const SAFETY = 30_000;
/** Skip window-focus reloads when we already have a fresh answer (e.g. after closing a native dialog). */
const FOCUS_COOLDOWN = 5_000;

/** `next`, with every part that is deep-equal to the same part of `prev` replaced by `prev`'s, so an unchanged answer
 * keeps its identity and React renders nothing for it. For JSON answers. */
export function reuse<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next) || !prev || !next || typeof prev !== "object" || typeof next !== "object") return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(prev)) return next;
    const len = next.length;
    let same = prev.length === len;
    const out = new Array<unknown>(len);
    for (let i = 0; i < len; i++) {
      const v = reuse(prev[i], next[i]);
      out[i] = v;
      if (v !== prev[i]) same = false;
    }
    return (same ? prev : out) as T;
  }
  if (Array.isArray(prev)) return next;
  const before = prev as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  let same = Object.keys(before).length === keys.length;
  const out: Record<string, unknown> = {};
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const v = reuse(before[k], after[k]);
    out[k] = v;
    if (v !== before[k] || !(k in before)) same = false;
  }
  return (same ? prev : out) as T;
}

const onVisibility = (change: () => void) => {
  document.addEventListener("visibilitychange", change);
  return () => document.removeEventListener("visibilitychange", change);
};
const isVisible = () => document.visibilityState !== "hidden";

export type Answer<T> = {
  data?: T;
  error: string;
  failures: number;
  at?: number;
  connection?: Connection;
  key?: string;
};
const none: Answer<never> = { error: "", failures: 0 };

const prefetchInflight = new WeakMap<Map<string, unknown>, Map<string, Promise<void>>>();
const flightKey = (connection: Connection, key: string) => `${connection.url}\n${connection.token ?? ""}\n${key}`;

/** Warms a keyed read into the shared `Feed` cache (deduped in-flight) so switching tabs shows data immediately. */
export function prefetch<T>(
  cache: Map<string, unknown>,
  connection: Connection,
  key: string,
  read: () => Promise<T>,
  staleTime = 10_000,
): Promise<void> {
  const existing = cache.get(key) as Answer<T> | undefined;
  if (existing && existing.connection === connection && existing.at && Date.now() - existing.at < staleTime) {
    return Promise.resolve();
  }
  let flights = prefetchInflight.get(cache);
  if (!flights) prefetchInflight.set(cache, (flights = new Map()));
  const fKey = flightKey(connection, key);
  const running = flights.get(fKey);
  if (running) return running;
  const started = Date.now();
  const task = Promise.resolve()
    .then(read)
    .then(
      (next) => {
        const prev = cache.get(key) as Answer<T> | undefined;
        // Do not let an older machine's late prefetch overwrite a newer cache entry from another connection.
        if (prev && prev.connection !== connection && (prev.at ?? 0) > started) return;
        const prevData = prev?.connection === connection ? prev.data : undefined;
        cache.set(key, {
          data: reuse(prevData, next),
          error: "",
          failures: 0,
          at: Date.now(),
          connection,
          key,
        } satisfies Answer<T>);
      },
      () => {},
    )
    .finally(() => {
      if (flights?.get(fKey) === task) flights.delete(fKey);
    });
  flights.set(fKey, task);
  return task;
}

function cachedFor<T>(cache: Map<string, unknown>, connection: Connection, key?: string): Answer<T> | undefined {
  if (!key) return undefined;
  const hit = cache.get(key) as Answer<T> | undefined;
  return hit && hit.connection === connection ? hit : undefined;
}

/** One read. One request in flight; a reload asked meanwhile runs once after it. Answers for older deps or an
 * unmounted view are dropped. Data is kept on error, and `failures` counts the errors since the last answer. Reloads
 * when a named topic changes, when the window regains focus (throttled), and on a slow safety interval. With `key`,
 * the last answer is kept for the connection and shown at once when the view mounts again or switches back to that key.
 * Stops while the window is hidden, unless `hidden` gives an interval for that. */
export function useDaemon<T>(
  read: (() => Promise<T>) | false,
  opts: {
    topics: Topic[];
    deps?: unknown[];
    every?: number;
    key?: string;
    hidden?: number;
    /** Minimum time between topic-triggered reloads; changes inside the window coalesce into one trailing reload. */
    minInterval?: number;
    /** Skip the initial mount/key-change fetch if the cached answer is younger than this many milliseconds. */
    staleTime?: number;
  },
): { data?: T; error: string; failures: number; at?: number; stale: boolean; reload(): Promise<void> } {
  const { topics, deps = [], every = SAFETY, key, hidden, minInterval = 0, staleTime = 0 } = opts;
  const { connection, versions, cache } = useFeed();
  const period = useSyncExternalStore(onVisibility, isVisible) ? every : hidden;
  const enabled = read !== false;
  const tick = topics.map((t) => versions[t]).join();
  const [state, setState] = useState<Answer<T>>(() => cachedFor<T>(cache, connection, key) ?? none);
  // A switch to another daemon or another key reads that key's cached answer immediately instead of showing stale data.
  const own =
    state.connection === connection && (key === undefined || state.key === key)
      ? state
      : (cachedFor<T>(cache, connection, key) ?? none);

  const latest = useRef({ read, connection, cache, key, ownAt: own.at });
  latest.current = { read, connection, cache, key, ownAt: own.at };
  // Bumped when deps change or the view unmounts, which drops the answers still on their way.
  const generation = useRef(0);
  const flight = useRef<{ now?: Promise<void>; next?: Promise<void> }>({});
  useEffect(
    () => () => {
      generation.current++;
      flight.current = {};
    },
    [connection, key, ...deps],
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
    const ours = (prev: Answer<T>) =>
      prev.connection === connection && (key === undefined || prev.key === key)
        ? prev
        : (cachedFor<T>(cache, connection, key) ?? none);
    f.now = Promise.resolve()
      .then(read)
      .then(
        (next) => {
          if (g !== generation.current) return;
          setState((prev) => {
            const answer: Answer<T> = {
              data: reuse(ours(prev).data, next),
              error: "",
              failures: 0,
              at: Date.now(),
              connection,
              key,
            };
            if (key) cache.set(key, answer);
            return answer;
          });
        },
        (e) => {
          if (g !== generation.current) return;
          setState((prev) => {
            const own = ours(prev);
            return { ...own, connection, key, error: messageOf(e), failures: own.failures + 1 };
          });
        },
      )
      .finally(() => {
        f.now = undefined;
      });
    return f.now;
  }, []);

  const prevTrigger = useRef<{ connection: Connection; key?: string; tick: string } | undefined>(undefined);
  useEffect(() => {
    if (!enabled || period === undefined) return;
    const prev = prevTrigger.current;
    prevTrigger.current = { connection, key, tick };
    const topicOnly = !!prev && prev.connection === connection && prev.key === key && prev.tick !== tick;
    const age = latest.current.ownAt ? Date.now() - latest.current.ownAt : Infinity;
    if (!topicOnly && staleTime > 0 && age < staleTime) return;
    if (topicOnly && minInterval > 0 && age < minInterval) {
      const wait = setTimeout(() => void reload(), minInterval - age);
      return () => clearTimeout(wait);
    }
    void reload();
    return undefined;
  }, [enabled, period !== undefined, tick, connection, key, reload, minInterval, staleTime, ...deps]);

  useEffect(() => {
    if (!enabled || period === undefined) return;
    const timer = setInterval(() => void reload(), period);
    const focus = () => {
      const at = latest.current.ownAt;
      if (!at || Date.now() - at >= Math.max(FOCUS_COOLDOWN, minInterval)) void reload();
    };
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [enabled, period, minInterval, reload]);

  if (!enabled) return { error: "", failures: 0, stale: false, reload };
  const stale = own.at !== undefined && Date.now() - own.at > 2 * (period ?? every);
  return { data: own.data, error: own.error, failures: own.failures, at: own.at, stale, reload };
}
