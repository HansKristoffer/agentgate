/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { accountStatus } from "../llm/pool.ts";
import { type Account, type Store } from "../store.ts";

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
  if (st.expired) return <div class="meters"><span class="tone-bad">Token expired · waiting for refresh</span></div>;
  if (st.refreshError) return <div class="meters"><span class="tone-bad">Refresh failed · retrying</span></div>;
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
        const usable = mine.filter((a) => { const st = accountStatus(s, a); return a.enabled && !st.needsLogin && !st.expired && !st.exhausted; });
        return (
          <Panel title={<><span class={`prov ${p}`} />{providerName(p)}</>} meta={mine.length ? `${usable.length} of ${mine.length} usable${s.local(`quotaUnknown:${p}`) ? " · quota headers unrecognized" : ""}` : undefined}>
            {mine.length ? (
              <div class="channels">
                {mine.map((a) => {
                  const st = accountStatus(s, a);
                  const lamp = st.needsLogin || st.expired || st.refreshError || st.exhausted ? "bad" : !a.enabled ? "off" : st.active ? "ok pulse" : "idle";
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




export { ago, askName, Empty, Layout, Live, Meters, Panel, Post, providerName, Tag, until };
