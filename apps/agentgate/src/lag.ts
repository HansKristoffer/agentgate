// How late the daemon's event loop runs: a timer that should fire every interval records how far past it each tick
// lands. A slow synchronous step anywhere in the daemon (a big JSON parse, a sync SQLite scan) shows up here.

let running: ReturnType<typeof startLagProbe> | undefined;

/** Starts a probe that keeps the last `windowMs` of ticks, and makes it the one `lag()` reads. */
export function startLagProbe(intervalMs = 100, windowMs = 60_000) {
  // A stalled loop ticks less often, so a ring of one window's ticks spans at least the window.
  const samples = new Float64Array(Math.ceil(windowMs / intervalMs));
  let count = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    samples[count++ % samples.length] = Math.max(0, now - last - intervalMs);
    last = now;
  }, intervalMs);
  timer.unref();
  const probe = {
    stop() {
      clearInterval(timer);
      if (running === probe) running = undefined;
    },
    read() {
      const sorted = samples.slice(0, Math.min(count, samples.length)).sort();
      if (!sorted.length) return { worstMs: 0, p99Ms: 0 };
      return {
        worstMs: Math.round(sorted[sorted.length - 1]!),
        p99Ms: Math.round(sorted[Math.ceil(sorted.length * 0.99) - 1]!),
      };
    },
  };
  running = probe;
  return probe;
}

/** The running probe's reading, or undefined when none runs (tests, CLI commands that do not serve). */
export function lag() {
  return running?.read();
}
