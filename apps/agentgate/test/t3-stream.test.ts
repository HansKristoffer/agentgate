import { afterAll, afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTmp, tmp } from "./fixtures/git.ts";
import { fakeT3 } from "./fixtures/t3.ts";
import { connectT3, createPairingLink, host as t3Host, t3Client, T3Error } from "../src/handoff/t3.ts";
import { Store } from "../src/store.ts";

afterAll(removeTmp);

const stops: (() => unknown)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

async function until(fn: () => boolean, what: string) {
  const deadline = Date.now() + 2_000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

async function connected(options: { routes?: (req: Request) => Response | undefined } = {}) {
  const fake = fakeT3({ claudeDir: tmp(), ...options });
  const s = new Store(":memory:");
  s.setLocal("node", "a");
  stops.push(fake.stop, () => s.close());
  await connectT3(s, { url: fake.url, token: fake.pairingToken() });
  return { fake, s, client: t3Client(s) };
}

/** A shell subscription whose items can be awaited one by one. */
function subscribe(client: ReturnType<typeof t3Client>, payload: Record<string, unknown> = {}) {
  const items: unknown[] = [];
  let wake = () => {};
  const controller = new AbortController();
  const done = client.stream(
    "orchestration.subscribeShell",
    payload,
    (values) => {
      items.push(...values);
      wake();
    },
    controller.signal,
  );
  done.catch(() => {}); // each test awaits the outcome it expects
  return {
    done,
    controller,
    async received(count: number) {
      while (items.length < count) await new Promise<void>((resolve) => (wake = resolve));
      return items;
    },
  };
}

test("a shell subscription gets the snapshot, then live updates, acknowledging each chunk until T3 ends it", async () => {
  const { fake, client } = await connected();
  const project = fake.addProject(tmp());
  const thread = fake.addThread({ projectId: project.id, sessionId: "s1" });
  const sub = subscribe(client);

  const [first] = await sub.received(1);
  expect(first).toMatchObject({
    kind: "snapshot",
    snapshot: { threads: [{ id: thread.id }], projects: [{ id: project.id }] },
  });
  const update = {
    kind: "thread.updated",
    sequence: 1,
    location: "active",
    thread: { id: thread.id, title: "Renamed" },
  };
  fake.shell.push(update);
  expect((await sub.received(2))[1]).toEqual(update);
  await until(() => fake.shell.acks === 2, "an ack per chunk");

  fake.shell.end();
  await sub.done;
  expect(fake.shell.subscriptions).toEqual([{}]);
});

test("a resumed subscription sends its sequence and gets no snapshot", async () => {
  const { fake, client } = await connected();
  const sub = subscribe(client, { afterSequence: 7 });
  await until(() => fake.shell.subscriptions.length === 1, "the subscription");
  expect(fake.shell.subscriptions).toEqual([{ afterSequence: 7 }]);

  fake.shell.push({ kind: "thread.removed", sequence: 8, location: "active", threadId: "t1" });
  expect(await sub.received(1)).toEqual([{ kind: "thread.removed", sequence: 8, location: "active", threadId: "t1" }]);
  sub.controller.abort();
});

test("a subscription fails when T3 fails it or the socket drops, and stops reading when aborted", async () => {
  const { fake, client } = await connected();

  const failed = subscribe(client);
  await failed.received(1);
  fake.shell.fail("Failed to prepare the application shell stream");
  await expect(failed.done).rejects.toThrow(
    new T3Error("T3 Code on a: Failed to prepare the application shell stream"),
  );

  const dropped = subscribe(client);
  await dropped.received(1);
  fake.shell.drop();
  await expect(dropped.done).rejects.toThrow(new T3Error("T3 Code on a closed the WebSocket"));

  const aborted = subscribe(client);
  await aborted.received(1);
  aborted.controller.abort();
  await expect(aborted.done).rejects.toThrow("aborted");
  await until(() => fake.server.pendingWebSockets === 0, "the socket to close");
});

test("routes answer on the fake's own origin before its built-in routes", async () => {
  const { fake } = await connected({
    routes: (req) => (new URL(req.url).pathname === "/mcp" ? Response.json({ mcp: true }) : undefined),
  });
  expect(await (await fetch(`${fake.url}/mcp`)).json()).toEqual({ mcp: true });
  expect(await (await fetch(`${fake.url}/.well-known/t3/environment`)).json()).toMatchObject({ label: "fake" });
});

test("a pairing link asks t3 pair for exactly the scopes given", async () => {
  const s = new Store(":memory:");
  s.setLocal("node", "a");
  stops.push(() => s.close());
  // A stand-in for `t3 pair` that records its arguments.
  const dir = tmp(),
    bin = join(dir, "t3"),
    args = join(dir, "args");
  writeFileSync(bin, `#!/bin/sh\necho "$@" > ${args}\necho "Pairing URL: http://127.0.0.1:1/pair#token=t"`, {
    mode: 0o755,
  });
  const real = t3Host.t3;
  t3Host.t3 = () => bin;
  stops.push(() => {
    t3Host.t3 = real;
  });

  await createPairingLink(s, { scopes: ["orchestration:read", "orchestration:operate"] });
  expect(readFileSync(args, "utf8").trim()).toBe(
    "pair --log-level error --scope orchestration:read --scope orchestration:operate",
  );
});
