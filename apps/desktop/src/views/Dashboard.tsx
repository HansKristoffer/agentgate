import { ArrowRight, Boxes, Monitor, Users } from "lucide-react";
import { Button } from "@heroui/react";
import { Badge, Empty, Panel } from "../components/ui.tsx";
import { AccountQuota } from "../features/proxy/AccountQuota.tsx";
import { TokenUsage } from "../features/proxy/TokenUsage.tsx";
import type { ViewProps } from "../types.ts";
import { outdatedNodes } from "@agentgate/protocol";
import { providerIcon, providerName } from "./utils.ts";

export function Dashboard({
  data,
  connection,
  navigate,
}: ViewProps & { navigate: (view: "accounts" | "servers" | "nodes") => void }) {
  const outdated = outdatedNodes(data.nodes);
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
      {outdated.length > 0 && (
        <Panel
          title="Machines on an older version"
          detail="Paired machines work best on the same release."
          action={
            <Button size="sm" variant="tertiary" onPress={() => navigate("nodes")}>
              Update on Machines
              <ArrowRight size={14} />
            </Button>
          }
        >
          {outdated.map((n) => (
            <div className="item" key={n.id}>
              <div className="machine-icon">
                <Monitor size={16} />
              </div>
              <div className="grow">
                <strong>{n.id}</strong>
                <small>{n.version ? `Agentgate ${n.version}` : "An older Agentgate release"}</small>
              </div>
              {!n.online && <Badge>Offline</Badge>}
            </div>
          ))}
        </Panel>
      )}
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
                {providerIcon(a.account.provider)}
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
      {data.accounts.length > 0 && <TokenUsage connection={connection} />}
    </>
  );
}
