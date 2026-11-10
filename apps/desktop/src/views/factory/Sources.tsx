import { useState } from "react";
import { Button, Tabs, toast } from "@heroui/react";
import { Plus } from "lucide-react";
import { weekdays, type FactoryBoard, type FactorySourceAddInput, type Weekday } from "@agentgate/protocol";
import type { ViewProps } from "../../types.ts";
import { factoryOp, openExternal } from "../../api.ts";
import { ActionButton, Badge, Check, Choice, Empty, Field, Modal, Panel } from "../../components/ui.tsx";
import { ago, field, relative } from "../utils.ts";
import { OpenInT3 } from "../Factory.tsx";

type Run = (task: () => Promise<unknown>, message?: string, key?: string) => Promise<void>;
type Kind = "webhook" | "scout";

const DAY_LABELS: Record<Weekday, string> = {
  mon: "Mo",
  tue: "Tu",
  wed: "We",
  thu: "Th",
  fri: "Fr",
  sat: "Sa",
  sun: "Su",
};
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * The input of the `source add` operation from the dialog's form. The daemon checks it against the same schema, and
 * leaves out of the folder what equals a default.
 */
export function sourceInput(form: FormData, kind: Kind, when: "every" | "at"): FactorySourceAddInput {
  const optional = (name: string) => field(form, name) || undefined;
  const base = { id: field(form, "id"), repo: field(form, "repo") };
  if (kind === "scout") {
    const days = form.getAll("days").map(String) as Weekday[];
    const intake = field(form, "intake");
    const mcp = form.getAll("mcp").map(String);
    return {
      source: {
        ...base,
        type: "scout",
        schedule:
          when === "every"
            ? { every: field(form, "every") }
            : { at: field(form, "at"), days, ...(optional("timezone") && { timezone: field(form, "timezone") }) },
        intake: intake === "hold" ? "hold" : "auto",
        ...(mcp.length && { mcp }),
        enabled: !!form.get("enabled"),
      },
      prompt: field(form, "prompt"),
    };
  }
  const header = optional("header");
  const secret = optional("secret");
  const body = optional("body");
  const dedupe = optional("dedupe");
  const intake = field(form, "intake");
  return {
    source: {
      ...base,
      type: "webhook",
      title: field(form, "title"),
      ...(body && { body }),
      ...(dedupe && { dedupe }),
      intake: intake === "auto" ? "auto" : "hold",
      ...(header &&
        secret && {
          signature: {
            header,
            encoding: field(form, "encoding") === "base64" ? "base64" : "hex",
            prefix: field(form, "prefix"),
            secret: `secret:${secret}`,
          },
        }),
    },
  };
}

/** New webhook or New scout, laid out like T3 Code's New task: proposed to the factory folder, so a folder in git gets a
 * PR that starts it on merge, and the stored folder takes it at once. */
function SourceDialog({
  data,
  connection,
  perform,
  board,
  kind,
  close,
}: Pick<ViewProps, "data" | "connection" | "perform"> & { board: FactoryBoard; kind: Kind; close: () => void }) {
  const [when, setWhen] = useState<"every" | "at">("every");
  const repos = [...new Set(board.sources.map((s) => s.repo))];
  return (
    <Modal title={kind === "scout" ? "New scout" : "New webhook"} close={close} size="lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const input = sourceInput(new FormData(e.currentTarget), kind, when);
          void perform(async () => {
            const result = await factoryOp(connection, "source add", input);
            close();
            for (const warning of result.warnings) toast(warning);
            if ("pr" in result) {
              const { pr } = result;
              toast(`A PR adds ${input.source.id}`, {
                description: "It starts once the PR merges.",
                actionProps: { children: "Open PR", onPress: () => void openExternal(pr) },
              });
            } else toast(`${input.source.id} is added`, { description: "It starts within 2 minutes." });
          });
        }}
      >
        <p className="muted">
          {kind === "scout"
            ? "On its schedule, a T3 Code thread follows your prompt in a worktree of the repository and reports what it finds. Each finding becomes an item that goes through triage, a fix and review."
            : "Each request to the webhook's URL becomes an item. Its URL shows under Sources once it starts."}{" "}
          Saving adds it to the folder agentgate stores at once, or opens a PR on a factory folder in git with the{" "}
          <code>gh</code> login of {data.node}.
        </p>
        <div className="row">
          <Field
            label="Name"
            name="id"
            isRequired
            placeholder={kind === "scout" ? "perf" : "support-desk"}
            description="Lowercase letters, digits and dashes."
          />
          <Field
            label="Repository"
            name="repo"
            isRequired
            defaultValue={repos[0]}
            description="Listed under repositories in factory.yaml."
          />
        </div>
        {kind === "scout" ? (
          <>
            <Field
              label="Prompt"
              name="prompt"
              isRequired
              multiline
              placeholder="What should the scout look into each time, and what is worth a ticket?"
            />
            <div className="row">
              <strong className="grow">Schedule</strong>
              <Tabs
                className="segmented"
                selectedKey={when}
                onSelectionChange={(key) => setWhen(key as "every" | "at")}
              >
                <Tabs.ListContainer>
                  <Tabs.List aria-label="Schedule">
                    <Tabs.Tab id="every">
                      Every interval
                      <Tabs.Indicator />
                    </Tabs.Tab>
                    <Tabs.Tab id="at">
                      At a time
                      <Tabs.Indicator />
                    </Tabs.Tab>
                  </Tabs.List>
                </Tabs.ListContainer>
              </Tabs>
            </div>
            {when === "every" ? (
              <Field
                label="Every"
                name="every"
                isRequired
                defaultValue="1d"
                description="Such as 6h, 1d or 7d; at least 1h."
              />
            ) : (
              <>
                <div className="row">
                  <Field label="Run at" name="at" isRequired defaultValue="09:00" description="24-hour time, HH:MM." />
                  <Field label="Timezone" name="timezone" isRequired defaultValue={browserZone()} />
                </div>
                <div className="row factory-actions">
                  {weekdays.map((d) => (
                    <Check key={d} name="days" value={d} defaultSelected={d !== "sat" && d !== "sun"}>
                      {DAY_LABELS[d]}
                    </Check>
                  ))}
                </div>
              </>
            )}
            {!!data.servers.length && (
              <div className="factory-actions">
                <p className="muted">MCP servers the scout may use. Each must also be mapped to the repository.</p>
                <div className="row factory-actions">
                  {data.servers.map((s) => (
                    <Check key={s.id} name="mcp" value={s.id}>
                      {s.label ?? s.id}
                    </Check>
                  ))}
                </div>
              </div>
            )}
            <Choice
              label="Its tickets"
              name="intake"
              defaultValue="auto"
              options={[
                { id: "auto", label: "Start at once" },
                { id: "hold", label: "Wait for my approval" },
              ]}
            />
            <Check name="enabled" defaultSelected>
              Enabled: a disabled scout stays in the folder and runs only when you ask
            </Check>
          </>
        ) : (
          <>
            <Field
              label="Title"
              name="title"
              isRequired
              defaultValue="{{body.title}}"
              description="{{body.path}}, {{headers.name}}, {{query.name}} or {{body}} read from the request."
            />
            <Field label="Body" name="body" multiline defaultValue="{{body}}" />
            <Field
              label="Skip repeats of"
              name="dedupe"
              placeholder="{{body.id}}"
              description="Optional: a request whose value matches one in the last hour is skipped."
            />
            <div className="row">
              <Field
                label="Signature header"
                name="header"
                placeholder="X-Signature"
                description="Optional: the HMAC-SHA256 header the sender signs with."
              />
              <Field
                label="Secret name"
                name="secret"
                placeholder="DESK_SIGNING"
                description="Set its value once the source is added."
              />
            </div>
            <div className="row">
              <Choice
                label="Encoding"
                name="encoding"
                defaultValue="hex"
                options={[
                  { id: "hex", label: "Hex" },
                  { id: "base64", label: "Base64" },
                ]}
              />
              <Field label="Prefix" name="prefix" placeholder="sha256=" />
            </div>
            <Choice
              label="Its items"
              name="intake"
              defaultValue="hold"
              options={[
                { id: "hold", label: "Wait for my approval" },
                { id: "auto", label: "Start at once" },
              ]}
            />
          </>
        )}
        <Button type="submit" size="sm">
          Add {kind === "scout" ? "the scout" : "the webhook"}
        </Button>
      </form>
    </Modal>
  );
}

function sourceDetail(s: FactoryBoard["sources"][number]) {
  if (s.error) return s.error;
  const scout = s.scout;
  if (!scout) return s.lastPollAt ? `Polled ${ago(s.lastPollAt)}` : "Not polled yet";
  const next = !scout.enabled ? "disabled" : scout.nextAt ? `next ${relative(scout.nextAt)}` : "waits for intake";
  const last = scout.lastRun
    ? scout.lastRun.state === "reported"
      ? `last run ${ago(scout.lastRun.at)} filed ${scout.lastRun.filed}${scout.lastRun.skipped ? `, skipped ${scout.lastRun.skipped}` : ""}`
      : `last run ${scout.lastRun.state}`
    : "never run";
  return `${scout.schedule} · ${next} · ${last}`;
}

/** Where items come from: each source with its webhook URL or its schedule, and the dialogs that add one. */
export function Sources(props: ViewProps & { board: FactoryBoard; run: Run }) {
  const { board, connection, run } = props;
  const [adding, setAdding] = useState<Kind>();
  const action = (
    <div className="row">
      <Button size="sm" variant="tertiary" onPress={() => setAdding("webhook")}>
        <Plus size={14} />
        New webhook
      </Button>
      <Button size="sm" variant="tertiary" onPress={() => setAdding("scout")}>
        <Plus size={14} />
        New scout
      </Button>
    </div>
  );
  return (
    <Panel title="Sources" detail="Where items come from. Give a webhook URL only to its sender." action={action}>
      {board.sources.length ? (
        board.sources.map((s) => (
          <div className="item" key={s.id}>
            <div className="grow">
              <div className="row">
                <strong>{s.id}</strong>
                <small className="muted">
                  {s.type} · {s.repo}
                </small>
                {s.scout && !s.scout.enabled && <Badge>disabled</Badge>}
              </div>
              <small className={s.error ? "danger" : "muted"}>{sourceDetail(s)}</small>
            </div>
            {s.webhook?.url && (
              <Button size="sm" variant="tertiary" onPress={() => void navigator.clipboard.writeText(s.webhook!.url!)}>
                Copy webhook URL
              </Button>
            )}
            {s.scout && <OpenInT3 link={s.scout.lastRun?.threadLink} label="Last run" />}
            {s.scout && (
              <ActionButton
                size="sm"
                variant="tertiary"
                pendingKey={`factory:scout:${s.id}`}
                onPress={() =>
                  void run(
                    async () => {
                      const r = await factoryOp(connection, "scout", { id: s.id });
                      if ("skipped" in r) throw new Error(r.skipped);
                    },
                    `The ${s.id} scout runs now`,
                    `factory:scout:${s.id}`,
                  )
                }
              >
                Run now
              </ActionButton>
            )}
          </div>
        ))
      ) : (
        <Empty>
          <p>No sources yet. Add a webhook or a scout, or list GitHub and Linear sources in factory.yaml.</p>
        </Empty>
      )}
      {adding && <SourceDialog {...props} kind={adding} close={() => setAdding(undefined)} />}
    </Panel>
  );
}
