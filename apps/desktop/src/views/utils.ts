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
/** "5h" → "5-hour", "7d:opus" → "Weekly Opus". */
export const windowName = (name: string) => {
  const [w, model] = name.split(":");
  const base = w === "5h" ? "5-hour" : w === "7d" ? "Weekly" : w!;
  return model ? `${base} ${model[0]!.toUpperCase()}${model.slice(1)}` : base;
};
/** "in 4 h"; undefined when the window has no reset yet. */
export const resetIn = (at?: number) => {
  if (!at) return undefined;
  const m = Math.max(1, Math.round((at - Date.now()) / 60_000));
  return m < 60 ? `in ${m} min` : m < 1440 ? `in ${Math.round(m / 60)} h` : `in ${Math.round(m / 1440)} d`;
};
export const planName = (plan: string) => {
  const p = plan.replace(/^claude_/, "");
  return p[0]!.toUpperCase() + p.slice(1);
};
