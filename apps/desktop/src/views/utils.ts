import type { Provider } from "@agentgate/protocol";

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
  window.confirm(`Delete ${name}? This removes it from every paired machine.`);
