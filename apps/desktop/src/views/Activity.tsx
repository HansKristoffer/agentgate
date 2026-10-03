import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Card, DateField, Label } from "@heroui/react";
import { ChevronRight, Copy, Pause, Play, RefreshCw } from "lucide-react";
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
      // Date fields submit local ISO time; the daemon filters on Unix milliseconds.
      if (text)
        next.set(key, key === "since" || key === "until" ? String(new Date(text).getTime()) : text);
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
  const options = (all: string, ids: string[]) => [
    { id: "", label: all },
    ...ids.map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) })),
  ];
  const time = (name: string, label: string) => (
    <DateField className="field" name={name} granularity="minute">
      <Label>{label}</Label>
      <DateField.Group>
        <DateField.Input>
          {(segment) => <DateField.Segment segment={segment} />}
        </DateField.Input>
      </DateField.Group>
    </DateField>
  );
  return (
    <>
      <Panel
        title="Filters"
        detail="Local sanitized diagnostics. Prompts, responses, credentials, and session IDs are omitted."
      >
        <form onSubmit={applyFilters} onReset={() => setQuery("")}>
          <div className="item stack">
            <div className="activity-filters">
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
                options={options("All outcomes", [
                  "pending",
                  "success",
                  "failed",
                  "interrupted",
                  "cancelled",
                ])}
              />
              <Choice
                label="Failure"
                name="failure"
                defaultValue=""
                options={options("All reasons", [
                  "quota",
                  "rate",
                  "login",
                  "model",
                  "transient",
                  "request",
                  "cancelled",
                  "budget",
                  "stateful",
                ])}
              />
              <Field label="Model" name="model" placeholder="Exact routed model" />
              <Field
                label="Search"
                name="search"
                placeholder="Request ID, model, or account ID"
              />
              {time("since", "From")}
              {time("until", "Until")}
            </div>
          </div>
          <div className="item item-actions">
            <Button type="reset" size="sm" variant="ghost">
              Clear
            </Button>
            <Button type="submit" size="sm">
              Apply filters
            </Button>
          </div>
        </form>
      </Panel>
      <Panel
        title={`Requests on ${data.node}`}
        detail={follow ? "Updates every 5 seconds." : "Paused. Refresh to update."}
        action={
          <div className="row">
            <Button
              size="sm"
              variant="ghost"
              isDisabled={!page?.requests.length}
              onPress={() => void copyDiagnostics()}
            >
              <Copy size={14} />
              Copy diagnostics
            </Button>
            <Button size="sm" variant="ghost" onPress={() => void load()}>
              <RefreshCw size={14} />
              Refresh
            </Button>
            <Button
              size="sm"
              variant="tertiary"
              onPress={() => setFollow(!follow)}
            >
              {follow ? <Pause size={14} /> : <Play size={14} />}
              {follow ? "Pause" : "Follow"}
            </Button>
          </div>
        }
      >
        {error && (
          <div className="item danger" role="alert">
            {error}
          </div>
        )}
        {page?.cursorReset && (
          <div className="item">
            <small>
              Older activity was removed by retention. Showing the available
              results.
            </small>
          </div>
        )}
        {!page?.requests.length ? (
          <Empty>No matching requests.</Empty>
        ) : (
          page.requests.map((r) => (
            <button
              type="button"
              className="item activity-request"
              key={r.id}
              onClick={() => void showDetail(r.id)}
            >
              <span className="grow">
                <strong>
                  {r.routedModel || r.provider} · {label(r) || "No account"}
                </strong>
                <small>
                  {new Date(r.at).toLocaleString()} · {r.selection} ·{" "}
                  {r.attempts} {r.attempts === 1 ? "attempt" : "attempts"} ·{" "}
                  {r.headersMs ?? "—"} ms to headers
                </small>
              </span>
              <Badge good={r.outcome === "success"}>
                {r.outcome}
                {r.failure ? ` · ${r.failure}` : ""}
              </Badge>
              <ChevronRight size={14} className="muted" />
            </button>
          ))
        )}
        {page?.nextCursor && (
          <div className="item item-actions">
            {follow && <small className="grow">Pause to load older requests.</small>}
            <Button
              size="sm"
              variant="tertiary"
              isDisabled={follow}
              onPress={() => void load(page.nextCursor)}
            >
              Load older requests
            </Button>
          </div>
        )}
      </Panel>
      {detail && (
        <Modal title="Request details" close={() => setDetail(undefined)}>
          <dl className="facts">
            <dt>Request</dt>
            <dd>
              <code>{detail.request.id}</code>
            </dd>
            <dt>Model</dt>
            <dd>
              {detail.request.requestedModel} → {detail.request.routedModel}
            </dd>
            <dt>Outcome</dt>
            <dd>
              {detail.request.outcome} · HTTP {detail.request.status}
            </dd>
            <dt>Timing</dt>
            <dd>
              {detail.request.headersMs ?? "—"} ms to headers ·{" "}
              {detail.request.firstByteMs ?? "—"} ms to first byte ·{" "}
              {detail.request.durationMs ?? "—"} ms total
            </dd>
            <dt>Stream</dt>
            <dd>{detail.request.stream ?? "—"}</dd>
          </dl>
          <Card className="rows">
            {detail.attempts.map((a) => (
              <div className="item" key={a.id}>
                <span className="grow">
                  <strong>
                    Attempt {a.number} ·{" "}
                    {data.accounts.find((x) => x.account.id === a.account)
                      ?.account.label ?? a.account}
                  </strong>
                  <small>
                    {a.selection} · {a.headersMs} ms
                    {a.failure ? ` · ${a.failure}` : ""}
                  </small>
                </span>
                <Badge good={a.status < 400}>
                  HTTP {a.status}
                </Badge>
              </div>
            ))}
          </Card>
        </Modal>
      )}
    </>
  );
}
