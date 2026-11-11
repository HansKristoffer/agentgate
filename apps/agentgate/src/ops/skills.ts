import {
  projectChangeSchema,
  projectIdSchema,
  SkillConflict,
  skillIdSchema,
  type SkillPreviewResponse,
} from "@agentgate/protocol";
import { getErrorMessage, truncate } from "hanzio";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { Ctx } from "../daemon.ts";
import { SkillImports } from "../skill-import.ts";
import {
  changeSkillProjects,
  changeSkillRepoProjects,
  connectSkillRepo,
  deleteSkill,
  fetchSkills,
  installSkills,
  repoUrl,
  setSkillRepoProjects,
  skillPreview,
  skillRepoSummaries,
  skillRevision,
  syncSkillRepo,
  updateSkill,
  updateSkills,
  writeSkillMd,
} from "../skills.ts";
import type { Store } from "../store.ts";
import { controlOp, shownError, UserError } from "./registry.ts";

/** The skills family's control operations. None is loopback-only: the app manages a paired server's skills too. */

const sourceSchema = z.string().trim().min(1).max(2048);
const repoSchema = z.string().trim().min(1).max(512);
const skillMdSchema = z.string().max(1024 * 1024);

/** A path the CLI was given, from the folder it ran in. */
const absolute = (path: string, cwd = process.cwd()) => resolve(cwd, path.replace(/^~(?=\/|$)/, homedir()));
/** A source that looks like a folder is read on this machine, so it is made absolute where the CLI ran. */
export const sourceFrom = (source: string, cwd?: string) =>
  /^(\.{1,2}(\/|$)|~(\/|$)|\/)/.test(source) ? absolute(source, cwd) : source;

/** The words after an operation's name, read by `parseArgs`; words it cannot read print the usage. */
const read = <T>(parse: () => T) => {
  try {
    return parse();
  } catch (error) {
    throw new UserError(getErrorMessage(error));
  }
};
const readFile = (file: string | undefined, cwd: string | undefined) => {
  if (!file) throw new UserError("--file SKILL.md is required");
  try {
    return readFileSync(absolute(file, cwd), "utf8");
  } catch {
    throw new UserError(`Could not read ${file}`);
  }
};

/** The CLI's own process prints only a UserError's text (cli/ops.ts), while the daemon answers a conflict's text with a
 * 409; the CLI shows it either way. */
async function conflictsShown<T>(daemon: Ctx | undefined, run: () => T | Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (!daemon && error instanceof SkillConflict) throw new UserError(error.message);
    throw error;
  }
}

// The CLI's own process previews and installs in one run when no daemon answers, so it keeps its previews here.
let ownImports: SkillImports | undefined;
const importsOf = (daemon: Ctx | undefined) => daemon?.imports ?? (ownImports ??= new SkillImports());

const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`);
/** The preview the app shows before installing, as lines: each skill, what it clashes with, and its audit. */
export function previewLines(preview: SkillPreviewResponse) {
  return preview.skills.flatMap((k) => {
    const { details, ...audit } = k.security ?? {};
    const findings = Object.entries(audit).map(([key, value]) => `${key}: ${value}`);
    return [
      `${k.id}${k.conflict ? `  ${k.conflict}` : k.installed ? "  installed; this updates it" : ""}`,
      ...(k.description ? [`  ${truncate(k.description, 180)}`] : []),
      `  ${k.files} ${k.files === 1 ? "file" : "files"}, ${size(k.size)}`,
      `  security: ${findings.join(", ") || "no audit for this source"}${details ? ` (${details})` : ""}`,
    ];
  });
}

const outcomes = (results: { name: string; outcome: string }[]) =>
  results.length ? results.map((r) => `${r.name}: ${r.outcome}`) : ["Nothing to update"];
const outcome = (changed: boolean) => (changed ? "updated" : "up to date");

async function syncRepos(s: Store, urls: string[], signal: AbortSignal | undefined) {
  const results: { name: string; outcome: string }[] = [];
  for (const url of urls)
    results.push({
      name: url,
      outcome: await syncSkillRepo(s, url, undefined, signal).then(
        outcome,
        (error) => `failed: ${shownError(error) || "the sync failed"}`,
      ),
    });
  return results;
}

controlOp({
  name: "skills preview",
  summary: "fetch a source and show what it would install, with the skills.sh security audit",
  input: z.object({ source: sourceSchema, skill: z.string().min(1).max(256).optional() }).strict(),
  needs: "store",
  run: ({ source, skill }, { s, daemon }) =>
    conflictsShown(daemon, async () =>
      skillPreview(s, await importsOf(daemon).preview(source, skill, daemon?.abort.signal)),
    ),
  terminal: {
    usage: "skills preview <owner/repo|url|folder> [--skill <name>]",
    parse(args, _stdin, cwd) {
      const { values, positionals } = read(() =>
        parseArgs({ args, options: { skill: { type: "string" } }, allowPositionals: true, strict: true }),
      );
      const [source, ...extra] = positionals;
      if (!source || extra.length) throw new UserError();
      return { input: { source: sourceFrom(source, cwd), skill: values.skill } };
    },
    print: previewLines,
  },
});

// The CLI's `skills add` previews, asks, and then installs through this (cli/skills.ts).
controlOp({
  name: "skills add",
  summary: "install skills from a preview",
  input: z
    .object({
      token: z.string().uuid(),
      ids: z.array(skillIdSchema).min(1).max(100),
      projects: z.array(projectIdSchema).max(5000).default([]),
    })
    .strict(),
  needs: "store",
  run: ({ token, ids, projects }, { s, daemon }) =>
    conflictsShown(daemon, () => {
      const artifact = importsOf(daemon).get(token);
      return { installed: installSkills(s, artifact.source, artifact.skills, ids, projects) };
    }),
});

const written = (id: string) => [`saved ${id}; link it with: agentgate skills projects ${id} <owner/repo|*>`];
const writeWords = (args: string[], cwd: string | undefined) => {
  const { values, positionals } = read(() =>
    parseArgs({ args, options: { file: { type: "string" } }, allowPositionals: true, strict: true }),
  );
  const [id, ...extra] = positionals;
  if (!id || extra.length) throw new UserError();
  return { id, skillMd: readFile(values.file, cwd) };
};

controlOp({
  name: "skills new",
  summary: "write a skill by hand",
  input: z.object({ id: skillIdSchema, skillMd: skillMdSchema }).strict(),
  needs: "store",
  run: ({ id, skillMd }, { s, daemon }) =>
    conflictsShown(daemon, () => {
      if (s.get("skill", id)) throw new UserError(`${id} already exists; use skills edit`);
      writeSkillMd(s, id, skillMd, null);
      return null;
    }),
  terminal: {
    usage: "skills new <name> --file SKILL.md",
    parse: (args, _stdin, cwd) => ({ input: writeWords(args, cwd) }),
    print: (_, { input }) => written(input.id),
  },
});

controlOp({
  name: "skills edit",
  summary: "replace a hand-written skill's SKILL.md",
  input: z.object({ id: skillIdSchema, skillMd: skillMdSchema, revision: z.string().max(1024).optional() }).strict(),
  needs: "store",
  run: ({ id, skillMd, revision }, { s, daemon }) =>
    conflictsShown(daemon, () =>
      s.transaction(() => {
        const current = skillRevision(s, id);
        if (current === null) throw new UserError(`No skill ${id}; use skills new`);
        writeSkillMd(s, id, skillMd, revision ?? current);
        return null;
      }),
    ),
  terminal: {
    usage: "skills edit <name> --file SKILL.md",
    parse: (args, _stdin, cwd) => ({ input: writeWords(args, cwd) }),
    print: (_, { input }) => written(input.id),
  },
});

controlOp({
  name: "skills rm",
  summary: "delete a skill from every machine",
  input: z.object({ id: z.string().min(1).max(256) }).strict(),
  needs: "store",
  run: ({ id }, { s, daemon }) =>
    conflictsShown(daemon, () => {
      if (!s.get("skill", id)) throw new UserError(`No skill ${id}`);
      deleteSkill(s, id);
      return null;
    }),
  terminal: {
    usage: "skills rm <name>",
    parse(args) {
      const [id, ...extra] = args;
      if (!id || extra.length) throw new UserError();
      return { input: { id } };
    },
    print: (_, { input }) => [`deleted ${input.id}`],
  },
});

const usedIn = (what: string, projects: string[]) =>
  projects.length ? `${what} used in ${projects.join(", ")}` : `${what} not linked to any project`;

controlOp({
  name: "skills projects",
  summary: "where the skill is linked (* = every session)",
  input: z.object({ id: z.string().min(1).max(256), change: projectChangeSchema }).strict(),
  needs: "store",
  run({ id, change }, { s }) {
    changeSkillProjects(s, id, change);
    return {
      projects: s
        .list("project")
        .filter((p) => p.skills.includes(id))
        .map((p) => p.id),
    };
  },
  terminal: {
    usage: "skills projects <name> [<owner/repo|*> ...]",
    parse(args) {
      const [id, ...projects] = args;
      if (!id) throw new UserError();
      return { input: { id, change: { projects } } };
    },
    print: ({ projects }, { input }) => [usedIn(`${input.id} is`, projects)],
  },
});

controlOp({
  name: "skills update",
  summary: "fetch a skill's source again; with no name, every skill and connected repository",
  input: z.object({ id: z.string().min(1).max(256).optional() }).strict(),
  needs: "store",
  run: ({ id }, { s, daemon }) =>
    conflictsShown(daemon, async () => {
      const fetch = daemon?.imports.fetchFresh ?? fetchSkills;
      const signal = daemon?.abort.signal;
      if (id) return [{ name: id, outcome: outcome(await updateSkill(s, id, fetch, signal)) }];
      const skills = (await updateSkills(s, fetch, signal)).map((r) => ({ name: r.id, outcome: r.outcome }));
      return [
        ...skills,
        ...(await syncRepos(
          s,
          skillRepoSummaries(s).map((r) => r.url),
          signal,
        )),
      ];
    }),
  terminal: {
    usage: "skills update [<name>]",
    parse(args) {
      const [id, ...extra] = args;
      if (extra.length) throw new UserError();
      return { input: { id } };
    },
    print: outcomes,
  },
});

controlOp({
  name: "skills repo add",
  summary: "keep a public repository's .claude/skills and .agents/skills in sync",
  input: z.object({ url: repoSchema, projects: z.array(projectIdSchema).max(5000) }).strict(),
  needs: "store",
  async run({ url, projects }, { s, daemon }) {
    const connected = await connectSkillRepo(s, url, projects, undefined, daemon?.abort.signal);
    return skillRepoSummaries(s).find((r) => r.url === connected)!;
  },
  terminal: {
    usage: "skills repo add <github-url> --project <owner/repo|*> ...",
    parse(args) {
      const { values, positionals } = read(() =>
        parseArgs({
          args,
          options: { project: { type: "string", multiple: true } },
          allowPositionals: true,
          strict: true,
        }),
      );
      const [url, ...extra] = positionals;
      if (!url || extra.length) throw new UserError();
      if (!values.project?.length)
        throw new UserError("Choose where its skills go: --project '*' for every session, or --project owner/repo");
      return { input: { url, projects: values.project } };
    },
    print: (r) => [
      `connected ${r.url}: ${r.skills.join(", ") || "no skills installed"}`,
      ...r.skipped.map((reason) => `skipped: ${reason}`),
    ],
  },
});

controlOp({
  name: "skills repo sync",
  summary: "check connected repositories for new commits now",
  input: z.object({ url: repoSchema.optional() }).strict(),
  needs: "store",
  async run({ url }, { s, daemon }) {
    if (!url)
      return syncRepos(
        s,
        skillRepoSummaries(s).map((r) => r.url),
        daemon?.abort.signal,
      );
    const repo = repoUrl(url);
    return [{ name: repo, outcome: outcome(await syncSkillRepo(s, repo, undefined, daemon?.abort.signal)) }];
  },
  terminal: {
    usage: "skills repo sync [<url>]",
    parse(args) {
      const [url, ...extra] = args;
      if (extra.length) throw new UserError();
      return { input: { url } };
    },
    print: outcomes,
  },
});

controlOp({
  name: "skills repo projects",
  summary: "where a connected repository's skills are linked; disconnecting is skills repo rm",
  input: z.object({ url: repoSchema, change: projectChangeSchema }).strict(),
  needs: "store",
  run({ url, change }, { s }) {
    return { projects: changeSkillRepoProjects(s, url, change) };
  },
  terminal: {
    usage: "skills repo projects <url> <owner/repo|*> ...",
    parse(args) {
      const [url, ...projects] = args;
      if (!url || !projects.length) throw new UserError();
      return { input: { url, change: { projects } } };
    },
    print: ({ projects }, { input }) => [usedIn(`${repoUrl(input.url)}'s skills are`, projects)],
  },
});

controlOp({
  name: "skills repo rm",
  summary: "disconnect a repository; its skills are removed from every machine",
  input: z.object({ url: repoSchema }).strict(),
  needs: "store",
  run({ url }, { s }) {
    setSkillRepoProjects(s, url, []);
    return null;
  },
  terminal: {
    usage: "skills repo rm <url>",
    parse(args) {
      const [url, ...extra] = args;
      if (!url || extra.length) throw new UserError();
      return { input: { url } };
    },
    print: (_, { input }) => [`disconnected ${repoUrl(input.url)}; its skills were removed`],
  },
});

controlOp({
  name: "skills resolve",
  summary: "link Agentgate's copy where a skill folder clashes (the old one moves to a backup), or keep that one",
  input: z.object({ path: z.string().min(1).max(4096), use: z.enum(["agentgate", "keep"]) }).strict(),
  needs: "daemon",
  run({ path, use }, { daemon }) {
    if (!daemon) throw new UserError("agentgate is not running");
    if (!daemon.skills.conflicts().includes(path) && !daemon.skills.kept().includes(path))
      throw new UserError(`${path} is not a skill that clashes with Agentgate's`);
    return { backup: daemon.skills.resolveConflict(path, use) };
  },
  terminal: {
    usage: "skills resolve <path> agentgate|keep",
    parse(args, _stdin, cwd) {
      const [path, use, ...extra] = args;
      if (!path || (use !== "agentgate" && use !== "keep") || extra.length) throw new UserError();
      return { input: { path: absolute(path, cwd), use } };
    },
    print: ({ backup }, { input }) => [
      backup ? `Linked Agentgate's copy; the old one is in ${backup}` : `Kept ${input.path}; Agentgate leaves it alone`,
    ],
  },
});
