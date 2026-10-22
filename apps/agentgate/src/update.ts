import { chmodSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { getErrorMessage } from "hanzio";
import { dirname, join, resolve } from "node:path";
import packageInfo from "../../../package.json";
import { PeerError, peerCall } from "./handoff/jobs.ts";
import { routeHere } from "./setup.ts";
import { serviceRuns } from "./service.ts";
import { selfCommand } from "./setup.ts";
import { CONFIG_DIR, liveOnly, type Store } from "./store.ts";
import { nodeUpdateSchema, type NodeUpdate } from "@agentgate/protocol";

const REPO = process.env.AGENTGATE_REPO ?? "HansKristoffer/agentgate";
const NPM = "@hanskristoffer/agentpool";
const asset = `agentgate-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;

/** Replace `target` with the latest release's binary for this machine, checked against the release's SHA256SUMS
 * like install.sh does. Returns the new version, or undefined when `current` is already the latest. */
export async function installLatest(target: string, current = packageInfo.version, github = "https://github.com") {
  // The redirect names the release, so the binary and its checksum come from the same one.
  const latest = await fetch(`${github}/${REPO}/releases/latest`, {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const tag = latest.headers.get("location")?.split("/").pop();
  if (!tag) throw new Error(`could not find the latest agentgate release (HTTP ${latest.status})`);
  if (tag.replace(/^v/, "") === current) return undefined;

  const base = `${github}/${REPO}/releases/download/${tag}`;
  const download = async (name: string) => {
    const response = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok) throw new Error(`could not download ${name} from ${tag} (HTTP ${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const [binary, sums] = await Promise.all([download(asset), download("SHA256SUMS")]);
  const expected = new TextDecoder()
    .decode(sums)
    .split("\n")
    .map((line) => line.split(/\s+/))
    .find(([, name]) => name === asset)?.[0];
  if (expected?.length !== 64) throw new Error(`${tag} has no checksum for ${asset}`);
  if (new Bun.CryptoHasher("sha256").update(binary).digest("hex") !== expected)
    throw new Error("checksum verification failed; nothing was changed");

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
  if (!Bun.main.startsWith("/$bunfs/")) throw new Error("agentgate runs from source here; update it with git pull");
  const target = selfCommand()[0]!;
  // The app reinstalls its bundled copy whenever it differs, which would undo this update.
  if (process.platform === "darwin" && target === resolve(CONFIG_DIR, "bin", "agentgate"))
    throw new Error("This copy belongs to the Agentgate app, which keeps it up to date. Update the app instead.");
  if (target.includes("/node_modules/"))
    throw new Error(
      `agentgate was installed with npm; update it with npm install -g ${NPM}@latest, then agentgate service restart`,
    );
  const version = await installLatest(target);
  return { target, version, restart: !!version && serviceRuns(target) };
}

/** Exits the daemon after the reply is out; launchd (KeepAlive) and systemd (Restart=always) start the new binary.
 * A seam so tests do not stop the test runner. */
export const restart = { soon: () => void setTimeout(() => process.kill(process.pid, "SIGTERM"), 1000) };

/** Update the node this daemon runs on, from the API or a paired node. `version` is absent when it was current. */
export async function updateHere(s: Store) {
  const { version, restart: restarting } = await updateSelf();
  if (restarting) restart.soon();
  return { node: s.nodeId, version, restarting };
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
      throw new Error(`${node} runs an agentgate too old to update from here; run agentgate update on ${node}`);
    throw e;
  }
}

/** Where an update this daemon started stands, until the node runs the new release: node-local, shown in status so the
 * app and `agentgate nodes` can follow it. Done once the node's record reports the version; a node that does not come
 * back in time shows as failed. */
export function nodeUpdate(s: Store, node: string): NodeUpdate | undefined {
  const raw = s.local(`update:${node}`);
  if (!raw) return undefined;
  const parsed = nodeUpdateSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) return undefined;
  const u = parsed.data;
  if (u.version && s.get("node", node)?.version === u.version) return undefined;
  const age = s.now() - u.since;
  if (u.state === "installing" && age > 15 * 60_000) return { ...u, state: "failed", error: `${node} did not answer` };
  if (u.state === "restarting" && age > 3 * 60_000)
    return { ...u, state: "failed", error: `${node} installed ${u.version} but did not come back on it` };
  // A failure stays visible for a while, then the Update button is all that is left.
  return u.state === "failed" && age > 60 * 60_000 ? undefined : u;
}

/** `updateNode`, recorded for `nodeUpdate`. Refuses a second update of a node while one is under way. */
export async function updateTracked(s: Store, node: string) {
  const key = `update:${node}`;
  const running = nodeUpdate(s, node);
  if (running && running.state !== "failed") throw new Error(`${node} is already updating`);
  const note = (u: Omit<NodeUpdate, "since"> | undefined) =>
    s.setLocal(key, u && JSON.stringify({ ...u, since: s.now() }));
  note({ state: "installing" });
  try {
    const result = await updateNode(s, node);
    note(
      !result.version ? undefined : { state: result.restarting ? "restarting" : "installed", version: result.version },
    );
    return result;
  } catch (e) {
    note({ state: "failed", error: getErrorMessage(e) });
    throw e;
  }
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
