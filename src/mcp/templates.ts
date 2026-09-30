import type { McpInstance } from "../store.ts";

/** A one-click server: a hosted MCP URL (login happens through its OAuth), or a local command. */
export interface Preset {
  id: string;
  label: string;
  url?: string;
  command?: string;
  args?: string[];
  mode?: McpInstance["mode"];
  note?: string;
}

// Each hosted URL was checked to offer MCP OAuth with dynamic client registration (2026-09-30).
export const presets: Preset[] = [
  { id: "posthog", label: "PostHog", url: "https://mcp.posthog.com/mcp" },
  { id: "linear", label: "Linear", url: "https://mcp.linear.app/mcp" },
  { id: "sentry", label: "Sentry", url: "https://mcp.sentry.dev/mcp" },
  { id: "notion", label: "Notion", url: "https://mcp.notion.com/mcp" },
  { id: "supabase", label: "Supabase", url: "https://mcp.supabase.com/mcp" },
  { id: "stripe", label: "Stripe", url: "https://mcp.stripe.com" },
  { id: "vercel", label: "Vercel", url: "https://mcp.vercel.com" },
  { id: "cloudflare", label: "Cloudflare", url: "https://mcp.cloudflare.com/mcp" },
  { id: "neon", label: "Neon", url: "https://mcp.neon.tech/mcp" },
  { id: "railway", label: "Railway", url: "https://mcp.railway.com" },
  { id: "context7", label: "Context7", url: "https://mcp.context7.com/mcp" },
  { id: "filesystem", label: "Filesystem", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."], mode: "perSession", note: "runs in each session's worktree" },
];

export const preset = (id: string) => presets.find((p) => p.id === id);

export const validId = (id: string) => /^[a-z0-9][a-z0-9_-]*$/i.test(id);

/** `Name: value` lines (or `name=value` pairs) into a header map. */
export function parseHeaders(text: string | string[] = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (Array.isArray(text) ? text : text.split("\n")).map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^([^:=\s]+)\s*[:=]\s*(.*)$/);
    if (!m) throw new Error(`bad header: ${line} (use Name: value)`);
    out[m[1]!] = m[2]!;
  }
  return out;
}

/** Build an instance record from a URL or a command. */
export function newInstance(o: { id: string; template?: string; url?: string; headers?: Record<string, string>; command?: string; args?: string[]; mode?: McpInstance["mode"] }): McpInstance {
  if (!validId(o.id)) throw new Error("name: letters, digits, - and _ (it becomes the tool prefix)");
  const base = { id: o.id, template: o.template ?? "custom", secrets: {}, fields: {} };
  if (o.url) {
    const url = new URL(o.url.trim()); // throws on a bad URL
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("use an https:// URL");
    return { ...base, transport: "http", mode: "shared", url: url.href, headers: o.headers ?? {} };
  }
  if (!o.command) throw new Error("a URL or a command is required");
  return { ...base, transport: "stdio", mode: o.mode ?? "shared", command: o.command, args: o.args ?? [] };
}

export function fromPreset(p: Preset, id = p.id): McpInstance {
  return newInstance({ id, template: p.id, url: p.url, command: p.command, args: p.args, mode: p.mode });
}

/** A free name for a new instance: `posthog`, then `posthog-2`, … */
export function freeId(taken: (id: string) => boolean, base: string): string {
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
}

// Older instances may use `{{x}}` / `{{secret.x}}` placeholders filled from fields and secrets.
const fill = (s: string, inst: McpInstance) =>
  s.replace(/\{\{(secret\.)?(\w+)\}\}/g, (_, secret, k) => (secret ? inst.secrets[k] : inst.fields[k]) ?? "");

const fillAll = (o: Record<string, string> | undefined, inst: McpInstance) => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o ?? {})) {
    const f = fill(v, inst);
    if (f && !/^Bearer\s*$/.test(f)) out[k] = f; // drop headers whose optional value was left empty
  }
  return out;
};

/** The instance with every placeholder filled in, ready to connect. */
export function resolve(inst: McpInstance) {
  return {
    ...inst,
    url: inst.url && fill(inst.url, inst),
    headers: fillAll(inst.headers, inst),
    env: fillAll(inst.env, inst),
    args: (inst.args ?? []).map((a) => fill(a, inst)),
  };
}
