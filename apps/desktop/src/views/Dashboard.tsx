import { ArrowRight, Boxes, Monitor, Users } from "lucide-react";
import { Button } from "@heroui/react";
import { Badge, Empty, Panel } from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { AccountQuota } from "../features/proxy/AccountQuota.tsx";
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
              <stat.icon size={16} />
              <ArrowRight size={14} />
            </div>
            <strong>{stat.value}</strong>
            <span>{stat.label}</span>
          </button>
        ))}
      </div>
      {data.metrics && <Panel title="Proxy health" detail="Completed requests retained on this daemon in the last 24 hours."><div className="item proxy-actions"><strong>{data.metrics.total} requests</strong><span>{data.metrics.succeeded} succeeded · {data.metrics.total ? Math.round(100 * data.metrics.succeeded / data.metrics.total) : 0}% success</span><span>{data.metrics.failed} failed</span><span>{data.metrics.interrupted} interrupted</span><span>{data.metrics.cancelled} cancelled</span><span>{data.metrics.fallback} account fallbacks</span><span>{data.metrics.averageHeadersMs ?? "—"} ms average to headers</span></div></Panel>}
      <Panel
        title="Subscription pool"
        detail="Your sessions use the next available account automatically."
      >
        {!data.accounts.length ? (
          <Empty>
            <Users size={22} />
            {data.detected.length ? (
              <>
                <strong>
                  You're signed in to{" "}
                  {data.detected.map((d) => providerName(d.provider)).join(" and ")}{" "}
                  on this machine.
                </strong>
                <p>
                  {data.detected.map((d) => d.email).filter((e, i, all) => all.indexOf(e) === i).join(", ")}. Add{" "}
                  {data.detected.length === 1 ? "it" : "them"} to the pool with one browser confirmation each.
                </p>
              </>
            ) : (
              <>
                <strong>Your pool starts with one account.</strong>
                <p>
                  Add a Claude or Codex login to route your sessions through
                  Agentgate.
                </p>
              </>
            )}
            <Button
              size="sm"
              variant="tertiary"
              onPress={() => navigate("accounts")}
            >
              {data.detected.length ? "Add to pool" : "Add an account"}
              <ArrowRight size={14} />
            </Button>
          </Empty>
        ) : (
          data.accounts.map((a) => (
            <div className="item" key={a.account.id}>
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
              <AccountQuota account={a} />
            </div>
          ))
        )}
      </Panel>
      <div className="columns">
        <Panel
          title="Machines"
          detail="Paired over your Tailscale network."
          action={
            <Button size="sm" variant="ghost" onPress={() => navigate("nodes")}>
              Manage
            </Button>
          }
        >
          {data.nodes.map((n) => (
            <div className="item" key={n.id}>
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
            <>
              {data.activity.slice(0, 8).map((a, i) => (
                <div className="item" key={`${a.at}-${i}`}>
                  <span
                    className={`dot ${a.status > 0 && a.status < 400 ? "online" : ""}`}
                  />
                  <div className="grow">
                    <strong>
                      {a.note || `${a.provider} request · ${a.status}`}
                    </strong>
                    <small>{a.account || a.provider}</small>
                  </div>
                  <time className="activity-time">
                    {new Date(a.at).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
              ))}
            </>
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
