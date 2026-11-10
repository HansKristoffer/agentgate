import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryFolderSchema, storedFolderChangeSchema, type StoredFolderView } from "@agentgate/protocol";
import { jsonInput } from "../http.ts";
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
import { asInput, requireFactoryProtocol, type FactoryRuntime } from "./runtime.ts";

/**
 * The factory folder agentgate stores, for a project whose repository must not hold it: one synced `factoryFolder`
 * record that `agentgate factory folder` and the app edit, and that `factory init --store agentgate` and `source add`
 * write. Every write checks that the result loads, so the stored folder is never broken. Two machines that save at
 * once keep the later save, like every record.
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

const FOLDER_USAGE = "folder ls | cat <path> | put <path> < file | rm <path> | delete";

export function setup(f: FactoryRuntime): void {
  f.commands.set("folder", {
    usage: `${FOLDER_USAGE}  the factory folder agentgate stores`,
    local: true,
    stdin: ["put"],
    async run(args, io) {
      const [verb, path, ...extra] = args;
      const usage = () => {
        io.out(`usage: agentgate factory ${FOLDER_USAGE}`);
        return 2;
      };
      if (extra.length) return usage();
      const files = storedFiles(f.s);
      switch (verb) {
        case "ls": {
          if (path) return usage();
          if (!files) throw new Error(NO_STORED_FOLDER);
          io.out(`The stored folder is at ${storedCommit(files).slice(0, 7)}:`);
          for (const file of sortedFiles(files)) io.out(`  ${file.path}  ${Buffer.byteLength(file.text)} bytes`);
          return 0;
        }
        case "cat": {
          if (!path) return usage();
          const text = files?.[path];
          if (text === undefined) throw new Error(files ? `The stored folder has no ${path}` : NO_STORED_FOLDER);
          io.out(text.replace(/\n$/, ""));
          return 0;
        }
        case "put": {
          if (!path) return usage();
          if (io.stdin === undefined) throw new Error("put reads the file from stdin: put <path> < file");
          const saved = await changeStored(f, { [path]: io.stdin });
          io.out(`Saved ${path}; the stored folder is at ${saved.commit!.slice(0, 7)}.`);
          return 0;
        }
        case "rm": {
          if (!path) return usage();
          if (files && !(path in files)) throw new Error(`The stored folder has no ${path}`);
          const saved = await changeStored(f, { [path]: null });
          io.out(`Removed ${path}; the stored folder is at ${saved.commit!.slice(0, 7)}.`);
          return 0;
        }
        case "delete":
          if (path) return usage();
          deleteStored(f);
          io.out("The stored folder is deleted.");
          return 0;
        default:
          return usage();
      }
    },
  });

  f.api.get("/folder", (c) => c.json(view(f)));
  f.api.put("/folder", async (c) => {
    const { files } = storedFolderChangeSchema.parse(await jsonInput(c.req.raw));
    return c.json(await asInput(() => changeStored(f, files)));
  });
  f.api.delete("/folder", async (c) =>
    c.json(
      await asInput(() => {
        deleteStored(f);
        return view(f);
      }),
    ),
  );
}
