import { useState } from "react";
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
const total = (t: ModelTokens) => t.input + t.output + t.cacheRead + t.cacheWrite;
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
/** The point on the unit circle at angle `a`, for the pie's arcs. */
const point = (a: number) => `${Math.sin(a)} ${-Math.cos(a)}`;
/** The colour slot a slice draws in: its rank, or the shared "other" slot for the folded rest. */
const slot = (s: { detail?: ModelTokens }, i: number) => `slice-${s.detail ? i + 1 : "other"}`;

export function TokenUsage({ connection }: { connection: Connection }) {
  const [range, setRange] = useState<Range>("today");
  const { data: rows, error } = useDaemon(
    () => request<ModelTokens[]>(connection, `/proxy/tokens?since=${since(range)}`),
    { topics: ["activity"], deps: [range], every: 60_000, key: `tokens:${range}` },
  );

  // Rows are per provider and model, so the same model name can appear for Cursor or Antigravity and for its own provider.
  const top = (rows ?? []).slice(0, SLICES).map((r) => ({
    key: `${r.provider}:${r.model}`,
    label: r.provider === "cursor" || r.provider === "antigravity" ? `${r.model} (${SUFFIX[r.provider]})` : r.model,
    value: total(r),
    detail: r,
  }));
  const rest = sumBy((rows ?? []).slice(SLICES), total);
  const slices = rest ? [...top, { key: "other", label: "Other", value: rest, detail: undefined }] : top;
  const sum = sumBy(slices, "value");
  let angle = 0;

  return (
    <Panel
      title="Token usage"
      detail="Every machine and account, by model. Cursor's come from its own usage history, Antigravity's from its conversations."
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
        <div className="tokens">
          <svg viewBox="-1 -1 2 2" role="img" aria-label={`${compact.format(sum)} tokens by model`}>
            {slices.map((s, i) => {
              const start = angle;
              angle += (s.value / sum) * 2 * Math.PI;
              return (
                <path
                  key={s.key}
                  className={slot(s, i)}
                  d={
                    slices.length === 1
                      ? "M0 -1 A1 1 0 1 1 0 1 A1 1 0 1 1 0 -1Z"
                      : `M0 0 L${point(start)} A1 1 0 ${angle - start > Math.PI ? 1 : 0} 1 ${point(angle)}Z`
                  }
                >
                  <title>{`${s.label}: ${s.value.toLocaleString()} tokens`}</title>
                </path>
              );
            })}
          </svg>
          <div className="grow">
            {slices.map((s, i) => (
              <div className="token-row" key={s.key}>
                <i className={slot(s, i)} />
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
                <span className="muted">{Math.round((s.value / sum) * 100)}%</span>
              </div>
            ))}
            <div className="token-row">
              <i />
              <strong className="grow">Total</strong>
              <span>{compact.format(sum)}</span>
              <span />
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}
