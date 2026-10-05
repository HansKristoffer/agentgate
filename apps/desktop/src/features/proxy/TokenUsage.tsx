import { useEffect, useState } from "react";
import { Tabs } from "@heroui/react";
import type { Connection, ModelTokens } from "@agentgate/protocol";
import { request } from "../../api.ts";
import { Empty, Panel } from "../../components/ui.tsx";
import { useGeneration } from "./useGeneration.ts";

const RANGES = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
] as const;
type Range = (typeof RANGES)[number]["id"];
const since = (range: Range) =>
  range === "all" ? 0
  : range === "today" ? new Date().setHours(0, 0, 0, 0)
  : Date.now() - (range === "7d" ? 7 : 30) * 86400000;
/** Slices past this fold into "Other", so a slot's colour always means the same rank. */
const SLICES = 6;
const total = (t: ModelTokens) => t.input + t.output + t.cacheRead + t.cacheWrite;
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export function TokenUsage({ connection }: { connection: Connection }) {
  const [range, setRange] = useState<Range>("today"),
    [rows, setRows] = useState<ModelTokens[]>(),
    [error, setError] = useState("");
  const capture = useGeneration(connection);
  useEffect(() => {
    const current = capture();
    const load = () =>
      request<ModelTokens[]>(connection, `/proxy/tokens?since=${since(range)}`).then(
        (r) => { if (current()) { setRows(r); setError(""); } },
        (e) => { if (current()) setError(String(e)); },
      );
    void load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [range, connection]);

  // Rows are per provider and model, so the same model name can appear for Cursor and for its own provider.
  const top = (rows ?? []).slice(0, SLICES).map((r) => ({ key: `${r.provider}:${r.model}`, label: r.provider === "cursor" ? `${r.model} (Cursor)` : r.model, value: total(r), detail: r }));
  const rest = (rows ?? []).slice(SLICES).reduce((sum, r) => sum + total(r), 0);
  const slices = rest ? [...top, { key: "other", label: "Other", value: rest, detail: undefined }] : top;
  const sum = slices.reduce((s, x) => s + x.value, 0);
  let angle = 0;

  return (
    <Panel
      title="Token usage"
      detail="Every account on this machine, by model. Cursor's come from its own usage history."
      action={
        <Tabs className="token-range" selectedKey={range} onSelectionChange={(key) => setRange(key as Range)}>
          <Tabs.ListContainer>
            <Tabs.List aria-label="Time range">
              {RANGES.map((r) => (
                <Tabs.Tab key={r.id} id={r.id}>
                  {r.label}
                  <Tabs.Indicator />
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
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
              const point = (a: number) => `${Math.sin(a)} ${-Math.cos(a)}`;
              return (
                <path
                  key={s.key}
                  className={`slice-${s.detail ? i + 1 : "other"}`}
                  d={slices.length === 1 ? "M0 -1 A1 1 0 1 1 0 1 A1 1 0 1 1 0 -1Z" : `M0 0 L${point(start)} A1 1 0 ${angle - start > Math.PI ? 1 : 0} 1 ${point(angle)}Z`}
                >
                  <title>{`${s.label}: ${s.value.toLocaleString()} tokens`}</title>
                </path>
              );
            })}
          </svg>
          <div className="grow">
            {slices.map((s, i) => (
              <div className="token-row" key={s.key}>
                <i className={`slice-${s.detail ? i + 1 : "other"}`} />
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
