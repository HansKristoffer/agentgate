/** @jsxImportSource hono/jsx */
import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Ctx, Env } from "../daemon.ts";
import { accountStatus } from "../llm/pool.ts";
import { aliasesFor, listAllTools, scanRepos, toolName } from "../mcp/gateway.ts";
import { freeId, presets } from "../mcp/templates.ts";
import { exportBackup, schemas } from "../store.ts";
import { lastSeen, peers, tailscale } from "../sync.ts";
import css from "./style.css" with { type: "text" };

import { ago, askName, Empty, Live, Meters, Panel, Post, providerName, Tag, until } from "./components.tsx";

export function registerViews(app: Hono<Env>, ctx: Ctx, page: (c: Context<Env>, path: string, body: Child, head?: { title: string; lede?: string }) => Response | Promise<Response>) {
  const { s } = ctx;
  const scanDir = () => s.local("scanDir") ?? join(homedir(), "Documents", "GitHub");
  const tilde = (p: string) => p.replace(homedir(), "~");
  app.get("/style.css", (c) => c.body(css, 200, { "content-type": "text/css" }));

  app.get("/login", (c) =>
    page(c, "/login", (
      <Panel cls="narrow">
        <form method="post" action="/login" class="field-stack">
          <label class="field">
            <span>Admin token</span>
            <input name="token" type="password" autofocus class="mono" />
            <small>On the machine itself, run <code>agentgate admin-token</code>.</small>
          </label>
          <button class="btn primary">Unlock</button>
        </form>
      </Panel>
    ), { title: "Unlock", lede: "This node's UI is reachable over your tailnet. Prove it's you." }),
  );

  app.get("/api/status", (c) =>
    c.json({
      node: s.nodeId,
      unknownQuota: Object.fromEntries((["claude", "codex"] as const).map(provider => [provider, s.local(`quotaUnknown:${provider}`)])),
      accounts: s.list("account").map((a) => accountStatus(s, a)),
      peers: peers(s).map((p) => ({ node: p.node, url: p.url, lastSeen: p.last_seen, cursor: p.cursor, error: s.local(`syncError:${p.node}`) })),
      html: String(<Live s={s} />),
    }),
  );

  app.get("/", (c) => {
    const nodes = s.list("node");
    const creds = s.list("credential");
    const insts = s.list("mcp");
    const log = s.db.query("select * from request_log where note != '' order by rowid desc limit 40").all() as { at: number; provider: string; account: string; note: string }[];
    const online = (id: string) => id === s.nodeId || Date.now() - lastSeen(s, id) < 60_000;
    const activeLabel = (p: "claude" | "codex") => s.get("account", s.local(`active:${p}`) ?? "")?.label;
    const running = insts.filter((i) => ctx.gateway.status(i.id) === "running").length;
    const toneOf = (note: string) => (/fail|invalid|needs|exhausted|429|error/i.test(note) ? "bad" : /switch|took over|waiting/i.test(note) ? "signal" : "");
    return page(c, "/", (
      <>
        <div class="stats">
          {(["claude", "codex"] as const).map((p) => (
            <div class="stat">
              <div class="stat-label"><span class={`prov ${p}`} />{providerName(p)}</div>
              <div class="stat-value">{activeLabel(p) ?? <span class="dim">idle</span>}</div>
              <div class="stat-sub">{s.list("account").filter((a) => a.provider === p).length} in pool</div>
            </div>
          ))}
          <div class="stat">
            <div class="stat-label">MCP servers</div>
            <div class="stat-value">{insts.length}</div>
            <div class="stat-sub">{running} connected now</div>
          </div>
          <div class="stat">
            <div class="stat-label">Nodes</div>
            <div class="stat-value">{nodes.filter((n) => online(n.id)).length}<span class="dim"> / {nodes.length}</span></div>
            <div class="stat-sub">online</div>
          </div>
        </div>

        <Live s={s} />
        <script dangerouslySetInnerHTML={{ __html: "setInterval(async()=>{try{const r=await fetch('/api/status');if(r.ok)document.getElementById('live').outerHTML=(await r.json()).html}catch{}},5000)" }} />

        <div class="grid-2 wide-right">
          <Panel title="Nodes" actions={<a class="btn ghost sm" href="/nodes">Manage</a>}>
            <div class="list">
              {nodes.map((n) => {
                const held = creds.filter((c) => c.holder === n.id).map((c) => s.get("account", c.accountId)?.label ?? c.accountId);
                return (
                  <div class="list-row">
                    <i class={`lamp ${online(n.id) ? "ok" : "bad"}`} />
                    <div class="grow">
                      <div class="mono strong clip">{n.id}</div>
                      <div class="dim">{n.id === s.nodeId ? "this machine" : `synced ${ago(lastSeen(s, n.id))}`}{n.alwaysOn ? " · always on" : ""}</div>
                      {held.length > 0 && <div class="dim">refreshes {held.join(", ")}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
          <Panel title="Activity" meta="Switches, refreshes and errors on this node">
            {log.length ? (
              <ol class="tape">
                {log.map((r) => (
                  <li class={toneOf(r.note)}>
                    <time class="mono">{new Date(r.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</time>
                    <span class="mono dim">{r.provider}</span>
                    <span>{r.account && <b>{s.get("account", r.account)?.label ?? r.account} </b>}{r.note}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <Empty>Quiet so far.</Empty>
            )}
          </Panel>
        </div>
      </>
    ));
  });

  app.get("/accounts", (c) => {
    const accounts = s.list("account");
    return page(c, "/accounts", (
      <>
        {(["claude", "codex"] as const).map((p) => {
          const mine = accounts.filter((a) => a.provider === p);
          return (
            <Panel
              title={<><span class={`prov ${p}`} />{providerName(p)}</>}
              meta={`${mine.length} account${mine.length === 1 ? "" : "s"}`}
              actions={
                <form method="post" action="/accounts/login" class="row tight">
                  <input type="hidden" name="provider" value={p} />
                  <input name="label" placeholder="label, e.g. work" class="sm" />
                  <button class="btn primary sm">+ Log in {providerName(p)}</button>
                </form>
              }
            >
              {mine.length ? (
                <div class="accounts">
                  {mine.map((a) => {
                    const st = accountStatus(s, a);
                    const u = `/accounts/${encodeURIComponent(a.id)}`;
                    return (
                      <div class={`account${st.active ? " is-active" : ""}${!a.enabled ? " is-off" : ""}`}>
                        <div class="account-id">
                          <div class="row tight">
                            <i class={`lamp ${st.needsLogin || st.expired || st.refreshError || st.exhausted ? "bad" : !a.enabled ? "off" : st.active ? "ok pulse" : "idle"}`} />
                            <span class="strong">{a.label}</span>
                            {a.plan && <Tag>{a.plan.replace(/^claude_/, "")}</Tag>}
                          </div>
                          {a.email && a.email !== a.label && <div class="dim">{a.email}</div>}
                          <div class="row tight" style="margin-top:.35rem">
                            {st.active && <Tag tone="signal">active</Tag>}
                            {a.pinned && <Tag>pinned</Tag>}
                            {!a.enabled && <Tag>disabled</Tag>}
                          </div>
                        </div>
                        <Meters s={s} a={a} />
                        <div class="account-side">
                          <div class="dim">
                            {st.needsLogin ? <span class="tone-bad">login expired</span> : <>token {st.holder === s.nodeId ? "refreshed here" : `refreshed by ${st.holder}`}<br />expires in {until(st.expiresAt)}</>}
                          </div>
                          <form method="post" action={`${u}/priority`} class="row tight" title="Higher wins when two accounts reset at the same time">
                            <span class="dim">priority</span>
                            <input name="priority" type="number" value={String(a.priority)} class="sm num" />
                            <button class="btn ghost sm">Set</button>
                          </form>
                        </div>
                        <div class="account-actions">
                          {st.needsLogin && <Post action="/accounts/login" fields={{ provider: p, label: a.label }} label="Log in again" cls="primary" size="sm" />}
                          <Post action={`${u}/${a.pinned ? "unpin" : "pin"}`} label={a.pinned ? "Unpin" : "Pin"} size="sm" />
                          <Post action={`${u}/${a.enabled ? "disable" : "enable"}`} label={a.enabled ? "Disable" : "Enable"} size="sm" />
                          <Post action={`${u}/rm`} label="Delete" cls="danger" size="sm" confirm={`Delete ${a.label}?`} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <Empty>No {providerName(p)} accounts. Log one in with the button above; it opens the provider's own login page.</Empty>
              )}
              <details class="fold">
                <summary>Import an existing login from a folder on this machine</summary>
                <form method="post" action="/accounts/import" class="row">
                  <input type="hidden" name="provider" value={p} />
                  <input name="dir" placeholder={p === "claude" ? "~/.claude" : "~/.codex"} class="mono grow" />
                  <input name="label" placeholder="label" />
                  <button class="btn ghost">Import</button>
                </form>
                <p class="note warn">After importing, stop using that login directly: its CLI would refresh the token and log agentgate out.</p>
              </details>
            </Panel>
          );
        })}
      </>
    ));
  });

  app.get("/servers", (c) => {
    const insts = s.list("mcp");
    const projects = s.list("project");
    const usedBy = (id: string) => projects.filter((p) => Object.values(p.mcp).includes(id)).map((p) => (p.id === "*" ? "every repo" : p.id));
    return page(c, "/servers", (
      <>
        <Panel cls="add-server">
          <form method="post" action="/servers/add" class="command">
            <span class="command-prompt mono">url</span>
            <input name="url" type="url" placeholder="https://app.example.com/api/mcp" required class="mono grow" />
            <span class="command-prompt mono">as</span>
            <input name="id" placeholder="geysier" pattern="[A-Za-z0-9][A-Za-z0-9_-]*" required class="mono name" />
            <button class="btn primary">Connect</button>
            <details class="fold full">
              <summary>Extra headers</summary>
              <textarea name="headers" rows={2} class="mono" placeholder={"x-posthog-project-id: 12345"} />
              <p class="note">Sent on every request. Pin a server to one project, or give servers that take an API key <code>Authorization: Bearer …</code>.</p>
            </details>
          </form>
          <p class="note">The name is the tool prefix the agent sees (<code>name__tool</code>). If the server needs a login, you're sent to its login page and back.</p>

          <div class="section-label mono">One click</div>
          <div class="presets">
            {presets.map((p) => (
              <form method="post" action="/servers/add" onsubmit={askName(freeId((x) => !!s.get("mcp", x), p.id))}>
                <input type="hidden" name="preset" value={p.id} />
                <input type="hidden" name="id" />
                <button class="preset" title={p.note ?? p.url}>
                  <span class="strong">{p.label}</span>
                  <span class="mono dim">{p.url ? new URL(p.url).host : "local · per session"}</span>
                </button>
              </form>
            ))}
          </div>
          <details class="fold">
            <summary>Run a local command instead</summary>
            <form method="post" action="/servers/add" class="row">
              <input name="command" placeholder="npx -y @some/mcp-server" required class="mono grow" />
              <input name="id" placeholder="name" pattern="[A-Za-z0-9][A-Za-z0-9_-]*" required class="mono" />
              <label class="check"><input type="checkbox" name="perSession" /> run inside each session's worktree</label>
              <button class="btn ghost">Add</button>
            </form>
          </details>
        </Panel>

        {insts.length ? (
          <div class="cards">
            {insts.map((i) => {
              const st = i.mode === "perSession" ? "per session" : ctx.gateway.status(i.id);
              const err = ctx.gateway.upstreams.get(i.id)?.error;
              const used = usedBy(i.id);
              const where = i.url ? i.url.replace(/^https?:\/\//, "") : [i.command, ...(i.args ?? [])].join(" ");
              const lamp = st === "running" ? "ok" : st === "error" || st === "needs login" ? "bad" : "idle";
              return (
                <article class="card">
                  <div class="card-head">
                    <div>
                      <div class="card-title mono">{i.id}<span class="dim">__</span></div>
                      <div class="dim mono clip" title={where}>{where}</div>
                    </div>
                    <span class={`status ${lamp}`}><i class={`lamp ${lamp}`} />{st}</span>
                  </div>
                  <div class="row tight wrap">
                    {s.get("mcpCredential", i.id)?.tokens && st !== "needs login" && <Tag tone="ok">logged in</Tag>}
                    {Object.keys(i.headers ?? {}).map((h) => <Tag>{h}</Tag>)}
                    {used.map((u) => <Tag tone="signal">{u}</Tag>)}
                    {!used.length && <span class="dim">Not used by any repo yet.</span>}
                  </div>
                  {err && st === "error" && <p class="note tone-bad">{err.slice(0, 180)}</p>}
                  <div class="card-actions">
                    {!used.length && <Post action="/projects/alias?project=*&back=/servers" fields={{ alias: i.id, instance: i.id }} label="Add to every repo" cls="primary" size="sm" />}
                    {i.url && (s.get("mcpCredential", i.id) || st === "needs login") && <Post action={`/servers/${i.id}/login`} label={s.get("mcpCredential", i.id)?.tokens ? "Log in again" : "Log in"} cls={st === "needs login" ? "primary" : ""} size="sm" />}
                    <Post action={`/servers/${i.id}/test`} label="Test" size="sm" />
                    <form class="inline" method="post" action={`/servers/${i.id}/rename`} onsubmit={askName(i.id)}>
                      <input type="hidden" name="id" /><button class="btn ghost sm">Rename</button>
                    </form>
                    <span class="grow" />
                    <Post action={`/servers/${i.id}/rm`} label="Delete" cls="danger" size="sm" confirm={`Delete ${i.id}? Repos using it lose these tools.`} />
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <Empty>No servers yet. Paste a URL above or pick one of the one-click servers.</Empty>
        )}
      </>
    ));
  });

  app.get("/projects", (c) => {
    const projects = s.list("project").filter((p) => p.id !== "*");
    const defaults = s.get("project", "*") ?? schemas.project.parse({ id: "*" });
    const insts = s.list("mcp");
    let found: ReturnType<typeof scanRepos> = [], scanError = "";
    try { found = scanRepos(scanDir()); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // A launchd service can't show macOS's folder-access prompt, so ~/Documents etc. just fail with EPERM.
      scanError = code === "ENOENT" ? "That folder doesn't exist." : code === "EPERM" && process.platform === "darwin"
        ? "macOS doesn't let the agentgate service read this folder. Repos are added automatically when you start a session in them, or give agentgate access: System Settings → Privacy & Security → Full Disk Access → add " + process.execPath + " (again after updates if the list comes back empty), then restart it with agentgate service install."
        : `Couldn't read this folder: ${code ?? e}`;
    }
    const pathOf = new Map(found.map((r) => [r.repo, r.path]));
    const added = new Set(projects.map((p) => p.id));
    const fresh = found.filter((r) => !added.has(r.repo));

    /** One toggle per server; changing one saves the form. */
    const Servers = ({ p, inherited }: { p: typeof defaults; inherited: Record<string, string> }) => {
      const mapped = new Map(Object.entries(p.mcp).map(([alias, id]) => [id, alias]));
      const missing = Object.entries(p.mcp).filter(([, id]) => !s.get("mcp", id));
      return (
        <form method="post" action={`/projects/servers?project=${encodeURIComponent(p.id)}`} onchange="this.submit()" class="jacks">
          <input type="hidden" name="present" value="1" />
          {insts.map((i) => {
            const alias = mapped.get(i.id);
            const viaAll = !alias && Object.values(inherited).includes(i.id);
            return (
              <label class={`jack${viaAll ? " inherited" : ""}`} title={viaAll ? "Comes from Every repo" : alias ? `Tools appear as ${alias}__…` : "Click to plug in"}>
                <input type="checkbox" name="server" value={i.id} checked={!!alias || viaAll} disabled={viaAll} />
                <i class="socket" />
                <span class="mono">{alias && alias !== i.id ? alias : i.id}</span>
                {alias && alias !== i.id && <span class="dim">→ {i.id}</span>}
                {viaAll && <span class="dim">all repos</span>}
              </label>
            );
          })}
          {missing.map(([alias, id]) => <span class="jack broken" title="This server was deleted">{alias} → {id} (missing)</span>)}
          {!insts.length && <span class="dim">No servers yet. <a href="/servers">Add one →</a></span>}
        </form>
      );
    };

    return page(c, "/projects", (
      <>
        <Panel title="Every repo" meta="Every session gets these, whatever the repo." cls="accent">
          <Servers p={defaults} inherited={{}} />
        </Panel>

        {projects.map((p) => {
          const q = encodeURIComponent(p.id);
          const inherited = p.inheritDefaults ? defaults.mcp : {};
          const path = pathOf.get(p.id);
          return (
            <Panel
              title={<span class="mono">{p.id}</span>}
              meta={<>{path ? tilde(path) : "not on this machine"}{p.seenAt && <> · last session {ago(p.seenAt)} on {p.seenOn}</>}</>}
              actions={<a class="btn ghost sm" href={`/projects/preview?project=${q}`}>Preview tools</a>}
            >
              <Servers p={p} inherited={inherited} />
              <div class="panel-foot">
                <form method="post" action={`/projects/inherit?project=${q}`} onchange="this.submit()">
                  <label class="switch"><input type="checkbox" checked={p.inheritDefaults} /><i /> Every-repo servers</label>
                </form>
                <details class="fold inline-fold">
                  <summary>Custom tool prefix</summary>
                  <form method="post" action={`/projects/alias?project=${q}`} class="row tight">
                    <input name="alias" placeholder="posthog" pattern="[A-Za-z0-9_-]+" required class="mono sm" />
                    <span class="dim">→</span>
                    <select name="instance" class="sm">{insts.map((i) => <option value={i.id}>{i.id}</option>)}</select>
                    <button class="btn ghost sm">Set</button>
                  </form>
                </details>
                <span class="grow" />
                <Post action={`/projects/rm?project=${q}`} label="Remove" cls="danger" size="sm" confirm={`Remove ${p.id}?`} />
              </div>
            </Panel>
          );
        })}

        <Panel title="Add projects" meta={scanError ? `Can't read ${tilde(scanDir())}` : `${fresh.length} repo${fresh.length === 1 ? "" : "s"} in ${tilde(scanDir())} not added yet`}>
          {scanError && <p class="dim" style="margin:0 0 .9rem">{scanError}</p>}
          <form method="post" action="/projects/scan-dir" class="command">
            <span class="command-prompt mono">scan</span>
            <input name="dir" value={tilde(scanDir())} class="mono grow" />
            <button class="btn ghost">Rescan</button>
          </form>
          {fresh.length > 0 && (
            <form method="post" action="/projects/add">
              <div class="row" style="margin:.9rem 0 .6rem">
                <input type="search" placeholder="Filter repos" class="grow"
                  oninput="for (const l of this.form.querySelectorAll('.repo')) l.style.display = l.textContent.toLowerCase().includes(this.value.toLowerCase()) ? '' : 'none'" />
                <button type="button" class="btn ghost" onclick="for (const b of this.form.querySelectorAll('.repo')) if (b.style.display !== 'none') b.querySelector('input').checked = true">Select shown</button>
                <button class="btn primary">Add selected</button>
              </div>
              <div class="repos">
                {fresh.map((r) => (
                  <label class="repo">
                    <input type="checkbox" name="repo" value={r.repo} />
                    <span class="mono">{r.repo}</span>
                    <span class="dim clip">{tilde(r.path)}</span>
                  </label>
                ))}
              </div>
            </form>
          )}
          <form method="post" action="/projects/add" class="row" style="margin-top:.9rem">
            <span class="dim">Not on this machine?</span>
            <input name="repo" placeholder="owner/repo" pattern="[^/\s]+/[^/\s]+" required class="mono" />
            <button class="btn ghost">Add</button>
          </form>
        </Panel>
      </>
    ));
  });

  app.get("/projects/preview", async (c) => {
    const project = c.req.query("project") ?? "*";
    const rows: Child[] = [];
    for (const [alias, id] of Object.entries(aliasesFor(s, project))) {
      const inst = s.get("mcp", id);
      if (!inst) {
        rows.push(<tr><td><code>{alias}__*</code></td><td class="tone-bad">instance {id} is missing</td></tr>);
      } else if (inst.mode === "perSession") {
        rows.push(<tr><td><code>{alias}__*</code></td><td class="dim">{id} starts inside each session's worktree</td></tr>);
      } else {
        try {
          for (const t of await listAllTools(await ctx.gateway.shared(inst)))
            rows.push(<tr><td><code>{toolName(alias, t.name)}</code></td><td class="dim">{(t.description ?? "").slice(0, 160)}</td></tr>);
        } catch (e) {
          rows.push(<tr><td><code>{alias}__*</code></td><td class="tone-bad">{String(e)}</td></tr>);
        }
      }
    }
    return page(c, "/projects", (
      <Panel>
        {rows.length ? <table class="tools">{rows}</table> : <Empty>No MCP servers plugged into this repo.</Empty>}
        <p class="note"><a href="/projects">← Back to projects</a></p>
      </Panel>
    ), { title: project === "*" ? "Every repo" : project, lede: "The exact tool list a session in this repo sees." });
  });

  app.get("/nodes", async (c) => {
    const ts = await tailscale();
    const code = c.req.query("code");
    const nodes = s.list("node");
    const creds = s.list("credential");
    const joinCmd = `agentgate join ${s.get("node", s.nodeId)?.url ?? ts?.url ?? "http://<this-node>:7878"} ${code}`;
    return page(c, "/nodes", (
      <>
        {code && (
          <Panel title="Pairing code" meta="Run this on the other machine within 10 minutes." cls="accent">
            <div class="codeblock">
              <pre class="mono">{joinCmd}</pre>
              <button class="btn ghost sm" type="button" data-copy={joinCmd} onclick="navigator.clipboard.writeText(this.dataset.copy);this.textContent='Copied'">Copy</button>
            </div>
          </Panel>
        )}
        <div class="cards">
          {nodes.map((n) => {
            const peer = peers(s).find((p) => p.node === n.id);
            const self = n.id === s.nodeId;
            const on = self || Date.now() - lastSeen(s, n.id) < 60_000;
            const held = creds.filter((c) => c.holder === n.id).length;
            return (
              <article class="card">
                <div class="card-head">
                  <div>
                    <div class="card-title mono">{n.id}</div>
                    <div class="dim mono clip">{n.url ?? "no tailnet address yet"}</div>
                  </div>
                  <span class={`status ${on ? "ok" : "bad"}`}><i class={`lamp ${on ? "ok" : "bad"}`} />{on ? "online" : "offline"}</span>
                </div>
                <dl class="facts">
                  <div><dt>Role</dt><dd>{self ? "this machine" : "peer"}{n.alwaysOn ? " · always on" : ""}</dd></div>
                  <div><dt>Last sync</dt><dd>{self ? "—" : ago(lastSeen(s, n.id))}</dd></div>
                  <div><dt>Refreshes</dt><dd>{held} login{held === 1 ? "" : "s"}</dd></div>
                  {peer && <div><dt>Cursor</dt><dd class="mono">{peer.cursor}</dd></div>}
                </dl>
                <div class="card-actions">
                  <Post action={`/nodes/${encodeURIComponent(n.id)}/always-on`} label={n.alwaysOn ? "Unset always on" : "Set always on"} size="sm" />
                  <span class="grow" />
                  {peer && <Post action={`/nodes/${encodeURIComponent(n.id)}/unpair`} label="Unpair" cls="danger" size="sm" confirm={`Unpair ${n.id}?`} />}
                </div>
              </article>
            );
          })}
          <article class="card add-card">
            <div>
              <div class="strong">Add a machine</div>
              <p class="dim">Creates a one-time code. The other machine joins over Tailscale and copies everything.</p>
            </div>
            <Post action="/nodes/pair" label="Pair a new machine" cls="primary" />
          </article>
        </div>
        <Panel title="Setup for this machine" meta="Writes the Claude Code and Codex config here and shows the T3 Code settings." actions={<Post action="/nodes/setup" label="Run setup" size="sm" />} />
      </>
    ));
  });

  app.get("/settings", (c) => {
    const st = s.settings();
    return page(c, "/settings", (
      <>
        <Panel title="Switching">
          <form method="post" action="/settings" class="settings">
            <label class="setting">
              <div><b>Switch at</b><p class="dim">Move to the next account once any quota window of the current one reaches this share.</p></div>
              <div class="row tight"><input name="threshold" type="number" min="1" max="100" value={String(st.threshold)} class="num" /><span class="dim">%</span></div>
            </label>
            <label class="setting">
              <div><b>When every account is out</b><p class="dim">Fail at once with the reset time, or hold the request until an account resets.</p></div>
              <select name="whenExhausted">
                <option value="fail" selected={st.whenExhausted === "fail"}>Fail with retry-after</option>
                <option value="wait" selected={st.whenExhausted === "wait"}>Wait (max 10 min)</option>
              </select>
            </label>
            <label class="setting">
              <div><b>Short rate limits</b><p class="dim">Retries on the same account, which keeps the prompt cache warm.</p></div>
              <input name="retryLimit" type="number" min="0" max="10" value={String(st.retryLimit)} class="num" />
            </label>
            <label class="setting">
              <div><b>Activity kept</b><p class="dim">Rows of request history on this node.</p></div>
              <input name="logRetention" type="number" min="100" value={String(st.logRetention)} class="num wide" />
            </label>
            <div class="row end"><button class="btn primary">Save</button></div>
          </form>
        </Panel>
        <Panel title="Backup" meta="Accounts, logins, servers and projects as one JSON file.">
          <div class="row wrap">
            <a class="btn ghost" href="/settings/export">Download backup</a>
            <a class="btn ghost" href="/settings/export?secrets=0">Without secrets</a>
            <span class="grow" />
            <form method="post" action="/settings/import" enctype="multipart/form-data" class="row tight">
              <input type="file" name="file" accept="application/json" required />
              <button class="btn ghost">Restore</button>
            </form>
          </div>
        </Panel>
      </>
    ));
  });

  app.get("/settings/export", (c) => {
    c.header("content-disposition", `attachment; filename="agentgate-${s.nodeId}.json"`);
    return c.json(exportBackup(s, c.req.query("secrets") !== "0"));
  });
}
