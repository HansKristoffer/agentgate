import { ArrowRight, Boxes, Monitor, Users } from "lucide-react";
import { Badge, Empty, Panel } from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { request } from "../api.ts";
import { providerName } from "./utils.ts";

export function Dashboard({
  data,
  navigate,
}: ViewProps & { navigate: (view: "accounts" | "servers" | "nodes") => void }) {
  return (
    <>
      <div className="stats">
        {[
          {
            icon: Users,
            value: data.accounts.filter((a) => a.account.enabled).length,
            label: "Enabled accounts",
            view: "accounts" as const,
          },
          {
            icon: Boxes,
            value: data.servers.length,
            label: "MCP servers",
            view: "servers" as const,
          },
          {
            icon: Monitor,
            value: data.nodes.filter((n) => n.online).length,
            label: "Machines online",
            view: "nodes" as const,
          },
        ].map((stat) => (
          <button
            key={stat.label}
            className="stat"
            onClick={() => navigate(stat.view)}
          >
            <div className="stat-top">
              <stat.icon size={19} />
              <ArrowRight size={15} />
            </div>
            <strong>{stat.value}</strong>
            <span>{stat.label}</span>
          </button>
        ))}
      </div>
      <Panel
        title="Subscription pool"
        detail="Your sessions use the next available account automatically."
      >
        {!data.accounts.length ? (
          <Empty>
            <Users size={24} />
            <strong>Your pool starts with one account.</strong>
            <p>
              Add a Claude or Codex login to route your sessions through
              Agentgate.
            </p>
            <button className="button" onClick={() => navigate("accounts")}>
              Add an account
              <ArrowRight size={14} />
            </button>
          </Empty>
        ) : (
          data.accounts.map((a) => (
            <div className="list-row" key={a.account.id}>
              <div className={`provider-icon ${a.account.provider}`}>
                {a.account.provider === "claude" ? "✳" : "◎"}
              </div>
              <div className="grow">
                <strong>{a.account.label}</strong>
                <small>
                  {providerName(a.account.provider)} ·{" "}
                  {a.account.email ?? a.account.plan ?? "Subscription"}
                </small>
              </div>
              <Badge good={a.active && !a.needsLogin && !a.expired}>
                {a.needsLogin
                  ? "Needs login"
                  : a.expired
                    ? "Token expired"
                    : a.refreshError
                      ? "Refresh failed"
                      : a.exhausted
                        ? "Exhausted"
                        : a.active
                          ? "Active"
                          : a.account.enabled
                            ? "Ready"
                            : "Disabled"}
              </Badge>
              <div className="mini-quotas">
                {a.windows.length ? (
                  a.windows.map((w) => (
                    <div key={w.name}>
                      <span>{w.name}</span>
                      <meter min={0} max={100} value={w.usedPct} />
                      <small>{Math.round(w.usedPct)}%</small>
                    </div>
                  ))
                ) : (
                  <small>No quota data yet</small>
                )}
              </div>
            </div>
          ))
        )}
      </Panel>
      <div className="columns">
        <Panel
          title="Machines"
          action={
            <button className="text-button" onClick={() => navigate("nodes")}>
              Manage
              <ArrowRight size={14} />
            </button>
          }
        >
          {data.nodes.map((n) => (
            <div className="list-row" key={n.id}>
              <span className={`dot ${n.online ? "online" : ""}`} />
              <div className="grow">
                <strong>{n.id}</strong>
                <small>
                  {n.id === data.node
                    ? "This node"
                    : n.online
                      ? "Connected"
                      : "Offline"}
                  {n.alwaysOn ? " · Always on" : ""}
                </small>
              </div>
              {n.syncError && <Badge>Sync failed</Badge>}
            </div>
          ))}
        </Panel>
        <Panel
          title="Recent activity"
          detail="Account switches, requests, and refreshes."
        >
          {data.activity.length ? (
            <div className="activity-list">
              {data.activity.slice(0, 8).map((a, i) => (
                <div className="activity-row" key={`${a.at}-${i}`}>
                  <span
                    className={`dot ${a.status > 0 && a.status < 400 ? "online" : ""}`}
                  />
                  <div className="grow">
                    <strong>
                      {a.note || `${a.provider} request · ${a.status}`}
                    </strong>
                    <small>{a.account || a.provider}</small>
                  </div>
                  <time>
                    {new Date(a.at).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
              ))}
            </div>
          ) : (
            <Empty>
              All quiet. Activity appears when your agents start working.
            </Empty>
          )}
        </Panel>
      </div>
    </>
  );
}
