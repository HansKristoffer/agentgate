import type { BoardAction, NeedsYou, NeedsYouCause, NeedsYouKind } from "@agentgate/protocol";

/** Each cause's kind, and its title for a person. */
export const CAUSES: Record<NeedsYouCause, { kind: NeedsYouKind; title: string }> = {
  held: { kind: "start", title: "Waiting for approval" },
  decision: { kind: "answer", title: "Needs a decision" },
  blocked: { kind: "answer", title: "Blocked" },
  question: { kind: "answer", title: "Asks you" },
  failed: { kind: "stopped", title: "Failed" },
  stalled: { kind: "stopped", title: "Stalled on its PR" },
  stuck: { kind: "stopped", title: "Stuck" },
  budget: { kind: "stopped", title: "Over its token budget" },
  stopped: { kind: "stopped", title: "Stopped in T3 Code" },
  "handed-off": { kind: "stopped", title: "Handed to another machine" },
  deleted: { kind: "stopped", title: "Its thread was deleted" },
};

/** Which kinds of wait post a `waiting` comment on the item's issue: a question to answer, and work that stopped. A
 * start does not: the `taken` comment already said the item waits for approval, and a held stage is the
 * maintainer's own setting. */
export const POSTS: Record<NeedsYouKind, boolean> = { start: false, answer: true, stopped: true };

/** An action as the command that takes it. No angle brackets: GitHub would take `<text>` in a comment for a tag. */
export const actionCommand = (key: string, action: BoardAction) =>
  `agentgate factory ${action.name} ${key}${action.takesText ? ' --reason "..."' : ""}`;

/** Each action as its command and what it will do, aligned. */
export function actionLines(key: string, actions: BoardAction[]): string[] {
  const commands = actions.map((a) => actionCommand(key, a));
  const width = Math.max(0, ...commands.map((c) => c.length));
  return actions.map((a, i) => `${commands[i]!.padEnd(width)}  ${a.effect}`);
}

/**
 * The one rendering of what an item waits for, used by `status`, `show`, the issue comment and the remote tools: what
 * happened, the question, the recommendation, the options and what each action does. The app draws the same parts from
 * the board item. `detail` adds the rest of a long question, such as a spec.
 */
export function needsYouLines(
  key: string,
  needsYou: NeedsYou,
  actions: BoardAction[],
  { detail = false } = {},
): string[] {
  const lines = [`${needsYou.title}: ${needsYou.question}`];
  if (detail && needsYou.detail) lines.push("", needsYou.detail, "");
  if (needsYou.recommendation) lines.push(`Recommended: ${needsYou.recommendation}`);
  if (needsYou.options?.length) lines.push("Options:", ...needsYou.options.map((o) => `  - ${o}`));
  if (actions.length) lines.push("What you can do:", ...actionLines(key, actions).map((l) => `  ${l}`));
  return lines;
}
