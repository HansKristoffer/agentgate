import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { factoryFolderSchema, storedFolderChangeSchema, type StoredFolderView } from "@agentgate/protocol";
import { z } from "zod";
import { loadFolder, storedChanged } from "./config.ts";
import {
  NO_STORED_FOLDER,
  sortedFiles,
  STORED_FOLDER,
  storedCommit,
  storedFiles,
  writeFiles,
  type FolderFiles,
} from "./folder.ts";
import { runsOnStoredFolder } from "./folder-store.ts";
import { noWords, operation, requireFactoryProtocol, UsageError, type FactoryRuntime } from "./runtime.ts";

/**
 * The factory folder agentgate stores: one synced `factoryFolder` record that `factory init` starts, the `folder`
 * operations edit from the CLI and the app, and changes proposed through folder-store.ts write. Every write checks that
 * the result loads, so the stored folder is never broken. Two machines that save at once keep the later save, like
 * every record. The record is every machine's, so the operations run where they are asked.
 */

type FolderChanges = Record<string, string | null>;

/** `files` with `changes` applied: text writes a file, null deletes it. */
function withChanges(files: FolderFiles, changes: FolderChanges): FolderFiles {
  const next = { ...files };
  for (const [path, text] of Object.entries(changes))
    if (text === null) delete next[path];
    else next[path] = text;
  return next;
}

/** The record for `files`, checked for its paths and size and that it loads as a factory folder. Throws a FolderError
 * naming the file and field otherwise. */
function checkStored(s: { nodeId: string }, files: FolderFiles) {
  const sorted = sortedFiles(files);
  const parsed = factoryFolderSchema.safeParse({ files: sorted, from: s.nodeId });
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const at = typeof issue.path[1] === "number" ? sorted[issue.path[1]]?.path : undefined;
    throw new Error(at ? `${at}: ${issue.message}` : `The folder: ${issue.message}`);
  }
  const record = parsed.data;
  const dir = mkdtempSync(join(tmpdir(), "agentgate-factory-check-"));
  try {
    writeFiles(dir, files);
    loadFolder(dir, storedCommit(files));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return record;
}

/** Saves the stored folder with `changes`, or starts one from them when agentgate stores none. Returns the new
 * folder. */
export async function changeStored(f: FactoryRuntime, changes: FolderChanges) {
  const { s } = f;
  requireFactoryProtocol(s);
  const files = withChanges(storedFiles(s) ?? {}, changes);
  s.put("factoryFolder", STORED_FOLDER, checkStored(s, files));
  await storedChanged(f);
  return view(f);
}

function view(f: FactoryRuntime): StoredFolderView {
  const files = storedFiles(f.s);
  return files ? { commit: storedCommit(files), files: sortedFiles(files) } : { files: [] };
}

/** Removes the stored folder; refused while the factory runs on it, since off keeps it to turn on again. */
function deleteStored(f: FactoryRuntime) {
  if (runsOnStoredFolder(f))
    throw new Error("The factory runs on the stored folder; turn it off with agentgate factory off first");
  if (!storedFiles(f.s)) throw new Error(NO_STORED_FOLDER);
  f.s.del("factoryFolder", STORED_FOLDER);
}

/** Every file under `dir` by its path inside it. Links are left out, as a fetch from git leaves them out, and so are
 * names that start with a dot (`.git`, `.DS_Store`), which a stored folder cannot hold. */
function readDir(dir: string, under = ""): FolderFiles {
  const files: FolderFiles = {};
  for (const entry of readdirSync(join(dir, under), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = under ? `${under}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, readDir(dir, path));
    else if (entry.isFile()) files[path] = readFileSync(join(dir, path), "utf8");
    // A stored folder holds at most 500 files; this stops before reading a whole home directory named by mistake.
    if (Object.keys(files).length > 500) throw new Error(`${dir} has more than the 500 files a stored folder holds`);
  }
  return files;
}

/** `folder import`: the stored folder becomes exactly the directory's files, checked as a whole like every write. */
function importStored(f: FactoryRuntime, dir: string) {
  const files = readDir(dir);
  const gone = Object.keys(storedFiles(f.s) ?? {}).filter((path) => !(path in files));
  return changeStored(f, { ...Object.fromEntries(gone.map((path) => [path, null])), ...files });
}

/** `folder export`: the stored folder's files written into `dir`, which is created; one with files in it only with
 * `force`, which writes over files of the same name and leaves the others. */
function exportStored(f: FactoryRuntime, dir: string, force?: boolean) {
  const files = storedFiles(f.s);
  if (!files) throw new Error(NO_STORED_FOLDER);
  if (!force && existsSync(dir) && readdirSync(dir).length)
    throw new Error(`${dir} is not empty; --force writes the files into it anyway`);
  mkdirSync(dir, { recursive: true });
  writeFiles(dir, files);
  return { files: Object.keys(files).length };
}

const dirInput = z.object({
  dir: z.string().min(1).max(4096).refine(isAbsolute, "the directory must be an absolute path"),
  force: z.boolean().optional(),
});
/** The directory a terminal names: the daemon's working directory is not the CLI's, so a relative one is resolved
 * against the directory the CLI ran in. */
function dirWords(args: string[], cwd: string | undefined, withForce: boolean) {
  const { values, positionals } = parseArgs({
    args,
    options: withForce ? { force: { type: "boolean" } } : {},
    allowPositionals: true,
  });
  if (positionals.length !== 1 || !positionals[0]) throw new UsageError();
  const dir = positionals[0];
  if (!isAbsolute(dir) && !cwd) throw new Error("Give the directory as an absolute path");
  return { input: { dir: resolve(cwd ?? "/", dir), ...(values.force && { force: true }) } };
}

// ---- setup

const at = (saved: StoredFolderView) => `the stored folder is at ${saved.commit!.slice(0, 7)}`;
/** The one path `cat`, `put` or `rm` names in a terminal. */
const onePath = (args: string[]) => {
  if (args.length !== 1 || !args[0]) throw new UsageError();
  return args[0];
};

export function setup(f: FactoryRuntime): void {
  operation(f, {
    name: "folder ls",
    summary: "the files of the factory folder agentgate stores",
    input: z.object({}),
    local: true,
    run: () => view(f),
    terminal: {
      usage: "folder ls",
      parse: noWords,
      print({ commit, files }) {
        if (!commit) throw new Error(NO_STORED_FOLDER);
        return [
          `The stored folder is at ${commit.slice(0, 7)}:`,
          ...files.map((file) => `  ${file.path}  ${Buffer.byteLength(file.text)} bytes`),
        ];
      },
    },
  });
  operation(f, {
    name: "folder cat",
    summary: "print one of its files",
    input: z.object({ path: z.string() }),
    local: true,
    run({ path }) {
      const files = storedFiles(f.s);
      const text = files?.[path];
      if (text === undefined) throw new Error(files ? `The stored folder has no ${path}` : NO_STORED_FOLDER);
      return { text };
    },
    terminal: {
      usage: "folder cat <path>",
      parse: (args) => ({ input: { path: onePath(args) } }),
      print: ({ text }) => [text.replace(/\n$/, "")],
    },
  });
  operation(f, {
    name: "folder put",
    summary: "write a file from stdin",
    input: storedFolderChangeSchema,
    local: true,
    run: ({ files }) => changeStored(f, files),
    terminal: {
      usage: "folder put <path> < file",
      stdin: true,
      parse(args, stdin) {
        const path = onePath(args);
        if (stdin === undefined) throw new Error("put reads the file from stdin: put <path> < file");
        return { input: { files: { [path]: stdin } } };
      },
      print: (saved, { input }) => [`Saved ${Object.keys(input.files)[0]}; ${at(saved)}.`],
    },
  });
  operation(f, {
    name: "folder rm",
    summary: "remove a file",
    input: z.object({ path: z.string() }),
    local: true,
    run({ path }) {
      const files = storedFiles(f.s);
      if (files && !(path in files)) throw new Error(`The stored folder has no ${path}`);
      return changeStored(f, { [path]: null });
    },
    terminal: {
      usage: "folder rm <path>",
      parse: (args) => ({ input: { path: onePath(args) } }),
      print: (saved, { input }) => [`Removed ${input.path}; ${at(saved)}.`],
    },
  });
  operation(f, {
    name: "folder delete",
    summary: "delete the stored folder; refused while the factory runs on it",
    input: z.object({}),
    local: true,
    run() {
      deleteStored(f);
      return view(f);
    },
    terminal: { usage: "folder delete", parse: noWords, print: () => ["The stored folder is deleted."] },
  });
  // Both touch this machine's disk, so they are refused over the tailnet, and only a terminal names a directory.
  operation(f, {
    name: "folder export",
    summary: "write the stored folder's files into a directory, to keep it in git",
    input: dirInput,
    local: true,
    loopbackOnly: true,
    run: ({ dir, force }) => exportStored(f, dir, force),
    terminal: {
      usage: "folder export <dir> [--force]",
      parse: (args, _, cwd) => dirWords(args, cwd, true),
      print: ({ files }, { input }) => [`Wrote the stored folder's ${files} files to ${input.dir}.`],
    },
  });
  operation(f, {
    name: "folder import",
    summary: "replace the stored folder with a directory's files, checked as a whole",
    input: dirInput.omit({ force: true }),
    local: true,
    loopbackOnly: true,
    run: ({ dir }) => importStored(f, dir),
    terminal: {
      usage: "folder import <dir>",
      parse: (args, _, cwd) => dirWords(args, cwd, false),
      print: (saved) => [`Imported ${saved.files.length} files; ${at(saved)}.`],
    },
  });
}
