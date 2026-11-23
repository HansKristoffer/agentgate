import { providerSchema, type Provider } from "@agentgate/protocol";
import { confirmDialog } from "@hanskristoffer/taurio/runtime";

export const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
export const idPath = (id: string) => encodeURIComponent(id);
export const providerName = (p: Provider) => ({ claude: "Claude", codex: "Codex", cursor: "Cursor" })[p];
/** The coding tool whose sessions use a provider's accounts. */
export const toolName = (p: Provider) => ({ claude: "Claude Code", codex: "Codex", cursor: "Cursor" })[p];
/** Every provider, for a choice between them. */
export const providerOptions = providerSchema.options.map((p) => ({ id: p, label: providerName(p) }));
export const providerIcon = (p: Provider) => ({ claude: "✳", codex: "◎", cursor: "◆" })[p];

const relativeFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const todayTimeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const fullDateTimeFmt = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

export const relative = (at?: number) => (!at ? "Not yet" : relativeFmt.format(at));
/** Compact timestamp for Activity rows: `14:32:05` today, `Nov 22, 14:32` for earlier days. */
export const compactTime = (at: number, todayStart: number) =>
  at >= todayStart ? todayTimeFmt.format(at) : relativeFmt.format(at);
export const fullTime = (at: number) => fullDateTimeFmt.format(at);

export const confirmDelete = (name: string) =>
  confirmDialog(`Delete ${name}? This removes it from every paired machine.`, {
    destructive: true,
    okLabel: "Delete",
  });
export const ago = (at: number) => {
  const m = Math.round((Date.now() - at) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
/** T3 Code's compact sidebar time: "now", "21m", "4h", "3d". */
export const since = (iso: string) => {
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  return m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};
/** How long a thread has been working, as T3 Code shows it: "3m", "1h 53m". */
export const elapsed = (iso: string) => {
  const m = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
/** "5h" → "5-hour", "7d:opus" → "Weekly Opus". */
export const windowName = (name: string) => {
  const [w, model] = name.split(":");
  const base = w === "5h" ? "5-hour" : w === "7d" ? "Weekly" : w!;
  return model ? `${base} ${model[0]!.toUpperCase()}${model.slice(1)}` : base;
};
/** "in 3 h 47 min"; empty when the window has no reset yet. */
export const resetIn = (at: number | undefined, now = Date.now()) => {
  if (!at) return "";
  if (at <= now) return "reset passed";

  const minutes = Math.max(1, Math.ceil((at - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 1440) return `in ${hours} h ${minutes % 60} min`;
  return `in ${Math.floor(hours / 24)} d ${hours % 24} h`;
};
export const planName = (plan: string) => {
  const p = plan.replace(/^claude_/, "");
  return p[0]!.toUpperCase() + p.slice(1);
};
/** Human-readable duration hint for millisecond settings, e.g. `660000` → `"11 min"`. */
export const formatDurationMs = (ms: number) => {
  if (!Number.isFinite(ms) || ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS ? `${m} min ${remS} s` : `${m} min`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM ? `${h} h ${remM} min` : `${h} h`;
};
/** Human-readable byte budget hint, e.g. `16777216` → `"16 MiB"`. */
export const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes % 1024 === 0 ? 0 : 1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MiB`;
};
/** Local midnight 52 weeks before the start of this week (Sunday), matching `TokenCalendar`. */
export const tokenYearStart = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 52 * 7 - d.getDay());
  return d.getTime();
};
