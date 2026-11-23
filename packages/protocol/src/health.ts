import { z } from "zod";

/** One point of a machine's last hour, as the app's charts plot it. */
export const healthPointSchema = z.object({
  t: z.number(),
  cpu: z.number(),
  load_per_cpu: z.number(),
  memory: z.number(),
  pressure_cpu: z.number(),
  pressure_memory: z.number(),
  pressure_io: z.number(),
  agents: z.number(),
  runners_busy: z.number(),
  oom_kills: z.number(),
});
export type HealthPoint = z.infer<typeof healthPointSchema>;

const usage = { total_gb: z.number(), used_gb: z.number(), used_percent: z.number() };

/** What the `health` operation returns for a Linux machine (health.ts): its latest sample and the hour before it.
 * Another machine's answer is parsed with it, so one on another version fails with a message naming it. */
export const machineHealthSchema = z.object({
  host: z.string(),
  checked_at: z.string(),
  uptime_hours: z.number(),
  cpus: z.number(),
  cpu_used_percent: z.number(),
  load: z.object({ "1m": z.number(), "5m": z.number(), "15m": z.number(), per_cpu_1m: z.number() }),
  memory: z.object({ ...usage, available_gb: z.number() }),
  disk: z.object({ ...usage, free_gb: z.number() }),
  /** Share of the last 10 seconds that some task waited for the resource (Linux PSI). */
  pressure: z.object({ cpu: z.number(), memory: z.number(), io: z.number() }),
  disk_io: z.object({ busy_percent: z.number(), read_mb_s: z.number(), write_mb_s: z.number() }),
  network: z.object({ interface: z.string(), in_mbit_s: z.number(), out_mbit_s: z.number() }),
  workload: z.object({
    agents: z.object({ claude: z.number(), codex: z.number() }),
    runners: z.object({ total: z.number(), busy: z.number() }),
    containers: z.object({
      running: z.number(),
      /** Docker's own words for its disk use ("783.1MB"); null until it has been measured, or without Docker. */
      disk: z
        .object({
          images: z.string().nullable(),
          images_reclaimable: z.string().nullable(),
          volumes: z.string().nullable(),
          build_cache: z.string().nullable(),
        })
        .nullable(),
    }),
    oom_kills: z.object({ since_boot: z.number(), last_hour: z.number() }),
  }),
  /** Docker only when it is installed, T3 Code only while agentgate is connected to it. */
  services: z.object({ tailscale: z.boolean(), docker: z.boolean().optional(), t3_code: z.boolean().optional() }),
  /** How late agentgate's own event loop ran in the last minute. */
  daemon_lag: z.object({ worstMs: z.number(), p99Ms: z.number() }).nullable(),
  top_processes: z.array(
    z.object({ program: z.string(), processes: z.number(), cpu_cores: z.number(), memory_gb: z.number() }),
  ),
  sample_seconds: z.number(),
  history: z.array(healthPointSchema),
});
export type MachineHealth = z.infer<typeof machineHealthSchema>;
