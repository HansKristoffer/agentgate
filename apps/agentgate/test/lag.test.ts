import { afterEach, expect, test } from "bun:test";
import { lag, startLagProbe } from "../src/lag.ts";

let probe: ReturnType<typeof startLagProbe> | undefined;
afterEach(() => probe?.stop());

const block = (ms: number) => {
  const until = performance.now() + ms;
  while (performance.now() < until);
};
/** Resolves once the probe's worst lag passes `check`. */
const until = async (check: (worst: number) => boolean) => {
  while (!check(probe!.read().worstMs)) await Bun.sleep(5);
};

test("a stalled event loop shows in the reading and drops out once the window has passed", async () => {
  probe = startLagProbe(5, 100);
  expect(lag()).toEqual({ worstMs: 0, p99Ms: 0 });

  block(150);
  await until((worst) => worst > 0);
  expect(probe.read().worstMs).toBeGreaterThanOrEqual(140);
  expect(lag()).toEqual(probe.read());

  await until((worst) => worst < 140);

  probe.stop();
  expect(lag()).toBeUndefined();
});
