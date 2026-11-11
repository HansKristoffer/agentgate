import { fetchHeaders, readBody } from "../runtime.ts";
import { LOCAL_URL, type Store } from "../store.ts";

/** What every command family in this folder shares with `cli.ts`. */

/** The options `parseFor` read for a command. */
export type Opts = Record<string, string | boolean | (string | boolean)[] | undefined>;
/** A family's `run`: `args` are the words after the command. */
export type Run = (command: string, args: string[], opts: Opts) => Promise<unknown>;

export const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

/** Thrown for words no command reads; `cli.ts` prints the help. */
export class ShowHelp extends Error {}
export const showHelp = (): never => {
  throw new ShowHelp();
};

/** A string option's value. */
export const stringOption = (opts: Opts) => (k: string) => opts[k] as string | undefined;

export async function management<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const signal = AbortSignal.timeout(100000);
  const res = await fetchHeaders(
    `${LOCAL_URL}/api${path}`,
    {
      method,
      signal,
      redirect: "manual",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    100000,
  );
  const result = JSON.parse(new TextDecoder().decode(await readBody(res.body, 2 * 1024 * 1024, signal)));
  if (!res.ok) throw new Error(result.error ?? "Daemon rejected the operation");
  return result;
}

export function initialized(s: Store) {
  if (!s.local("node")) die("Run `agentgate init` first.");
  return s;
}
