import { markerPayloadSchema, type MarkerPayload, type Moment } from "@agentgate/protocol";
import type { FactoryItem } from "./db.ts";

/**
 * What the factory writes on an item's source: fixed text, the agent's summary made harmless, and a hidden marker. A
 * comment that carries a marker is the factory's own, and the newest one tells intake on any machine whether the
 * factory finished the issue.
 */

export const MARKER_PREFIX = "<!-- agentgate-factory:1 ";
const CAP = 2000;

const cap = (text: string, max = CAP) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Agent and person text for a comment: no mentions that notify anyone, no HTML comment that could fake a marker or
 * hide the rest, and at most `max` characters. */
export function defuse(text: string, max = CAP) {
  return cap(text.replace(/@(?=[\w-])/g, "@​").replaceAll("<!--", "&lt;!--"), max);
}

const HEADLINES: Record<Moment, (marker: MarkerPayload) => string> = {
  taken: () => "The factory took this.",
  triaged: (m) =>
    m.route === "spec"
      ? "The factory triaged this and writes a spec first."
      : "The factory triaged this and starts on a fix.",
  "spec-approved": () => "The spec is approved, and the factory starts on the fix.",
  "pr-opened": () => "The factory opened a draft pull request.",
  ready: () => "The pull request is ready for review.",
  shipped: () => "Shipped: the pull request was merged.",
  closed: () => "The factory stopped working on this.",
  waiting: () => "The factory waits for the maintainer.",
};

/** The hidden marker. `>` never occurs inside the JSON, so nothing in a value can end the comment early. */
export const markerTag = (marker: MarkerPayload) =>
  `${MARKER_PREFIX}${JSON.stringify(marker).replaceAll(">", "\\u003e")} -->`;

export function renderComment(
  moment: Moment,
  item: FactoryItem,
  input: { summary?: string; extra?: string; marker: MarkerPayload },
): string {
  const parts = [`**${item.key}**: ${HEADLINES[moment](input.marker)}`, input.extra, input.summary];
  const text = cap(
    parts
      .filter((p): p is string => !!p?.trim())
      .map((p, i) => (i ? defuse(p.trim()) : p))
      .join("\n\n"),
  );
  return `${text}\n\n${markerTag(input.marker)}`;
}

/** Every valid marker in a comment, issue or PR body, in order. */
export function parseMarkers(text: string): MarkerPayload[] {
  const found: MarkerPayload[] = [];
  for (const [, json] of text.matchAll(/<!-- agentgate-factory:1 (\{[\s\S]*?\}) -->/g)) {
    try {
      const parsed = markerPayloadSchema.safeParse(JSON.parse(json!));
      if (parsed.success) found.push(parsed.data);
    } catch {
      // Not JSON: someone else's text that looks like a marker.
    }
  }
  return found;
}

/** The markers in the factory's own comments, oldest first: anyone who can comment could otherwise forge one. `read`
 * finds a comment's markers where its source keeps them. */
export const ownMarkers = (comments: { body: string; own: boolean }[], read = parseMarkers) =>
  comments.filter((c) => c.own).flatMap((c) => read(c.body));
