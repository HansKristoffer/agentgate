import { chmodSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import packageInfo from "../../../package.json";
import { PeerError, peerCall } from "./handoff/jobs.ts";
import { serviceRuns } from "./service.ts";
import { selfCommand } from "./setup.ts";
import { CONFIG_DIR, liveOnly, type Store } from "./store.ts";

const REPO = process.env.AGENTGATE_REPO ?? "HansKristoffer/agentgate";
const asset = `agentgate-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;

/** Replace `target` with the latest release's binary for this machine, checked against the release's SHA256SUMS
 * like install.sh does. Returns the new version, or undefined when `current` is already the latest. */
export async function installLatest(target: string, current = packageInfo.version, github = "https://github.com") {
  // The redirect names the release, so the binary and its checksum come from the same one.
  const latest = await fetch(`${github}/${REPO}/releases/latest`, { redirect: "manual" });
  const tag = latest.headers.get("location")?.split("/").pop();
  if (!tag) throw new Error(`could not find the latest agentgate release (HTTP ${latest.status})`);
  if (tag.replace(/^v/, "") === current) return undefined;

  const base = `${github}/${REPO}/releases/download/${tag}`;
  const download = async (name: string) => {
    const response = await fetch(`${base}/${name}`);
    if (!response.ok) throw new Error(`could not download ${name} from ${tag} (HTTP ${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const [binary, sums] = await Promise.all([download(asset), download("SHA256SUMS")]);
  const expected = new TextDecoder().decode(sums).split("\n").map((line) => line.split(/\s+/)).find(([, name]) => name === asset)?.[0];
  if (expected?.length !== 64) throw new Error(`${tag} has no checksum for ${asset}`);
  if (new Bun.CryptoHasher("sha256").update(binary).digest("hex") !== expected) throw new Error("checksum verification failed; nothing was changed");

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
  if (process.platform === "darwin" && target === resolve(CONFIG_DIR, "bin", "agentgate")) throw new Error("This copy belongs to the Agentgate app, which keeps it up to date. Update the app instead.");
  if (target.includes("/node_modules/")) throw new Error("agentgate was installed with npm; update it with npm install -g @hanskristoffer/agentpool@latest, then agentgate service restart");
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

/** Update any node: this one, or a paired one over the peer channel.
 * ponytail: the download runs inside the call, so a link slower than ~1 MB/s times out; make it a job if that bites. */
export async function updateNode(s: Store, node: string): Promise<Awaited<ReturnType<typeof updateHere>>> {
  if (node === s.nodeId) return updateHere(s);
  try {
    return await peerCall(s, node, "/update", { method: "POST", timeout: 90_000 });
  } catch (e) {
    if (e instanceof PeerError && e.status === 404) throw new Error(`${node} runs an agentgate too old to update from here; run agentgate update on ${node}`);
    throw e;
  }
}
