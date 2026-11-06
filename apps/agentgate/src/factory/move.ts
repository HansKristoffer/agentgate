import type { FactorySource } from "@agentgate/protocol";
import { lastSeen } from "../sync.ts";
import { currentFolder } from "./config.ts";
import { addItem, enqueueRun, moveItem } from "./controller.ts";
import { isOpenPhase, items, type FactoryItem } from "./db.ts";
import { issueKey } from "./github.ts";
import type { FactoryRuntime, IncomingItem, SourceAdapter } from "./runtime.ts";

/**
 * Taking over an issue another machine held. Every issue the factory takes gets a marker comment that names the
 * machine holding it, so after the factory moves, the new machine's intake leaves the old machine's issues alone, and
 * the old machine finishes them (it keeps its T3 sign-in while it holds items). An issue whose machine cannot be
 * reached shows as orphaned, and `retry <issue>` takes it over here at the stage its marker names. Webhook and manual
 * items have no issue to mark, so they stay with their machine.
 */

/** A machine that answered sync within this long drives its own items. */
const ONLINE_MS = 2 * 60_000;

/** The source and issue a `retry` reference names: `owner/repo#n`, a Linear key such as `ENG-42`, or a GitHub item
 * key such as `api-42`. */
function resolve(f: FactoryRuntime, ref: string): { externalId: string; sources: FactorySource[] } | undefined {
  const sources = currentFolder(f)?.config.sources ?? [];
  const github = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref);
  if (github) {
    const repo = github[1]!.toLowerCase();
    const matches = sources.filter((x) => x.type === "github" && x.repo.toLowerCase() === repo);
    return matches.length ? { externalId: `${matches[0]!.repo}#${github[2]}`, sources: matches } : undefined;
  }
  const key = /^([a-z0-9][a-z0-9-]*)-(\d+)$/i.exec(ref);
  if (!key) return undefined;
  const [, prefix, number] = key;
  const linear = sources.filter((x) => x.type === "linear" && x.team.toLowerCase() === prefix!.toLowerCase());
  if (linear.length) return { externalId: `${prefix!.toUpperCase()}-${number}`, sources: linear };
  // A GitHub key names its repository the way intake does.
  const github2 = sources.filter(
    (x) => x.type === "github" && issueKey(f, x.repo, Number(number)) === ref.toLowerCase(),
  );
  return github2.length ? { externalId: `${github2[0]!.repo}#${number}`, sources: github2 } : undefined;
}

/** `retry` for an issue this machine does not hold: it enters here from the issue, at the stage its marker names. A
 * machine that is online still drives its own; one the factory finished starts again at triage. */
async function adopt(f: FactoryRuntime, ref: string): Promise<FactoryItem | undefined> {
  const { s } = f;
  const target = resolve(f, ref);
  if (!target) return undefined;
  let found: { source: FactorySource; adapter: SourceAdapter; incoming: IncomingItem } | undefined;
  for (const source of target.sources) {
    const adapter = f.sources.get(source.type);
    if (!adapter?.poll) continue;
    const incoming = (await adapter.poll(source)).find(
      (i) => i.externalId.toLowerCase() === target.externalId.toLowerCase(),
    );
    if (incoming) {
      found = { source, adapter, incoming };
      break;
    }
  }
  if (!found) throw new Error(`${ref} is not an open issue that one of the factory's sources takes in`);
  const { source, adapter, incoming } = found;

  const mine = items.byExternal(s, incoming.externalId);
  if (mine && isOpenPhase(mine.phase)) throw new Error(`${s.nodeId} already holds ${ref} as ${mine.key}`);
  const marker = await adapter.newestMarker?.({
    source: source.id,
    externalId: incoming.externalId,
    repo: source.repo,
  });
  if (!marker) throw new Error(`No machine has marked ${incoming.key} as taken; intake adds it`);
  // Intake skips an issue the factory finished, so taking it again starts over.
  const finished = marker.state === "finished";
  const holder = marker.node;
  if (!finished && holder !== s.nodeId && s.now() - lastSeen(s, holder) < ONLINE_MS)
    throw new Error(`${holder} still holds ${incoming.key} and finishes it there`);

  const stage = finished ? "triage" : (marker.stage ?? "triage");
  // Held first, so intake's triage run is not queued; then started at the marked stage. A closed item here reopens.
  const item = addItem(f, { source: source.id, repo: source.repo, incoming, hold: true });
  moveItem(f, item.id, stage, null);
  enqueueRun(f, { kind: stage, item: item.id });
  f.events.emit({
    kind: "note",
    item: item.id,
    text: finished
      ? `${incoming.key} was taken again after the factory finished it; it restarts at triage`
      : `${incoming.key} was taken over from ${holder}; it restarts at ${stage}`,
  });
  return items.get(s, item.id);
}

export function setup(f: FactoryRuntime): void {
  f.adopt = (ref) => adopt(f, ref);
}
