/** @jsxImportSource hono/jsx */
import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { Child } from "hono/jsx";
import { pkce } from "../credentials.ts";
import type { Ctx, Env } from "../daemon.ts";
import * as claudeLogin from "../llm/claude.ts";
import * as codexLogin from "../llm/codex.ts";
import { accountStatus } from "../llm/pool.ts";
import { aliasesFor, connect, listAllTools, needsLogin, renameInstance, scanRepos, toolName } from "../mcp/gateway.ts";
import { finishLogin, startLogin } from "../mcp/oauth.ts";
import { freeId, fromPreset, newInstance, parseHeaders, preset, presets } from "../mcp/templates.ts";
import { setup } from "../setup.ts";
import { exportBackup, importBackup, mask, schemas, type Account, type Store } from "../store.ts";
import { lastSeen, pairCode, peers, tailscale, unpair } from "../sync.ts";
import css from "./style.css" with { type: "text" };

const ago = (t?: number | null, now = Date.now()) => {
  if (!t) return "never";
  const s = Math.round((now - t) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
const until = (t?: number, now = Date.now()) => {
  if (!t) return "";
  const m = Math.max(0, Math.round((t - now) / 60_000));
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
};

/** `8h 26m`, `3d 4h`: the compact form for tight meter rows. */
const short = (t: number, now = Date.now()) => {
  const m = Math.max(0, Math.round((t - now) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
};

const PAGES = [
  { href: "/", label: "Dashboard", title: "Dashboard", lede: "Which account carries your traffic, how much quota is left, and what every machine is doing." },
  { href: "/accounts", label: "Accounts", title: "Accounts", lede: "Subscriptions in the pool. The daemon moves to the next one before a limit stops a session." },
  { href: "/servers", label: "MCP servers", title: "MCP servers", lede: "Tool servers your sessions can reach. Paste a URL; logins are handled for you." },
  { href: "/projects", label: "Projects", title: "Projects", lede: "Which servers each repo gets. The agent sees them as name__tool." },
  { href: "/nodes", label: "Nodes", title: "Nodes", lede: "Your machines. Each one runs everything on its own and syncs over Tailscale." },
  { href: "/settings", label: "Settings", title: "Settings", lede: "Switching rules and backups." },
];

const Logo = () => (
  <svg class="logo" viewBox="0 0 32 32" aria-hidden="true">
    <path d="M7 28V6M25 28V6" />
    <path d="M7 11h18M7 17h18" class="bar" />
    <circle cx="16" cy="23" r="2.2" class="dot" />
  </svg>
);

function Layout(props: { path: string; s: Store; msg?: string; head?: { title: string; lede?: string }; children: Child }) {
  const pageInfo = PAGES.find((p) => p.href === props.path);
  const head = props.head ?? pageInfo;
  const index = PAGES.findIndex((p) => p.href === props.path);
  const self = props.s.get("node", props.s.nodeId);
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{head?.title ?? "agentgate"} · agentgate</title>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body>
        <aside class="rail">
          <a href="/" class="brand"><Logo /><span>agentgate</span></a>
          <nav>
            {PAGES.map((p, i) => (
              <a href={p.href} class={props.path === p.href ? "on" : ""}>
                <span class="num">{String(i + 1).padStart(2, "0")}</span>{p.label}
              </a>
            ))}
          </nav>
          <div class="node-card">
            <div class="row tight"><i class="lamp ok" /><span class="mono">{props.s.nodeId}</span></div>
            <div class="dim">{self?.alwaysOn ? "always on" : "this machine"}{self?.url ? " · on tailnet" : ""}</div>
          </div>
        </aside>
        <main>
          {props.msg && <div class="toast" role="status">{props.msg}</div>}
          {head && (
            <header class="page-head">
              <div class="eyebrow mono">{index >= 0 ? `${String(index + 1).padStart(2, "0")} / ${PAGES[index]!.label}` : "agentgate"}</div>
              <h1>{head.title}</h1>
              {head.lede && <p class="lede">{head.lede}</p>}
            </header>
          )}
          <div class="stack">{props.children}</div>
        </main>
      </body>
    </html>
  );
}

function Post(props: { action: string; label: string; cls?: string; fields?: Record<string, string>; confirm?: string; size?: "sm" }) {
  return (
    <form class="inline" method="post" action={props.action} onsubmit={props.confirm ? `return confirm(${JSON.stringify(props.confirm)})` : undefined}>
      {Object.entries(props.fields ?? {}).map(([k, v]) => <input type="hidden" name={k} value={v} />)}
      <button class={`btn ${props.cls || "ghost"}${props.size ? ` ${props.size}` : ""}`}>{props.label}</button>
    </form>
  );
}

function Panel(props: { title?: Child; meta?: Child; actions?: Child; cls?: string; children?: Child }) {
  return (
    <section class={`panel ${props.cls ?? ""}`}>
      {(props.title || props.actions) && (
        <div class="panel-head">
          <div>
            {props.title && <h2>{props.title}</h2>}
            {props.meta && <div class="meta">{props.meta}</div>}
          </div>
          {props.actions && <div class="row">{props.actions}</div>}
        </div>
      )}
      {props.children}
    </section>
  );
}

const Empty = (props: { children: Child }) => <div class="empty">{props.children}</div>;

const Tag = (props: { children: Child; tone?: string }) => <span class={`tag ${props.tone ?? ""}`}>{props.children}</span>;

function Meters({ s, a }: { s: Store; a: Account }) {
  const st = accountStatus(s, a);
  if (st.needsLogin) return <div class="meters"><span class="tone-bad">Needs a new login</span></div>;
  if (!st.windows.length)
    return <div class="meters dim">{st.exhaustedUntil ? <span class="tone-bad">Exhausted · resets in {until(st.exhaustedUntil)}</span> : "No quota data yet. It appears after the first request."}</div>;
  return (
    <div class="meters">
      {st.windows.map((w) => {
        const pct = Math.min(100, Math.round(w.usedPct));
        const tone = pct >= 100 ? "bad" : pct >= 80 ? "warn" : "ok";
        return (
          <div class="meter-row" title={w.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString()}` : ""}>
            <span class="mono meter-name">{w.name}</span>
            <span class={`meter ${tone}`} style={`--p:${pct}`} />
            <span class="mono meter-pct">{pct}%</span>
            <span class="dim meter-reset">{w.resetsAt ? `↻ ${short(w.resetsAt)}` : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

const providerName = (p: "claude" | "codex") => (p === "claude" ? "Claude" : "Codex");

function Live({ s }: { s: Store }) {
  const accounts = s.list("account");
  return (
    <div id="live" class="grid-2">
      {(["claude", "codex"] as const).map((p) => {
        const mine = accounts.filter((a) => a.provider === p);
        const usable = mine.filter((a) => { const st = accountStatus(s, a); return a.enabled && !st.needsLogin && !st.exhausted; });
        return (
          <Panel title={<><span class={`prov ${p}`} />{providerName(p)}</>} meta={mine.length ? `${usable.length} of ${mine.length} usable` : undefined}>
            {mine.length ? (
              <div class="channels">
                {mine.map((a) => {
                  const st = accountStatus(s, a);
                  const lamp = st.needsLogin || st.exhausted ? "bad" : !a.enabled ? "off" : st.active ? "ok pulse" : "idle";
                  return (
                    <div class={`channel${st.active ? " is-active" : ""}`}>
                      <div class="channel-id">
                        <i class={`lamp ${lamp}`} />
                        <div>
                          <div class="strong">{a.label}</div>
                          <div class="row tight">
                            {st.active && <Tag tone="signal">active</Tag>}
                            {a.pinned && <Tag>pinned</Tag>}
                            {!a.enabled && <Tag>disabled</Tag>}
                          </div>
                        </div>
                      </div>
                      <Meters s={s} a={a} />
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty>No {providerName(p)} accounts yet. <a href="/accounts">Log one in →</a></Empty>
            )}
          </Panel>
        );
      })}
    </div>
  );
}

/** Ask for a server name before submitting; it becomes the tool prefix. */
const askName = (suggested: string) =>
  `const n = prompt("Name for this server. It becomes the tool prefix the agent sees (name__tool).", ${JSON.stringify(suggested)}); if (!n) return false; this.elements.namedItem("id").value = n.trim(); return true;`;

const pending = new Map<string, { provider: "claude" | "codex"; verifier: string; label?: string; at: number }>();

export function ui(ctx: Ctx) {
  const { s } = ctx;
  const app = new Hono<Env>();
  const back = (c: any, path: string, msg: string) => c.redirect(`${path}?msg=${encodeURIComponent(msg)}`);
  const page = (c: any, path: string, body: Child, head?: { title: string; lede?: string }) =>
    c.html(<Layout path={path} s={s} msg={c.req.query("msg")} head={head}>{body}</Layout>);
  const form = async (c: any) => (await c.req.parseBody()) as Record<string, string>;

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
  app.post("/login", async (c) => {
    const { token } = await form(c);
    if (!token || token !== s.local("adminToken")) return back(c, "/login", "Wrong token");
    setCookie(c, "agentgate_admin", token, { httpOnly: true, sameSite: "Strict", path: "/", maxAge: 30 * 86400 });
    return c.redirect("/");
  });

  // ---- Dashboard
  app.get("/api/status", (c) =>
    c.json({
      node: s.nodeId,
      accounts: s.list("account").map((a) => accountStatus(s, a)),
      peers: peers(s).map((p) => ({ node: p.node, url: p.url, lastSeen: p.last_seen, cursor: p.cursor })),
      html: String(<Live s={s} />),
    }),
  );

  app.get("/", (c) => {
    const nodes = s.list("node");
    const creds = s.list("credential");
    const insts = s.list("mcp");
    const log = s.db.query("select * from request_log where note != '' order by rowid desc limit 40").all() as any[];
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

  // ---- Accounts
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
                            <i class={`lamp ${st.needsLogin || st.exhausted ? "bad" : !a.enabled ? "off" : st.active ? "ok pulse" : "idle"}`} />
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

  app.post("/accounts/:id/:action{enable|disable|pin|unpin|rm|priority}", async (c) => {
    const id = c.req.param("id");
    const a = s.get("account", id);
    if (!a) return back(c, "/accounts", "No such account");
    const action = c.req.param("action");
    if (action === "rm") {
      for (const k of ["account", "credential", "usage"] as const) s.del(k, id);
      return back(c, "/accounts", `Deleted ${a.label}`);
    }
    if (action === "pin") for (const o of s.list("account")) if (o.pinned && o.provider === a.provider) s.put("account", o.id, { ...o, pinned: false });
    const patch: Partial<Account> =
      action === "enable" ? { enabled: true } : action === "disable" ? { enabled: false } : action === "pin" ? { pinned: true } : action === "unpin" ? { pinned: false } : action === "priority" ? { priority: Number((await form(c)).priority) || 0 } : {};
    s.put("account", id, { ...a, ...patch });
    return c.redirect("/accounts");
  });

  app.post("/accounts/import", async (c) => {
    const f = await form(c);
    const dir = f.dir!.replace(/^~/, process.env.HOME ?? "~");
    try {
      const id = await (f.provider === "claude" ? claudeLogin.importFrom(s, dir, f.label || undefined) : codexLogin.importFrom(s, dir, f.label || undefined));
      return back(c, "/accounts", `Imported ${id}`);
    } catch (e) {
      return back(c, "/accounts", String(e));
    }
  });

  // Native OAuth (PKCE). The provider shows a code (Claude) or redirects to a localhost URL (Codex); the user pastes it here.
  app.post("/accounts/login", async (c) => {
    const f = await form(c);
    const provider = f.provider === "codex" ? "codex" : "claude";
    const { verifier, challenge, state } = await pkce();
    for (const [k, v] of pending) if (Date.now() - v.at > 30 * 60_000) pending.delete(k);
    pending.set(state, { provider, verifier, label: f.label || undefined, at: Date.now() });
    const url = provider === "claude" ? claudeLogin.authorizeUrl(challenge, state) : codexLogin.authorizeUrl(challenge, state);
    return page(c, "/accounts", (
      <Panel cls="narrow">
        <ol class="steps">
          <li>
            <b>Sign in</b>
            <p>Open the login page and sign in with the account you want to add.</p>
            <a class="btn primary" href={url} target="_blank" rel="noreferrer">Open {provider === "claude" ? "Claude" : "ChatGPT"} login ↗</a>
          </li>
          <li>
            <b>Copy the result</b>
            <p>{provider === "claude"
              ? "At the end the page shows a code. Copy it."
              : "The browser ends on a localhost:1455 page that doesn't load. Copy that page's full address from the address bar."}</p>
          </li>
          <li>
            <b>Paste it here</b>
            <form method="post" action="/accounts/login/finish" class="row">
              <input type="hidden" name="state" value={state} />
              <input name="code" autofocus class="mono grow" placeholder={provider === "claude" ? "code#state" : "http://localhost:1455/auth/callback?code=…"} />
              <button class="btn primary">Finish</button>
            </form>
          </li>
        </ol>
      </Panel>
    ), { title: `Add a ${provider === "claude" ? "Claude" : "Codex"} account`, lede: "Three steps. The login stays with agentgate; your own CLI login is not touched." });
  });

  app.post("/accounts/login/finish", async (c) => {
    const f = await form(c);
    const p = pending.get(f.state!);
    if (!p) return back(c, "/accounts", "That login expired; start again");
    pending.delete(f.state!);
    try {
      const id = await (p.provider === "claude" ? claudeLogin.exchange(s, f.code!, p.verifier, p.label) : codexLogin.exchange(s, f.code!, p.verifier, p.label));
      return back(c, "/accounts", `Logged in ${s.get("account", id)?.label ?? id}`);
    } catch (e) {
      return back(c, "/accounts", `Login failed: ${e}`);
    }
  });

  // ---- MCP servers
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
                    {i.oauth?.tokens && st !== "needs login" && <Tag tone="ok">logged in</Tag>}
                    {Object.keys(i.headers ?? {}).map((h) => <Tag>{h}</Tag>)}
                    {used.map((u) => <Tag tone="signal">{u}</Tag>)}
                    {!used.length && <span class="dim">Not used by any repo yet.</span>}
                  </div>
                  {err && st === "error" && <p class="note tone-bad">{err.slice(0, 180)}</p>}
                  <div class="card-actions">
                    {!used.length && <Post action="/projects/alias?project=*&back=/servers" fields={{ alias: i.id, instance: i.id }} label="Add to every repo" cls="primary" size="sm" />}
                    {i.url && (i.oauth || st === "needs login") && <Post action={`/servers/${i.id}/login`} label={i.oauth?.tokens ? "Log in again" : "Log in"} cls={st === "needs login" ? "primary" : ""} size="sm" />}
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

  const callbackUrl = (c: any) => `${new URL(c.req.url).origin}/oauth/callback`;

  async function tryTools(id: string) {
    const client = await connect(s.get("mcp", id)!, process.cwd(), s);
    const tools = await listAllTools(client);
    await client.close();
    return tools;
  }

  /** Connect; when the server wants a login, send the browser to its login page. */
  async function connectOrLogin(c: any, id: string, forceLogin = false) {
    const inst = s.get("mcp", id)!;
    try {
      if (inst.url && forceLogin) throw new Error("401 login requested");
      const tools = await tryTools(id);
      return back(c, "/servers", `Connected ${id}: ${tools.length} tools`);
    } catch (e) {
      if (!inst.url || !needsLogin(e)) return back(c, "/servers", `${id}: ${e}`);
      try {
        const url = await startLogin(s, id, callbackUrl(c));
        if (url) return c.redirect(url.href);
        return back(c, "/servers", `Connected ${id}: ${(await tryTools(id)).length} tools`);
      } catch (e2) {
        return back(c, "/servers", `${id} needs a login, but it could not be started: ${e2}. If the server takes an API key, add it under Extra headers.`);
      }
    }
  }

  app.post("/servers/add", async (c) => {
    const f = await form(c);
    try {
      const p = f.preset ? preset(f.preset) : undefined;
      if (f.preset && !p) throw new Error(`unknown preset ${f.preset}`);
      const id = f.id?.trim() || (p ? freeId((x) => !!s.get("mcp", x), p.id) : "");
      if (s.get("mcp", id)) throw new Error(`${id} already exists; pick another name`);
      const inst = p
        ? fromPreset(p, id)
        : f.command
          ? newInstance({ id, command: f.command.trim().split(/\s+/)[0], args: f.command.trim().split(/\s+/).slice(1), mode: f.perSession ? "perSession" : "shared" })
          : newInstance({ id, url: f.url, headers: parseHeaders(f.headers) });
      s.put("mcp", id, inst);
      if (inst.mode === "perSession") return back(c, "/servers", `Added ${id}; it starts inside each session.`);
      return connectOrLogin(c, id);
    } catch (e) {
      return back(c, "/servers", String(e));
    }
  });

  app.post("/servers/:id/rename", async (c) => {
    const to = (await form(c)).id?.trim() ?? "";
    try {
      renameInstance(s, c.req.param("id"), to);
      return back(c, "/servers", `Renamed to ${to}; its tools are now ${to}__…`);
    } catch (e) {
      return back(c, "/servers", String(e));
    }
  });

  app.post("/servers/:id/login", (c) => (s.get("mcp", c.req.param("id")) ? connectOrLogin(c, c.req.param("id"), true) : back(c, "/servers", "No such server")));

  app.get("/oauth/callback", async (c) => {
    const { code, state, error, error_description } = c.req.query();
    if (error || !code || !state) return back(c, "/servers", `Login failed: ${error_description ?? error ?? "no code returned"}`);
    try {
      const id = await finishLogin(s, state, code);
      const tools = await tryTools(id).catch(() => undefined);
      return back(c, "/servers", `Logged in to ${id}${tools ? `: ${tools.length} tools` : ""}`);
    } catch (e) {
      return back(c, "/servers", `Login failed: ${e}`);
    }
  });

  app.post("/servers/:id/test", async (c) => {
    const id = c.req.param("id");
    if (!s.get("mcp", id)) return back(c, "/servers", "No such server");
    try {
      const tools = await tryTools(id);
      return back(c, "/servers", `${id}: ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
    } catch (e) {
      return back(c, "/servers", `${id}: ${needsLogin(e) ? "needs a login (click Log in)" : e}`);
    }
  });

  app.post("/servers/:id/rm", (c) => {
    const id = c.req.param("id");
    s.del("mcp", id);
    for (const p of s.list("project"))
      if (Object.values(p.mcp).includes(id)) s.put("project", p.id, { ...p, mcp: Object.fromEntries(Object.entries(p.mcp).filter(([, v]) => v !== id)) });
    return back(c, "/servers", `Deleted ${id}`);
  });

  // ---- Projects
  const scanDir = () => s.local("scanDir") ?? join(homedir(), "Documents", "GitHub");
  const tilde = (p: string) => p.replace(homedir(), "~");

  app.get("/projects", (c) => {
    const projects = s.list("project").filter((p) => p.id !== "*");
    const defaults = s.get("project", "*") ?? schemas.project.parse({ id: "*" });
    const insts = s.list("mcp");
    const found = scanRepos(scanDir());
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

        <Panel title="Add projects" meta={`${fresh.length} repo${fresh.length === 1 ? "" : "s"} in ${tilde(scanDir())} not added yet`}>
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

  const formAll = async (c: any) => (await c.req.parseBody({ all: true })) as Record<string, string | string[]>;
  const many = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

  app.post("/projects/scan-dir", async (c) => {
    const dir = (await form(c)).dir?.trim().replace(/^~/, homedir());
    if (dir) s.setLocal("scanDir", dir);
    return c.redirect("/projects");
  });

  app.post("/projects/add", async (c) => {
    const repos = many((await formAll(c)).repo).map((r) => r.trim()).filter((r) => /^[^/\s]+\/[^/\s]+$/.test(r));
    for (const id of repos) if (!s.get("project", id)) s.put("project", id, { id });
    return back(c, "/projects", repos.length ? `Added ${repos.length} project${repos.length === 1 ? "" : "s"}; pick their servers below.` : "Nothing selected");
  });

  /** Checked servers are mapped under their own name; a custom prefix on a server that stays checked is kept. */
  app.post("/projects/servers", async (c) => {
    const id = c.req.query("project")!;
    const selected = new Set(many((await formAll(c)).server));
    const p = s.get("project", id) ?? schemas.project.parse({ id });
    const mcp = Object.fromEntries(Object.entries(p.mcp).filter(([, inst]) => selected.has(inst) || !s.get("mcp", inst)));
    for (const inst of selected) if (!Object.values(mcp).includes(inst)) mcp[inst] = inst;
    s.put("project", id, { ...p, mcp });
    return c.redirect("/projects");
  });

  app.post("/projects/alias", async (c) => {
    const f = await form(c);
    const id = c.req.query("project") ?? f.project!;
    const p = s.get("project", id) ?? schemas.project.parse({ id });
    const mcp = { ...p.mcp };
    if (f.instance) mcp[f.alias!] = f.instance;
    else delete mcp[f.alias!];
    s.put("project", id, { ...p, mcp });
    return c.redirect(c.req.query("back") === "/servers" ? "/servers" : "/projects");
  });
  app.post("/projects/inherit", (c) => {
    const id = c.req.query("project")!;
    const p = s.get("project", id) ?? schemas.project.parse({ id });
    s.put("project", id, { ...p, inheritDefaults: !p.inheritDefaults });
    return c.redirect("/projects");
  });
  app.post("/projects/rm", (c) => {
    s.del("project", c.req.query("project")!);
    return c.redirect("/projects");
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

  // ---- Nodes
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
  app.post("/nodes/pair", (c) => c.redirect(`/nodes?code=${pairCode(s)}`));
  app.post("/nodes/:id/unpair", (c) => {
    unpair(s, c.req.param("id"));
    return back(c, "/nodes", `Unpaired ${c.req.param("id")}`);
  });
  app.post("/nodes/:id/always-on", (c) => {
    const n = s.get("node", c.req.param("id"));
    if (n) s.put("node", n.id, { ...n, alwaysOn: !n.alwaysOn });
    return c.redirect("/nodes");
  });
  app.post("/nodes/setup", async (c) =>
    page(c, "/nodes", <Panel><pre class="mono output">{await setup()}</pre></Panel>, { title: "Setup done", lede: "Paste these settings into T3 Code." }));

  // ---- Settings
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
  app.post("/settings", async (c) => {
    const f = await form(c);
    s.put("setting", "settings", { threshold: Number(f.threshold), whenExhausted: f.whenExhausted as any, retryLimit: Number(f.retryLimit), logRetention: Number(f.logRetention) });
    return back(c, "/settings", "Saved");
  });
  app.get("/settings/export", (c) => {
    c.header("content-disposition", `attachment; filename="agentgate-${s.nodeId}.json"`);
    return c.json(exportBackup(s, c.req.query("secrets") !== "0"));
  });
  app.post("/settings/import", async (c) => {
    const f = (await c.req.parseBody()).file as File;
    try {
      return back(c, "/settings", `Restored ${importBackup(s, JSON.parse(await f.text()))} records`);
    } catch (e) {
      return back(c, "/settings", `Restore failed: ${e}`);
    }
  });

  return app;
}
