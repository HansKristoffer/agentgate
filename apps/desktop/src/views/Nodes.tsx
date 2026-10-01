import { useState } from "react";
import { Copy, Monitor, Plus } from "lucide-react";
import { Badge, Modal, Panel } from "../components/ui.tsx";
import type { ViewProps } from "../types.ts";
import { request } from "../api.ts";
import { field, idPath, relative } from "./utils.ts";

export function Nodes({ data, connection, perform }: ViewProps) {
  const [pair, setPair] = useState("");
  const [joinOpen, setJoinOpen] = useState(false);
  return (
    <>
      <div className="toolbar">
        <span>
          {data.nodes.length} {data.nodes.length === 1 ? "machine" : "machines"}{" "}
          in your setup
        </span>
        <div className="row">
          <button className="button" onClick={() => setJoinOpen(true)}>
            Join another machine
          </button>
          <button
            className="button primary"
            onClick={() =>
              void perform(async () => {
                const result = await request<{ command: string }>(
                  connection,
                  "/nodes/pair",
                  "POST",
                );
                setPair(result.command);
              })
            }
          >
            <Plus size={15} />
            Pair a machine
          </button>
        </div>
      </div>
      <Panel
        title="Your machines"
        detail="Accounts, tools, and project mappings sync between paired nodes."
        foot="Each machine serves its own agents and keeps working offline. Always-on machines take care of token refreshes while your laptop is away."
      >
        {data.nodes.map((n) => (
          <div className="item" key={n.id}>
            <div className="machine-icon">
              <Monitor size={16} />
            </div>
            <div className="grow">
              <div className="row">
                <strong>{n.id}</strong>
                {n.id === data.node && <Badge>This node</Badge>}
                <Badge good={n.online}>{n.online ? "Online" : "Offline"}</Badge>
              </div>
              <small>{n.url ?? "Tailscale address not available"}</small>
              <small>
                {n.syncError ??
                  (n.id === data.node
                    ? "Local daemon"
                    : `Last seen ${relative(n.lastSeen)}`)}
              </small>
            </div>
            <label className="check muted">
              Always on
              <input
                type="checkbox"
                className="switch"
                checked={!!n.alwaysOn}
                onChange={() =>
                  void perform(() =>
                    request(connection, `/nodes/${idPath(n.id)}`, "PATCH", {
                      alwaysOn: !n.alwaysOn,
                    }),
                  )
                }
              />
            </label>
            {n.id !== data.node && (
              <button
                className="button danger"
                onClick={() => {
                  if (
                    window.confirm(
                      `Unpair ${n.id}? It will stop syncing with this node.`,
                    )
                  )
                    void perform(
                      () =>
                        request(connection, `/nodes/${idPath(n.id)}`, "DELETE"),
                      "Machine unpaired",
                    );
                }}
              >
                Unpair
              </button>
            )}
          </div>
        ))}
      </Panel>
      {pair && (
        <Modal title="Pair another machine" close={() => setPair("")}>
          <p>
            On the other machine, initialize Agentgate, start Tailscale, then
            run this command. The code expires in 10 minutes.
          </p>
          <pre>{pair}</pre>
          <button
            className="button"
            onClick={() =>
              void perform(
                () => navigator.clipboard.writeText(pair),
                "Pairing command copied",
              )
            }
          >
            <Copy size={15} />
            Copy command
          </button>
          <p className="note">
            Pair only machines you control. Working account and MCP credentials
            are copied to each paired node.
          </p>
        </Modal>
      )}
      {joinOpen && (
        <Modal title="Join another machine" close={() => setJoinOpen(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void perform(async () => {
                await request(connection, "/nodes/join", "POST", {
                  url: field(f, "url"),
                  code: field(f, "code"),
                });
                setJoinOpen(false);
              }, "Machine paired");
            }}
          >
            <label>
              Other machine's Tailscale address
              <input
                name="url"
                type="url"
                required
                placeholder="http://server.tailnet.ts.net:7878"
              />
            </label>
            <label>
              Pairing code
              <input
                name="code"
                required
                placeholder="From agentgate pair on the other machine"
              />
            </label>
            <button className="button primary">Join machine</button>
          </form>
        </Modal>
      )}
    </>
  );
}
