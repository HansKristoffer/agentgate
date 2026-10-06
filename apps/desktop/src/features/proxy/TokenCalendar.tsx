import { useEffect, useMemo, useRef, useState } from "react";
import type { Connection, TokenHour } from "@agentgate/protocol";
import { request } from "../../api.ts";
import { Panel } from "../../components/ui.tsx";
import { useGeneration } from "./useGeneration.ts";

const WEEKS = 53, CELL = 10, STEP = 13, LEFT = 28, TOP = 16;
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const month = new Intl.DateTimeFormat(undefined, { month: "short" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });

/** The last year of local days, Sunday to Saturday per column, ending today. */
function lastYear() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days: Date[] = [], d = new Date(today);
  d.setDate(d.getDate() - (WEEKS - 1) * 7 - today.getDay());
  for (; d <= today; d.setDate(d.getDate() + 1)) days.push(new Date(d));
  return days;
}

/** Tokens per day over the last year, like a GitHub contribution graph. */
export function TokenCalendar({ connection }: { connection: Connection }) {
  const [hours, setHours] = useState<TokenHour[]>(), [error, setError] = useState("");
  const capture = useGeneration(connection);
  // The app's web view shows no native tooltips for SVG titles, so the hovered day gets its own.
  const [hover, setHover] = useState<{ day: number; x: number; y: number; align: "start" | "center" | "end" }>();
  const box = useRef<HTMLDivElement>(null);
  const days = useMemo(lastYear, [hours]); // each reload moves the grid on past midnight
  useEffect(() => {
    const current = capture();
    const load = () =>
      request<TokenHour[]>(connection, `/proxy/tokens/hours?since=${lastYear()[0]!.getTime()}`).then(
        (r) => { if (current()) { setHours(r); setError(""); } },
        (e) => { if (current()) setError(String(e)); },
      );
    void load();
    const timer = setInterval(load, 5 * 60_000);
    return () => clearInterval(timer);
  }, [connection]);

  const perDay = new Map<string, number>();
  for (const [hour, tokens] of hours ?? []) {
    const key = new Date(hour).toDateString();
    perDay.set(key, (perDay.get(key) ?? 0) + tokens);
  }
  const values = days.map((d) => perDay.get(d.toDateString()) ?? 0);
  // Levels split the days with any usage into quarters, so one huge day does not wash out the rest.
  const used = values.filter((v) => v > 0).sort((a, b) => a - b);
  const cuts = [0.25, 0.5, 0.75].map((p) => used[Math.floor(p * (used.length - 1))] ?? 0);
  const level = (v: number) => (v ? 1 + cuts.filter((c) => v > c).length : 0);
  const total = values.reduce((sum, v) => sum + v, 0);
  // A month is labelled above the week its first day falls in.
  const describe = (i: number) => `${values[i] ? `${compact.format(values[i]!)} tokens` : "No tokens"} on ${dayLabel.format(days[i]!)}`;
  const months = days.flatMap((d, i) => (d.getDate() === 1 && Math.floor(i / 7) < WEEKS - 1 ? [{ week: Math.floor(i / 7), label: month.format(d) }] : []));

  return (
    <Panel title="Token activity" detail={hours ? `${compact.format(total)} tokens in the last year, on every machine.` : undefined}>
      {error ? (
        <div className="item danger">{error}</div>
      ) : (
        <div className="token-calendar" ref={box}>
          <svg viewBox={`0 0 ${LEFT + WEEKS * STEP} ${TOP + 7 * STEP}`} role="img" aria-label={`${compact.format(total)} tokens in the last year`} onMouseLeave={() => setHover(undefined)}>
            {months.map((m) => (
              <text key={m.week} x={LEFT + m.week * STEP} y={TOP - 6}>{m.label}</text>
            ))}
            {[1, 3, 5].map((row) => (
              <text key={row} x={0} y={TOP + row * STEP + CELL - 1}>{weekday.format(days[row]!)}</text>
            ))}
            {days.map((_, i) => (
              <rect
                key={i}
                className={`level-${hours ? level(values[i]!) : 0}`}
                x={LEFT + Math.floor(i / 7) * STEP}
                y={TOP + (i % 7) * STEP}
                width={CELL}
                height={CELL}
                rx={2}
                aria-label={describe(i)}
                onMouseEnter={(e) => {
                  const cell = e.currentTarget.getBoundingClientRect(), frame = box.current!.getBoundingClientRect();
                  const x = cell.left + cell.width / 2 - frame.left;
                  // Keep the tooltip inside the panel at either end of the year.
                  setHover({ day: i, x, y: cell.top - frame.top, align: x < 100 ? "start" : x > frame.width - 100 ? "end" : "center" });
                }}
              />
            ))}
          </svg>
          {hover && (
            <div className={`token-tip ${hover.align}`} style={{ left: hover.x, top: hover.y }}>
              {describe(hover.day)}
            </div>
          )}
          <div className="token-legend">
            Less
            {[0, 1, 2, 3, 4].map((l) => <i key={l} className={`level-${l}`} />)}
            More
          </div>
        </div>
      )}
    </Panel>
  );
}
