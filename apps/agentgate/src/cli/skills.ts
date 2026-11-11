import type { Status } from "@agentgate/protocol";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { LOCAL_URL, store } from "../store.ts";
import { die, initialized, management, showHelp, stringOption, type Run } from "./common.ts";

/** `skills <sub>`. */
export const run: Run = async (_cmd, [sub, ...rest], opts) => {
  const s = initialized(store());
  const str = stringOption(opts);
  const sk = await import("../skills.ts");
  if (sub === "prepare") {
    const projects = (opts.project as string[] | undefined) ?? [];
    if (projects.length > 1) die("skills prepare accepts one --project");
    const path = resolve((rest[0] ?? process.cwd()).replace(/^~(?=\/|$)/, homedir()));
    const { fetchHeaders, readBody } = await import("../runtime.ts");
    const signal = AbortSignal.timeout(30_000);
    const response = await fetchHeaders(`${LOCAL_URL}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, project: projects[0] }),
      signal,
    });
    const result = JSON.parse(new TextDecoder().decode(await readBody(response.body, 1024 * 1024, signal))) as {
      checkout?: string;
      error?: string;
      errors?: { path: string; message: string }[];
    };
    if (!response.ok) die(result.error ?? "Could not prepare checkout");
    if (!result.checkout)
      die("No repository/project found. Supply --project owner/repo for a repository without an origin.");
    if (result.errors?.length) die(result.errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
    return console.log(`Prepared ${result.checkout}; start your session now.`);
  }
  if (sub === "conflicts") {
    const st = await management<Status>("/status");
    for (const path of st.skillConflicts) console.log(`${path}  clashes with Agentgate's copy`);
    for (const path of st.skillKept) console.log(`${path}  kept; Agentgate's copy isn't linked here`);
    if (!st.skillConflicts.length && !st.skillKept.length) console.log("No skill conflicts.");
    return;
  }
  if (sub === "resolve") {
    const usage = "skills resolve <path> agentgate|keep";
    const use = rest[1] === "agentgate" || rest[1] === "keep" ? rest[1] : die(usage);
    const path = resolve((rest[0] ?? die(usage)).replace(/^~(?=\/|$)/, homedir()));
    const { backup } = await management<{ backup?: string }>("/skills/conflicts", "POST", { path, use });
    return console.log(
      backup ? `Linked Agentgate's copy; the old one is in ${backup}` : `Kept ${path}; Agentgate leaves it alone`,
    );
  }
  if (sub === "find") {
    for (const r of await sk.searchSkills(rest.join(" ") || die("skills find <query>")))
      console.log(`${`${r.source}@${r.skill}`.padEnd(60)} ${r.installs} installs`);
    return;
  }
  if (!sub || sub === "ls") {
    for (const k of sk.skillSummaries(s)) {
      const where = s
        .list("project")
        .filter((p) => p.skills.includes(k.id))
        .map((p) => p.id);
      console.log(
        `${k.id.padEnd(32)} ${(k.source ?? "(hand-written)").padEnd(40)} ${where.join(" ") || "(no projects)"}`,
      );
    }
    return;
  }
  if (sub === "add") {
    let source = rest[0] ?? die("skills add <owner/repo|url|folder> [--skill <name>] [--project <owner/repo|*>]");
    // A folder is read by the daemon's CLI process too, so make it absolute here.
    if (/^(\.{1,2}(\/|$)|~\/|\/)/.test(source)) source = resolve(source.replace(/^~(?=\/)/, homedir()));
    const projects = (opts.project as string[] | undefined) ?? [];
    const ids = sk.installSkills(s, source, await sk.fetchSkills(source, str("skill")), undefined, projects);
    console.log(`installed ${ids.join(", ")}`);
    if (!projects.length) console.log("Link it with: agentgate skills projects <name> <owner/repo|*>");
    return;
  }
  if (sub === "repo") {
    const [action, url] = rest;
    if (action === "ls" || !action) {
      for (const r of sk.skillRepoSummaries(s))
        console.log(
          `${r.url.padEnd(48)} ${r.projects.join(" ")}  ${r.skills.length} skills${r.error ? `  error: ${r.error}` : ""}${r.skipped.length ? `\n  skipped: ${r.skipped.join("\n  skipped: ")}` : ""}`,
        );
      return;
    }
    if (action === "add") {
      const connected = await sk.connectSkillRepo(
        s,
        url ?? die("skills repo add <github-url> --project <owner/repo|*>"),
        (opts.project as string[] | undefined) ??
          die("Choose where its skills go: --project '*' for every session, or --project owner/repo"),
      );
      const r = sk.skillRepoSummaries(s).find((r) => r.url === connected)!;
      console.log(
        `connected ${connected}: ${r.skills.join(", ") || "no skills installed"}${r.skipped.length ? `\nskipped: ${r.skipped.join("\nskipped: ")}` : ""}`,
      );
      return;
    }
    if (action === "sync") {
      for (const r of sk.skillRepoSummaries(s).filter((r) => !url || r.url === sk.repoUrl(url)))
        console.log(
          `${r.url}: ${await sk.syncSkillRepo(s, r.url).then(
            (changed) => (changed ? "updated" : "up to date"),
            (e) => `failed: ${e.message}`,
          )}`,
        );
      return;
    }
    if (action === "projects") {
      sk.setSkillRepoProjects(s, url ?? die("skills repo projects <url> <owner/repo|*> ..."), rest.slice(2));
      return console.log("ok");
    }
    if (action === "rm") {
      sk.setSkillRepoProjects(s, url ?? die("skills repo rm <url>"), []);
      return console.log("disconnected; its skills were removed");
    }
    return showHelp();
  }
  if (sub === "update" && !rest[0]) {
    for (const { id, outcome } of await sk.updateSkills(s)) console.log(`${id}: ${outcome}`);
    for (const r of sk.skillRepoSummaries(s))
      console.log(
        `${r.url}: ${await sk.syncSkillRepo(s, r.url).then(
          (changed) => (changed ? "updated" : "up to date"),
          (e) => `failed: ${e.message}`,
        )}`,
      );
    return;
  }
  const id = rest[0] ?? die(`skills ${sub} <name>`);
  if (sub === "new" || sub === "edit") {
    if (sub === "new" && s.get("skill", id)) die(`${id} already exists; use skills edit`);
    const revision = sk.skillRevision(s, id);
    if (sub === "edit" && revision === null) die(`no skill ${id}; use skills new`);
    sk.writeSkillMd(s, id, await Bun.file(str("file") ?? die("--file SKILL.md is required")).text(), revision);
    return console.log(`saved ${id}; link it with: agentgate skills projects ${id} <owner/repo|*>`);
  }
  if (sub === "show") {
    const k = s.get("skill", id) ?? die(`no skill ${id}`);
    console.log(`${k.id}  ${k.source ?? "(hand-written)"}\n${k.files.map((f) => `  ${f.path}`).join("\n")}\n`);
    const md = k.files.find((f) => f.path === "SKILL.md");
    if (md) console.log(Buffer.from(md.data, "base64").toString());
    return;
  }
  if (sub === "update") return console.log((await sk.updateSkill(s, id)) ? "updated" : "up to date");
  if (sub === "projects") {
    sk.setSkillProjects(s, id, rest.slice(1));
    return console.log("ok");
  }
  if (sub === "rm") {
    s.get("skill", id) ?? die(`no skill ${id}`);
    sk.deleteSkill(s, id);
    return console.log("ok");
  }
  return showHelp();
};
