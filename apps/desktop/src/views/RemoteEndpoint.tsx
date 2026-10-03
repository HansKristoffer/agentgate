import { useEffect, useState } from "react";
import { Copy, Eye, EyeOff } from "lucide-react";
import { Button } from "@heroui/react";
import type { PublicProject } from "@agentgate/protocol";
import { Badge, Choice } from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { request } from "../api.ts";
import { idPath, relative } from "./utils.ts";

type Endpoint = { url: string; secret: string };

/** A virtual project's public endpoint, shown in its Projects row: what to paste into Grok, who serves it, and its controls. */
export function EndpointDetails({ project, data, connection, perform, local }: ViewProps & { project: PublicProject }) {
  const remote = project.remote;
  const [shown, setShown] = useState<Endpoint>();
  const [reveal, setReveal] = useState(false);
  // The secret is only ever read over a local connection.
  useEffect(() => {
    if (local && remote?.enabled) void request<Endpoint>(connection, `/projects/remote?id=${idPath(project.id)}`).then(setShown, () => { });
  }, [local, remote?.enabled, remote?.url, connection, project.id]);
  const call = (path: string, body: Record<string, unknown>, message: string) =>
    perform(async () => { setShown(await request<Endpoint>(connection, path, "POST", { id: project.id, ...body })); }, message);
  const copy = (text: string, what: string) => perform(() => navigator.clipboard.writeText(text), `${what} copied`);
  const nodes = data.nodes.map((n) => ({ id: n.id, label: `${n.id}${n.alwaysOn ? " (always on)" : ""}${n.online ? "" : " — offline"}` }));
  const serving = data.nodes.find((n) => n.id === remote?.servedBy);

  return (
    <>
      {!remote?.enabled ? (
        <div className="item">
          <span className="grow">
            <small>{local
              ? "Give this project a URL on the relay. Grok calls it with a secret, and one of your machines answers with these MCP servers and skills."
              : "Run this on that machine: the secret is only shown over a local connection."}</small>
          </span>
          <Button size="sm" variant="tertiary" isDisabled={!local} onPress={() => void call("/projects/remote", {}, "Endpoint created")}>
            {remote ? "Turn endpoint on" : "Create endpoint for Grok"}
          </Button>
        </div>
      ) : (
        <>
          <div className="item">
            <span className="grow">
              <strong>Server URL</strong>
              <small><code>{remote.url}</code></small>
            </span>
            <Button isIconOnly size="sm" variant="ghost" aria-label="Copy URL" onPress={() => void copy(remote.url, "URL")}><Copy size={15} /></Button>
          </div>
          <div className="item">
            <span className="grow">
              <strong>Authorization header</strong>
              <small><code>{shown ? `Bearer ${reveal ? shown.secret : "•".repeat(24)}` : local ? "Loading…" : "Run this on that machine to see the secret"}</code></small>
            </span>
            {shown && <>
              <Button isIconOnly size="sm" variant="ghost" aria-label={reveal ? "Hide secret" : "Show secret"} onPress={() => setReveal(!reveal)}>{reveal ? <EyeOff size={15} /> : <Eye size={15} />}</Button>
              <Button isIconOnly size="sm" variant="ghost" aria-label="Copy Authorization value" onPress={() => void copy(`Bearer ${shown.secret}`, "Authorization value")}><Copy size={15} /></Button>
            </>}
          </div>
          <div className="item">
            <span className="grow">
              <strong>Status</strong>
              <small>
                {remote.connected ? <Badge good>Connected</Badge> : serving && !serving.online ? `${remote.servedBy} is offline` : remote.servedBy !== data.node ? `Served by ${remote.servedBy}` : "Connecting to the relay…"}
                {remote.updating && " · updating the secret at the relay"}
                {remote.error && ` · ${remote.error}`}
                {remote.lastCall && ` · last request ${relative(remote.lastCall)}`}
              </small>
              {remote.failedAliases?.length ? <small>Not reachable on {remote.servedBy}: {remote.failedAliases.join(", ")}</small> : null}
            </span>
          </div>
          <div className="item">
            <Choice
              label="Served by"
              description="This machine answers Grok. Its MCP servers must work there."
              options={nodes}
              selectedKey={remote.servedBy}
              isDisabled={!local}
              onSelectionChange={(key) => key && key !== remote.servedBy && void call("/projects/remote", { servedBy: String(key) }, "Serving machine changed")}
            />
          </div>
          <div className="item item-actions">
            <Button size="sm" variant="tertiary" isDisabled={!local} onPress={() => void call("/projects/remote/secret", {}, "New secret created; update it in Grok")}>New secret</Button>
            <Button size="sm" variant="tertiary" isDisabled={!local} onPress={() => void call("/projects/remote/regenerate", {}, "New URL and secret created; update both in Grok")}>New URL</Button>
            <Button size="sm" variant="ghost" className="delete" onPress={() => void perform(async () => { await request(connection, `/projects/remote?id=${idPath(project.id)}`, "DELETE"); setShown(undefined); }, "Endpoint turned off")}>Turn off</Button>
          </div>
        </>
      )}
      {remote?.enabled && <p className="note">Requests from Grok, including the secret, are encrypted in transit but readable by the relay. Your logins stay on your machines. Anyone with the URL and secret can use these tools.</p>}
    </>
  );
}
