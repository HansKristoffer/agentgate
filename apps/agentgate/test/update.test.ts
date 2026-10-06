import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outdatedNodes } from "@agentgate/protocol";
import { Store } from "../src/store.ts";
import { installLatest, updateNode } from "../src/update.ts";

const asset = `agentgate-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
let checksum = sha("new-binary");

// A stand-in for GitHub's release redirect and download URLs.
const github = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/releases/latest")) return new Response(null, { status: 302, headers: { location: "https://github.com/x/agentgate/releases/tag/v9.9.9" } });
    if (path.endsWith(`/v9.9.9/${asset}`)) return new Response("new-binary");
    if (path.endsWith("/v9.9.9/SHA256SUMS")) return new Response(`${checksum}  ${asset}\n${sha("other")}  agentgate-other\n`);
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
  const nodes = [{ id: "a", version: "0.13.0" }, { id: "b", version: "0.9.1" }, { id: "c" }, { id: "d", version: "0.13.0" }];
  expect(outdatedNodes(nodes).map((n) => n.id)).toEqual(["b", "c"]);
  expect(outdatedNodes(nodes.map(({ id }) => ({ id })))).toEqual([]);
});

test("updating a paired node asks it over the peer channel and explains a node too old to answer", async () => {
  let answer = Response.json({ node: "server", version: "9.9.9", restarting: true });
  const peer = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === "/peer/update" && req.headers.get("authorization") === "Bearer t" ? answer : new Response("no", { status: 401 })) });
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
