import { getErrorMessage } from "hanzio";
import { realpathSync } from "node:fs";
import { relative as relativePath, resolve } from "node:path";
import { FILES_ROOT, checkoutProject, fileContent, listFiles } from "../checkout-files.ts";
import { revision } from "../configuration.ts";
import { aliasesFor } from "../mcp/gateway.ts";
import { endpointUrl, showRemote } from "../remote.ts";
import { store } from "../store.ts";
import { die, initialized, showHelp, type Run } from "./common.ts";

/** The reads of `project` and `remote`; their changes are control operations (ops/projects.ts). */
export const run: Run = async (cmd, [sub, ...rest]) => {
  const s = initialized(store());
  if (cmd === "remote") {
    if (sub === "ls" || sub === undefined) {
      for (const p of s.list("project"))
        if (p.remote)
          console.log(
            `${p.id.padEnd(24)} ${p.remote.enabled ? "on " : "off"} served by ${p.remote.servedBy.padEnd(12)} ${endpointUrl(p.remote)}${p.factoryTools ? " +factory" : ""}${p.factoryWebhook ? ` +webhook ${new URL(p.factoryWebhook).origin}` : ""}`,
          );
      return;
    }
    if (sub !== "show") return showHelp();
    const id = rest[0] ?? die("remote show @name");
    try {
      const r = showRemote(s, id);
      return console.log(
        `URL:            ${r.url}\nAuthorization:  Bearer ${r.secret}\n\nThe relay can read requests and results for this endpoint; your logins stay on your machines.`,
      );
    } catch (e) {
      return die(getErrorMessage(e));
    }
  }

  if (sub === "ls") {
    for (const p of s.list("project"))
      console.log(
        `${p.id.padEnd(32)} ${Object.entries(p.mcp)
          .map(([a, i]) => `${a}=${i}`)
          .join(
            " ",
          )}${p.skills.length ? `  skills: ${p.skills.join(",")}` : ""}${p.id !== "*" && !p.inheritDefaults ? "  (no * defaults)" : ""}`,
      );
    return;
  }
  if (sub === "files") {
    const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stderr: "ignore", timeout: 5000 });
    const top =
      git.exitCode === 0 ? git.stdout.toString().trim() : die("Run project files in a checkout of the repository");
    const [action, ...paths] = rest;
    // Paths are relative to where you are, stored relative to the checkout.
    const relative = paths.map((p) => relativePath(top, resolve(realpathSync(process.cwd()), p)));
    if (action === "cat" && relative.length === 1) {
      const { project } = await checkoutProject(s, top);
      return process.stdout.write(fileContent(s, FILES_ROOT, project, relative[0]!).content);
    }
    if (action === "ls" || action === undefined) {
      const list = await listFiles(s, FILES_ROOT, top);
      for (const f of list.files)
        console.log(
          `${f.path.padEnd(40)} ${f.stored ? (f.machine ? "this machine only" : f.updatedAt) : "not saved"}${f.listed ? "" : "  (buncargo)"}`,
        );
      if (!list.files.length)
        console.log(`no files for ${list.project}; add one with: agentgate project files add .env.local`);
      if (list.error) console.log(`not syncing: ${list.error}`);
      return;
    }
    return die("project files add|rm <path> [...] | cat <path> | set <path> [--if-sha <sha256>] | ls");
  }
  if (sub === "show") {
    const id = rest[0] ?? die("project show <owner/repo>");
    for (const [alias, inst] of Object.entries(aliasesFor(s, id)))
      console.log(`${alias.padEnd(16)} → ${inst}${s.get("mcp", inst) ? "" : "  (missing)"}`);
    // What `project set --if-revision` names to refuse a change made since.
    if (s.get("project", id)) console.log(`revision ${revision(s, "project", id)}`);
    return;
  }
  return showHelp();
};
