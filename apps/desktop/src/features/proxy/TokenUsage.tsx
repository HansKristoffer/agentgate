import { useMemo, useState } from "react";
import { sumBy, typedSwitch } from "hanzio";
import type { Connection, ModelTokens } from "@agentgate/protocol";
import { request } from "../../api.ts";
import { Empty, Panel, Segmented } from "../../components/ui.tsx";
import { useDaemon } from "../../useDaemon.ts";

const RANGES = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
] as const;
type Range = (typeof RANGES)[number]["id"];
/** Preserved across tab switches so returning to Overview keeps the range you were inspecting. */
let savedRange: Range = "today";

const since = (range: Range) =>
  typedSwitch(range, {
    all: () => 0,
    today: () => new Date().setHours(0, 0, 0, 0),
    "7d": () => Date.now() - 7 * 86_400_000,
    "30d": () => Date.now() - 30 * 86_400_000,
  });
const SUFFIX = { cursor: "Cursor", antigravity: "Antigravity" };
/** Slices past this fold into "Other", so a slot's colour always means the same rank. */
const SLICES = 6;
const INNER = 0.62;
const total = (t: ModelTokens) => t.input + t.output + t.cacheRead + t.cacheWrite;
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const point = (a: number, r: number) => `${r * Math.sin(a)} ${-r * Math.cos(a)}`;
/** An annular sector (donut slice) from angle `start` to `end`, or a full ring when alone. */
function arcPath(start: number, end: number, full: boolean) {
  if (full) {
    return `M0 -1 A1 1 0 1 1 0 1 A1 1 0 1 1 0 -1 M0 ${-INNER} A${INNER} ${INNER} 0 1 0 0 ${INNER} A${INNER} ${INNER} 0 1 0 0 ${-INNER}Z`;
  }
  const large = end - start > Math.PI ? 1 : 0;
  return `M${point(start, 1)} A1 1 0 ${large} 1 ${point(end, 1)} L${point(end, INNER)} A${INNER} ${INNER} 0 ${large} 0 ${point(start, INNER)}Z`;
}
/** The colour slot a slice draws in: its rank, or the shared "other" slot for the folded rest. */
const slot = (s: { detail?: ModelTokens }, i: number) => `slice-${s.detail ? i + 1 : "other"}`;

export function TokenUsage({ connection }: { connection: Connection }) {
  const [range, setRangeState] = useState<Range>(savedRange);
  const [hovered, setHovered] = useState<string>();
  const setRange = (next: Range) => {
    savedRange = next;
    setHovered(undefined);
    setRangeState(next);
  };
  const { data: rows, error } = useDaemon(
    () => request<ModelTokens[]>(connection, `/proxy/tokens?since=${since(range)}`),
    {
      topics: ["activity"],
      deps: [range],
      every: 60_000,
      minInterval: 30_000,
      staleTime: 10_000,
      key: `tokens:${range}`,
    },
  );

  const { slices, sum } = useMemo(() => {
    // Rows are per provider and model, so the same model name can appear for Cursor or Antigravity and for its own provider.
    const top = (rows ?? []).slice(0, SLICES).map((r) => ({
      key: `${r.provider}:${r.model}`,
      label: r.provider === "cursor" || r.provider === "antigravity" ? `${r.model} (${SUFFIX[r.provider]})` : r.model,
      value: total(r),
      detail: r,
    }));
    const rest = sumBy((rows ?? []).slice(SLICES), total);
    const list = rest ? [...top, { key: "other", label: "Other", value: rest, detail: undefined }] : top;
    const totalSum = sumBy(list, "value");
    let angle = 0;
    const withPaths = list.map((s, i) => {
      const start = angle;
      angle += totalSum ? (s.value / totalSum) * 2 * Math.PI : 0;
      return {
        ...s,
        slotClass: slot(s, i),
        pct: totalSum ? Math.round((s.value / totalSum) * 100) : 0,
        path: arcPath(start, angle, list.length === 1),
      };
    });
    return { slices: withPaths, sum: totalSum };
  }, [rows]);

  const focused = hovered ? slices.find((s) => s.key === hovered) : undefined;

  return (
    <Panel
      title="Token usage"
      detail="All machines and accounts, by model"
      action={
        <Segmented className="token-range" label="Time range" value={range} onChange={setRange} options={RANGES} />
      }
    >
      {error ? (
        <div className="item danger">{error}</div>
      ) : !sum ? (
        <Empty>
          <p>{rows ? "No tokens used in this period." : "Loading…"}</p>
        </Empty>
      ) : (
        <div className="tokens" onMouseLeave={() => setHovered(undefined)}>
          <div className="token-donut">
            <svg viewBox="-1.04 -1.04 2.08 2.08" role="img" aria-label={`${compact.format(sum)} tokens by model`}>
              {slices.map((s) => (
                <path
                  key={s.key}
                  className={s.slotClass}
                  d={s.path}
                  fillRule="evenodd"
                  style={hovered && hovered !== s.key ? { opacity: 0.3 } : undefined}
                  onMouseEnter={() => setHovered(s.key)}
                />
              ))}
            </svg>
            <div className="token-donut-center">
              <strong>{compact.format(focused ? focused.value : sum)}</strong>
              <small>{focused ? `${focused.pct}%` : "tokens"}</small>
            </div>
          </div>
          <div className="grow">
            {slices.map((s) => (
              <div
                className={`token-row${hovered === s.key ? " active" : hovered ? " dimmed" : ""}`}
                key={s.key}
                onMouseEnter={() => setHovered(s.key)}
              >
                <i className={s.slotClass} />
                <div className="grow">
                  <strong>{s.label}</strong>
                  {s.detail && (
                    <small>
                      {compact.format(s.detail.input)} in · {compact.format(s.detail.output)} out ·{" "}
                      {compact.format(s.detail.cacheRead + s.detail.cacheWrite)} cache
                    </small>
                  )}
                </div>
                <span>{compact.format(s.value)}</span>
                <span className="muted">{s.pct}%</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
