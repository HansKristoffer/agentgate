import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@heroui/react";
import type {
  RequestDetail,
  RequestPage,
  ProxyRequest,
} from "@agentgate/protocol";
import type { ViewProps } from "../types.ts";
import { request } from "../api.ts";
import {
  Badge,
  Choice,
  Empty,
  Field,
  Modal,
  Panel,
} from "../components/ui.tsx";
import { useGeneration } from "../features/proxy/useGeneration.ts";

export function ActivityView({ data, connection, perform }: ViewProps) {
  const [query, setQuery] = useState(""),
    [page, setPage] = useState<RequestPage>(),
    [follow, setFollow] = useState(true);
  const [detail, setDetail] = useState<RequestDetail>(),
    [error, setError] = useState("");
  const serial = useRef(0),
    pending = useRef<symbol | undefined>(undefined);
  const capture = useGeneration(connection);
  const load = async (cursor?: string) => {
    if (pending.current) return;
    const operation = Symbol();
    pending.current = operation;
    const current = capture(),
      generation = ++serial.current;
    const q = new URLSearchParams(query);
    if (cursor) q.set("cursor", cursor);
    try {
      const result = await request<RequestPage>(connection, `/requests?${q}`);
      if (current() && generation === serial.current) {
        setPage((old) =>
          cursor && !result.cursorReset
            ? {
                ...result,
                requests: [...(old?.requests ?? []), ...result.requests].slice(
                  -1000,
                ),
              }
            : result,
        );
        setError("");
      }
    } catch (e) {
      if (current() && generation === serial.current) setError(String(e));
    } finally {
      if (pending.current === operation) pending.current = undefined;
    }
  };
  useEffect(() => {
    pending.current = undefined;
    setPage(undefined);
    void load();
    return () => {
      serial.current++;
    };
  }, [query, connection]);
  useEffect(() => {
    if (!follow) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [query, follow, connection]);
  const label = (r: ProxyRequest) =>
    data.accounts.find((a) => a.account.id === r.account)?.account.label ??
    r.account;
  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = new URLSearchParams();
    for (const [key, value] of new FormData(event.currentTarget)) {
      const text = String(value).trim();
      if (text) next.set(key, text);
    }
    setQuery(next.toString());
  };
  const showDetail = (id: string) =>
    perform(async () => {
      const current = capture();
      const result = await request<RequestDetail>(
        connection,
        `/requests/${encodeURIComponent(id)}`,
      );
      if (current()) setDetail(result);
    });
  const copyDiagnostics = () =>
    perform(async () => {
      const current = capture();
      const rows: RequestDetail[] = [];
      for (const row of page?.requests ?? []) {
        if (!current()) return;
        rows.push(
          await request<RequestDetail>(
            connection,
            `/requests/${encodeURIComponent(row.id)}`,
          ),
        );
      }
      if (current())
        await navigator.clipboard.writeText(
          rows.map((row) => JSON.stringify(row)).join("\n"),
        );
    }, "Loaded diagnostics copied as NDJSON");
  return (
    <Panel
      title={`Request activity · ${data.node}`}
      detail="Local sanitized diagnostics. Prompts, responses, credentials, and session IDs are omitted."
    >
      <form className="activity-filters" onSubmit={applyFilters}>
        <Choice
          label="Provider"
          name="provider"
          defaultValue=""
          options={[
            { id: "", label: "All providers" },
            { id: "claude", label: "Claude" },
            { id: "codex", label: "Codex" },
          ]}
        />
        <Choice
          label="Account"
          name="account"
          defaultValue=""
          options={[
            { id: "", label: "All accounts" },
            ...data.accounts.map((a) => ({
              id: a.account.id,
              label: a.account.label,
            })),
          ]}
        />
        <Choice
          label="Outcome"
          name="outcome"
          defaultValue=""
          options={[
            { id: "", label: "All outcomes" },
            ...["pending", "success", "failed", "interrupted", "cancelled"].map(
              (id) => ({ id, label: id }),
            ),
          ]}
        />
        <Choice
          label="Failure"
          name="failure"
          defaultValue=""
          options={[
            { id: "", label: "All reasons" },
            ...[
              "quota",
              "rate",
              "login",
              "model",
              "transient",
              "request",
              "cancelled",
              "budget",
              "stateful",
            ].map((id) => ({ id, label: id })),
          ]}
        />
        <Field label="Model" name="model" placeholder="Exact routed model" />
        <Field
          label="Search"
          name="search"
          placeholder="Request ID, model, or account ID"
        />
        <Field label="From (Unix milliseconds)" name="since" type="number" />
        <Field label="Until (Unix milliseconds)" name="until" type="number" />
        <Button type="submit" size="sm">
          Apply filters
        </Button>
      </form>
      <div className="item proxy-actions">
        <Button size="sm" variant="tertiary" onPress={() => setFollow(!follow)}>
          {follow ? "Pause" : "Follow latest"}
        </Button>
        <Button size="sm" variant="ghost" onPress={() => void load()}>
          Refresh
        </Button>
        <Button
          size="sm"
          variant="ghost"
          isDisabled={!page?.requests.length}
          onPress={() => void copyDiagnostics()}
        >
          Copy loaded diagnostics
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {page?.cursorReset && (
        <p className="note">
          Older activity was removed by retention. Showing the available
          results.
        </p>
      )}
      {!page?.requests.length ? (
        <Empty>No matching requests.</Empty>
      ) : (
        page.requests.map((r) => (
          <button
            className="item activity-request"
            key={r.id}
            onClick={() => void showDetail(r.id)}
          >
            <span className="grow">
              <strong>
                {r.routedModel || r.provider} · {label(r) || "No account"}
              </strong>
              <small>
                {new Date(r.at).toLocaleString()} · {r.selection} · {r.attempts}{" "}
                attempts · {r.headersMs ?? "—"} ms to headers
              </small>
            </span>
            <Badge good={r.outcome === "success"}>
              {r.outcome}
              {r.failure ? ` · ${r.failure}` : ""}
            </Badge>
          </button>
        ))
      )}
      {page?.nextCursor && (
        <Button
          size="sm"
          variant="tertiary"
          isDisabled={follow}
          onPress={() => void load(page.nextCursor)}
        >
          Load older requests (pause first)
        </Button>
      )}
      {detail && (
        <Modal title="Request details" close={() => setDetail(undefined)}>
          <p>{detail.request.id}</p>
          <p>
            {detail.request.requestedModel} → {detail.request.routedModel} ·{" "}
            {detail.request.outcome} · HTTP {detail.request.status}
          </p>
          <p>
            Headers: {detail.request.headersMs ?? "—"} ms · First byte:{" "}
            {detail.request.firstByteMs ?? "—"} ms · Total:{" "}
            {detail.request.durationMs ?? "—"} ms · Stream:{" "}
            {detail.request.stream ?? "—"}
          </p>
          {detail.attempts.map((a) => (
            <div className="item stack" key={a.id}>
              <strong>
                Attempt {a.number} ·{" "}
                {data.accounts.find((x) => x.account.id === a.account)?.account
                  .label ?? a.account}
              </strong>
              <small>
                {a.selection} · HTTP {a.status} · {a.headersMs} ms
                {a.failure ? ` · ${a.failure}` : ""}
              </small>
            </div>
          ))}
        </Modal>
      )}
    </Panel>
  );
}
