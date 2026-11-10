import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { noWords, operation, requireFactoryProtocol, UsageError, type FactoryRuntime } from "./runtime.ts";

/**
 * The factory folder agentgate stores, for a project whose repository must not hold it: one synced `factoryFolder`
 * record that the `folder` operations edit, from the CLI and the app, and that `factory init --store agentgate` and
 * `source add` write. Every write checks that the result loads, so the stored folder is never broken. Two machines
 * that save at once keep the later save, like every record. The record is every machine's, so the operations run
 * where they are asked.
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
  if (f.pointer()?.store === "agentgate")
    throw new Error("The factory runs on the stored folder; turn it off with agentgate factory off first");
  if (!storedFiles(f.s)) throw new Error(NO_STORED_FOLDER);
  f.s.del("factoryFolder", STORED_FOLDER);
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
}
