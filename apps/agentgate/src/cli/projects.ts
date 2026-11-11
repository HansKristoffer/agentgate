import { getErrorMessage } from "hanzio";
import { realpathSync } from "node:fs";
import { relative as relativePath, resolve } from "node:path";
import { FILES_ROOT, addFiles, checkoutProject, fileContent, listFiles, removeFiles } from "../checkout-files.ts";
import { aliasesFor } from "../mcp/gateway.ts";
import { saveProject, setFactoryTools, setFactoryWebhook } from "../operations.ts";
import {
  deleteProject,
  disableRemote,
  enableRemote,
  endpointUrl,
  regenerate,
  rotateSecret,
  showRemote,
} from "../remote.ts";
import { schemas, store } from "../store.ts";
import { die, initialized, management, showHelp, stringOption, type Run } from "./common.ts";

/** `project` and `remote`. */
export const run: Run = async (cmd, [sub, ...rest], opts) => {
  const s = initialized(store());
  const str = stringOption(opts);
  if (cmd === "remote") {
    const printEndpoint = (r: { url: string; secret: string }) =>
      console.log(
        `URL:            ${r.url}\nAuthorization:  Bearer ${r.secret}\n\nThe relay can read requests and results for this endpoint; your logins stay on your machines.`,
      );
    if (sub === "ls" || sub === undefined) {
      for (const p of s.list("project"))
        if (p.remote)
          console.log(
            `${p.id.padEnd(24)} ${p.remote.enabled ? "on " : "off"} served by ${p.remote.servedBy.padEnd(12)} ${endpointUrl(p.remote)}${p.factoryTools ? " +factory" : ""}${p.factoryWebhook ? ` +webhook ${new URL(p.factoryWebhook).origin}` : ""}`,
          );
      return;
    }
    const id = rest[0] ?? die(`remote ${sub} @name`);
    try {
      if (sub === "enable") return printEndpoint(enableRemote(s, id, str("node")));
      if (sub === "show") return printEndpoint(showRemote(s, id));
      if (sub === "secret") return printEndpoint(rotateSecret(s, id));
      if (sub === "regenerate") return printEndpoint(regenerate(s, id));
      if (sub === "disable") {
        disableRemote(s, id);
        return console.log("ok");
      }
      if (sub === "factory") {
        const on = rest[1] === "on" ? true : rest[1] === "off" ? false : die("remote factory @name on|off");
        setFactoryTools(s, id, on);
        return console.log(
          on
            ? `${id} offers the factory's tools. Anyone with its URL and secret can add tasks and approve, retry or drop items.`
            : `${id} no longer offers the factory's tools.`,
        );
      }
      if (sub === "webhook") {
        const url = rest[1] ?? die("remote webhook @name <https-url>|off");
        setFactoryWebhook(s, id, url === "off" ? undefined : url);
        return console.log(
          url === "off"
            ? "Updates are no longer posted."
            : "The factory posts there when an item waits for you or a PR is ready.",
        );
      }
    } catch (e) {
      return die(getErrorMessage(e));
    }
    return showHelp();
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
    const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stderr: "ignore" });
    const top =
      git.exitCode === 0 ? git.stdout.toString().trim() : die("Run project files in a checkout of the repository");
    const [action, ...paths] = rest;
    // Paths are relative to where you are, stored relative to the checkout.
    const relative = paths.map((p) => relativePath(top, resolve(realpathSync(process.cwd()), p)));
    if (action === "add" && paths.length)
      return console.log(`saved for ${await addFiles(s, FILES_ROOT, top, relative)} on every machine`);
    if (action === "rm" && paths.length) {
      const { project } = await checkoutProject(s, top);
      return console.log(`removed from ${removeFiles(s, FILES_ROOT, project, relative)} on every machine`);
    }
    if ((action === "cat" || action === "set") && relative.length === 1) {
      const { project } = await checkoutProject(s, top);
      if (action === "cat") return process.stdout.write(fileContent(s, FILES_ROOT, project, relative[0]!).content);
      // Through the daemon, which follows the save into this machine's checkouts and logs it.
      const edit = { project, path: relative[0]!, content: await Bun.stdin.text(), sha256: str("if-sha") };
      const saved = await management<{ project: string; checkouts: Record<string, number> }>(
        "/projects/files/content",
        "PUT",
        edit,
      ).catch((e: Error) => die(e.message));
      const followed = Object.entries(saved.checkouts)
        .filter(([, n]) => n)
        .map(([outcome, n]) => `${n} ${outcome}`);
      return console.log(
        `saved for ${saved.project} on every machine${followed.length ? `; checkouts here: ${followed.join(", ")}` : ""}`,
      );
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
  const id = rest[0] ?? die(`project ${sub} <owner/repo>`);
  if (sub === "show") {
    for (const [alias, inst] of Object.entries(aliasesFor(s, id)))
      console.log(`${alias.padEnd(16)} → ${inst}${s.get("mcp", inst) ? "" : "  (missing)"}`);
    return;
  }
  const p = s.get("project", id) ?? schemas.project.parse({ id });
  if (sub === "set") {
    const mcp = { ...p.mcp };
    for (const pair of rest.slice(1)) {
      const [alias, inst] = pair.split("=");
      if (!alias) die(`bad mapping ${pair}`);
      if (inst) {
        if (!s.get("mcp", inst)) die(`no MCP instance ${inst}`);
        mcp[alias!] = inst;
      } else delete mcp[alias!];
    }
    saveProject(s, id, { mcp });
    return console.log("ok");
  }
  if (sub === "defaults") return void saveProject(s, id, { inheritDefaults: rest[1] !== "off" });
  if (sub === "rm") return deleteProject(s, id);
  return showHelp();
};
