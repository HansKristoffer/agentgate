import { runTerminal, shownError, type TerminalOp, type TerminalResult } from "../ops/index.ts";
import { store } from "../store.ts";
import { die, initialized, management } from "./common.ts";

/** Bun's error when nothing listens on the daemon's port. */
const noDaemon = (e: unknown) => (e as { code?: unknown } | null)?.code === "ECONNREFUSED";

/**
 * `agentgate <words>` for a registered control operation. It goes through the running daemon, so the daemon's memory
 * and the app's change feed see it at once. With no daemon, an operation that needs only the store runs here.
 */
export async function runOp(op: TerminalOp, words: string[]): Promise<never> {
  // Stdin is read only for an operation that takes it: any other must answer while its stdin stays open and silent.
  const stdin = op.terminal.stdin && !process.stdin.isTTY ? await Bun.stdin.text() : undefined;
  const cwd = process.cwd();
  const answer = await management<TerminalResult>("/ops-terminal", "POST", {
    words,
    ...(stdin !== undefined && { stdin }),
    cwd,
  }).catch((e) => {
    if (noDaemon(e)) return undefined;
    throw e;
  });
  const result = answer ?? (await here(op, words, stdin, cwd));
  for (const line of result.lines) console.log(line);
  process.exit(result.code);
}

async function here(op: TerminalOp, words: string[], stdin: string | undefined, cwd: string) {
  if (op.needs === "daemon") return die("agentgate is not running (agentgate serve or service start)");
  const s = initialized(store());
  try {
    return await runTerminal(op, words, stdin, cwd, { s });
  } catch (e) {
    return die(shownError(e) || `The operation failed (${e instanceof Error ? e.name : "error"})`);
  }
}
