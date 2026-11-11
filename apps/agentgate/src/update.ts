import { chmodSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import packageInfo from "../../../package.json";
import { PeerError, peerCall } from "./handoff/jobs.ts";
import { routeHere } from "./setup.ts";
import { isServiceProcess, serviceRuns } from "./service.ts";
import { selfCommand } from "./setup.ts";
import { CONFIG_DIR, liveOnly, type Store } from "./store.ts";
import { nodeUpdateSchema, type NodeUpdate } from "@agentgate/protocol";
import { z } from "zod";
import { defineLocal } from "./local-state.ts";

const REPO = process.env.AGENTGATE_REPO ?? "HansKristoffer/agentgate";
const NPM = "@hanskristoffer/agentpool";
const asset = `agentgate-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;

/** An update failure whose message is ours: it names paths, versions and HTTP statuses, never another program's text,
 * so status and a paired node may show it. */
export class UpdateError extends Error {}

/** Replace `target` with the latest release's binary for this machine, checked against the release's SHA256SUMS
 * like install.sh does. Returns the new version, or undefined when `current` is already the latest. */
export async function installLatest(target: string, current = packageInfo.version, github = "https://github.com") {
  // The redirect names the release, so the binary and its checksum come from the same one.
  const latest = await fetch(`${github}/${REPO}/releases/latest`, {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  await latest.body?.cancel();
  const tag = latest.headers.get("location")?.split("/").pop();
  if (!tag) throw new UpdateError(`could not find the latest agentgate release (HTTP ${latest.status})`);
  if (tag.replace(/^v/, "") === current) return undefined;

  const base = `${github}/${REPO}/releases/download/${tag}`;
  const download = async (name: string) => {
    const response = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok) throw new UpdateError(`could not download ${name} from ${tag} (HTTP ${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const [binary, sums] = await Promise.all([download(asset), download("SHA256SUMS")]);
  const expected = new TextDecoder()
    .decode(sums)
    .split("\n")
    .map((line) => line.split(/\s+/))
    .find(([, name]) => name === asset)?.[0];
  if (expected?.length !== 64) throw new UpdateError(`${tag} has no checksum for ${asset}`);
  if (new Bun.CryptoHasher("sha256").update(binary).digest("hex") !== expected)
    throw new UpdateError("checksum verification failed; nothing was changed");

  // Rename over the old file: the running daemon keeps its copy until it restarts.
  const temp = join(dirname(target), `.agentgate-update.${crypto.randomUUID()}`);
  try {
    await Bun.write(temp, binary);
    chmodSync(temp, 0o755);
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
  return tag.replace(/^v/, "");
}

/** Update this machine's binary unless another tool owns it. `restart` says whether the installed service runs this
 * binary, so restarting it picks up the new version. */
export async function updateSelf() {
  liveOnly("agentgate update");
  if (!Bun.main.startsWith("/$bunfs/"))
    throw new UpdateError("agentgate runs from source here; update it with git pull");
  const target = selfCommand()[0]!;
  // The app reinstalls its bundled copy whenever it differs, which would undo this update.
  if (process.platform === "darwin" && target === resolve(CONFIG_DIR, "bin", "agentgate"))
    throw new UpdateError("This copy belongs to the Agentgate app, which keeps it up to date. Update the app instead.");
  if (target.includes("/node_modules/"))
    throw new UpdateError(
      `agentgate was installed with npm; update it with npm install -g ${NPM}@latest, then agentgate service restart`,
    );
  const version = await installLatest(target);
  return { target, version, restart: !!version && serviceRuns(target) };
}

/** Exits the daemon after the reply is out; launchd (KeepAlive) and systemd (Restart=always) start the new binary.
 * A seam so tests do not stop the test runner. */
export const restart = { soon: () => void setTimeout(() => process.kill(process.pid, "SIGTERM"), 1000) };

/** Update the node this daemon runs on, from the API or a paired node. `version` is absent when it was current.
 * Past the checkout guard it throws only an UpdateError, whose message a paired node shows as is. */
export async function updateHere(s: Store) {
  // Outside the try, so a checkout's refusal keeps its own explanation.
  liveOnly("agentgate update");
  let result;
  try {
    result = await updateSelf();
  } catch (e) {
    if (e instanceof UpdateError) throw e;
    console.warn(`update failed: ${e instanceof Error ? e.name : "unknown error"}`);
    throw new UpdateError("the update could not be downloaded or installed; run agentgate update on this node");
  }
  // Exiting a daemon the service manager did not start would leave it down.
  const restarting = result.restart && isServiceProcess();
  if (restarting) restart.soon();
  return { node: s.nodeId, version: result.version, restarting };
}

/** `setup --primary [off]` on any node: this one, or a paired one over the peer channel. The deliberate exception to
 * coding-tool setup being local-only: routing your own server is something you set up from your laptop. */
export async function routeNode(s: Store, node: string, on: boolean): Promise<Awaited<ReturnType<typeof routeHere>>> {
  if (node === s.nodeId) return routeHere(s, on);
  try {
    return await peerCall(s, node, "/setup/primary", { json: { on } });
  } catch (e) {
    if (e instanceof PeerError && e.status === 404)
      throw new Error(
        `${node} runs an agentgate too old to switch from here; run agentgate setup --primary on ${node}`,
      );
    throw e;
  }
}

/** Update any node: this one, or a paired one over the peer channel.
 * ponytail: the download runs inside the call, so a link slower than ~1 MB/s times out; make it a job if that bites. */
export async function updateNode(s: Store, node: string): Promise<Awaited<ReturnType<typeof updateHere>>> {
  if (node === s.nodeId) return updateHere(s);
  try {
    return await peerCall(s, node, "/update", { method: "POST", timeout: 90_000 });
  } catch (e) {
    if (e instanceof PeerError && e.status === 404)
      throw new UpdateError(`${node} runs an agentgate too old to update from here; run agentgate update on ${node}`);
    throw e;
  }
}

// `from`: the version the node ran when it installed the update, for `nodeUpdate`. Kept out of NodeUpdate.
const updates = defineLocal("update:", nodeUpdateSchema.extend({ from: z.string().nullable().optional() }), {
  topic: "status",
});

/** Where an update this daemon started stands, until the node runs the new release: node-local, shown in status so the
 * app and `agentgate nodes` can follow it. Done once the node's record reports the version; a node that does not come
 * back in time shows as failed. */
export function nodeUpdate(s: Store, node: string): NodeUpdate | undefined {
  const stored = updates.get(s, node);
  if (!stored) return undefined;
  const { from, ...u } = stored;
  const running = s.get("node", node)?.version ?? null;
  if (u.version && running === u.version) return undefined;
  // Waiting for a restart onto u.version: once the node runs anything other than what it ran then (an older or newer
  // release, installed some other way), that restart is not coming.
  if (u.state === "installed" && from !== undefined && running !== from) return undefined;
  const age = s.now() - u.since;
  if (u.state === "installing" && age > 15 * 60_000) return { ...u, state: "failed", error: `${node} did not answer` };
  if (u.state === "restarting" && age > 3 * 60_000)
    return { ...u, state: "failed", error: `${node} installed ${u.version} but did not come back on it` };
  // A failure stays visible for a while, then the Update button is all that is left.
  return u.state === "failed" && age > 60 * 60_000 ? undefined : u;
}

/** `updateNode`, recorded for `nodeUpdate`. Refuses a second update of a node while one is under way. */
export async function updateTracked(s: Store, node: string) {
  const running = nodeUpdate(s, node);
  if (running && running.state !== "failed") throw new Error(`${node} is already updating`);
  const note = (u: (Omit<NodeUpdate, "since"> & { from?: string | null }) | undefined) =>
    updates.set(s, node, u && { ...u, since: s.now() });
  note({ state: "installing" });
  try {
    const result = await updateNode(s, node);
    note(
      !result.version
        ? undefined
        : result.restarting
          ? { state: "restarting", version: result.version }
          : { state: "installed", version: result.version, from: s.get("node", node)?.version ?? null },
    );
    return result;
  } catch (e) {
    note({ state: "failed", error: failure(e, node) });
    throw e;
  }
}

/** What status shows for a failed update: never the text of an error we did not word. */
function failure(e: unknown, node: string) {
  if (e instanceof UpdateError) return e.message;
  // A paired node answers 409 with the UpdateError its updateHere threw.
  if (e instanceof PeerError) return e.status === 409 ? e.message : `${node} answered ${e.status}`;
  return `${node} could not be updated`;
}

/** Wait until `node` reports running `version`: a daemon writes it on its node record when it starts, and the record
 * reaches this store through sync. Resolves whether it did within `timeout`. A seam for tests: `sleep`. */
export async function waitForVersion(
  s: Store,
  node: string,
  version: string,
  timeout = 90_000,
  sleep: (ms: number) => Promise<unknown> = Bun.sleep,
) {
  const deadline = s.now() + timeout;
  for (;;) {
    if (s.get("node", node)?.version === version) return true;
    if (s.now() >= deadline) return false;
    await sleep(1000);
  }
}

/** What to tell someone whose CLI is not the release the daemon runs. The daemon writes its version on its node record
 * when it starts; a global npm or bun install earlier on PATH than the installed binary is the usual stale copy. */
export function versionNotice(daemon: string, mine = packageInfo.version, exec = process.execPath) {
  const older = mine.localeCompare(daemon, "en", { numeric: true }) < 0;
  const fix = !older
    ? "restart it with agentgate service restart, or update the copy it runs"
    : exec.includes("/.bun/install/global/")
      ? `update this copy with bun add -g ${NPM}@${daemon}`
      : exec.includes("/node_modules/")
        ? `update this copy with npm install -g ${NPM}@${daemon}`
        : "update this copy with agentgate update";
  return `this agentgate is ${mine} (${exec}) but the daemon runs ${daemon}; ${fix}`;
}

/** A global npm or bun install of agentgate that PATH finds, its version, and the command that installs another. */
export function pathCopy(found = Bun.which("agentgate")) {
  let script: string;
  try {
    script = realpathSync(found ?? "");
  } catch {
    return undefined;
  }
  if (!script.endsWith(`/node_modules/${NPM}/bin/agentpool.js`)) return undefined;
  let version: string | undefined;
  try {
    version = JSON.parse(readFileSync(join(dirname(script), "..", "package.json"), "utf8")).version;
  } catch {}
  const manager = script.includes("/.bun/install/global/") ? ["bun", "add", "-g"] : ["npm", "install", "-g"];
  return { path: found!, version, install: (to: string) => [...manager, `${NPM}@${to}`] };
}
