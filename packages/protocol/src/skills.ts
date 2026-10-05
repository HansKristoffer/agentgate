import { z } from "zod";

export const SKILL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** Any name a person types as an id: "PostHog Work" → "posthog-work", "Café" → "cafe". Empty when nothing usable is left. */
export const slugify = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // the accents NFKD split off: é becomes e
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");
/** `*`, a GitHub `owner/repo`, or a virtual project `@name` (GitHub owners can't start with `@`). */
export const PROJECT_ID = /^(\*|[^/\s@][^/\s]*\/[^/\s]+|@[a-z0-9][a-z0-9-]{0,63})$/;
export const isVirtual = (project: string) => project.startsWith("@");
export const MAX_SKILL = 3 * 1024 * 1024; // Encoded payload, about 2.25 MiB decoded.
export const MAX_SKILL_FILES = 5000;
export const MAX_RECORD = 4 * 1024 * 1024;
export const SKILL_MARKER = ".agentgate-rev";
export const skillIdSchema = z.string().regex(SKILL_ID);
/** A connected skill repository, normalized to its lowercase https URL. */
export const SKILL_REPO = /^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9._-]+$/;
export const skillRepoSchema = z.string().max(256).regex(SKILL_REPO);
export const projectIdSchema = z.string().max(512).regex(PROJECT_ID);
export const decodedSize = (data: string) => data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
export const safePath = (path: string) => !path.startsWith("/") && !/[\\\x00-\x1f]/.test(path)
  && path.split("/").length <= 32
  && path.split("/").every(part => !!part && part !== "." && part !== ".." && part !== ".git" && part !== SKILL_MARKER);
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/;
export const skillFileSchema = z.object({
  path: z.string().max(512).refine(safePath, "unsafe or reserved skill file path"),
  data: z.string().max(MAX_SKILL).refine(value => base64.test(value), "invalid base64 skill file"),
  executable: z.boolean().optional(),
});
export const skillSchema = z.object({
  id: skillIdSchema,
  description: z.string().max(8192).default(""),
  source: z.string().max(2048).optional(),
  selector: z.string().max(256).optional(),
  hash: z.string().max(128).optional(),
  contentHash: z.string().max(128).optional(),
  size: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative(),
  files: z.array(skillFileSchema).min(1).max(MAX_SKILL_FILES),
}).superRefine((skill, ctx) => {
  const paths = new Set<string>(), directories = new Set<string>();
  let encoded = 0;
  for (const [index, file] of skill.files.entries()) {
    encoded += file.data.length;
    const path = file.path.normalize("NFC").toLowerCase();
    if (paths.has(path)) ctx.addIssue({ code: "custom", path: ["files", index, "path"], message: "duplicate or case-colliding skill path" });
    paths.add(path);
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  if ([...paths].some(path => directories.has(path))) ctx.addIssue({ code: "custom", path: ["files"], message: "skill file/directory collision" });
  const md = skill.files.find(file => file.path === "SKILL.md");
  if (!md || !md.data || (base64.test(md.data) && !atob(md.data).trim())) ctx.addIssue({ code: "custom", path: ["files"], message: "a nonempty root SKILL.md is required" });
  if (encoded > MAX_SKILL) ctx.addIssue({ code: "custom", path: ["files"], message: "skill exceeds 3 MiB of encoded data (about 2.25 MiB of files)" });
  if (new TextEncoder().encode(JSON.stringify(skill)).byteLength > MAX_RECORD) ctx.addIssue({ code: "custom", message: "skill record exceeds 4 MiB" });
}).transform(skill => ({
  ...skill,
  files: skill.files.map(file => ({ ...file, executable: file.executable || undefined }) as z.infer<typeof skillFileSchema>).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  size: skill.files.reduce((sum, file) => sum + decodedSize(file.data), 0),
}));

export class SkillConflict extends Error {
  constructor(message = "This skill changed while you were working. Refresh and try again.") { super(message); this.name = "SkillConflict"; }
}
