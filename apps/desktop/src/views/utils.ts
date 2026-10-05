import type { Provider } from "@agentgate/protocol";
import { confirmDialog } from "@hanskristoffer/taurio/runtime";

export const field = (form: FormData, name: string) =>
  String(form.get(name) ?? "").trim();
export const idPath = (id: string) => encodeURIComponent(id);
export const providerName = (p: Provider) =>
  p === "claude" ? "Claude" : "Codex";
export const relative = (at?: number) =>
  !at
    ? "Not yet"
    : new Date(at).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
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
