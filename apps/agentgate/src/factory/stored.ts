import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  factoryFolderSchema,
  folderProposalSchema,
  storedFolderChangeSchema,
  type FolderProposal,
  type StoredFolderView,
} from "@agentgate/protocol";
import { z } from "zod";
import { jsonInput } from "../http.ts";
import { loadFolder, storedChanged } from "./config.ts";
import { dataOf, runs, type FactoryRun } from "./db.ts";
import {
  NO_STORED_FOLDER,
  sortedFiles,
  STORED_FOLDER,
  storedCommit,
  storedFiles,
  writeFiles,
  type FolderFiles,
} from "./folder.ts";
import { asInput, opRoute, requireFactoryProtocol, runOp, withItem, type FactoryRuntime } from "./runtime.ts";

/**
 * The factory folder agentgate stores, for a project whose repository must not hold it: one synced `factoryFolder`
 * record that `agentgate factory folder` and the app edit, and that `factory init --store agentgate`, `source add` and
 * an applied learning proposal write. Every write checks that the result loads, so the stored folder is never broken.
 * Two machines that save at once keep the later save, like every record.
 */

export const RULINGS = "rulings.md";

type FolderChanges = Record<string, string | null>;

/** `files` with `changes` applied: text writes a file, null deletes it. */
export function withChanges(files: FolderFiles, changes: FolderChanges): FolderFiles {
  const next = { ...files };
  for (const [path, text] of Object.entries(changes))
    if (text === null) delete next[path];
    else next[path] = text;
  return next;
}

/** The record for `files`, checked for its paths and size and that it loads as a factory folder. Throws a FolderError
 * naming the file and field otherwise. */
export function checkStored(s: { nodeId: string }, files: FolderFiles) {
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

// ---- learning proposals

/** A line diff with two lines of context around each change; `…` stands for the lines left out. */
function lineDiff(before: string, after: string) {
  const a = before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  // Folder files are short; a pair too large for the table is shown whole.
  if (a.length * b.length > 4_000_000) return [...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)].join("\n");
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push(` ${a[i++]}`);
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) lines.push(`-${a[i++]}`);
    else lines.push(`+${b[j++]}`);
  }
  const near = (k: number) => lines.slice(Math.max(0, k - 2), k + 3).some((l) => !l.startsWith(" "));
  return lines.flatMap((line, k) => (near(k) ? [line] : k === 0 || near(k - 1) ? ["…"] : [])).join("\n");
}

const proposalOf = (run: FactoryRun | undefined) =>
  run?.report?.result?.kind === "learn" ? run.report.result.proposal : undefined;

function proposalView(run: FactoryRun): FolderProposal {
  const proposed = proposalOf(run)!;
  const { before, state } = dataOf(run, "learn")!.proposal!;
  return folderProposalSchema.parse({
    run: run.id,
    state,
    at: run.endedAt ?? run.queuedAt,
    body: proposed.body,
    files: Object.entries(proposed.files).map(([path, text]) => {
      const old = before[path] ?? null;
      const whole = (sign: string, lines: string) =>
        lines
          .replace(/\n$/, "")
          .split("\n")
          .map((l) => `${sign}${l}`)
          .join("\n");
      if (text === null) return { path, change: "deleted", diff: whole("-", old ?? "") };
      if (old === null) return { path, change: "added", diff: whole("+", text) };
      return { path, change: "changed", diff: lineDiff(old, text) };
    }),
  });
}

/** Shows a learning run's proposal, or applies or discards it. Applying refuses a file someone changed since the run
 * reported, so a proposal never overwrites a newer edit; the maintainer reads it and makes the change by hand. */
async function proposal(f: FactoryRuntime, input: unknown) {
  const { run: id, action } = z
    .object({ run: z.string().min(1).max(100), action: z.enum(["apply", "discard"]).optional() })
    .strict()
    .parse(input);
  const found = runs.get(f.s, id);
  const checked = dataOf(found, "learn");
  if (!found || !proposalOf(found) || !checked?.proposal)
    throw new Error(`${id} is not a learning run with a proposal on ${f.s.nodeId}`);
  if (!action) return proposalView(found);
  return withItem(f, id, async () => {
    const run = runs.get(f.s, id)!;
    const data = dataOf(run, "learn")!;
    const { before, state } = data.proposal!;
    if (state !== "open") throw new Error(`The proposal of ${id} was ${state} already`);
    if (action === "apply") {
      const files = proposalOf(run)!.files;
      const now = storedFiles(f.s) ?? {};
      const moved = Object.keys(files).filter((path) => (now[path] ?? null) !== (before[path] ?? null));
      if (moved.length)
        throw new Error(
          `${moved.join(", ")} changed since ${id} proposed this; read it with agentgate factory proposal ${id} and change the folder by hand`,
        );
      await changeStored(f, files);
    }
    const next = action === "apply" ? "applied" : "discarded";
    runs.update(f.s, id, { checked: { ...data, proposal: { before, state: next } } });
    f.events.emit({ kind: "note", run: id, text: `The learning proposal of ${id} was ${next}` });
    return proposalView(runs.get(f.s, id)!);
  });
}

function proposalText(p: FolderProposal) {
  return [
    `Learning run ${p.run} proposes changes to the stored folder (${p.state}):`,
    "",
    p.body,
    ...p.files.flatMap((file) => ["", `--- ${file.path} (${file.change})`, file.diff]),
    ...(p.state === "open"
      ? [
          "",
          `Apply it with agentgate factory proposal apply ${p.run}, or discard it with agentgate factory proposal discard ${p.run}.`,
        ]
      : []),
  ];
}

/** Open proposals for the board, oldest first. */
function openProposals(f: FactoryRuntime) {
  return runs
    .list(f.s, { kinds: ["learn"] })
    .filter((run) => dataOf(run, "learn")?.proposal?.state === "open" && proposalOf(run))
    .map((run) => ({
      run: run.id,
      at: run.endedAt ?? run.queuedAt,
      files: Object.keys(proposalOf(run)!.files).sort(),
    }));
}

// ---- setup

const FOLDER_USAGE = "folder ls | cat <path> | put <path> < file | rm <path> | delete";

export function setup(f: FactoryRuntime): void {
  f.commands.set("folder", {
    usage: `${FOLDER_USAGE}  the factory folder agentgate stores`,
    local: true,
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

  f.ops.set("proposal", { run: (input) => proposal(f, input) });
  f.commands.set("proposal", {
    usage: "proposal [apply|discard] <run>  a learning run's changes to the stored folder",
    async run(args, io) {
      const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
      const [first, second] = positionals;
      const action = first === "apply" || first === "discard" ? first : undefined;
      const run = action ? second : first;
      if (!run || positionals.length !== (action ? 2 : 1)) {
        io.out("usage: agentgate factory proposal [apply|discard] <run>");
        return 2;
      }
      proposalText(folderProposalSchema.parse(await runOp(f, "proposal", { run, ...(action && { action }) }))).forEach(
        (line) => io.out(line),
      );
      return 0;
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
  f.api.get("/proposals/:run", async (c) => c.json(await opRoute(f, "proposal", { run: c.req.param("run") })));
  f.api.post("/proposals/:run/:action", async (c) =>
    c.json(await opRoute(f, "proposal", { run: c.req.param("run"), action: c.req.param("action") })),
  );
  f.boardParts.push(async () => ({ proposals: openProposals(f) }));
}
