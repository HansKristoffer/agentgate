import { parseArgs } from "node:util";
import { boardItemSchema, type BoardItem, type FactorySource } from "@agentgate/protocol";
import { getErrorMessage } from "hanzio";
import { z } from "zod";
import { peerCall } from "../handoff/jobs.ts";
import { currentFolder } from "./config.ts";
import { addItem, boardItem, enqueueRun, moveItem } from "./controller.ts";
import { isOpenPhase, items, runs, type FactoryItem } from "./db.ts";
import type { FactoryRuntime, ForwardOp, IncomingItem, SourceAdapter } from "./runtime.ts";

/**
 * Moving the factory to another machine (D29). The new factory machine pauses intake until it has asked every other
 * machine for the items it still holds, and its intake skips those: an item in triage has no marker on its issue yet.
 * The old machine stops intake and drives its own items to the end. A machine that cannot be asked leaves only its
 * markers, so GitHub and Linear issues marked `open` there show as orphaned, and `retry` adopts one here. Webhook and
 * manual items live only in their machine's tables and stay there.
 */

const PEER_TIMEOUT = 10_000;
/** How often an unreachable machine's markers are read again: a pass reads every open issue's comments, like intake. */
const SCAN_EVERY = 2 * 60_000;

interface Orphan {
  item: BoardItem;
  externalId: string;
}
interface Memory {
  /** The pointer this machine took over for. */
  takenOver?: string;
  /** Each other machine's open items, as last fetched. */
  held: Map<string, BoardItem[]>;
  orphans: Orphan[];
  scan?: { at: number; nodes: string };
}
const memories = new WeakMap<FactoryRuntime, Memory>();
function memory(f: FactoryRuntime) {
  let m = memories.get(f);
  if (!m) memories.set(f, (m = { held: new Map(), orphans: [] }));
  return m;
}

const pointerKey = (f: FactoryRuntime) => JSON.stringify(f.pointer() ?? null);
const sourceKey = (source: string, key: string) => `${source}\0${key}`;

/** This machine's items for another machine's board. */
const boardItems = (f: FactoryRuntime, open: boolean) => items.list(f.s, { open }).map((item) => boardItem(f, item));

const heldSchema = z.array(boardItemSchema);
async function openItemsOf(f: FactoryRuntime, node: string) {
  const list = heldSchema.parse(await peerCall(f.s, node, "/factory/items?open=1", { timeout: PEER_TIMEOUT }));
  return list.map((item) => ({ ...item, heldBy: node }));
}

/** Whether another machine holds the issue, by what it last told us. */
function heldElsewhere(f: FactoryRuntime, source: string, key: string) {
  const wanted = sourceKey(source, key);
  return [...memory(f).held.values()].some((list) => list.some((i) => sourceKey(i.source, i.key) === wanted));
}

/** Every open, labelled issue of a source, including those other machines hold. */
const unfiltered = new WeakMap<SourceAdapter, NonNullable<SourceAdapter["poll"]>>();
const pollAll = (adapter: SourceAdapter, source: FactorySource) => (unfiltered.get(adapter) ?? adapter.poll!)(source);

/** Intake asks the sources through `poll`, so this runtime's adapters leave out the issues other machines hold. The
 * adapters are copied, not changed: the GitHub one is shared by every runtime in the process. */
function skipHeld(f: FactoryRuntime) {
  for (const [type, adapter] of f.sources) {
    const poll = adapter.poll?.bind(adapter);
    if (!poll) continue;
    const filtered: SourceAdapter = {
      ...adapter,
      poll: async (source) => (await poll(source)).filter((i) => !heldElsewhere(f, source.id, i.key)),
    };
    unfiltered.set(filtered, poll);
    f.sources.set(type, filtered);
  }
}

async function takeOver(f: FactoryRuntime) {
  if (!f.isFactoryNode()) {
    // Moving back here later takes over again.
    memories.delete(f);
    return;
  }
  const m = memory(f);
  const pointer = pointerKey(f);
  const unreachable: string[] = [];
  await Promise.all(
    otherNodes(f).map(async (node) => {
      try {
        m.held.set(node, await openItemsOf(f, node));
      } catch {
        // The last list it gave stays: forgetting it would let intake take its issues.
        unreachable.push(node);
      }
    }),
  );
  m.takenOver = pointer;
  await findOrphans(f, unreachable.sort());
}

/** Issues whose newest marker is `open` on a machine that cannot be asked. */
async function findOrphans(f: FactoryRuntime, unreachable: string[]) {
  const { s } = f;
  const m = memory(f);
  const nodes = unreachable.join(",");
  if (!unreachable.length) {
    m.orphans = [];
    m.scan = undefined;
    return;
  }
  if (m.scan?.nodes === nodes && s.now() - m.scan.at < SCAN_EVERY) return;
  m.scan = { at: s.now(), nodes };
  const orphans: Orphan[] = [];
  for (const source of currentFolder(f)?.config.sources ?? []) {
    const adapter = f.sources.get(source.type);
    if (!adapter?.poll || !adapter.newestMarker) continue;
    try {
      for (const incoming of await pollAll(adapter, source)) {
        const mine = items.byExternal(s, source.id, incoming.externalId);
        if (mine && isOpenPhase(mine.phase)) continue;
        const marker = await adapter.newestMarker({
          source: source.id,
          externalId: incoming.externalId,
          repo: source.repo,
        });
        if (marker?.state !== "open" || !unreachable.includes(marker.node)) continue;
        orphans.push({
          externalId: incoming.externalId,
          item: {
            id: marker.item,
            key: incoming.key,
            repo: source.repo,
            title: incoming.title,
            ...(incoming.url && { url: incoming.url }),
            source: source.id,
            phase: marker.stage ?? "triage",
            heldBy: marker.node,
            needsYou: {
              reason: "orphaned",
              question: `${marker.node} is unreachable; take it over here with agentgate factory retry ${incoming.externalId}`,
            },
            tokens: 0,
            inPhaseSince: 0,
            updatedAt: 0,
          },
        });
      }
    } catch (e) {
      // The adapters' errors name the source and what was asked, never a credential.
      console.error(`factory: reading the markers of ${source.id} failed: ${getErrorMessage(e).slice(0, 300)}`);
      m.scan = undefined;
    }
  }
  m.orphans = orphans;
}

/** The sources and issue a `retry` reference names: an orphan's id, key or external id, `owner/repo#n` or a Linear key. */
function resolve(f: FactoryRuntime, ref: string) {
  const lower = ref.toLowerCase();
  const sources = currentFolder(f)?.config.sources ?? [];
  const orphans = memory(f).orphans.filter((o) =>
    [o.item.id, o.item.key, o.externalId].some((x) => x.toLowerCase() === lower),
  );
  if (orphans.length > 1)
    throw new Error(`${ref} names ${orphans.length} orphaned issues; name one as owner/repo#number or its Linear key`);
  const github = /^([\w.-]+\/[\w.-]+)#\d+$/.exec(ref)?.[1]?.toLowerCase();
  const team = /^([a-z][a-z0-9]*)-\d+$/i.exec(ref)?.[1]?.toLowerCase();
  const matches = sources.filter((x) =>
    orphans[0]
      ? x.id === orphans[0].item.source
      : (x.type === "github" && x.repo.toLowerCase() === github) ||
        (x.type === "linear" && x.team.toLowerCase() === team),
  );
  // A reference no source takes, such as a manual item's key, is not for adopting.
  return matches.length ? { externalId: orphans[0]?.externalId ?? ref, sources: matches } : undefined;
}

/** Whether a machine still holds an item, when it can be asked. */
async function stillHolds(f: FactoryRuntime, node: string, item: string, source: string, key: string) {
  try {
    const list = await openItemsOf(f, node);
    return list.some((i) => i.id === item || sourceKey(i.source, i.key) === sourceKey(source, key));
  } catch {
    return false;
  }
}

/** `retry` for an issue this machine does not hold: it enters here from the issue, at the stage its marker names. */
async function adopt(f: FactoryRuntime, ref: string): Promise<FactoryItem | undefined> {
  const { s } = f;
  const target = resolve(f, ref);
  if (!target) return undefined;
  let found: { source: FactorySource; adapter: SourceAdapter; incoming: IncomingItem } | undefined;
  for (const source of target.sources) {
    const adapter = f.sources.get(source.type);
    if (!adapter?.poll) continue;
    const incoming = (await pollAll(adapter, source)).find(
      (i) => i.externalId.toLowerCase() === target.externalId.toLowerCase(),
    );
    if (incoming) {
      found = { source, adapter, incoming };
      break;
    }
  }
  if (!found) throw new Error(`${ref} is not an open issue that one of the factory's sources takes in`);
  const { source, adapter, incoming } = found;

  const mine = items.byExternal(s, source.id, incoming.externalId);
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
  if (!finished && holder !== s.nodeId && (await stillHolds(f, holder, marker.item, source.id, incoming.key)))
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
  const m = memory(f);
  m.orphans = m.orphans.filter((o) => o.externalId !== incoming.externalId);
  return items.get(s, item.id);
}

const ITEM_COMMANDS = ["approve", "reject", "retry", "drop"];

/** A call about a run or an item in this machine's tables, which stays here after the factory moved away. */
function heldHere(f: FactoryRuntime, op: ForwardOp) {
  const { s } = f;
  if (op.kind === "tool") return typeof op.args.run === "string" && !!runs.get(s, op.args.run);
  if (!ITEM_COMMANDS.includes(op.name)) return false;
  const { positionals } = parseArgs({ args: op.args, options: { reason: { type: "string" } }, strict: false });
  const ref = positionals[0];
  return !!ref && (!!items.get(s, ref) || items.list(s).some((i) => i.key === ref));
}

async function runHere(f: FactoryRuntime, op: ForwardOp) {
  if (op.kind === "tool") return f.tools.get(op.name)!.call(op.args, op.caller);
  const output: string[] = [];
  const io = { ...(op.stdin !== undefined && { stdin: op.stdin }), out: (line: string) => output.push(line) };
  const code = await f.commands.get(op.name)!.run(op.args, io);
  return { code, output };
}

const otherNodes = (f: FactoryRuntime) =>
  f.s
    .list("node")
    .map((n) => n.id)
    .filter((id) => id !== f.s.nodeId);

export function setup(f: FactoryRuntime): void {
  skipHeld(f);
  f.adopt = (ref) => adopt(f, ref);
  // The stage threads of the items this machine still holds report here, and their questions are answered here.
  const forward = f.forwarder;
  if (forward) f.forwarder = (op) => (heldHere(f, op) ? runHere(f, op) : forward(op));
  // A machine alone has no one to ask.
  f.intakeBlockers.push(() =>
    f.isFactoryNode() && memory(f).takenOver !== pointerKey(f) && otherNodes(f).length
      ? "the factory is asking the other machines which items they still hold"
      : undefined,
  );
  f.peer.get("/items", (c) => c.json(boardItems(f, c.req.query("open") === "1")));
  f.loops.push({ name: "factory-move", everyMs: 30_000, where: "every-node", run: () => takeOver(f) });
  // Other machines' items while they hold any, then orphans, which replace an unreachable machine's last known row.
  f.boardParts.push(async () => {
    if (!f.isFactoryNode()) return {};
    const m = memory(f);
    return { items: [...[...m.held.values()].flat(), ...m.orphans.map((o) => o.item)] };
  });
}
