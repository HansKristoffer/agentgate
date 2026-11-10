import { ghAnswer, host, type GhAnswer } from "../../src/logins.ts";
import recordings from "./gh-recorded.json";

/** A run of `gh` as GitHub really answered it; gh-recorded.json says how each was recorded and what was cut. */
export type Recording = Exclude<keyof typeof recordings, "_source">;

/** A recorded run as `host.gh` hands it on, for a fake that answers it to a call of its own. */
export const recorded = (name: Recording): GhAnswer => ghAnswer(recordings[name]);

/** A recorded answer's JSON, to build a variant GitHub cannot be asked for on demand, such as a failing check. */
export const recordedJson = (name: Recording) => JSON.parse(recordings[name].stdout);

/**
 * Answers `gh` from the recordings named until `cleanup` runs. A call gets the one recorded with exactly its
 * arguments and any other call throws, so when gh.ts changes what it asks, the entry must be recorded again, and
 * nothing here can answer what GitHub does not.
 */
export function replayGh(cleanup: (() => unknown)[], ...names: Recording[]) {
  const real = host.gh;
  host.gh = async (args) => {
    const name = names.find((n) => Bun.deepEquals(recordings[n].args, args));
    if (!name) throw new Error(`nothing was recorded for gh ${args.join(" ").slice(0, 200)}`);
    return recorded(name);
  };
  cleanup.push(() => (host.gh = real));
}
