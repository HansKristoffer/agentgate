import { chmodSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import packageInfo from "../../../package.json";

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
