import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { ArrowLeft, Monitor } from "lucide-react";
import { Spinner } from "@heroui/react";
import type { HealthPoint, MachineHealth as Health } from "@agentgate/protocol";
import { control } from "../api.ts";
import { HeaderActions } from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { useDaemon } from "../useDaemon.ts";

/** How often the open view asks; the daemon samples every 5 seconds while someone asks within a minute (health.ts). */
const EVERY = 5000;

type Level = "" | "warn" | "bad";
/** The tile's dot, value color and word carry severity together, so it never rests on color alone. */
function severity(share: number, high = 0.7, critical = 0.9): { level: Level; word: string } {
  if (share >= critical) return { level: "bad", word: "Critical" };
  if (share >= high) return { level: "warn", word: "High" };
  return { level: "", word: "" };
}

const gb = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(2)} TB` : `${value.toFixed(0)} GB`);
// Docker prints "783.1MB"; the rest of the view puts a space before the unit.
const dockerSize = (text: string | null) => String(text ?? "?").replace(/([0-9.])([kKMGT]?B)/, "$1 $2");
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const stalled = (value: number) => severity(value / 100, 0.1, 0.25); // PSI: a few percent is noticeable, 25% painful

type Tile = { label: string; value: string; sub: string; level?: { level: Level; word: string } };

function StatStrip({ tiles }: { tiles: Tile[] }) {
  return (
    <div className="health-strip" style={{ "--cols": tiles.length } as CSSProperties}>
      {tiles.map((t) => (
        <div className="health-tile" key={t.label}>
          <div className="health-tile-label">
            <span className={`health-dot ${t.level?.level || "ok"}`} />
            <span className="grow">{t.label}</span>
            {t.level?.word && <span className={`health-word ${t.level.level}`}>{t.level.word}</span>}
          </div>
          <div className={`health-tile-value ${t.level?.level ?? ""}`}>{t.value}</div>
          <div className="health-tile-sub">{t.sub}</div>
        </div>
      ))}
    </div>
  );
}

type Series = { key: Exclude<keyof HealthPoint, "t">; label: string; color: string };
type Axis = {
  max: (points: HealthPoint[]) => number;
  format: (value: number) => string;
  reference?: { value: number; label: string };
};

const percentAxis: Axis = { max: () => 100, format: (v) => `${Math.round(v)}%` };
/** The highest value of `keys`, at least `floor`, rounded up to a whole `step`. */
const ceilingOf = (keys: Series["key"][], floor: number, step: number) => (points: HealthPoint[]) =>
  Math.ceil(Math.max(floor, ...points.flatMap((p) => keys.map((k) => p[k]))) / step) * step;

type ChartProps = { points: HealthPoint[]; series: Series[]; axis: Axis; label: string };

/** A line chart of the last hour, sized to its box. */
function LineChart(props: ChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);
  const ready = props.points.length >= 2;
  return (
    <div className={`health-plot${ready ? "" : " health-plot-empty"}`} ref={box}>
      {/* The history lives in the daemon's memory, so it starts over after a restart or a minute nobody watched. */}
      {ready ? width > 0 && <Plot {...props} width={width} /> : "Collecting samples, one every 5 seconds…"}
    </div>
  );
}

/** The chart's lines, `width` pixels wide, with the sample nearest the pointer read out. */
function Plot({ points, series, axis, label, width }: ChartProps & { width: number }) {
  const [hover, setHover] = useState<number>();
  const height = 150,
    left = 36,
    top = 6,
    plotWidth = Math.max(1, width - left),
    plotHeight = height - 26;
  const max = axis.max(points);
  const t0 = points[0]!.t,
    t1 = points[points.length - 1]!.t;
  const x = (t: number) => left + ((t - t0) / Math.max(1, t1 - t0)) * plotWidth;
  const y = (v: number) => top + plotHeight - (Math.min(v, max) / max) * plotHeight;
  const near = hover === undefined ? undefined : points[hover];

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const t = t0 + ((event.clientX - bounds.left - left) / plotWidth) * (t1 - t0);
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(p.t - t) < Math.abs(points[best]!.t - t)) best = i;
    });
    setHover(best);
  };

  return (
    <>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(undefined)}
      >
        {[0, max / 2, max].map((v) => (
          <g key={v}>
            <line x1={left} x2={width} y1={y(v)} y2={y(v)} className="health-grid" />
            <text x={left - 6} y={y(v) + 4} textAnchor="end">
              {axis.format(v)}
            </text>
          </g>
        ))}
        {axis.reference && axis.reference.value <= max && (
          <g className="health-reference">
            <line x1={left} x2={width} y1={y(axis.reference.value)} y2={y(axis.reference.value)} />
            {/* Left edge, haloed in the card's color: the line is newest at the right. */}
            <text x={left + 4} y={y(axis.reference.value) - 4}>
              {axis.reference.label}
            </text>
          </g>
        )}
        <line x1={left} x2={width} y1={top + plotHeight} y2={top + plotHeight} className="health-axis" />
        <text x={x(t0)} y={height - 4}>
          {clock(t0)}
        </text>
        <text x={x(t1)} y={height - 4} textAnchor="end">
          {clock(t1)}
        </text>
        {series.map((s) => (
          <path
            key={s.key}
            d={points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join("")}
            stroke={s.color}
            className="health-line"
          />
        ))}
        {near && (
          <g>
            <line x1={x(near.t)} x2={x(near.t)} y1={top} y2={top + plotHeight} className="health-cross" />
            {series.map((s) => (
              <circle key={s.key} cx={x(near.t)} cy={y(near[s.key])} r={4} fill={s.color} className="health-mark" />
            ))}
          </g>
        )}
      </svg>
      {near && (
        <div
          className="health-tip"
          style={{ left: x(near.t), top: Math.min(...series.map((s) => y(near[s.key]))) }}
          role="status"
        >
          <strong>{clock(near.t)}</strong>
          {series.map((s) => (
            <span key={s.key}>
              {series.length > 1 && <i style={{ background: s.color }} />}
              {series.length > 1 && `${s.label} `}
              {axis.format(near[s.key])}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function ChartCard({ title, detail, series, ...chart }: { title: string; detail: string } & ChartProps) {
  return (
    <div className="health-card health-chart">
      <div>
        <h3>{title}</h3>
        <p>{detail}</p>
      </div>
      {/* One series needs no legend: the title names it. */}
      {series.length > 1 && (
        <div className="health-legend">
          {series.map((s) => (
            <span key={s.key}>
              <i style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <LineChart series={series} {...chart} />
    </div>
  );
}

const SERVICE_NAMES = { tailscale: "Tailscale", docker: "Docker", t3_code: "T3 Code" } as const;

function Sections({ health: h }: { health: Health }) {
  const { load, memory, disk, pressure, disk_io: io, network: net, workload: w, history } = h;
  const lag = h.daemon_lag;
  const one = (key: Series["key"]): Series[] => [{ key, label: "", color: "var(--h-series-1)" }];
  return (
    <>
      <h2 className="health-section">Resources</h2>
      <StatStrip
        tiles={[
          {
            label: "CPU used",
            value: `${h.cpu_used_percent.toFixed(0)}%`,
            sub: `${h.cpus} cores`,
            level: severity(h.cpu_used_percent / 100),
          },
          {
            label: "Load per core",
            value: load.per_cpu_1m.toFixed(2),
            sub: `${load["1m"]} · ${load["5m"]} · ${load["15m"]} (1, 5, 15 min)`,
            level: severity(load.per_cpu_1m),
          },
          {
            label: "Memory used",
            value: `${memory.used_percent.toFixed(0)}%`,
            sub: `${gb(memory.used_gb)} of ${gb(memory.total_gb)}`,
            level: severity(memory.used_percent / 100),
          },
          {
            label: "Disk used",
            value: `${disk.used_percent.toFixed(0)}%`,
            sub: `${gb(disk.used_gb)} of ${gb(disk.total_gb)}, ${gb(disk.free_gb)} free`,
            level: severity(disk.used_percent / 100),
          },
        ]}
      />

      <h2 className="health-section">Workload</h2>
      <StatStrip
        tiles={[
          {
            label: "Agents running",
            value: String(w.agents.claude + w.agents.codex),
            sub: `Claude Code ${w.agents.claude} · Codex ${w.agents.codex}`,
          },
          {
            label: "CI runners busy",
            value: `${w.runners.busy} of ${w.runners.total}`,
            sub:
              w.runners.total > 0 && w.runners.busy >= w.runners.total
                ? "Every runner busy, jobs queue"
                : `${w.runners.total - w.runners.busy} idle`,
            level: severity(w.runners.total ? w.runners.busy / w.runners.total : 0, 0.75, 1),
          },
          {
            label: "Containers running",
            value: String(w.containers.running),
            sub: w.containers.disk
              ? `Images ${dockerSize(w.containers.disk.images)}, volumes ${dockerSize(w.containers.disk.volumes)}`
              : "Disk use not measured yet",
          },
          {
            label: "Out-of-memory kills",
            value: String(w.oom_kills.last_hour),
            sub: `In the last hour, ${w.oom_kills.since_boot} since boot`,
            level: severity(w.oom_kills.last_hour > 0 ? 1 : 0, 1, 1),
          },
          // How late agentgate's own event loop ran: a tenth of a second is noticeable, half a second stalls requests.
          ...(lag
            ? [
                {
                  label: "Agentgate event loop",
                  value: `${lag.worstMs} ms`,
                  sub: `Worst, p99 ${lag.p99Ms} ms, last minute`,
                  level: severity(lag.worstMs / 1000, 0.1, 0.5),
                },
              ]
            : []),
        ]}
      />

      <h2 className="health-section">Pressure and I/O</h2>
      <StatStrip
        tiles={[
          {
            label: "CPU pressure",
            value: `${pressure.cpu.toFixed(1)}%`,
            sub: "Waiting for a core, last 10 s",
            level: stalled(pressure.cpu),
          },
          {
            label: "Memory pressure",
            value: `${pressure.memory.toFixed(1)}%`,
            sub: "Waiting for memory, last 10 s",
            level: stalled(pressure.memory),
          },
          {
            label: "I/O pressure",
            value: `${pressure.io.toFixed(1)}%`,
            sub: "Waiting for disk, last 10 s",
            level: stalled(pressure.io),
          },
          {
            label: "Disk busy",
            value: `${io.busy_percent.toFixed(0)}%`,
            sub: `Read ${io.read_mb_s.toFixed(1)} MB/s · write ${io.write_mb_s.toFixed(1)} MB/s`,
            level: severity(io.busy_percent / 100),
          },
          {
            label: "Network",
            value: `${net.in_mbit_s.toFixed(1)} Mbit/s`,
            sub: `In; ${net.out_mbit_s.toFixed(1)} Mbit/s out (${net.interface})`,
          },
        ]}
      />

      <h2 className="health-section">Last hour</h2>
      <div className="health-charts">
        <ChartCard
          title="CPU used"
          detail="Share of every core's time"
          points={history}
          series={one("cpu")}
          axis={percentAxis}
          label="CPU used over the last hour"
        />
        <ChartCard
          title="Load per core"
          detail="Runnable tasks per core, 1-minute average"
          points={history}
          series={one("load_per_cpu")}
          axis={{
            max: ceilingOf(["load_per_cpu"], 1.2, 0.2),
            format: (v) => v.toFixed(2),
            reference: { value: 1, label: "1.0 = every core busy" },
          }}
          label="Load per core over the last hour"
        />
        <ChartCard
          title="Memory used"
          detail="Share of memory not available to new programs"
          points={history}
          series={one("memory")}
          axis={percentAxis}
          label="Memory used over the last hour"
        />
        <ChartCard
          title="Time stalled waiting"
          detail="Share of time some task waited for the resource"
          points={history}
          series={[
            { key: "pressure_cpu", label: "CPU", color: "var(--h-series-1)" },
            { key: "pressure_memory", label: "Memory", color: "var(--h-series-2)" },
            { key: "pressure_io", label: "I/O", color: "var(--h-series-3)" },
          ]}
          axis={{
            max: ceilingOf(["pressure_cpu", "pressure_memory", "pressure_io"], 10, 10),
            format: (v) => `${v.toFixed(1)}%`,
          }}
          label="Share of time tasks waited for CPU, memory or disk over the last hour"
        />
        <ChartCard
          title="Agents and busy CI runners"
          detail="Claude Code and Codex sessions, and runners on a job"
          points={history}
          series={[
            { key: "agents", label: "Agents", color: "var(--h-series-1)" },
            { key: "runners_busy", label: "Busy CI runners", color: "var(--h-series-2)" },
          ]}
          axis={{ max: ceilingOf(["agents", "runners_busy"], 4, 2), format: (v) => String(Math.round(v)) }}
          label="Agents running and busy CI runners over the last hour"
        />
      </div>

      <h2 className="health-section">Top programs by CPU</h2>
      <div className="health-card health-table">
        <div className="health-row health-row-head">
          <span>Program</span>
          <span>Processes</span>
          <span>CPU (cores)</span>
          <span>Memory</span>
        </div>
        {h.top_processes.map((p) => (
          <div className="health-row" key={p.program}>
            <span className="health-program">{p.program}</span>
            <span>{p.processes}</span>
            <span>{p.cpu_cores.toFixed(2)}</span>
            <span>{p.memory_gb.toFixed(2)} GB</span>
          </div>
        ))}
      </div>
    </>
  );
}

/** Seconds since `at`, ticking once a second. */
function useAge(at: number | undefined) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return at === undefined ? undefined : Math.max(0, Math.round((now - at) / 1000));
}

/** A machine's health inside Machines: what its daemon measures, asked every 5 seconds while the view is open. */
export function MachineHealth({
  data,
  connection,
  node,
  onNode,
  onBack,
}: Pick<ViewProps, "data" | "connection"> & { node: string; onNode: (node: string) => void; onBack: () => void }) {
  const {
    data: health,
    error,
    at,
  } = useDaemon(() => control(connection, "health", { node }), {
    topics: [],
    deps: [node],
    every: EVERY,
    key: `health:${node}`,
  });
  const age = useAge(at);
  const stale = age !== undefined && age > 20;
  const services = health
    ? (Object.keys(SERVICE_NAMES) as (keyof typeof SERVICE_NAMES)[]).flatMap((key) => {
        const up = health.services[key];
        return up === undefined ? [] : [{ name: SERVICE_NAMES[key], up }];
      })
    : [];

  return (
    <div className="health">
      <HeaderActions>
        <label className="factory-select-wrap" aria-label="Machine">
          <Monitor size={14} className="muted" />
          <select className="factory-select" value={node} onChange={(e) => onNode(e.target.value)}>
            {data.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.id}
                {n.id === data.node ? " (this machine)" : ""}
              </option>
            ))}
          </select>
        </label>
      </HeaderActions>
      <button type="button" className="health-back" onClick={onBack}>
        <ArrowLeft size={13} />
        Back to Machines
      </button>
      <div className="health-head">
        <div>
          <h2>{health?.host ?? node}</h2>
          <p className={stale ? "health-stale" : undefined}>
            {age === undefined
              ? `Asking ${node}…`
              : stale
                ? `No answer for ${age} s`
                : `Updated ${age} s ago, every ${EVERY / 1000} s${health ? ` · up ${Math.round(health.uptime_hours)} h` : ""}`}
          </p>
        </div>
        <div className="health-services">
          {services.map((s) => (
            <span key={s.name} className={`health-chip ${s.up ? "ok" : "bad"}`}>
              <i />
              {s.name} {s.up ? "up" : "down"}
            </span>
          ))}
        </div>
      </div>
      {error && <div className="health-notice">{error}</div>}
      {health ? (
        <Sections health={health} />
      ) : (
        !error && (
          <div className="health-card health-waiting">
            <Spinner size="sm" color="current" />
            Measuring {node}. The first sample takes about 5 seconds.
          </div>
        )
      )}
    </div>
  );
}
