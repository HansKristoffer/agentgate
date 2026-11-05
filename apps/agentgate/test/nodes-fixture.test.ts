import { afterAll, expect, test } from "bun:test";
import { startNodes } from "./fixtures/nodes.ts";
import { peerCall } from "../src/handoff/jobs.ts";
import { removeTmp } from "./fixtures/git.ts";

afterAll(removeTmp);

test("started nodes reach each other's peer routes until they stop", async () => {
  const [a, b] = await startNodes("a", "b");
  // Neither node has T3 Code connected, so b answers with an empty view of its own.
  expect(await peerCall(a!.s, "b", "/threads")).toMatchObject({ t3: { connected: false }, threads: [] });
  expect(await peerCall(b!.s, "a", "/threads")).toMatchObject({ t3: { connected: false }, threads: [] });

  await Promise.all([a!.stop(), b!.stop()]);
  await expect(fetch(`${a!.url}/peer/threads`)).rejects.toThrow();
  await expect(fetch(`${b!.url}/peer/threads`)).rejects.toThrow();
});
