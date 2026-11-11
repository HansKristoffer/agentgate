// The machine health dashboard at HEALTH_PATH, sampled while this node's healthDashboard setting is on and someone has
// requested it in the last minute. It reads /proc, /sys and pressure stall files as the daemon's own user, so it runs on
// Linux only.
import { access, readdir, readFile, statfs } from "node:fs/promises";
import { sortBy, sumBy } from "hanzio";
import os from "node:os";
import { t3State } from "./handoff/t3.ts";
import { HEALTH_PAGE } from "./health-page.ts";
import { lag } from "./lag.ts";
import type { Store } from "./store.ts";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const SAMPLE_MS = 5000;
const DOCKER_MS = 5 * 60_000;
const SERVICES_MS = 30_000;
/** Sampling stops this long after the last request; the open page asks every 5 s. */
const WATCHED_MS = 60_000;
const HISTORY_SAMPLES = 720; // one hour
const CLOCK_TICKS = 100; // USER_HZ: /proc/<pid>/stat counts CPU time in 1/100 s
const PAGE_BYTES = 4096;

const round = (value: number) => Math.round(value * 100) / 100;
const percent = (part: number, whole: number) => (whole > 0 ? round((part / whole) * 100) : 0);
const read = (path: string) => readFile(path, "utf8");
// Kernels built without pressure stall information have no /proc/pressure; such a machine reports no pressure.
const readIfThere = (path: string) => read(path).catch(() => "");
// A directory that is not there (no /sys/block in some containers) lists as empty.
const listIfThere = (dir: string) => readdir(dir).catch(() => []);

async function cpuTimes() {
  // First line of /proc/stat: cpu user nice system idle iowait irq softirq steal ...
  const fields = (await read("/proc/stat")).split("\n")[0]!.trim().split(/\s+/).slice(1).map(Number);
  return {
    idle: fields[3]! + fields[4]!,
    total: sumBy(fields, (value) => value),
  };
}

async function memory() {
  const meminfo = await read("/proc/meminfo");
  const bytes = (name: string) => Number(meminfo.match(new RegExp(`^${name}:\\s+(\\d+) kB`, "m"))?.[1] ?? 0) * 1024;
  const total = bytes("MemTotal");
  const available = bytes("MemAvailable");
  return {
    total_gb: round(total / GB),
    used_gb: round((total - available) / GB),
    available_gb: round(available / GB),
    used_percent: percent(total - available, total),
  };
}

async function disk(path: string) {
  const stats = await statfs(path);
  const total = stats.blocks * stats.bsize;
  const free = stats.bavail * stats.bsize;
  return {
    total_gb: round(total / GB),
    used_gb: round((total - free) / GB),
    free_gb: round(free / GB),
    used_percent: percent(total - free, total),
  };
}

/** Share of the last 10 seconds that some task waited for the resource (Linux PSI). */
async function pressure(resource: "cpu" | "memory" | "io") {
  return Number((await readIfThere(`/proc/pressure/${resource}`)).match(/^some avg10=([\d.]+)/m)?.[1] ?? 0);
}

async function oomKills() {
  return Number((await read("/proc/vmstat")).match(/^oom_kill (\d+)/m)?.[1] ?? 0);
}

async function diskCounters(disks: string[]) {
  let ioTicksMs = 0;
  let sectorsRead = 0;
  let sectorsWritten = 0;
  for (const line of (await read("/proc/diskstats")).split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (!disks.includes(fields[2]!)) continue;
    sectorsRead += Number(fields[5]);
    sectorsWritten += Number(fields[9]);
    ioTicksMs += Number(fields[12]);
  }
  return { ioTicksMs, readBytes: sectorsRead * 512, writtenBytes: sectorsWritten * 512 };
}

/** The interface the default route uses: the public one. */
async function publicInterface() {
  const routes = (await read("/proc/net/route")).split("\n").slice(1);
  const defaultRoute = routes.find((line) => line.split("\t")[1] === "00000000");
  return defaultRoute?.split("\t")[0] ?? "eth0";
}

/** The machine's block devices, without partitions and virtual devices. */
async function physicalDisks() {
  const names = await listIfThere("/sys/block");
  const found = await Promise.all(
    names.map((name) =>
      access(`/sys/block/${name}/device`)
        .then(() => name)
        .catch(() => ""),
    ),
  );
  return found.filter(Boolean);
}

async function networkCounters(iface: string) {
  const line = (await read("/proc/net/dev")).split("\n").find((entry) => entry.trim().startsWith(`${iface}:`));
  const fields = line?.split(":")[1]!.trim().split(/\s+/).map(Number) ?? [];
  return { received: fields[0] ?? 0, sent: fields[8] ?? 0 };
}

/**
 * What a process is, from its command line: an agent started from a versioned
 * Claude binary still counts as `claude`, and a process that rewrites its title
 * (`postgres: user db host CREATE TYPE`) counts by its first word.
 */
function programName(argv0: string) {
  if (argv0.includes("/claude/versions/")) return "claude";
  const base = argv0.split("/").pop() ?? argv0;
  return base.replace(/^-/, "").split(/[: ]/)[0] || "?";
}

async function processes() {
  const list: { pid: number; ppid: number; program: string; ticks: number; rssBytes: number }[] = [];
  // ponytail: one process at a time keeps open files to two; batch the reads if a sample of thousands of processes is slow.
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const argv0 = (await read(`/proc/${entry}/cmdline`)).split("\0")[0];
      if (!argv0) continue; // a kernel thread

      // The name in parentheses can hold spaces; the fields after it are fixed.
      const stat = await read(`/proc/${entry}/stat`);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      list.push({
        pid: Number(entry),
        ppid: Number(fields[1]),
        program: programName(argv0),
        ticks: Number(fields[11]) + Number(fields[12]), // utime + stime
        rssBytes: Number(fields[21]) * PAGE_BYTES,
      });
    } catch {
      // The process exited while it was being read.
    }
  }
  return list;
}

async function runningContainers() {
  // One cgroup scope per running container, readable without the Docker socket.
  return (await listIfThere("/sys/fs/cgroup/system.slice")).filter((name) => /^docker-.+\.scope$/.test(name)).length;
}

/** `docker system df --format '{{json .}}'`, one JSON row per kind of disk use; null when there is no answer. */
function dockerDisk(text: string) {
  if (!text) return null;
  try {
    const rows = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { Type: string; Size: string; Reclaimable: string });
    const size = (type: string) => rows.find((row) => row.Type === type);
    return {
      images: size("Images")?.Size ?? null,
      images_reclaimable: size("Images")?.Reclaimable ?? null,
      volumes: size("Local Volumes")?.Size ?? null,
      build_cache: size("Build Cache")?.Size ?? null,
    };
  } catch {
    return null;
  }
}

/** Standard output of a short command, or "" when it is missing, fails or runs past its deadline. */
async function output(argv: string[], deadline: number) {
  const bin = Bun.which(argv[0]!);
  if (!bin) return "";
  try {
    const child = Bun.spawn([bin, ...argv.slice(1)], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => child.kill(), deadline);
    try {
      const text = await new Response(child.stdout).text();
      return (await child.exited) === 0 ? text : "";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return "";
  }
}

/** Whether something answers at a URL, within two seconds: any response counts. */
async function answers(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

async function tailscaleRunning() {
  try {
    return JSON.parse((await output(["tailscale", "status", "--json"], 3000)) || "{}").BackendState === "Running";
  } catch {
    return false;
  }
}

/** The tailnet listener answers without a token, so a page on another site must not reach it by DNS rebinding: only an
 * address, or this node's own tailnet name, is accepted as the Host. */
function ownHost(host: string | null, url: string | undefined) {
  const name = host?.replace(/:\d+$/, "");
  if (!name) return false;
  return /^\d+\.\d+\.\d+\.\d+$/.test(name) || (!!url && URL.canParse(url) && name === new URL(url).hostname);
}

/** One point of the last hour, as the charts plot it. */
type Point = {
  t: number;
  cpu: number;
  load_per_cpu: number;
  memory: number;
  pressure_cpu: number;
  pressure_memory: number;
  pressure_io: number;
  agents: number;
  runners_busy: number;
  oom_kills: number;
};

/** Samples this machine while its dashboard is on and watched: a request starts sampling, and it stops a minute after the
 * last one. Rates are deltas between two samples, so one timer takes them all and keeps the last hour. Stopping drops the
 * history, so the charts never draw a line across a time nobody watched. */
export class HealthDashboard {
  private timer?: ReturnType<typeof setInterval>;
  private dockerTimer?: ReturnType<typeof setInterval>;
  private running = false;
  private lastRequest = 0;
  private pending?: Promise<void>;
  private disks: string[] = [];
  private iface = "";
  private previous?: Awaited<ReturnType<HealthDashboard["counters"]>>;
  private docker: ReturnType<typeof dockerDisk> = null;
  private checked?: { at: number; tailscale: boolean; t3: boolean | undefined };
  private latest?: Sample;
  private history: Point[] = [];

  constructor(private readonly s: Store) {}

  /** Follows this node's setting. Called at startup and whenever a node record changes. */
  reconcile() {
    this.running = process.platform === "linux" && this.s.get("node", this.s.nodeId)?.healthDashboard === true;
    if (!this.running) this.pause();
  }

  stop() {
    this.running = false;
    this.pause();
  }

  /** Stops sampling and forgets what it measured, until the next request. */
  private pause() {
    clearInterval(this.timer);
    clearInterval(this.dockerTimer);
    this.timer = this.dockerTimer = undefined;
    this.previous = this.latest = this.checked = undefined;
    this.history = [];
    this.docker = null;
  }

  /** GET HEALTH_PATH on either listener: the page for a browser, JSON for everything else (`?history=1` adds the hour). */
  async respond(request: Request, listener: "loopback" | "tailnet") {
    const node = this.s.get("node", this.s.nodeId);
    if (!node?.healthDashboard) return new Response("Not found", { status: 404 });
    if (listener === "tailnet" && !ownHost(request.headers.get("host"), node.url))
      return new Response("forbidden host", { status: 403 });
    if (process.platform !== "linux")
      return new Response("The health dashboard reads Linux's /proc, so it runs on Linux machines only.", {
        status: 501,
      });
    await this.watched();
    if (request.headers.get("accept")?.includes("text/html"))
      return new Response(HEALTH_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (!this.latest)
      return Response.json({ status: "starting" }, { status: 503, headers: { "cache-control": "no-store" } });
    const body = new URL(request.url).searchParams.has("history")
      ? { ...this.latest, sample_seconds: SAMPLE_MS / 1000, history: this.history }
      : this.latest;
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }

  /** A request keeps sampling going; the first one starts it and waits for the baseline the first sample needs. */
  private watched() {
    this.lastRequest = this.s.now();
    if (!this.running || this.timer) return;
    this.timer = setInterval(() => void this.sample(), SAMPLE_MS);
    this.dockerTimer = setInterval(() => void this.refreshDocker(), DOCKER_MS);
    void this.refreshDocker();
    return this.sample();
  }

  /** One tick of the timer: the baseline after a start, then a sample against it. A tick that comes while one still runs
   * waits for that one instead of doubling it. */
  sample() {
    return (this.pending ??= this.tick().finally(() => (this.pending = undefined)));
  }

  private async tick() {
    if (!this.timer) return;
    if (this.s.now() - this.lastRequest >= WATCHED_MS) return this.pause();
    try {
      if (this.previous) {
        const sample = await this.measure();
        if (this.timer) {
          this.latest = sample;
          this.history.push(point(sample));
          if (this.history.length > HISTORY_SAMPLES) this.history.shift();
        }
      } else {
        [this.disks, this.iface] = await Promise.all([physicalDisks(), publicInterface()]);
        this.previous = await this.counters();
      }
      // Paused meanwhile: the next start takes a fresh baseline.
      if (!this.timer) this.previous = undefined;
    } catch (e) {
      console.error(`health sample failed: ${(e as Error)?.name ?? "error"}`);
    }
  }

  private async counters() {
    const [cpu, disk, network, list] = await Promise.all([
      cpuTimes(),
      diskCounters(this.disks),
      networkCounters(this.iface),
      processes(),
    ]);
    return { at: performance.now(), cpu, disk, network, processes: list };
  }

  private async refreshDocker() {
    this.docker = dockerDisk(await output(["docker", "system", "df", "--format", "{{json .}}"], 120_000));
  }

  /** What the dashboard reports as up: Tailscale, Docker when it is installed, and the T3 Code agentgate is connected to.
   * Tailscale and T3 Code are asked every SERVICES_MS, not every sample. */
  private async services(dockerRunning: boolean) {
    if (!this.checked || this.s.now() - this.checked.at >= SERVICES_MS) {
      const t3 = t3State(this.s).url;
      const [tailscale, t3Answers] = await Promise.all([tailscaleRunning(), t3 ? answers(t3) : undefined]);
      this.checked = { at: this.s.now(), tailscale, t3: t3Answers };
    }
    return {
      tailscale: this.checked.tailscale,
      ...(Bun.which("docker") !== null && { docker: dockerRunning }),
      ...(this.checked.t3 !== undefined && { t3_code: this.checked.t3 }),
    };
  }

  /** Takes a sample against the previous one, and that one becomes the baseline for the next. */
  async measure() {
    const previous = this.previous;
    if (!previous) throw new Error("not sampling");
    const now = await this.counters();
    const list = now.processes;
    const seconds = (now.at - previous.at) / 1000;

    // Per program: CPU in cores over the interval, and resident memory.
    const ticksBefore = new Map(previous.processes.map((proc) => [proc.pid, proc.ticks]));
    const byProgram = new Map<string, { processes: number; cores: number; memoryBytes: number }>();
    for (const proc of list) {
      const group = byProgram.get(proc.program) ?? { processes: 0, cores: 0, memoryBytes: 0 };
      const before = ticksBefore.get(proc.pid);
      // A process born in this interval is counted from the next one.
      if (before !== undefined) group.cores += (proc.ticks - before) / CLOCK_TICKS / seconds;
      group.processes += 1;
      group.memoryBytes += proc.rssBytes;
      byProgram.set(proc.program, group);
    }
    const count = (program: string) => byProgram.get(program)?.processes ?? 0;

    // An agent is a session's top process: not a helper its own program started, and not a daemon left running with init
    // as its parent (Codex's app-server).
    const programByPid = new Map(list.map((proc) => [proc.pid, proc.program]));
    const agents = (program: string) =>
      list.filter((proc) => proc.program === program && proc.ppid !== 1 && programByPid.get(proc.ppid) !== program)
        .length;

    const cpus = os.cpus().length;
    const [one = 0, five = 0, fifteen = 0] = os.loadavg();
    const busyTicks = now.cpu.total - previous.cpu.total - (now.cpu.idle - previous.cpu.idle);
    const [oom, memoryUse, diskUse, pressureCpu, pressureMemory, pressureIo, containers, services] = await Promise.all([
      oomKills(),
      memory(),
      disk("/"),
      pressure("cpu"),
      pressure("memory"),
      pressure("io"),
      runningContainers(),
      this.services(count("dockerd") > 0),
    ]);
    const sample = {
      status: "ok",
      host: os.hostname(),
      checked_at: new Date().toISOString(),
      uptime_hours: round(os.uptime() / 3600),
      cpus,
      cpu_used_percent: percent(busyTicks, now.cpu.total - previous.cpu.total),
      // Load per core: 1.0 means every core is busy.
      load: { "1m": round(one), "5m": round(five), "15m": round(fifteen), per_cpu_1m: round(one / cpus) },
      memory: memoryUse,
      disk: diskUse,
      pressure: { cpu: pressureCpu, memory: pressureMemory, io: pressureIo },
      disk_io: {
        busy_percent: Math.min(100, percent(now.disk.ioTicksMs - previous.disk.ioTicksMs, seconds * 1000)),
        read_mb_s: round((now.disk.readBytes - previous.disk.readBytes) / MB / seconds),
        write_mb_s: round((now.disk.writtenBytes - previous.disk.writtenBytes) / MB / seconds),
      },
      network: {
        interface: this.iface,
        in_mbit_s: round(((now.network.received - previous.network.received) * 8) / 1e6 / seconds),
        out_mbit_s: round(((now.network.sent - previous.network.sent) * 8) / 1e6 / seconds),
      },
      workload: {
        agents: { claude: agents("claude"), codex: agents("codex") },
        runners: { total: count("Runner.Listener"), busy: count("Runner.Worker") },
        containers: { running: containers, disk: this.docker },
        oom_kills: { since_boot: oom, last_hour: oom - (this.history[0]?.oom_kills ?? oom) },
      },
      services,
      daemon_lag: lag() ?? null,
      top_processes: sortBy(
        [...byProgram].map(([program, group]) => ({
          program,
          processes: group.processes,
          cpu_cores: round(group.cores),
          memory_gb: round(group.memoryBytes / GB),
        })),
        { by: "cpu_cores", order: "desc" },
        { by: "memory_gb", order: "desc" },
      ).slice(0, 8),
    };

    this.previous = now;
    return sample;
  }
}

type Sample = Awaited<ReturnType<HealthDashboard["measure"]>>;

function point(sample: Sample): Point {
  return {
    t: Date.now(),
    cpu: sample.cpu_used_percent,
    load_per_cpu: sample.load.per_cpu_1m,
    memory: sample.memory.used_percent,
    pressure_cpu: sample.pressure.cpu,
    pressure_memory: sample.pressure.memory,
    pressure_io: sample.pressure.io,
    agents: sample.workload.agents.claude + sample.workload.agents.codex,
    runners_busy: sample.workload.runners.busy,
    oom_kills: sample.workload.oom_kills.since_boot,
  };
}
