import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timeoutSignal } from "hanzio";
import { runSkillCommand } from "../skill-import.ts";
import { CONFIG_DIR } from "../store.ts";

/**
 * Fetches the factory's folder from GitHub into one directory per commit, `<agentgate home>/factory/<commit>/`, so an
 * item keeps reading the folder it started with while newer commits arrive.
 */

/** Resolves null when the ref is still at `since`. */
export type FolderFetcher = (input: {
  repo: string;
  ref?: string;
  path: string;
  since?: string;
}) => Promise<{ commit: string; dir: string } | null>;

const COMMIT = /^[0-9a-f]{40,64}$/;

/** `path` from `settings.factory` as a relative folder: "" is the repository's root, and `..` is refused. */
export function folderPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  if (parts.some((p) => p === "." || p === ".." || p.includes("\\")))
    throw new Error(`${path} is not a folder inside the repository`);
  return parts.join("/");
}

// Git's own message, without color codes, cut to its last lines: it names the repository and ref, never a token.
const plain = (text: string) =>
  text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .join("; ")
    .slice(0, 500);

const fetchFolder: FolderFetcher = async ({ repo, ref, path, since }) => {
  const folder = folderPath(path);
  const bin = Bun.which("git");
  if (!bin) throw new Error("the factory needs git on the machine that runs it");
  // This machine's gh login reads private repositories; without gh, only public ones work.
  const gh = Bun.which("gh");
  const auth = ["-c", "credential.helper=", ...(gh ? ["-c", `credential.helper=!"${gh}" auth git-credential`] : [])];
  const url = `https://github.com/${repo}.git`;
  const at = ref ? `${repo} at ${ref}` : repo;
  const bounded = timeoutSignal(120_000);
  const scratch = mkdtempSync(join(tmpdir(), "agentgate-factory-"));
  const git = async (cwd: string, ...args: string[]) => {
    const { out, err, code } = await runSkillCommand([bin, ...auth, ...args], cwd, bounded);
    if (code === 0) return out.trim();
    const detail = plain(err) || `exit ${code}`;
    // ls-remote fails first and clearest for a missing repository or a login that cannot read it.
    if (args[0] === "ls-remote")
      throw new Error(`${repo} was not found, or this machine's gh login cannot read it (${detail})`);
    throw new Error(`git ${args[0]} of ${at} failed: ${detail}`);
  };

  try {
    // A cheap check first, so an unmoved ref costs one round trip.
    const refs = (await git(scratch, "ls-remote", "--", url, ref ?? "HEAD")).split("\n").map((l) => l.split("\t"));
    const named = (name: string) => refs.find(([, n]) => n === name)?.[0];
    // A branch, else an annotated tag's commit, else a lightweight tag.
    const head = ref
      ? (named(`refs/heads/${ref}`) ?? named(`refs/tags/${ref}^{}`) ?? named(`refs/tags/${ref}`))
      : named("HEAD");
    if (!head) throw new Error(`${repo} has no branch or tag named ${ref}`);
    if (head === since) return null;
    const known = join(fetcher.root, head);
    if (existsSync(known)) return { commit: head, dir: known };

    const sparse = folder ? ["--filter=blob:none", "--sparse"] : [];
    const branch = ref ? ["--branch", ref] : [];
    await git(scratch, "clone", "--quiet", "--depth", "1", ...sparse, ...branch, "--", url, "repo");
    const clone = join(scratch, "repo");
    if (folder) await git(clone, "sparse-checkout", "set", "--no-cone", `/${folder}/`);

    const commit = await git(clone, "rev-parse", "HEAD");
    if (!COMMIT.test(commit)) throw new Error(`git rev-parse of ${at} returned no commit`);
    const source = join(clone, folder);
    if (!existsSync(source) || !lstatSync(source).isDirectory())
      throw new Error(`${folder || "the root"} is not a folder in ${at}`);

    const dir = join(fetcher.root, commit);
    if (existsSync(dir)) return { commit, dir };

    // Copied beside its final name and renamed, so a directory named after a commit is always complete. Links are
    // left out: one could point outside the repository.
    mkdirSync(fetcher.root, { recursive: true });
    const partial = join(fetcher.root, `.${commit}-${crypto.randomUUID()}`);
    cpSync(source, partial, {
      recursive: true,
      filter: (file) => !file.endsWith("/.git") && !lstatSync(file).isSymbolicLink(),
    });
    renameSync(partial, dir);
    return { commit, dir };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

/** Tests replace `fetch` and point `root` at a temporary folder. */
export const fetcher: { root: string; fetch: FolderFetcher } = {
  root: join(CONFIG_DIR, "factory"),
  fetch: fetchFolder,
};

/** Deletes every commit directory not in `keep`, and copies a crash left behind. */
export function pruneFolders(keep: Iterable<string>) {
  const kept = new Set(keep);
  let entries: string[] = [];
  try {
    entries = readdirSync(fetcher.root);
  } catch {
    // Nothing fetched on this machine yet.
    return;
  }
  for (const name of entries) if (!kept.has(name)) rmSync(join(fetcher.root, name), { recursive: true, force: true });
}
