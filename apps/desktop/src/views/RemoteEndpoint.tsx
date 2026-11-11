import { useState } from "react";
import { Copy, Eye, EyeOff } from "lucide-react";
import { Button } from "@heroui/react";
import type { PublicProject } from "@agentgate/protocol";
import { Badge, Choice, Field, Toggle } from "../components/ui.tsx";
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
  const setWebhook = (url: string | null) =>
    perform(() => control(connection, "remote webhook", { id, url }), url ? "Webhook saved" : "Webhook removed");
  const copy = (text: string, what: string) => perform(() => navigator.clipboard.writeText(text), `${what} copied`);
  const nodes = data.nodes.map((n) => ({
    id: n.id,
    label: `${n.id}${n.alwaysOn ? " (always on)" : ""}${n.online ? "" : " — offline"}`,
  }));
  const serving = data.nodes.find((n) => n.id === remote?.servedBy);

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
            {remote ? "Turn endpoint on" : "Create endpoint for Grok"}
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
              <strong>Status</strong>
              <small>
                {remote.connected ? (
                  <Badge good>Connected</Badge>
                ) : serving && !serving.online ? (
                  `${remote.servedBy} is offline`
                ) : remote.servedBy !== data.node ? (
                  `Served by ${remote.servedBy}`
                ) : (
                  "Connecting to the relay…"
                )}
                {remote.updating && " · updating the secret at the relay"}
                {remote.error && ` · ${remote.error}`}
                {remote.lastCall && ` · last request ${relative(remote.lastCall)}`}
              </small>
              {remote.failedAliases?.length ? (
                <small>
                  Not reachable on {remote.servedBy}: {remote.failedAliases.join(", ")}
                </small>
              ) : null}
            </span>
          </div>
          <div className="item">
            <Choice
              label="Served by"
              description="This machine answers Grok. Its MCP servers must work there."
              options={nodes}
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
          <Toggle
            label="Software factory"
            description="Grok sees the factory's board and items, adds tasks in its repositories, approves, rejects, retries or drops items, and pauses or resumes it."
            isSelected={!!project.factoryTools}
            onChange={(on) =>
              perform(
                () => control(connection, "remote factory", { id, on }),
                on ? "Grok can steer the factory" : "Factory tools removed",
              )
            }
          />
          {project.factoryTools &&
            (project.factoryWebhook ? (
              <div className="item">
                <span className="grow">
                  <strong>Updates webhook</strong>
                  <small>
                    The factory posts items that wait for you or have a ready PR to{" "}
                    <code>{project.factoryWebhook}</code>
                  </small>
                </span>
                <Button size="sm" variant="ghost" className="delete" onPress={() => void setWebhook(null)}>
                  Remove
                </Button>
              </div>
            ) : (
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void setWebhook(String(new FormData(e.currentTarget).get("url") ?? "").trim());
                }}
              >
                <Field
                  className="field grow"
                  name="url"
                  type="url"
                  isRequired
                  label="Updates webhook"
                  description="An https URL that gets each item added, moved or waiting for you. Grok can also set it."
                  placeholder="https://"
                />
                <Button type="submit" size="sm" variant="tertiary">
                  Save
                </Button>
              </form>
            ))}
          <div className="item item-actions">
            <Button
              size="sm"
              variant="tertiary"
              isDisabled={!local}
              onPress={() =>
                void changeEndpoint(
                  () => control(connection, "remote secret", { id }),
                  "New secret created; update it in Grok",
                )
              }
            >
              New secret
            </Button>
            <Button
              size="sm"
              variant="tertiary"
              isDisabled={!local}
              onPress={() =>
                void changeEndpoint(
                  () => control(connection, "remote regenerate", { id }),
                  "New URL and secret created; update both in Grok",
                )
              }
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
          Requests from Grok, including the secret, are encrypted in transit but readable by the relay. Your logins stay
          on your machines. Anyone with the URL and secret can use these tools.
        </p>
      )}
    </>
  );
}
