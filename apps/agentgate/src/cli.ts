#!/usr/bin/env bun
import { homedir, hostname } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { providerLogins } from "./llm/providers.ts";
import { patchSettings, revision, checkRevision } from "./configuration.ts";
import { modelPolicySchema } from "@agentgate/protocol";
import { fetchHeaders, readBody } from "./runtime.ts";
import { accountStatus, relevant } from "./llm/pool.ts";
import { aliasesFor, connect, listAllTools, needsLogin, renameInstance } from "./mcp/gateway.ts";
import { startLogin } from "./mcp/oauth.ts";
import { presets } from "./mcp/templates.ts";
import { exportBackup, importBackup, LOCAL_URL, schemas, store, type Store } from "./store.ts";
import { join, lastSeen, pairCode, peers, tailscale, unpair } from "./sync.ts";
import { cleanupRelay, createRelay, joinRelay, leaveRelay, reconcileRelay, relayNodes, relayStatus, rotateRelay, setServiceKey, usesRelay, via } from "./relay.ts";

import { createInstance, deleteAccount, deleteInstance, saveProject, setAccount } from "./operations.ts";

const HELP = `agentgate — pooled Claude/Codex subscriptions and per-repo MCP servers, shared over Tailscale or a relay

  init [--always-on] [--name srv]             create the store, name this node
  serve                                       run the daemon in the foreground
  status                                      quota bars, active accounts, nodes
  login claude|codex [--label work]           log in in a temporary dir and import it
  import claude|codex --from <dir> [--label]  take over an existing login
  accounts [enable|disable|pin|unpin|rm|exhaust] <id> [minutes]
  accounts quota|verify|models|refresh|reset-cooldown <id> [...] (daemon operations)
  accounts verify <id> --probe --model <model>  quota-consuming inference check
  accounts policy <id> --file policy.json    revision-safe account policy edit
  settings show | set --file patch.json      revision-safe partial settings edit
  proxy route <claude|codex> [--model <id>]   explain selection without sending traffic
  proxy capabilities                         daemon version and provider features
  requests [<request-id>|export] [--provider|--account|--model|--outcome|--failure|--search]
                                             structured local request diagnostics
  mcp                                         (the stdio shim, started by Claude Code / Codex)
  mcp add <name> <url|preset> [--header "Name: value" ...]
  mcp add <name> --command "npx -y …" [--per-session]
  mcp login <name> | rename <name> <new> | ls | presets | test <name> | rm <name>
  skills find <query>                         search skills.sh
  skills add <owner/repo|url|folder> [--skill <name>] [--project <owner/repo|*> ...]
  skills new|edit <name> --file SKILL.md      write a skill by hand
  skills [ls] | show <name> | update [name] | rm <name>
  skills projects <name> [<owner/repo|*> ...] where the skill is linked (* = every session)
  skills prepare [checkout] [--project <owner/repo>] register and apply links before launch
  project set <owner/repo|*> <alias>=<instance> [...]   (alias= removes)
  project ls | show <owner/repo> | defaults <owner/repo> on|off
  pair [--tailnet | --relay [--relay-url <url>]]   print the command for connecting another machine
  join <url> <code> | join agr1.… [--force]   connect to a paired machine (Tailscale) or a relay group
  nodes | unpair <node>
  relay status | reconcile | rotate | leave [--wipe] | cleanup [--abandon] | key <value>|--clear
  setup                                       write Claude/Codex config, print the T3 settings
  setup --primary [off]                       route your normal ~/.claude and ~/.codex through agentgate
  setup --mcp [off]                           only add agentgate's MCP servers to Claude Code (and Claude Desktop's Code tab)
  desktop                                     Claude Desktop: mode, account in use, saved logins (macOS)
  desktop add [email] | use <account> | capture | forget <account>
  desktop gateway on|off                      Desktop's Code tab uses the pool (no Chat, separate profile)
  service install|start|stop|logs
  export [--no-secrets] > backup.json | import-backup backup.json
  admin-token                                 print the token for native app control over the tailnet`;

const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const { values: opts, positionals: pos } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  strict: false,
  options: {
    name: { type: "string" },
    model: { type: "string" }, provider: { type: "string" }, account: { type: "string" }, outcome: { type: "string" }, failure: { type: "string" }, search: { type: "string" }, since: { type: "string" }, until: { type: "string" }, limit: { type: "string" }, cursor: { type: "string" }, probe: { type: "boolean" },
    "always-on": { type: "boolean" },
    label: { type: "string" },
    from: { type: "string" },
    header: { type: "string", multiple: true },
    command: { type: "string" },
    "per-session": { type: "boolean" },
    "no-secrets": { type: "boolean" },
    primary: { type: "boolean" },
    mcp: { type: "boolean" },
    skill: { type: "string" },
    project: { type: "string", multiple: true },
    file: { type: "string" },
    tailnet: { type: "boolean" },
    relay: { type: "boolean" },
    "relay-url": { type: "string" },
    force: { type: "boolean" },
    wipe: { type: "boolean" },
    abandon: { type: "boolean" },
    clear: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});
const str = (k: string) => opts[k] as string | undefined;
const kv = (list: unknown) => Object.fromEntries(((list as string[] | undefined) ?? []).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));

const [cmd, sub, ...rest] = pos;
async function management<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const signal = AbortSignal.timeout(100000);
  const res = await fetchHeaders(`${LOCAL_URL}/api${path}`, { method, signal, redirect: "manual", headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, 100000);
  const result = JSON.parse(new TextDecoder().decode(await readBody(res.body, 2 * 1024 * 1024, signal)));
  if (!res.ok) throw new Error(result.error ?? "Daemon rejected the operation");
  return result;
}

function initialized(s: Store) {
  if (!s.local("node")) die("Run `agentgate init` first.");
  return s;
}

const bar = (pct: number) => {
  const n = Math.round(Math.min(100, pct) / 5);
  return `${"█".repeat(n)}${"░".repeat(20 - n)} ${Math.round(pct)}%`;
};
const mins = (t?: number) => (t ? `${Math.max(0, Math.round((t - Date.now()) / 60_000))} min` : "?");

async function main() {
  if (!cmd || opts.help) return console.log(HELP);

  // The shim must never block or print to stdout: it speaks MCP there.
  if (cmd === "mcp" && !sub) return (await import("./mcp/shim.ts")).runShim();

  const s = store();
  switch (cmd) {
    case "init": {
      const name = str("name") ?? s.local("node") ?? hostname().split(".")[0]!.toLowerCase();
      const old = s.local("node");
      if (old && old !== name) {
        if (peers(s).length || usesRelay(s) || s.list("credential").length || s.list("mcpCredential").length) die("cannot rename a paired node, relay member or credential holder; keep its existing name");
        s.del("node", old);
      }
      s.setLocal("node", name);
      if (!s.local("adminToken")) s.setLocal("adminToken", crypto.randomUUID().replace(/-/g, ""));
      const ts = await tailscale();
      const prev = s.get("node", name);
      s.put("node", name, { id: name, url: ts?.url ?? prev?.url, alwaysOn: !!opts["always-on"] || !!prev?.alwaysOn });
      console.log(`node ${name}${opts["always-on"] ? " (always on)" : ""}, store ${s.db.filename}`);
      console.log(ts ? `tailnet: ${ts.url}` : "Tailscale not found; the daemon will keep looking for it. Without Tailscale, connect machines with `agentgate pair --relay`.");
      return;
    }
    case "serve":
      initialized(s);
      const daemon = await (await import("./daemon.ts")).serve(s);
      let shuttingDown = false;
      const shutdown = () => { if (shuttingDown) return; shuttingDown = true; void daemon.stop().then(() => { s.close(); process.exit(0); }); };
      process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
      return;

    case "status": {
      initialized(s);
      for (const p of ["claude", "codex"] as const) {
        console.log(`\n${p}`);
        const accounts = s.list("account").filter((a) => a.provider === p);
        if (!accounts.length) console.log("  (no accounts)");
        for (const a of accounts) {
          const st = accountStatus(s, a);
          const flags = [st.active && "active", a.pinned && "pinned", !a.enabled && "disabled", st.needsLogin && "NEEDS LOGIN", st.expired && "TOKEN EXPIRED", st.refreshError && "REFRESH FAILED", st.exhausted && "exhausted"].filter(Boolean).join(", ");
          console.log(`  ${a.id}  ${a.label}${flags ? `  [${flags}]` : ""}  holder ${st.holder ?? "-"}, token expires in ${mins(st.expiresAt)}`);
          for (const w of st.windows) console.log(`    ${w.name.padEnd(10)} ${bar(w.usedPct)}  resets in ${mins(w.resetsAt)}`);
          if (!st.windows.length && !st.needsLogin) console.log("    no quota data yet (or unrecognised quota headers)");
        }
      }
      console.log("\nnodes");
      for (const n of s.list("node")) {
        const seen = lastSeen(s, n.id);
        const peer = peers(s).find((p) => p.node === n.id);
        console.log(`  ${n.id}${n.id === s.nodeId ? " (this node)" : ""}${n.alwaysOn ? " always-on" : ""}  ${n.url ?? ""}  ${n.id === s.nodeId ? "" : `last seen ${seen ? `${Math.round((Date.now() - seen) / 1000)}s ago` : "never"}, cursor ${peer?.cursor ?? "-"}${s.local(`syncError:${n.id}`) ? ", sync failed" : ""}`}`);
      }
      const relay = relayStatus(s);
      if (relay) console.log(`\nrelay ${relay.url}${relay.hosted ? " (hosted)" : ""}${relay.reconciling ? ", reconciling" : ""}${relay.rotating ? ", rotating" : ""}${relay.cleanupPending ? ", cleanup pending" : ""}${relay.pushError ? `\n  upload: ${relay.pushError}` : ""}${relay.pullError ? `\n  download: ${relay.pullError}` : ""}`);
      const up = await fetch(`${LOCAL_URL}/api/status`).then((r) => r.ok, () => false);
      console.log(`\ndaemon: ${up ? `running at ${LOCAL_URL}` : "not running (agentgate service start)"}`);
      return;
    }

    case "login":
    case "import": {
      initialized(s);
      const mod = sub === "claude" || sub === "codex" ? providerLogins[sub] : die(`${cmd} claude|codex`);
      if (cmd === "login") return console.log(`added ${await mod.login(s, str("label"))}`);
      const dir = (str("from") ?? die("--from <dir> is required")).replace(/^~/, process.env.HOME ?? "~");
      const id = await mod.importFrom(s, dir, str("label"));
      console.log(`imported ${id}`);
      console.warn(`\nWARNING: agentgate now owns this login. Stop using ${dir} directly: its CLI would refresh the token and log agentgate out.`);
      return;
    }

    case "accounts": {
      initialized(s);
      if (!sub) {
        for (const a of s.list("account")) console.log(`${a.id.padEnd(24)} ${a.provider.padEnd(6)} ${a.label}${a.enabled ? "" : " (disabled)"}${a.pinned ? " (pinned)" : ""}  priority ${a.priority}`);
        return;
      }
      const id = rest[0] ?? die(`accounts ${sub} <id>`);
      if (sub === "verify" && opts.probe) return console.log(JSON.stringify(await management(`/accounts/${encodeURIComponent(id)}/verify`, "POST", { probe: true, model: str("model") ?? die("--model is required for an inference probe") }), null, 2));
      if (["quota", "verify", "models", "refresh", "reset-cooldown"].includes(sub)) return console.log(JSON.stringify(await management("/accounts/batch", "POST", { ids: rest, action: sub }), null, 2));
      if ((sub === "enable" || sub === "disable") && rest.length > 1) return console.log(JSON.stringify(await management("/accounts/batch", "POST", { ids: rest, action: sub }), null, 2));
      if (sub === "policy") {
        const expected = revision(s, "account", id);
        const policy = modelPolicySchema.parse(await Bun.file(str("file") ?? die("--file policy.json is required")).json());
        s.transaction(() => { checkRevision(s, "account", id, expected); setAccount(s, id, { policy }); });
        return console.log("Policy saved; synchronizes to paired machines");
      }
      if (sub === "enable") setAccount(s, id, { enabled: true });
      else if (sub === "disable") setAccount(s, id, { enabled: false });
      else if (sub === "pin") setAccount(s, id, { pinned: true });
      else if (sub === "unpin") setAccount(s, id, { pinned: false });
      else if (sub === "priority") setAccount(s, id, { priority: Number(rest[1] ?? 0) });
      else if (sub === "rm") deleteAccount(s, id);
      else if (sub === "exhaust") {
        // Test flag (PLAN §14 phase 1): pretend this account hit its quota.
        s.get("account", id) ?? die(`no account ${id}`);
        const until = Date.now() + Number(rest[1] ?? 60) * 60_000;
        s.put("usage", id, { accountId: id, observedAt: Date.now(), observedBy: s.nodeId, windows: [], status: "exhausted", exhaustedUntil: until, source: "manual" });
      } else die(HELP);
      return console.log("ok");
    }

    case "settings": {
      initialized(s);
      if (!sub || sub === "show") return console.log(JSON.stringify(s.settings(), null, 2));
      if (sub !== "set") die("settings show | settings set --file patch.json");
      const expected = revision(s, "setting", "settings");
      const patch = await Bun.file(str("file") ?? die("--file patch.json is required")).json();
      return console.log(JSON.stringify(patchSettings(s, patch, expected), null, 2));
    }
    case "proxy": {
      initialized(s);
      if (sub === "capabilities") { const st = await management<{ daemon: unknown }>("/status"); return console.log(JSON.stringify(st.daemon, null, 2)); }
      if (sub !== "route" || !["claude", "codex"].includes(rest[0] ?? "")) die("proxy route claude|codex [--model <id>]");
      const query = new URLSearchParams({ provider: rest[0]! }); if (str("model")) query.set("model", str("model")!);
      return console.log(JSON.stringify(await management(`/proxy/route?${query}`), null, 2));
    }
    case "requests": {
      initialized(s);
      if (sub && sub !== "export") return console.log(JSON.stringify(await management(`/requests/${encodeURIComponent(sub)}`), null, 2));
      const query = new URLSearchParams();
      for (const key of ["provider", "account", "model", "outcome", "failure", "search", "since", "until", "limit", "cursor"]) if (str(key)) query.set(key, str(key)!);
      if (sub !== "export") return console.log(JSON.stringify(await management(`/requests?${query}`), null, 2));
      query.set("limit", "100");
      for (let pages = 0; pages < 1000; pages++) {
        const page = await management<import("@agentgate/protocol").RequestPage>(`/requests?${query}`);
        for (const request of page.requests) console.log(JSON.stringify(await management(`/requests/${request.id}`)));
        if (!page.nextCursor) break;
        query.set("cursor", page.nextCursor);
      }
      return;
    }

    case "mcp": {
      initialized(s);
      if (sub === "presets") {
        for (const p of presets) console.log(`${p.id.padEnd(12)} ${p.url ?? [p.command, ...(p.args ?? [])].join(" ")}${p.note ? `  (${p.note})` : ""}`);
        return;
      }
      if (sub === "ls") {
        for (const i of s.list("mcp"))
          console.log(`${i.id.padEnd(20)} ${(i.url ?? [i.command, ...(i.args ?? [])].join(" ")).padEnd(48)} ${i.mode}${s.get("mcpCredential", i.id)?.tokens ? "  logged in" : ""}`);
        return;
      }
      if (sub === "add") {
        const [id, target] = rest;
        if (!id || (!target && !str("command"))) die('mcp add <name> <url|preset> [--header "Name: value"] | mcp add <name> --command "npx …" [--per-session]');
        const inst = createInstance(s, { id: id!, target, command: str("command"), perSession: !!opts["per-session"], headers: opts.header as string[] | undefined });
        if (inst.url) {
          const ok = await connect(inst, process.cwd(), s).then((c) => c.close().then(() => true), (e) => (needsLogin(e) ? false : die(`${id}: ${e}`)));
          if (!ok) console.log(`${id} needs a login: agentgate mcp login ${id}`);
        }
        return console.log(`added ${id}; use it with: agentgate project set <owner/repo|*> ${id}=${id}`);
      }
      if (sub === "login") {
        const id = rest[0] ?? die("mcp login <name>");
        const url = await startLogin(s, id, `${LOCAL_URL}/oauth/callback`);
        if (!url) return console.log(`${id}: logged in`);
        console.log(`Open this to log in (the daemon must be running to receive the callback):\n\n  ${url.href}\n`);
        if (process.platform === "darwin") Bun.spawn(["open", url.href]);
        return;
      }
      if (sub === "test") {
        const inst = s.get("mcp", rest[0] ?? "") ?? die(`no instance ${rest[0]}`);
        const client = await connect(inst, process.cwd(), s).catch((e) => die(needsLogin(e) ? `${inst.id} needs a login: agentgate mcp login ${inst.id}` : String(e)));
        let tools;
        try { tools = await listAllTools(client); } finally { await client.close(); }
        console.log(`${inst.id}: ${tools.length} tools`);
        for (const t of tools) console.log(`  ${t.name}`);
        return;
      }
      if (sub === "rename") {
        const [from, to] = rest;
        if (!from || !to) die("mcp rename <name> <new-name>");
        renameInstance(s, from!, to!);
        return console.log(`renamed ${from} to ${to}`);
      }
      if (sub === "rm") return deleteInstance(s, rest[0] ?? die("mcp rm <id>"));
      return die(HELP);
    }

    case "skills": {
      initialized(s);
      const sk = await import("./skills.ts");
      if (sub === "prepare") {
        const projects = (opts.project as string[] | undefined) ?? [];
        if (projects.length > 1) die("skills prepare accepts one --project");
        const path = resolve((rest[0] ?? process.cwd()).replace(/^~(?=\/|$)/, homedir()));
        const { fetchHeaders, readBody } = await import("./runtime.ts");
        const signal = AbortSignal.timeout(30_000);
        const response = await fetchHeaders(`${LOCAL_URL}/api/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, project: projects[0] }), signal });
        const result = JSON.parse(new TextDecoder().decode(await readBody(response.body, 1024 * 1024, signal))) as { checkout?: string; error?: string; errors?: { path: string; message: string }[] };
        if (!response.ok) die(result.error ?? "Could not prepare checkout");
        if (!result.checkout) die("No repository/project found. Supply --project owner/repo for a repository without an origin.");
        if (result.errors?.length) die(result.errors.map(e => `${e.path}: ${e.message}`).join("\n"));
        return console.log(`Prepared ${result.checkout}; start your session now.`);
      }
      if (sub === "find") {
        for (const r of await sk.searchSkills(rest.join(" ") || die("skills find <query>")))
          console.log(`${`${r.source}@${r.skill}`.padEnd(60)} ${r.installs} installs`);
        return;
      }
      if (!sub || sub === "ls") {
        for (const k of sk.skillSummaries(s)) {
          const where = s.list("project").filter((p) => p.skills.includes(k.id)).map((p) => p.id);
          console.log(`${k.id.padEnd(32)} ${(k.source ?? "(hand-written)").padEnd(40)} ${where.join(" ") || "(no projects)"}`);
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
      if (sub === "update" && !rest[0]) {
        for (const k of sk.skillSummaries(s).filter((k) => k.source))
          console.log(`${k.id}: ${await sk.updateSkill(s, k.id).then((changed) => (changed ? "updated" : "up to date"), (e) => `failed: ${e.message}`)}`);
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
      if (sub === "projects") { sk.setSkillProjects(s, id, rest.slice(1)); return console.log("ok"); }
      if (sub === "rm") { s.get("skill", id) ?? die(`no skill ${id}`); sk.deleteSkill(s, id); return console.log("ok"); }
      return die(HELP);
    }

    case "project": {
      initialized(s);
      if (sub === "ls") {
        for (const p of s.list("project"))
          console.log(`${p.id.padEnd(32)} ${Object.entries(p.mcp).map(([a, i]) => `${a}=${i}`).join(" ")}${p.skills.length ? `  skills: ${p.skills.join(",")}` : ""}${p.id !== "*" && !p.inheritDefaults ? "  (no * defaults)" : ""}`);
        return;
      }
      const id = rest[0] ?? die(`project ${sub} <owner/repo>`);
      if (sub === "show") {
        for (const [alias, inst] of Object.entries(aliasesFor(s, id))) console.log(`${alias.padEnd(16)} → ${inst}${s.get("mcp", inst) ? "" : "  (missing)"}`);
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
      if (sub === "rm") return s.del("project", id);
      return die(HELP);
    }

    case "pair": {
      initialized(s);
      let method = opts.tailnet ? "tailnet" : opts.relay || str("relay-url") ? "relay" : undefined;
      if (!method && process.stdin.isTTY && process.stdout.isTTY) {
        const answer = prompt("How will the other machine connect?\n  [1] Same network (Tailscale)\n  [2] Agentgate relay (any network, end-to-end encrypted)\nChoose 1 or 2:")?.trim();
        method = answer === "2" ? "relay" : answer === "1" ? "tailnet" : die("Choose 1 or 2.");
      }
      method ??= (await tailscale()) ? "tailnet" : "relay";
      if (method === "relay") {
        const invite = await createRelay(s, str("relay-url"));
        console.log(`On the other machine run:\n\n  agentgate join ${invite}\n`);
        console.log("This invite does not expire. Anyone who has it can read every account and MCP login, so share it privately.\nIf it leaks, run `agentgate relay rotate` and have every relay machine join again.");
        if (process.env.AGENTGATE_RELAY_KEY || s.local("relay:serviceKey")) console.log("This relay needs a service key: set AGENTGATE_RELAY_KEY on the other machine before joining.");
        const status = relayStatus(s);
        if (status?.pushError) console.warn(`\nUpload not finished yet: ${status.pushError}. The daemon keeps retrying.`);
        return;
      }
      const url = s.get("node", s.nodeId)?.url ?? (await tailscale())?.url ?? die("No tailnet URL; is Tailscale running? Use `agentgate pair --relay` to connect over the relay instead.");
      console.log(`On the other machine run (valid 10 minutes):\n\n  agentgate join ${url} ${pairCode(s)}\n`);
      return;
    }
    case "join": {
      initialized(s);
      if (sub?.startsWith("agr1.")) {
        await joinRelay(s, sub, !!opts.force);
        console.log(`joined the relay; ${s.list("account").length} accounts, ${s.list("mcp").length} MCP instances, ${s.list("project").length} projects`);
        return;
      }
      const [url, code] = [sub, rest[0]];
      if (!url || !code) die("join <url> <code>, or join agr1.…");
      const self = s.get("node", s.nodeId)?.url ?? (await tailscale())?.url ?? die("No tailnet URL for this node; is Tailscale running?");
      const peer = await join(s, url!, code!, self);
      console.log(`paired with ${peer}; ${s.list("account").length} accounts, ${s.list("mcp").length} MCP instances, ${s.list("project").length} projects`);
      return;
    }
    case "nodes":
      initialized(s);
      for (const p of peers(s)) console.log(`${p.node.padEnd(16)} tailscale ${p.url}  cursor ${p.cursor}  last seen ${p.last_seen ? new Date(p.last_seen).toISOString() : "never"}`);
      for (const n of relayNodes(s)) console.log(`${n.node.padEnd(16)} relay  last seen ${new Date(n.lastSeen).toISOString()}`);
      return;
    case "unpair": {
      initialized(s);
      const node = sub ?? die("unpair <node>");
      if (!via(s, node).includes("relay")) { unpair(s, node); return console.log("ok"); }
      if (peers(s).some((p) => p.node === node)) unpair(s, node);
      const rotated = await rotateRelay(s);
      console.log(`Moved this machine to a new relay secret. Every other relay machine must join again:\n\n  ${rotated.command}\n`);
      console.log(`Also remove ${node}'s Tailscale pairing from every machine you keep: rotation cannot revoke those links. If ${node} may be compromised, log in to its accounts again.`);
      if (rotated.cleanupPending) console.warn("Deleting the old relay group failed; it will be retried (agentgate relay cleanup).");
      return;
    }
    case "relay": {
      initialized(s);
      switch (sub) {
        case "status": case undefined: {
          const r = relayStatus(s);
          if (!r) return console.log("This machine does not use a relay. Connect one with `agentgate pair --relay`.");
          console.log(`relay       ${r.url}${r.hosted ? " (hosted)" : ""}\ngeneration  ${r.generation ?? "-"}\ncursor      ${r.cursor}\nuploaded    ${r.pushed} of ${s.seq()}\nstate       ${[r.reconciling && "reconciling", r.rotating && "rotation pending", r.cleanupPending && "cleanup pending"].filter(Boolean).join(", ") || "in sync"}`);
          if (r.pushError) console.log(`upload      ${r.pushError}`);
          if (r.pullError) console.log(`download    ${r.pullError}`);
          if (r.skipped) console.log(`skipped     ${r.skipped} entries could not be decrypted (agentgate relay reconcile retries them)`);
          for (const n of relayNodes(s)) console.log(`machine     ${n.node}, last seen ${new Date(n.lastSeen).toISOString()}`);
          return;
        }
        case "reconcile":
          await reconcileRelay(s);
          return console.log("reconciled");
        case "rotate": {
          const r = await rotateRelay(s);
          console.log(`New relay secret. Every other relay machine must join again:\n\n  ${r.command}\n`);
          if (r.cleanupPending) console.warn("Deleting the old relay group failed; it will be retried (agentgate relay cleanup).");
          return;
        }
        case "leave": {
          const r = await leaveRelay(s, !!opts.wipe);
          console.log(`This machine no longer uses the relay.${r.cleanupPending ? " Deleting the group failed; it will be retried (agentgate relay cleanup)." : ""}`);
          return;
        }
        case "cleanup": {
          const r = await cleanupRelay(s, !!opts.abandon);
          return console.log(r.cleanupPending ? "Some old relay groups could not be deleted yet." : "No cleanup pending.");
        }
        case "key":
          if (!opts.clear && !rest[0]) die("relay key <value> | relay key --clear");
          setServiceKey(s, opts.clear ? undefined : rest[0]);
          return console.log("ok");
        default:
          return die(HELP);
      }
    }

    case "desktop": {
      initialized(s);
      const desktop = await import("./desktop.ts");
      const st = desktop.status(s);
      if (!st.available) die("Claude Desktop is not installed on this Mac.");
      const name = (l: { label?: string; email?: string; accountUuid: string }) => l.label ?? l.email ?? l.accountUuid.slice(0, 8);
      const find = (arg?: string) => {
        const q = arg ?? die(`desktop ${sub} <account>`);
        const l = st.logins.find((l) => [l.accountId, l.label, l.email, l.accountUuid].includes(q) || l.accountUuid.startsWith(q));
        return l?.accountUuid ?? die(`No saved Claude Desktop login matches ${q}. Saved: ${st.logins.map(name).join(", ") || "none"}`);
      };
      if (!sub) {
        console.log(`Claude Desktop ${st.version ?? ""}${st.running ? "" : " (not running)"}`);
        console.log(st.mode === "pool" ? "mode: Code tab uses the pool (gateway mode)" : st.mode === "other-gateway" ? "mode: another company gateway" : `mode: signed in${st.current ? ` as ${name(st.current)}${st.current.saved ? "" : " (not saved: agentgate desktop capture)"}` : st.signedOut ? ", but signed out in Desktop" : " (no account)"}`);
        for (const l of st.logins) {
          const pct = l.accountId ? Math.max(0, ...relevant(s.get("usage", l.accountId), undefined, Date.now()).map((w) => w.usedPct)) : undefined; // windows that have reset count as 0
          console.log(`  ${st.current?.accountUuid === l.accountUuid ? "*" : " "} ${name(l).padEnd(28)} ${pct === undefined ? "not in the pool" : `${Math.round(pct)}% used`}${l.expired ? "  LOGIN EXPIRED" : l.sessionExpiresAt ? `  login valid ${Math.round((l.sessionExpiresAt - Date.now()) / 86_400_000)} days` : ""}${l.problem ? `  ${l.problem}` : ""}`);
        }
        if (st.pendingAdd) console.log("Waiting for you to sign in to Claude Desktop…");
        console.log(`MCP servers in Claude Code / Desktop's Code tab: ${st.mcp ? "on" : "off (agentgate setup --mcp)"}`);
        return;
      }
      if (sub === "capture") return console.log(`saved ${desktop.capture(s)}`);
      if (sub === "use") { await desktop.use(s, find(rest[0])); return console.log("switched; Claude Desktop is restarting"); }
      if (sub === "forget") { desktop.forget(s, find(rest[0])); return console.log("ok"); }
      if (sub === "gateway") { await desktop.gateway(s, rest[0] !== "off"); return console.log(rest[0] === "off" ? "Claude Desktop uses its own sign-in again" : "Claude Desktop's Code tab now uses the pool; keep the agentgate service running"); }
      if (sub === "add") {
        const started = Date.now();
        await desktop.add(s, rest[0]);
        console.log(`Claude Desktop restarted signed out. Sign in${rest[0] ? ` with ${rest[0]}` : " with the next account"}; this waits up to 10 minutes. Don't use Log out in Desktop: it ends saved logins.`);
        for (;;) {
          await Bun.sleep(2000);
          // The agentgate service may save it first; then this loop only reports it.
          const uuid = (await desktop.pollDesktopLogin(s)) ?? desktop.addedSince(s, started);
          if (uuid) {
            const wrong = desktop.status(s).addMismatch;
            return console.log(wrong ? `saved ${name(wrong)}, but you asked for ${wrong.expected}. Run agentgate desktop add ${wrong.expected} to connect it.` : `saved ${uuid}`);
          }
          if (!s.local("desktop:pendingAdd")) die(`Timed out waiting for the sign-in. Try again with: agentgate desktop add${rest[0] ? ` ${rest[0]}` : ""}`);
        }
      }
      return die(HELP);
    }

    case "setup": {
      const setupMod = await import("./setup.ts");
      if (opts.primary) return console.log(`${await setupMod.primary(sub !== "off")}\n${await setupMod.primaryCodex(sub !== "off")}`);
      if (opts.mcp) return console.log(await setupMod.mcp(sub !== "off"));
      return console.log(await setupMod.setup());
    }
    case "service":
      return process.exit(await (await import("./service.ts")).service(sub ?? ""));

    case "export":
      return console.log(JSON.stringify(exportBackup(s, !opts["no-secrets"]), null, 2));
    case "import-backup":
      return console.log(`restored ${importBackup(s, await Bun.file(sub ?? die("import-backup <file>")).json())} records`);
    case "admin-token":
      return console.log(initialized(s).local("adminToken"));
    default:
      die(HELP);
  }
}

main().catch((e) => die(String(e?.message ?? e)));
