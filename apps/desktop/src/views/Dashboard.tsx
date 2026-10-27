import { ArrowRight, Boxes, Monitor, TriangleAlert, Users } from "lucide-react";
import { Button } from "@heroui/react";
import { Badge, Empty, Panel } from "../components/ui.tsx";
import { AccountQuota } from "../features/proxy/AccountQuota.tsx";
import { TokenCalendar } from "../features/proxy/TokenCalendar.tsx";
import { TokenUsage } from "../features/proxy/TokenUsage.tsx";
import type { ViewProps } from "../types.ts";
import { accountProblem, problems, type Page } from "../attention.ts";
import { providerIcon, providerName, toolName } from "./utils.ts";

const pageTitle: Record<Page, string> = {
  accounts: "Accounts",
  servers: "MCP servers",
  skills: "Skills",
  projects: "Projects",
  nodes: "Machines",
};

export function Dashboard({ data, connection, navigate }: ViewProps & { navigate: (view: Page) => void }) {
  const issues = problems(data);
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
          <button key={stat.label} className="stat" onClick={() => navigate(stat.view)}>
            <div className="stat-top">
              <stat.icon size={16} />
              <ArrowRight size={14} />
            </div>
            <strong>{stat.value}</strong>
            <span>{stat.label}</span>
          </button>
        ))}
      </div>
      {issues.length > 0 && (
        <Panel title="Needs attention" detail="Agentgate can't fix these on its own.">
          {issues.map((p) => (
            <div className="item" key={p.key}>
              <TriangleAlert size={16} className="attention-icon" />
              <div className="grow">
                <strong>{p.title}</strong>
                {p.detail && <small>{p.detail}</small>}
              </div>
              <Button size="sm" variant="tertiary" onPress={() => navigate(p.page)}>
                {pageTitle[p.page]}
                <ArrowRight size={14} />
              </Button>
            </div>
          ))}
        </Panel>
      )}
      <Panel title="Subscription pool" detail="Your sessions use the next available account automatically.">
        {!data.accounts.length ? (
          <Empty>
            <Users size={22} />
            {data.detected.length ? (
              <>
                <strong>
                  You're signed in to {data.detected.map((d) => providerName(d.provider)).join(" and ")} on this
                  machine.
                </strong>
                <p>
                  {data.detected
                    .map((d) => d.email)
                    .filter((e, i, all) => all.indexOf(e) === i)
                    .join(", ")}
                  . Add {data.detected.length === 1 ? "it" : "them"} to the pool with one browser confirmation each.
                </p>
              </>
            ) : (
              <>
                <strong>Your pool starts with one account.</strong>
                <p>Add a Claude or Codex login to route your sessions through Agentgate.</p>
              </>
            )}
            <Button size="sm" variant="tertiary" onPress={() => navigate("accounts")}>
              {data.detected.length ? "Add to pool" : "Add an account"}
              <ArrowRight size={14} />
            </Button>
          </Empty>
        ) : (
          data.accounts.map((a) => (
            <div className="item" key={a.account.id}>
              <div className={`provider-icon ${a.account.provider}`}>{providerIcon(a.account.provider)}</div>
              <div className="grow">
                <strong>{a.account.label}</strong>
                <small>
                  {providerName(a.account.provider)} · {a.account.email ?? a.account.plan ?? "Subscription"}
                </small>
              </div>
              <Badge good={!accountProblem(a)}>
                {accountProblem(a) ?? (a.active ? `In ${toolName(a.account.provider)}` : "Ready")}
              </Badge>
              <AccountQuota account={a} />
            </div>
          ))
        )}
      </Panel>
      {data.accounts.length > 0 && <TokenCalendar connection={connection} />}
      {data.accounts.length > 0 && <TokenUsage connection={connection} />}
    </>
  );
}
