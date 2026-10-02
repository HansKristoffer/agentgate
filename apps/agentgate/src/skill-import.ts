import { MAX_SKILL, MAX_SKILL_FILES, SKILL_MARKER, SkillConflict, skillSchema, type SkillSearchResult } from "@agentgate/protocol";
import { spawn } from "node:child_process";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { z } from "zod";
import { fetchHeaders, readBody } from "./runtime.ts";
import type { Skill } from "./store.ts";

export const SKILLS_CLI_VERSION = "1.7.0";
export const MAX_PACK = 24 * 1024 * 1024;
export interface FetchedSkill {
  id: string;
  description: string;
  files: Skill["files"];
  selector?: string;
  hash?: string;
  security?: Record<string, string>;
}
export type SkillFetcher = (source: string, skill?: string, signal?: AbortSignal) => Promise<FetchedSkill[]>;
export const skillId = (name: string) => name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 128);

/** Loose on import, helpful validation when writing Markdown by hand. */
export function description(text: string, expectedName?: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    if (expectedName && text.startsWith("---")) throw new Error("SKILL.md has unterminated frontmatter");
    return "";
  }
  try {
    const value = Bun.YAML.parse(match[1]!) as { name?: unknown; description?: unknown } | null;
    if (expectedName && value?.name !== undefined && value.name !== expectedName) throw new Error(`Frontmatter name must be ${expectedName}`);
    return typeof value?.description === "string" ? value.description.trim().slice(0, 8192) : "";
  } catch (error) {
    if (expectedName) throw new Error(`Invalid SKILL.md frontmatter: ${error instanceof Error ? error.message : error}`);
    return "";
  }
}

export function readSkill(dir: string): Pick<FetchedSkill, "description" | "files"> {
  const files: Skill["files"] = [];
  let bytes = 0;
  const walk = (rel: string, depth = 0) => {
    if (depth > 32) throw new Error("skill directory nesting exceeds 32 levels");
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === SKILL_MARKER) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile()) {
        if (files.length >= MAX_SKILL_FILES) throw new Error("skill has too many files");
        const disk = join(dir, path), stat = lstatSync(disk);
        if (!stat.isFile()) throw new Error(`skill file changed while reading: ${path}`);
        bytes += Math.ceil(stat.size / 3) * 4;
        if (bytes > MAX_SKILL) throw new Error("skill exceeds 3 MiB of encoded data (about 2.25 MiB of files)");
        files.push({ path, data: readFileSync(disk).toString("base64"), ...(stat.mode & 0o111 ? { executable: true } : {}) });
      } else throw new Error(`unsupported skill entry ${path}: symlinks and special files cannot be synced`);
    }
  };
  walk("");
  const parsed = skillSchema.parse({ id: "import", files, updatedAt: 0 });
  const md = parsed.files.find(file => file.path === "SKILL.md")!;
  return { files: parsed.files, description: description(Buffer.from(md.data, "base64").toString()) };
}

export function validateFetched(fetched: FetchedSkill[]): FetchedSkill[] {
  if (!fetched.length || fetched.length > 100) throw new Error("a source must contain between 1 and 100 skills");
  const ids = new Set<string>();
  let bytes = 0;
  return fetched.map(f => {
    const parsed = skillSchema.parse({ ...f, updatedAt: 0 });
    if (ids.has(parsed.id)) throw new Error(`duplicate skill name in source: ${parsed.id}`);
    ids.add(parsed.id);
    bytes += Buffer.byteLength(JSON.stringify(f));
    if (bytes > MAX_PACK) throw new Error("skill pack exceeds 24 MiB of encoded data; select individual skills");
    return { ...f, files: parsed.files };
  });
}

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n").map(l => l.trim()).filter(Boolean).slice(-4).join("; ");
const cliResultSchema = z.array(z.object({ status: z.enum(["installed", "skipped", "failed"]), name: z.string().max(256).optional(), path: z.string().optional(), hash: z.string().nullish(), security: z.record(z.string(), z.string()).nullish() })).max(100);
export function parseSkillOutput(out: string) {
  let json: unknown;
  try { json = JSON.parse(out); } catch { throw new Error(`skills CLI ${SKILLS_CLI_VERSION} returned invalid JSON`); }
  const parsed = cliResultSchema.safeParse(json);
  if (!parsed.success) throw new Error(`skills CLI ${SKILLS_CLI_VERSION} returned incompatible JSON`);
  if (parsed.data.some(row => row.status === "installed" && !row.path)) throw new Error("skills CLI omitted an installed skill path");
  return parsed.data;
}

/** A detached process group lets cancellation reach npm's CLI and Git descendants too. */
export function runSkillCommand(argv: string[], cwd: string, signal: AbortSignal, outputLimit = 1024 * 1024): Promise<{ out: string; err: string; code: number | null }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DISABLE_TELEMETRY: "1" } });
    const out: Buffer[] = [], err: Buffer[] = [];
    let outBytes = 0, errBytes = 0, stopped = false, reason: unknown;
    let escalation: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
    const kill = (sig: "SIGTERM" | "SIGKILL") => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch { child.kill(sig); }
    };
    const finish = (error?: unknown, code: number | null = null) => {
      if (stopped) return;
      stopped = true; clearTimeout(escalation); clearTimeout(deadline); signal.removeEventListener("abort", abort);
      child.stdout?.destroy(); child.stderr?.destroy();
      if (error !== undefined) reject(error); else resolve({ out: Buffer.concat(out).toString(), err: Buffer.concat(err).toString(), code });
    };
    const cancel = (error: unknown) => {
      if (reason !== undefined || stopped) return;
      reason = error; kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 250);
      deadline = setTimeout(() => { kill("SIGKILL"); finish(reason); }, 1000);
    };
    const abort = () => cancel(signal.reason ?? new Error("skill import cancelled"));
    child.stdout?.on("data", (chunk: Buffer) => { outBytes += chunk.length; if (outBytes > outputLimit) cancel(new Error("skills CLI output exceeds its limit")); else out.push(chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { errBytes += chunk.length; if (errBytes > outputLimit) cancel(new Error("skills CLI diagnostics exceed their limit")); else err.push(chunk); });
    child.on("error", error => finish(error));
    child.on("close", code => { if (reason !== undefined) kill("SIGKILL"); finish(reason, code); });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function fetchSkills(source: string, selector = "*", signal?: AbortSignal): Promise<FetchedSkill[]> {
  const npx = Bun.which("npx"), bunx = Bun.which("bunx");
  const runner = npx ? [npx, "-y"] : bunx ? [bunx] : undefined;
  if (!runner) throw new Error("adding skills needs Node (npx) or Bun (bunx) on the daemon's machine");
  if (source.startsWith("-")) throw new Error("a skill source cannot start with a dash");
  const dir = mkdtempSync(join(tmpdir(), "agentgate-skills-"));
  const bounded = AbortSignal.any([AbortSignal.timeout(100_000), ...(signal ? [signal] : [])]);
  try {
    const { out, err, code } = await runSkillCommand([...runner, `skills@${SKILLS_CLI_VERSION}`, "add", source.replace(/^~(?=\/|$)/, homedir()), "--skill", selector, "--agent", "codex", "--copy", "-y", "--json"], dir, bounded);
    if (code !== 0) throw new Error(`skills add failed: ${plain(err) || plain(out) || `exit ${code}`}`);
    const rows = parseSkillOutput(out);
    const root = realpathSync(dir) + sep;
    return validateFetched(rows.filter(row => row.status === "installed").map(row => {
      if (!row.path) throw new Error("skills CLI omitted an installed skill path");
      const path = realpathSync(row.path);
      if (!path.startsWith(root)) throw new Error("the skills CLI wrote outside its scratch folder");
      return { id: skillId(basename(path)), selector: row.name ?? (selector === "*" ? undefined : selector), hash: row.hash ?? undefined, security: row.security ?? undefined, ...readSkill(path) };
    }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function searchSkills(query: string, signal?: AbortSignal): Promise<SkillSearchResult[]> {
  const bounded = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
  const res = await fetchHeaders(`https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=30`, { signal: bounded });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`skills.sh search failed (${res.status})`); }
  const body = z.object({ skills: z.array(z.object({ source: z.string().max(2048), skillId: z.string().max(256), installs: z.number().nonnegative().default(0) })).max(100) })
    .parse(JSON.parse(new TextDecoder().decode(await readBody(res.body, 1024 * 1024, bounded))));
  return body.skills.map(s => ({ source: s.source, skill: s.skillId, installs: s.installs }));
}

interface Artifact { token: string; source: string; selector: string; at: number; bytes: number; skills: FetchedSkill[] }
export class SkillImports {
  private artifacts = new Map<string, Artifact>();
  private flights = new Map<string, { work: Promise<Artifact>; abort: AbortController; users: number }>();
  private closed = false;
  constructor(private fetch: SkillFetcher = fetchSkills, private now = () => Date.now(), private maxBytes = 64 * 1024 * 1024, private ttl = 10 * 60_000) { }
  private prune() {
    for (const [token, artifact] of this.artifacts) if (this.now() - artifact.at >= this.ttl) this.artifacts.delete(token);
  }
  preview(source: string, selector = "*", signal?: AbortSignal): Promise<Artifact> {
    return this.acquire(source, selector, signal, false);
  }
  fetchFresh: SkillFetcher = async (source, selector = "*", signal) => (await this.acquire(source, selector, signal, true)).skills;

  private async acquire(source: string, selector: string, signal: AbortSignal | undefined, fresh: boolean): Promise<Artifact> {
    if (this.closed) throw new Error("skill importer is closed");
    signal?.throwIfAborted(); this.prune();
    const cached = !fresh && [...this.artifacts.values()].find(a => a.source === source && a.selector === selector);
    if (cached) return structuredClone(cached);
    const key = JSON.stringify([fresh, source, selector]);
    let flight = this.flights.get(key);
    if (!flight) {
      if (this.flights.size >= 2) throw new SkillConflict("Two skill imports are already running. Try again shortly.");
      const abort = new AbortController();
      const work = (async () => {
        const skills = validateFetched(await this.fetch(source, selector, abort.signal));
        abort.signal.throwIfAborted();
        const bytes = Buffer.byteLength(JSON.stringify(skills));
        if (bytes > this.maxBytes) throw new Error("skill preview exceeds the cache limit; select individual skills");
        this.prune();
        while (!fresh && this.artifacts.size && (this.artifacts.size >= 16 || [...this.artifacts.values()].reduce((n, a) => n + a.bytes, 0) + bytes > this.maxBytes)) this.artifacts.delete(this.artifacts.keys().next().value!);
        const artifact = { token: crypto.randomUUID(), source, selector, at: this.now(), bytes, skills };
        if (!fresh) this.artifacts.set(artifact.token, artifact);
        return artifact;
      })().finally(() => this.flights.delete(key));
      flight = { work, abort, users: 0 }; this.flights.set(key, flight);
    }
    flight.users++;
    const current = flight;
    let onAbort: (() => void) | undefined;
    try {
      return structuredClone(await (signal ? Promise.race([current.work, new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort(); })]) : current.work));
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      if (--current.users === 0 && this.flights.get(key) === current) current.abort.abort();
    }
  }
  get(token: string): Artifact {
    this.prune();
    const artifact = this.artifacts.get(token);
    if (!artifact) throw new SkillConflict("This preview expired or was evicted. Preview the source again before installing.");
    return structuredClone(artifact);
  }
  close() { this.closed = true; this.artifacts.clear(); for (const flight of this.flights.values()) flight.abort.abort(); }
  async drain() { await Promise.allSettled([...this.flights.values()].map(f => f.work)); }
}
