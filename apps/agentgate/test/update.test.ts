import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outdatedNodes } from "@agentgate/protocol";
import { Store } from "../src/store.ts";
import {
  installLatest,
  nodeUpdate,
  pathCopy,
  routeNode,
  updateNode,
  updateTracked,
  versionNotice,
  waitForVersion,
} from "../src/update.ts";

const asset = `agentgate-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
let checksum = sha("new-binary");

// A stand-in for GitHub's release redirect and download URLs.
const github = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/releases/latest"))
      return new Response(null, {
        status: 302,
        headers: { location: "https://github.com/x/agentgate/releases/tag/v9.9.9" },
      });
    if (path.endsWith(`/v9.9.9/${asset}`)) return new Response("new-binary");
    if (path.endsWith("/v9.9.9/SHA256SUMS"))
      return new Response(`${checksum}  ${asset}\n${sha("other")}  agentgate-other\n`);
    return new Response("not found", { status: 404 });
  },
});
const dir = mkdtempSync(join(tmpdir(), "agentgate-update-"));
afterAll(() => {
  github.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test("update replaces the binary with the latest release when its checksum matches", async () => {
  const target = join(dir, "agentgate");
  writeFileSync(target, "old-binary");

  expect(await installLatest(target, "9.9.9", github.url.origin)).toBeUndefined();
  expect(readFileSync(target, "utf8")).toBe("old-binary");

  checksum = "0".repeat(64);
  await expect(installLatest(target, "1.0.0", github.url.origin)).rejects.toThrow("checksum verification failed");
  expect(readFileSync(target, "utf8")).toBe("old-binary");

  checksum = sha("new-binary");
  expect(await installLatest(target, "1.0.0", github.url.origin)).toBe("9.9.9");
  expect(readFileSync(target, "utf8")).toBe("new-binary");
  expect(statSync(target).mode & 0o111).not.toBe(0);
  expect(readdirSync(dir)).toEqual(["agentgate"]);
});

test("nodes behind the newest reported release are outdated, including ones too old to report one", () => {
  const nodes = [
    { id: "a", version: "0.13.0" },
    { id: "b", version: "0.9.1" },
    { id: "c" },
    { id: "d", version: "0.13.0" },
  ];
  expect(outdatedNodes(nodes).map((n) => n.id)).toEqual(["b", "c"]);
  expect(outdatedNodes(nodes.map(({ id }) => ({ id })))).toEqual([]);
});

test("routing a paired node's coding tools asks it over the peer channel; this checkout never touches its own", async () => {
  let answer = (on: boolean) => Response.json({ node: "server", message: on ? "on" : "off" });
  const peer = Bun.serve({
    port: 0,
    fetch: async (req) =>
      new URL(req.url).pathname === "/peer/setup/primary" && req.headers.get("authorization") === "Bearer t"
        ? answer(((await req.json()) as { on: boolean }).on)
        : new Response("no", { status: 401 }),
  });
  try {
    const s = new Store(":memory:");
    s.setLocal("node", "laptop");
    s.put("node", "laptop", { id: "laptop", alwaysOn: false });
    s.db.run("insert or replace into peers values ('server', ?, 't', 0, null)", [peer.url.origin]);
    expect(await routeNode(s, "server", false)).toEqual({ node: "server", message: "off" });
    answer = () => Response.json({ error: "not found" }, { status: 404 });
    await expect(routeNode(s, "server", true)).rejects.toThrow("too old to switch from here");
    await expect(routeNode(s, "laptop", true)).rejects.toThrow("real setup");
  } finally {
    peer.stop(true);
  }
});

test("updating a paired node asks it over the peer channel and explains a node too old to answer", async () => {
  let answer = Response.json({ node: "server", version: "9.9.9", restarting: true });
  const peer = Bun.serve({
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === "/peer/update" && req.headers.get("authorization") === "Bearer t"
        ? answer
        : new Response("no", { status: 401 }),
  });
  try {
    const s = new Store(":memory:");
    s.setLocal("node", "laptop");
    s.db.run("insert or replace into peers values ('server', ?, 't', 0, null)", [peer.url.origin]);
    expect(await updateNode(s, "server")).toEqual({ node: "server", version: "9.9.9", restarting: true });
    answer = Response.json({ error: "not found" }, { status: 404 });
    await expect(updateNode(s, "server")).rejects.toThrow("too old to update from here");
    await expect(updateNode(s, "elsewhere")).rejects.toThrow("not paired");
  } finally {
    peer.stop(true);
  }
});

test("a CLI that is not the daemon's release says how to fix the copy that is stale", () => {
  const bun = "/Users/me/.bun/install/global/node_modules/agentpool-darwin-arm64/bin/agentgate";
  expect(versionNotice("0.21.0", "0.20.0", bun)).toEndWith(
    "update this copy with bun add -g @hanskristoffer/agentpool@0.21.0",
  );
  expect(versionNotice("0.21.0", "0.20.0", "/usr/lib/node_modules/agentpool-linux-x64/bin/agentgate")).toEndWith(
    "npm install -g @hanskristoffer/agentpool@0.21.0",
  );
  expect(versionNotice("0.10.0", "0.9.0", "/home/me/.local/bin/agentgate")).toEndWith("agentgate update");
  expect(versionNotice("0.21.0", "0.22.0", bun)).toContain("agentgate service restart");

  // A bun global install on PATH: ~/.bun/bin/agentgate links to the package's launcher.
  const home = mkdtempSync(join(tmpdir(), "agentgate-path-"));
  const pkg = join(home, ".bun", "install", "global", "node_modules", "@hanskristoffer", "agentpool");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  mkdirSync(join(home, ".bun", "bin"));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "0.20.0" }));
  writeFileSync(join(pkg, "bin", "agentpool.js"), "");
  symlinkSync(join(pkg, "bin", "agentpool.js"), join(home, ".bun", "bin", "agentgate"));
  const copy = pathCopy(join(home, ".bun", "bin", "agentgate"))!;
  expect(copy.version).toBe("0.20.0");
  expect(copy.install("0.21.0")).toEqual(["bun", "add", "-g", "@hanskristoffer/agentpool@0.21.0"]);
  expect(pathCopy("/usr/local/bin/agentgate-not-there")).toBeUndefined();
  rmSync(home, { recursive: true, force: true });
});

test("an update shows while it installs and restarts, clears once the node runs the release, and shows a failure", async () => {
  const gate = Promise.withResolvers<Response>();
  let answer: () => Promise<Response> = () => gate.promise;
  const peer = Bun.serve({ port: 0, fetch: () => answer() });
  try {
    const s = new Store(":memory:");
    let now = 1_000_000;
    s.now = () => now;
    s.setLocal("node", "laptop");
    s.put("node", "server", { id: "server", version: "9.9.8" });
    s.db.run("insert or replace into peers values ('server', ?, 't', 0, null)", [peer.url.origin]);
    const running = updateTracked(s, "server");
    expect(nodeUpdate(s, "server")).toMatchObject({ state: "installing" });
    await expect(updateTracked(s, "server")).rejects.toThrow("already updating");
    gate.resolve(Response.json({ node: "server", version: "9.9.9", restarting: true }));
    await running;
    expect(nodeUpdate(s, "server")).toMatchObject({ state: "restarting", version: "9.9.9" });
    // The restarted node's record arrives through sync.
    s.put("node", "server", { id: "server", version: "9.9.9" });
    expect(nodeUpdate(s, "server")).toBeUndefined();

    answer = async () => Response.json({ error: "this copy belongs to npm" }, { status: 409 });
    await expect(updateTracked(s, "server")).rejects.toThrow("npm");
    expect(nodeUpdate(s, "server")).toMatchObject({ state: "failed", error: "this copy belongs to npm" });
    now += 2 * 60 * 60_000;
    expect(nodeUpdate(s, "server")).toBeUndefined();
    s.close();
  } finally {
    peer.stop(true);
  }
});

test("waiting for an update returns once the node reports the new version, or after the timeout", async () => {
  const s = new Store(":memory:");
  let now = 0;
  s.now = () => now;
  s.put("node", "worker", { id: "worker", version: "0.21.0" });
  let polls = 0;
  // The restarted node's record arrives through sync after a few polls.
  const sleep = async (ms: number) => {
    now += ms;
    if (++polls === 3) s.put("node", "worker", { id: "worker", version: "0.21.1" });
  };
  expect(await waitForVersion(s, "worker", "0.21.1", 90_000, sleep)).toBe(true);
  expect(polls).toBe(3);
  expect(
    await waitForVersion(s, "worker", "0.22.0", 10_000, async (ms) => {
      now += ms;
    }),
  ).toBe(false);
  expect(now).toBe(13_000);
});
