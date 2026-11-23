import { memo, useCallback, useMemo, useRef, useState } from "react";
import { sumBy } from "hanzio";
import type { Connection, TokenHour } from "@agentgate/protocol";
import { request } from "../../api.ts";
import { Panel } from "../../components/ui.tsx";
import { useDaemon } from "../../useDaemon.ts";
import { tokenYearStart } from "../../views/utils.ts";

const WEEKS = 53,
  CELL = 10,
  STEP = 13,
  LEFT = 28,
  TOP = 16;
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const month = new Intl.DateTimeFormat(undefined, { month: "short" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dayLabel = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** The last year of local days, Sunday to Saturday per column, ending today. */
function lastYear() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days: Date[] = [],
    d = new Date(today);
  d.setDate(d.getDate() - (WEEKS - 1) * 7 - today.getDay());
  for (; d <= today; d.setDate(d.getDate() + 1)) days.push(new Date(d));
  return days;
}

type CalendarModel = {
  weekdays: { row: number; label: string }[];
  months: { week: number; label: string }[];
  cells: { level: number; label: string }[];
  total: number;
};

/** Memoized SVG grid so hovering across the 371 cells never re-renders the SVG or recomputes daily totals. */
const CalendarGrid = memo(function CalendarGrid({
  model,
  onEnter,
  onLeave,
}: {
  model: CalendarModel;
  onEnter: (day: number, target: SVGRectElement) => void;
  onLeave: () => void;
}) {
  return (
    <svg
      viewBox={`0 0 ${LEFT + WEEKS * STEP} ${TOP + 7 * STEP}`}
      role="img"
      aria-label={`${compact.format(model.total)} tokens in the last year`}
      onMouseLeave={onLeave}
    >
      {model.months.map((m) => (
        <text key={m.week} x={LEFT + m.week * STEP} y={TOP - 6}>
          {m.label}
        </text>
      ))}
      {model.weekdays.map((w) => (
        <text key={w.row} x={0} y={TOP + w.row * STEP + CELL - 1}>
          {w.label}
        </text>
      ))}
      {model.cells.map((cell, i) => (
        <rect
          key={i}
          className={`level-${cell.level}`}
          x={LEFT + Math.floor(i / 7) * STEP}
          y={TOP + (i % 7) * STEP}
          width={CELL}
          height={CELL}
          rx={2}
          aria-label={cell.label}
          onMouseEnter={(e) => onEnter(i, e.currentTarget)}
        />
      ))}
    </svg>
  );
});

/** Tokens per day over the last year, like a GitHub contribution graph. */
export function TokenCalendar({ connection }: { connection: Connection }) {
  const { data: hours, error } = useDaemon(
    () => request<TokenHour[]>(connection, `/proxy/tokens/hours?since=${tokenYearStart()}`),
    { topics: ["activity"], every: 60_000, minInterval: 30_000, staleTime: 10_000, key: "token-hours" },
  );
  // The app's web view shows no native tooltips for SVG titles, so the hovered day gets its own.
  const [hover, setHover] = useState<{ day: number; x: number; y: number; align: "start" | "center" | "end" }>();
  const box = useRef<HTMLDivElement>(null);

  const model = useMemo<CalendarModel>(() => {
    const days = lastYear();
    const perDay = new Map<string, number>();
    for (const [hour, tokens] of hours ?? []) {
      const key = new Date(hour).toDateString();
      perDay.set(key, (perDay.get(key) ?? 0) + tokens);
    }
    const values = days.map((d) => perDay.get(d.toDateString()) ?? 0);
    // Levels split the days with any usage into quarters, so one huge day does not wash out the rest.
    const used = values.filter((v) => v > 0).sort((a, b) => a - b);
    const cuts = [0.25, 0.5, 0.75].map((p) => used[Math.floor(p * (used.length - 1))] ?? 0);
    const levelOf = (v: number) => (v ? 1 + cuts.filter((c) => v > c).length : 0);
    const total = sumBy(values, (v) => v);
    const months = days.flatMap((d, i) =>
      d.getDate() === 1 && Math.floor(i / 7) < WEEKS - 1 ? [{ week: Math.floor(i / 7), label: month.format(d) }] : [],
    );
    const weekdays = [1, 3, 5].map((row) => ({ row, label: weekday.format(days[row]!) }));
    const cells = days.map((d, i) => ({
      level: hours ? levelOf(values[i]!) : 0,
      label: `${values[i] ? `${compact.format(values[i]!)} tokens` : "No tokens"} on ${dayLabel.format(d)}`,
    }));
    return { weekdays, months, cells, total };
  }, [hours]);

  const onEnter = useCallback((day: number, target: SVGRectElement) => {
    const frame = box.current?.getBoundingClientRect();
    if (!frame) return;
    const cell = target.getBoundingClientRect();
    const x = cell.left + cell.width / 2 - frame.left;
    // Keep the tooltip inside the panel at either end of the year.
    setHover({
      day,
      x,
      y: cell.top - frame.top,
      align: x < 100 ? "start" : x > frame.width - 100 ? "end" : "center",
    });
  }, []);
  const onLeave = useCallback(() => setHover(undefined), []);

  return (
    <Panel
      title="Token activity"
      detail={
        hours ? `${compact.format(model.total)} tokens in the last year across all machines` : "Loading last 12 months…"
      }
    >
      {error ? (
        <div className="item danger">{error}</div>
      ) : (
        <div className="token-calendar" ref={box}>
          <CalendarGrid model={model} onEnter={onEnter} onLeave={onLeave} />
          {hover && model.cells[hover.day] && (
            <div className={`token-tip ${hover.align}`} style={{ left: hover.x, top: hover.y }}>
              {model.cells[hover.day]!.label}
            </div>
          )}
          <div className="token-legend">
            Less
            {[0, 1, 2, 3, 4].map((l) => (
              <i key={l} className={`level-${l}`} />
            ))}
            More
          </div>
        </div>
      )}
    </Panel>
  );
}
