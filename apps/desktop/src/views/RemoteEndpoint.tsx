import { useState } from "react";
import { Copy, Eye, EyeOff } from "lucide-react";
import { Button } from "@heroui/react";
import { confirmDialog } from "@hanskristoffer/taurio/runtime";
import type { PublicProject } from "@agentgate/protocol";
import { Badge, Choice } from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { control, request } from "../api.ts";
import { idPath, relative } from "./utils.ts";
import { useDaemon } from "../useDaemon.ts";

type Endpoint = { url: string; secret: string };

/** A virtual project's public endpoint, shown in its Projects row: what to paste into Grok, who serves it, and its controls. */
export function EndpointDetails({ project, data, connection, perform, local }: ViewProps & { project: PublicProject }) {
  const remote = project.remote;
  const [reveal, setReveal] = useState(false);
  // The secret is only ever read over a local connection, and is kept out of the app's answer cache. A secret rotated
  // elsewhere keeps the URL, so the read also follows `status`, which every project change bumps.
  const secret = useDaemon(
    local && !!remote?.enabled && (() => request<Endpoint>(connection, `/projects/remote?id=${idPath(project.id)}`)),
    { topics: ["status"], deps: [project.id, remote?.url] },
  );
  const shown = secret.data;
  const id = project.id;
  const changeEndpoint = (change: () => Promise<unknown>, message: string) =>
    perform(async () => {
      await change();
      await secret.reload();
    }, message);
  const copy = (text: string, what: string) => perform(() => navigator.clipboard.writeText(text), `${what} copied`);
  const serving = data.nodes.find((n) => n.id === remote?.servedBy);
  const statusDetail = [
    !remote?.connected &&
      (serving && !serving.online
        ? `${remote?.servedBy} is offline`
        : remote?.servedBy !== data.node
          ? `Served by ${remote?.servedBy}`
          : "Connecting to the relay…"),
    remote?.updating && "Updating the secret at the relay",
    remote?.error,
    remote?.lastCall && `Last request ${relative(remote.lastCall)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      {!remote?.enabled ? (
        <div className="item">
          <span className="grow">
            <small>
              {local
                ? "Give this project a URL on the relay. Grok calls it with a secret, and one of your machines answers with these MCP servers and skills."
                : "Run this on that machine: the secret is only shown over a local connection."}
            </small>
          </span>
          <Button
            size="sm"
            variant="tertiary"
            isDisabled={!local}
            onPress={() => void changeEndpoint(() => control(connection, "remote enable", { id }), "Endpoint created")}
          >
            {remote ? "Turn endpoint on" : "Create endpoint"}
          </Button>
        </div>
      ) : (
        <>
          <div className="item">
            <span className="grow">
              <strong>Server URL</strong>
              <small>
                <code>{remote.url}</code>
              </small>
            </span>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label="Copy URL"
              onPress={() => void copy(remote.url, "URL")}
            >
              <Copy size={15} />
            </Button>
          </div>
          <div className="item">
            <span className="grow">
              <strong>Authorization header</strong>
              <small>
                <code>
                  {shown
                    ? `Bearer ${reveal ? shown.secret : "•".repeat(24)}`
                    : local
                      ? secret.error || "Loading…"
                      : "Run this on that machine to see the secret"}
                </code>
              </small>
            </span>
            {shown && (
              <>
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  aria-label={reveal ? "Hide secret" : "Show secret"}
                  onPress={() => setReveal(!reveal)}
                >
                  {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
                </Button>
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  aria-label="Copy Authorization value"
                  onPress={() => void copy(`Bearer ${shown.secret}`, "Authorization value")}
                >
                  <Copy size={15} />
                </Button>
              </>
            )}
          </div>
          <div className="item">
            <span className="grow">
              <div className="row">
                <strong>Status</strong>
                {remote.connected && <Badge good>Connected</Badge>}
              </div>
              {statusDetail && <small>{statusDetail}</small>}
              {remote.failedAliases?.length ? (
                <small className="danger">
                  Not reachable on {remote.servedBy}: {remote.failedAliases.join(", ")}
                </small>
              ) : null}
            </span>
          </div>
          <div className="item">
            <Choice
              label="Served by"
              description="This machine answers requests. Its MCP servers must work there."
              options={data.nodes.map((n) => ({
                id: n.id,
                label: `${n.id}${n.alwaysOn ? " (always on)" : ""}${n.online ? "" : " (offline)"}`,
              }))}
              selectedKey={remote.servedBy}
              isDisabled={!local}
              onSelectionChange={(key) =>
                key &&
                key !== remote.servedBy &&
                void changeEndpoint(
                  () => control(connection, "remote enable", { id, servedBy: String(key) }),
                  "Serving machine changed",
                )
              }
            />
          </div>
          <div className="item item-actions">
            <Button
              size="sm"
              variant="tertiary"
              isDisabled={!local}
              onPress={async () => {
                if (
                  await confirmDialog(
                    `Create a new secret for ${id}? Clients using the current secret will stop working until updated.`,
                    { okLabel: "New secret" },
                  )
                )
                  void changeEndpoint(
                    () => control(connection, "remote secret", { id }),
                    "New secret created; update it in your client",
                  );
              }}
            >
              New secret
            </Button>
            <Button
              size="sm"
              variant="tertiary"
              isDisabled={!local}
              onPress={async () => {
                if (
                  await confirmDialog(
                    `Create a new URL and secret for ${id}? Clients using the current URL will stop working until updated.`,
                    { okLabel: "New URL" },
                  )
                )
                  void changeEndpoint(
                    () => control(connection, "remote regenerate", { id }),
                    "New URL and secret created; update both in your client",
                  );
              }}
            >
              New URL
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="delete"
              onPress={() => void perform(() => control(connection, "remote disable", { id }), "Endpoint turned off")}
            >
              Turn off
            </Button>
          </div>
        </>
      )}
      {remote?.enabled && (
        <p className="note">
          Requests, including the secret, are encrypted in transit but readable by the relay. Your logins stay on your
          machines. Anyone with the URL and secret can use these tools.
        </p>
      )}
    </>
  );
}
