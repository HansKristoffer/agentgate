import type { FactoryPointer, FolderChangeResult } from "@agentgate/protocol";
import { fetcher, storedFetch, storedFiles, type FolderFetcher } from "./folder.ts";
import { branchExists, defaultBranch, openPr, openPrFor, pushNewBranch, readFile } from "./gh.ts";
import type { FactoryRuntime } from "./runtime.ts";
import { changeStored } from "./stored.ts";

/**
 * Where the factory's folder lives, behind one interface: a folder of a repository on GitHub, or the folder agentgate
 * stores (stored.ts). The folder loop reads it, and `source add` and `repo add|remove` propose changes to it, without
 * knowing which it is. The stored folder checks a change as a whole and applies it at once; a folder in git gets a pull
 * request for a person to merge, since whatever reaches its branch changes every later brief.
 */

/** A change to the folder: files by their path inside it, null to remove one. */
export interface FolderChange {
  title: string; // the commit and pull request title
  body: string; // the pull request's description
  branch: string; // the branch a folder in git pushes the change to
  files: Record<string, string | null>;
}

export type Proposed = Exclude<FolderChangeResult, { unchanged: true }>;

export interface FolderStore {
  /** Where the folder is, for a person: `owner/repo:path at ref`, or that agentgate stores it. */
  label: string;
  /** Names the folder, so state kept about one is not read for another. */
  key: string;
  /** The `source` of the skills installed from its `skills/`. */
  skillSource: string;
  /** The folder at its newest revision, as the folder loop loads it; null while it is still at `since`. */
  read(at: { since?: string; tree?: string; signal?: AbortSignal }): ReturnType<FolderFetcher>;
  /** A file's text where a change would start from, or undefined when there is none. */
  file(path: string): Promise<string | undefined>;
  propose(change: FolderChange): Promise<Proposed>;
}

export function folderStore(f: FactoryRuntime, pointer: FactoryPointer): FolderStore {
  return pointer.store === "github" ? gitFolder(pointer) : storedFolder(f);
}

/** Whether the factory runs on the stored folder, which then loads each change at once and cannot be deleted. */
export const runsOnStoredFolder = (f: FactoryRuntime) => f.pointer()?.store === "agentgate";

function storedFolder(f: FactoryRuntime): FolderStore {
  return {
    label: "stored in agentgate",
    key: "agentgate",
    skillSource: "factory:agentgate",
    read: async ({ since }) => storedFetch(f.s, since),
    file: async (path) => storedFiles(f.s)?.[path],
    async propose({ files }) {
      await changeStored(f, files);
      return { applied: true, warnings: [] };
    },
  };
}

function gitFolder({ repo, path, ref }: Extract<FactoryPointer, { store: "github" }>): FolderStore {
  const prefix = path ? `${path}/` : "";
  // A change goes to the branch the factory follows, or to the default branch when it follows a tag. Asked once.
  let target: Promise<{ base: string; warnings: string[] }> | undefined;
  const base = () =>
    (target ??= (async () => {
      if (ref && (await branchExists(repo, ref))) return { base: ref, warnings: [] };
      const warnings = ref
        ? [
            `The factory follows ${ref}, which is not a branch, so the PR goes to the default branch; the change takes effect once ${ref} includes it`,
          ]
        : [];
      return { base: await defaultBranch(repo), warnings };
    })());
  return {
    label: `${repo}${path ? `:${path}` : ""}${ref ? ` at ${ref}` : ""}`,
    key: JSON.stringify([repo.toLowerCase(), path, ref ?? null]),
    skillSource: `factory:${repo.toLowerCase()}`,
    read: ({ since, tree, signal }) => fetcher.fetch({ repo, ref, path, since, signal, ...(tree && { tree }) }),
    file: async (file) => readFile(repo, `${prefix}${file}`, (await base()).base),
    async propose({ title, body, branch, files }) {
      const { base: onto, warnings } = await base();
      // A branch without an open PR is an earlier attempt that failed after pushing: this one takes it over.
      const earlier = await branchExists(repo, branch);
      if (earlier) {
        const open = await openPrFor(repo, branch);
        if (open) throw new Error(`A PR with this change is open: ${open}`);
      }
      const inRepo = Object.fromEntries(Object.entries(files).map(([file, text]) => [`${prefix}${file}`, text]));
      await pushNewBranch(repo, branch, title, inRepo, onto, earlier);
      const pr = await openPr(repo, branch, title, body, { base: onto });
      return { pr: pr.url, warnings };
    },
  };
}
