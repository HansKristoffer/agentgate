import type { Status } from "@agentgate/protocol";
import type { ControlOps } from "@agentgate/protocol/control";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { controlOps, shownError } from "../ops/index.ts";
import { previewLines, sourceFrom } from "../ops/skills.ts";
import { LOCAL_URL, store, type Store } from "../store.ts";
import { die, initialized, management, showHelp, stringOption, type Run } from "./common.ts";

/**
 * Control operations called one after another through the running daemon, or all in this process when none answers
 * (like cli/ops.ts), so a preview and the install that follows it happen in the same place.
 */
function controls(s: Store) {
  let here = false;
  return async <N extends keyof ControlOps>(name: N, input: ControlOps[N]["input"]) => {
    if (!here)
      try {
        return await management<ControlOps[N]["result"]>(`/ops/${encodeURIComponent(name)}`, "POST", input);
      } catch (e) {
        if ((e as { code?: unknown } | null)?.code !== "ECONNREFUSED") throw e;
        here = true;
      }
    const op = controlOps.get(name)!;
    try {
      return (await op.run(op.input.parse(input), { s })) as ControlOps[N]["result"];
    } catch (e) {
      return die(shownError(e) || `The operation failed (${e instanceof Error ? e.name : "error"})`);
    }
  };
}

/** `skills <sub>` for what is not a control operation (ops/skills.ts): reads, `add`, and preparing a checkout. */
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
  // The same preview and audit the app shows, then the install once you agree.
  if (sub === "add") {
    const source = sourceFrom(
      rest[0] ?? die("skills add <owner/repo|url|folder> [--skill <name>] [--project <owner/repo|*> ...] [--yes]"),
    );
    const projects = (opts.project as string[] | undefined) ?? [];
    const control = controls(s);
    const preview = await control("skills preview", { source, skill: str("skill") });
    for (const line of previewLines(preview)) console.log(line);
    const ids = preview.skills.filter((k) => !k.conflict).map((k) => k.id);
    if (!ids.length) die("Nothing to install: each of these clashes with a skill you already have");
    if (!opts.yes) {
      // An agent or a script cannot answer, and its stdin may stay open and silent.
      if (!process.stdin.isTTY) die("Nothing installed. Run it again with --yes to install these.");
      if (!/^y(es)?$/i.test(prompt(`Install ${ids.join(", ")}? [y/N]`)?.trim() ?? "")) die("Nothing installed.");
    }
    const { installed } = await control("skills add", { token: preview.token, ids, projects });
    console.log(`installed ${installed.join(", ")}`);
    if (!projects.length) console.log("Link it with: agentgate skills projects <name> <owner/repo|*>");
    return;
  }
  if (sub === "repo" && (!rest[0] || rest[0] === "ls")) {
    for (const r of sk.skillRepoSummaries(s))
      console.log(
        `${r.url.padEnd(48)} ${r.projects.join(" ")}  ${r.skills.length} skills${r.error ? `  error: ${r.error}` : ""}${r.skipped.length ? `\n  skipped: ${r.skipped.join("\n  skipped: ")}` : ""}`,
      );
    return;
  }
  if (sub === "show") {
    const id = rest[0] ?? die("skills show <name>");
    const k = sk.skillDetail(s, id) ?? die(`no skill ${id}`);
    console.log(`${k.id}  ${k.source ?? "(hand-written)"}\n${k.files.map((f) => `  ${f.path}`).join("\n")}\n`);
    if (k.skillMd) console.log(k.skillMd);
    return;
  }
  return showHelp();
};
