import {
  ConfigurationConflict,
  isVirtual,
  projectIdSchema,
  skillIdSchema,
  type ToolPreview,
} from "@agentgate/protocol";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  addFileAt,
  addFiles,
  checkoutProject,
  FILES_ROOT,
  removeFiles,
  setFileContent,
  StoreBusy,
} from "../checkout-files.ts";
import { revision } from "../configuration.ts";
import type { Ctx } from "../daemon.ts";
import { aliasesFor, canonicalProject, parseRemote, toolName } from "../mcp/gateway.ts";
import { saveProject, setFactoryWebhook } from "../operations.ts";
import { deleteProject, disableRemote, enableRemote, regenerate, rotateSecret } from "../remote.ts";
import { requireNodeProtocol, type Store } from "../store.ts";
import { asUserError, controlOp, onOff, UserError } from "./registry.ts";
import { toolList } from "./servers.ts";

/** The projects family's control operations: projects, their env files and virtual projects' endpoints. */

/** The project, file and endpoint helpers throw a plain Error whose message is meant for the caller. A system error
 * (it has a `code`) or any other class is not shown. */
const shown = <T>(fn: () => T) =>
  asUserError(fn, (e) =>
    e instanceof ConfigurationConflict ||
    e instanceof StoreBusy ||
    (e instanceof Error && e.constructor === Error && !("code" in e))
      ? e.message
      : undefined,
  );

/** A git command's output, or undefined when it fails or runs past its deadline. */
async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5000 });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return code === 0 ? out.trim() : undefined;
}

/** The checkout a path is in, as its real path. */
async function checkoutTop(path: string) {
  const top = await git(path, "rev-parse", "--show-toplevel");
  if (!top) throw new UserError(`${path} is not in a checkout of a repository`);
  return realpath(top);
}

const id = z.string().min(1).max(512);
const virtualId = z.string().min(1).max(80);
const filePath = z.string().min(1).max(4096);
/** Where a file command runs: in a checkout on the daemon's machine (`cwd`, as the CLI sends it), or for a project. */
const filesTarget = <T extends z.ZodRawShape>(shape: T) =>
  z.union([z.object({ project: projectIdSchema, ...shape }).strict(), z.object({ cwd: filePath, ...shape }).strict()]);
const paths = z.array(filePath).min(1).max(100);
/** The words' one value for `--<name> <value>`, and the words without it. */
function option(args: string[], name: string) {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return { rest: args };
  const value = args[at + 1];
  if (!value || value.startsWith("-")) throw new UserError(`--${name} needs a value`);
  return { value, rest: args.toSpliced(at, 2) };
}
/** Only for a `needs: "daemon"` operation, which the CLI never runs in its own process. */
const needsDaemon = (daemon: Ctx | undefined) => {
  if (!daemon) throw new Error("A daemon operation ran without the daemon");
  return daemon;
};
const filesRoot = (daemon: Ctx | undefined) => {
  if (!daemon) return FILES_ROOT;
  if (!daemon.files.root) throw new UserError("Env files are off in this daemon");
  return daemon.files.root;
};

/** Changes a project, creating it when new. `mcp` names only the tool prefixes to change; null removes one. */
function setProject(
  s: Store,
  f: { id: string; mcp?: Record<string, string | null>; skills?: string[]; inheritDefaults?: boolean },
  expected?: string,
) {
  return s.transaction(() => {
    const { mcp, ...fields } = f;
    const current = s.get("project", canonicalProject(s, f.id))?.mcp ?? {};
    const merged =
      mcp &&
      Object.fromEntries(
        Object.entries({ ...current, ...mcp }).filter((e): e is [string, string] => typeof e[1] === "string"),
      );
    const saved = saveProject(s, f.id, { ...fields, ...(merged && { mcp: merged }) }, expected);
    return { id: saved.id, revision: revision(s, "project", saved.id) };
  });
}

controlOp({
  name: "project set",
  summary: "map tool prefixes to servers (prefix= removes one); --if-revision <r> refuses if changed since show",
  input: z
    .object({
      id: projectIdSchema,
      mcp: z.record(z.string().max(200), z.string().max(200).nullable()).optional(),
      // Optional, so a caller that does not know skills cannot clear them.
      skills: z.array(skillIdSchema).max(5000).optional(),
      inheritDefaults: z.boolean().optional(),
      revision: z.string().length(64).optional(),
    })
    .strict(),
  needs: "store",
  async run({ revision: expected, ...f }, { s, daemon }) {
    const saved = await shown(() => setProject(s, f, expected));
    daemon?.remote.reconcile();
    return saved;
  },
  terminal: {
    usage: "project set <project> <prefix>=<server> ...",
    parse(args) {
      const { value: revision, rest } = option(args, "if-revision");
      const [project, ...pairs] = rest;
      if (!project || !pairs.length) throw new UserError();
      const mcp: Record<string, string | null> = {};
      for (const pair of pairs) {
        const [alias, server, ...extra] = pair.split("=");
        if (!alias || server === undefined || extra.length) throw new UserError(`Not a prefix=server pair: ${pair}`);
        mcp[alias] = server || null;
      }
      return { input: { id: project, mcp, ...(revision && { revision }) } };
    },
    print: (saved) => [`${saved.id} saved (revision ${saved.revision})`],
  },
});

controlOp({
  name: "project defaults",
  summary: "whether a repository also gets the Global defaults' servers",
  input: z.object({ id: projectIdSchema, on: z.boolean() }).strict(),
  needs: "store",
  async run({ id, on }, { s, daemon }) {
    const saved = await shown(() => setProject(s, { id, inheritDefaults: on }));
    daemon?.remote.reconcile();
    return { ...saved, on };
  },
  terminal: {
    usage: "project defaults <owner/repo> on|off",
    parse([project, state, ...extra]) {
      if (!project || extra.length) throw new UserError();
      return { input: { id: project, on: onOff(state) } };
    },
    print: ({ id, on }) => [on ? `${id} gets the Global defaults' servers` : `${id} leaves out the Global defaults`],
  },
});

controlOp({
  name: "project rm",
  summary: "remove a project, and a virtual project's endpoint with it",
  input: z.object({ id }).strict(),
  needs: "store",
  run({ id }, { s, daemon }) {
    if (!s.get("project", id)) throw new UserError(`No project ${id}`);
    deleteProject(s, id);
    daemon?.remote.reconcile();
    return { id };
  },
  terminal: {
    usage: "project rm <owner/repo|@name>",
    parse([project, ...extra]) {
      if (!project || extra.length) throw new UserError();
      return { input: { id: project } };
    },
    print: ({ id }) => [`removed ${id}`],
  },
});

// Local only: it links folders inside this machine's checkouts.
controlOp({
  name: "project mirroring",
  summary: "share a repository's own skills between Claude and Codex in its checkouts here",
  input: z.object({ project: projectIdSchema, on: z.boolean() }).strict(),
  needs: "daemon",
  loopbackOnly: true,
  async run({ project, on }, { s, daemon }) {
    const { skills } = needsDaemon(daemon);
    const wanted = canonicalProject(s, project).toLowerCase();
    const checkouts = Object.entries(skills.checkouts())
      .filter(([, repo]) => repo.toLowerCase() === wanted)
      .map(([path]) => path);
    if (!checkouts.length)
      throw new UserError(`No checkout of ${project} on this machine; scan its folder or open a session in it first`);
    await shown(() => {
      for (const path of checkouts) skills.setMirroring(path, on);
    });
    return { checkouts };
  },
  terminal: {
    usage: "project mirroring <owner/repo> on|off",
    parse([project, state, ...extra]) {
      if (!project || extra.length) throw new UserError();
      return { input: { project, on: onOff(state) } };
    },
    print: ({ checkouts }, { input }) => [
      `${input.on ? "Sharing" : "No longer sharing"} repository skills between Claude and Codex in:`,
      ...checkouts.map((path) => `  ${path}`),
    ],
  },
});

/** The git repositories directly inside `dir` whose origin names owner/repo, read without blocking the daemon: the
 * origin comes from `.git/config`, and only a worktree, whose `.git` is a file, asks git. */
async function scanRepos(dir: string) {
  const names = await readdir(dir).catch(() => {
    throw new UserError(`Cannot read the folder ${dir}`);
  });
  const found = await Promise.all(
    names
      .filter((name) => !name.startsWith("."))
      .map(async (name) => {
        const path = join(dir, name);
        const info = await stat(join(path, ".git")).catch(() => undefined);
        if (!info) return;
        const origin = info.isDirectory()
          ? (await readFile(join(path, ".git", "config"), "utf8").catch(() => "")).match(
              /\[remote "origin"\][^[]*?\burl\s*=\s*(.+)/,
            )?.[1]
          : await git(path, "remote", "get-url", "origin");
        const repo = origin && parseRemote(origin);
        return repo ? { repo, path, worktree: !info.isDirectory() } : undefined;
      }),
  );
  return found.filter((r) => !!r).sort((a, b) => a.path.localeCompare(b.path));
}

/** A checkout's main checkout, where its skills are linked. */
async function mainCheckout(path: string, worktree: boolean) {
  if (!worktree) return realpath(path);
  const common = await git(path, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return common && basename(common) === ".git" ? realpath(dirname(common)) : undefined;
}

controlOp({
  name: "project scan",
  summary: "find the repositories in a folder here; their checkouts get their projects' skills",
  input: z.object({ dir: filePath }).strict(),
  needs: "daemon",
  loopbackOnly: true,
  async run({ dir }, { s, daemon }) {
    const { skills } = needsDaemon(daemon);
    const found = await scanRepos(dir.replace(/^~(?=$|\/)/, homedir()));
    // Registering spawns git; a checkout already registered for its repository needs none.
    const registered = skills.checkouts();
    for (const r of found) {
      const main = await mainCheckout(r.path, r.worktree).catch(() => undefined);
      if (main && registered[main]?.toLowerCase() !== canonicalProject(s, r.repo).toLowerCase())
        skills.register(main, r.repo, false);
    }
    skills.sync();
    return { repos: found.map(({ repo, path }) => ({ repo, path })) };
  },
  terminal: {
    usage: "project scan <folder>",
    parse([dir, ...extra], _stdin, cwd) {
      if (!dir || extra.length) throw new UserError();
      return { input: { dir: dir.startsWith("~") || !cwd ? dir : resolve(cwd, dir) } };
    },
    print: ({ repos }, { input }) =>
      repos.length
        ? repos.map((r) => `${r.repo.padEnd(40)} ${r.path}`)
        : [`No repositories with a GitHub origin in ${input.dir}`],
  },
});

// Through the daemon's shared connections (`toolList`), so a preview reuses what sessions already opened.
controlOp({
  name: "project tools",
  summary: "the tools a project's sessions see",
  input: z.object({ id }).strict(),
  needs: "daemon",
  async run({ id }, { s, daemon }) {
    const ctx = needsDaemon(daemon);
    const result: ToolPreview[] = [];
    for (const [alias, server] of Object.entries(aliasesFor(s, id))) {
      const inst = s.get("mcp", server);
      if (inst?.mode === "perSession") {
        result.push({ name: `${alias}__*`, description: "Starts inside each session's worktree" });
        continue;
      }
      try {
        if (!inst) throw new Error("missing server");
        for (const t of await toolList(ctx, inst))
          if (!inst.tools || inst.tools.includes(t.name))
            result.push({ name: toolName(alias, t.name), description: t.description });
      } catch {
        result.push({ name: `${alias}__*`, error: "Could not connect; test the server or sign in again" });
      }
    }
    return result;
  },
  terminal: {
    usage: "project tools <owner/repo|*|@name>",
    parse([project, ...extra]) {
      if (!project || extra.length) throw new UserError();
      return { input: { id: project } };
    },
    print: (tools, { input }) =>
      tools.length
        ? tools.map((t) => `${t.name.padEnd(40)} ${t.error ?? t.description ?? ""}`.trimEnd())
        : [`No tools mapped to ${input.id}`],
  },
});

/** The checkout the CLI ran a file command in, its project, and the paths it was given made relative to the checkout. */
async function inCheckout(s: Store, dir: string, files: string[]) {
  const top = await checkoutTop(dir);
  const cwd = await realpath(dir);
  const { project } = await shown(() => checkoutProject(s, top));
  return { top, project, paths: files.map((p) => relative(top, resolve(cwd, p))) };
}
/** The project a file command acts on and its paths as the project lists them. */
const filesOf = (s: Store, f: { paths: string[] } & ({ project: string } | { cwd: string })) =>
  "cwd" in f ? inCheckout(s, f.cwd, f.paths) : { project: f.project, paths: f.paths };

// Local only: it reads files from this machine's checkouts.
controlOp({
  name: "project files add",
  summary: "save gitignored files (.env.local) from a checkout here for every machine",
  // With a project, the paths are absolute: the files the app picked, each checked to be in a checkout of it.
  input: filesTarget({ paths }),
  needs: "store",
  loopbackOnly: true,
  async run(f, { s, daemon }) {
    const root = filesRoot(daemon);
    if ("cwd" in f) {
      const { top, paths } = await inCheckout(s, f.cwd, f.paths);
      return { project: await shown(() => addFiles(s, root, top, paths)) };
    }
    if (!f.paths.every((p) => isAbsolute(p))) throw new UserError("Name each file by its full path");
    let project = f.project;
    for (const file of f.paths) project = await shown(() => addFileAt(s, root, f.project, file));
    return { project };
  },
  terminal: {
    usage: "project files add <path> [...]",
    parse(args, _stdin, cwd) {
      if (!args.length || !cwd) throw new UserError();
      return { input: { cwd, paths: args } };
    },
    print: ({ project }) => [`saved for ${project} on every machine`],
  },
});

controlOp({
  name: "project files rm",
  summary: "stop syncing a project's files and remove them from every machine's store",
  // With a project, the paths are the ones it lists, relative to its checkouts.
  input: filesTarget({ paths }),
  needs: "store",
  async run(f, { s, daemon }) {
    const root = filesRoot(daemon);
    const { project, paths } = await filesOf(s, f);
    return { project: await shown(() => removeFiles(s, root, project, paths)) };
  },
  terminal: {
    usage: "project files rm <path> [...]",
    parse(args, _stdin, cwd) {
      if (!args.length || !cwd) throw new UserError();
      return { input: { cwd, paths: args } };
    },
    print: ({ project }) => [`removed from ${project} on every machine`],
  },
});

// Local only: a file's contents are secrets.
controlOp({
  name: "project files set",
  summary: "replace a synced file's contents; --if-sha <sha256> refuses a newer version than cat printed",
  input: filesTarget({ path: filePath, content: z.string().max(1024 * 1024), sha256: z.string().max(64).optional() }),
  needs: "store",
  loopbackOnly: true,
  async run(f, { s, daemon }) {
    const root = filesRoot(daemon);
    const { path, content, sha256, ...target } = f;
    const { project, paths } = await filesOf(s, { ...target, paths: [path] });
    return shown(() => setFileContent(s, root, project, paths[0]!, content, sha256));
  },
  terminal: {
    usage: "project files set <path> < new-contents",
    stdin: true,
    parse(args, stdin, cwd) {
      const { value: sha256, rest } = option(args, "if-sha");
      const [path, ...extra] = rest;
      if (!path || extra.length || !cwd) throw new UserError();
      if (stdin === undefined) throw new UserError("Pipe the new contents in");
      return { input: { cwd, path, content: stdin, ...(sha256 && { sha256 }) } };
    },
    print({ project, checkouts }) {
      const followed = Object.entries(checkouts)
        .filter(([, n]) => n)
        .map(([outcome, n]) => `${n} ${outcome}`);
      return [
        `saved for ${project} on every machine${followed.length ? `; checkouts here: ${followed.join(", ")}` : ""}`,
      ];
    },
  },
});

const endpointLines = (r: { url: string; secret: string }) => [
  `URL:            ${r.url}`,
  `Authorization:  Bearer ${r.secret}`,
  "",
  "The relay can read requests and results for this endpoint; your logins stay on your machines.",
];
const virtualWords = (args: string[]) => {
  const [project, ...extra] = args;
  if (!project || extra.length) throw new UserError();
  return project;
};

// The endpoint operations that return its secret are local only.
controlOp({
  name: "remote enable",
  summary: "a public MCP endpoint for a virtual project (e.g. for Grok), or a new machine to serve it",
  input: z.object({ id: virtualId, servedBy: id.optional() }).strict(),
  needs: "store",
  loopbackOnly: true,
  async run({ id, servedBy }, { s, daemon }) {
    const endpoint = await shown(() => enableRemote(s, id, servedBy));
    daemon?.remote.reconcile();
    return endpoint;
  },
  terminal: {
    usage: "remote enable @name [--node <node>]",
    parse(args) {
      const { value: servedBy, rest } = option(args, "node");
      return { input: { id: virtualWords(rest), ...(servedBy && { servedBy }) } };
    },
    print: endpointLines,
  },
});

controlOp({
  name: "remote secret",
  summary: "a new secret for a virtual project's endpoint, at the same URL",
  input: z.object({ id: virtualId }).strict(),
  needs: "store",
  loopbackOnly: true,
  async run({ id }, { s, daemon }) {
    const endpoint = await shown(() => rotateSecret(s, id));
    daemon?.remote.reconcile();
    return endpoint;
  },
  terminal: {
    usage: "remote secret @name",
    parse: (args) => ({ input: { id: virtualWords(args) } }),
    print: endpointLines,
  },
});

controlOp({
  name: "remote regenerate",
  summary: "a new URL and secret for a virtual project's endpoint",
  input: z.object({ id: virtualId }).strict(),
  needs: "store",
  loopbackOnly: true,
  async run({ id }, { s, daemon }) {
    const endpoint = await shown(() => regenerate(s, id));
    daemon?.remote.reconcile();
    return endpoint;
  },
  terminal: {
    usage: "remote regenerate @name",
    parse: (args) => ({ input: { id: virtualWords(args) } }),
    print: endpointLines,
  },
});

controlOp({
  name: "remote disable",
  summary: "turn a virtual project's endpoint off; enable keeps its URL and secret",
  input: z.object({ id: virtualId }).strict(),
  needs: "store",
  async run({ id }, { s, daemon }) {
    await shown(() => disableRemote(s, id));
    daemon?.remote.reconcile();
    return { id };
  },
  terminal: {
    usage: "remote disable @name",
    parse: (args) => ({ input: { id: virtualWords(args) } }),
    print: ({ id }) => [`${id}'s endpoint is off`],
  },
});

/** The node protocol that keeps `factoryTools` on project records (see NODE_PROTOCOL in remote.ts). */
const FACTORY_TOOLS_PROTOCOL = 9;

/** Offers the software factory's tools on a virtual project's endpoint, or stops offering them
 * (factory/remote-tools.ts). Turning them on waits until every node keeps the field; turning them off needs no wait,
 * since a dropped field reads as off. */
export function setFactoryTools(s: Store, id: string, on: boolean) {
  return s.transaction(() => {
    if (!isVirtual(id)) throw new Error("Only virtual projects (@name) can offer the factory's tools");
    const p = s.get("project", id);
    if (!p) throw new Error(`no project ${id}`);
    if (on) requireNodeProtocol(s, FACTORY_TOOLS_PROTOCOL, "drop the factory tools setting");
    // Turning the tools off drops the webhook too: it was set for them, and turning them on again must not resume posting.
    const { factoryTools: _, factoryWebhook: __, ...rest } = p;
    return s.put("project", id, on ? { ...p, factoryTools: true } : rest);
  });
}

controlOp({
  name: "remote factory",
  summary: "let the endpoint see and steer the software factory: its board, items and tasks",
  input: z.object({ id: virtualId, on: z.boolean() }).strict(),
  needs: "store",
  async run({ id, on }, { s }) {
    await shown(() => setFactoryTools(s, id, on));
    return { id, on };
  },
  terminal: {
    usage: "remote factory @name on|off",
    parse([project, state, ...extra]) {
      if (!project || extra.length) throw new UserError();
      return { input: { id: project, on: onOff(state) } };
    },
    print: ({ id, on }) => [
      on
        ? `${id} offers the factory's tools. Anyone with its URL and secret can add tasks and approve, retry or drop items.`
        : `${id} no longer offers the factory's tools.`,
    ],
  },
});

controlOp({
  name: "remote webhook",
  summary: "post the factory's updates (items added, moved, waiting for you) to an https URL",
  input: z.object({ id: virtualId, url: z.string().max(2000).nullable() }).strict(),
  needs: "store",
  async run({ id, url }, { s }) {
    await shown(() => setFactoryWebhook(s, id, url ?? undefined));
    return { id, on: !!url };
  },
  terminal: {
    usage: "remote webhook @name <https-url>|off",
    parse([project, url, ...extra]) {
      if (!project || !url || extra.length) throw new UserError();
      return { input: { id: project, url: url === "off" ? null : url } };
    },
    print: ({ on }) => [
      on ? "The factory posts there when an item waits for you or a PR is ready." : "Updates are no longer posted.",
    ],
  },
});
