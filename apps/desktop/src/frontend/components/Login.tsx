import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink } from "lucide-react";
import { Button } from "@heroui/react";
import type { Connection, LoginStart, Provider } from "@agentgate/protocol";
import { openExternal, request } from "../api.ts";
import type { Perform } from "../types.ts";
import { field, providerName } from "../views/utils.ts";
import { useGeneration } from "../features/proxy/useGeneration.ts";
import { Field, Modal } from "./ui.tsx";

/** The browser sign-in for an account: `start` opens the login page, `dialog` takes the pasted code,
 * or for Cursor waits until the browser sign-in finishes. */
export function useAccountLogin(connection: Connection, perform: Perform, done?: () => void) {
  const [login, setLogin] = useState<LoginStart>();
  const capture = useGeneration(connection);
  const attempt = useRef(0);
  const pending = useRef<{ connection: Connection; state: string } | undefined>(undefined);
  const cancel = async () => { const previous = pending.current; pending.current = undefined; if (previous) await request(previous.connection, `/accounts/login/${encodeURIComponent(previous.state)}`, "DELETE").catch(() => {}); };
  useEffect(() => () => { attempt.current++; void cancel(); }, []);
  // Cursor has no code to paste: the daemon waits on its sign-in and answers `pending` until it is done.
  // This runs outside `perform`, which would hold the app's action lock for the whole sign-in.
  useEffect(() => {
    if (login?.provider !== "cursor") return;
    const current = capture(), generation = attempt.current, live = () => current() && generation === attempt.current;
    void (async () => {
      try {
        let id: string | undefined;
        while (!id && live()) ({ id } = await request<{ id?: string }>(connection, "/accounts/login/finish", "POST", { state: login.state }));
        if (!id || !live()) return;
        pending.current = undefined;
        setLogin(undefined);
        done?.();
        await perform(async () => {}, "Account added");
      } catch (e) {
        if (live()) { setLogin(undefined); await perform(() => Promise.reject(e)); }
      }
    })();
  }, [login]);
  /** `email` pre-selects that account on the provider's login page. */
  const start = (provider: Provider, label: string, email?: string) =>
    perform(async () => {
      const current = capture(), generation = ++attempt.current;
      await cancel();
      const result = await request<LoginStart>(
        connection,
        "/accounts/login",
        "POST",
        { provider, label: label || undefined, email },
      );
      if (!current() || generation !== attempt.current) { await request(connection, `/accounts/login/${encodeURIComponent(result.state)}`, "DELETE").catch(() => {}); return; }
      pending.current = { connection, state: result.state };
      setLogin({ ...result, provider }); // the dialog follows what was clicked, not the reply
      await openExternal(result.url);
    });
  const dialog = login && (
    <Modal
      title={`Sign in to ${providerName(login.provider)}`}
      close={() => { attempt.current++; setLogin(undefined); void cancel(); }}
    >
      <p>{login.provider === "cursor" ? "Finish signing in to Cursor in your browser. This window closes when you're done." : "Your browser has opened the provider's login page."}</p>
      <Button
        size="sm"
        variant="tertiary"
        onPress={() => void perform(() => openExternal(login.url))}
      >
        Open login page again
        <ExternalLink size={14} />
      </Button>
      {login.provider !== "cursor" && <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void perform(async () => {
            const current = capture(), generation = attempt.current;
            await request(connection, "/accounts/login/finish", "POST", {
              state: login.state,
              code: field(f, "code"),
            });
            if (!current() || generation !== attempt.current) return;
            pending.current = undefined;
            setLogin(undefined);
            done?.();
          }, "Account added");
        }}
      >
        <Field
          multiline
          label={
            login.provider === "claude"
              ? "Paste the code shown after signing in"
              : "Paste the full localhost:1455 callback address"
          }
          name="code"
          isRequired
          autoFocus
          placeholder={
            login.provider === "claude"
              ? "code#state"
              : "http://localhost:1455/auth/callback?code=…"
          }
        />
        <p className="note">
          {login.provider === "codex"
            ? "The browser may show a page that cannot load. Copy its full address from the address bar."
            : "This login belongs to Agentgate and leaves your current CLI and Claude Desktop logins untouched."}
        </p>
        <Button type="submit" size="sm">
          Finish sign in
          <Check size={15} />
        </Button>
      </form>}
    </Modal>
  );
  return { start, dialog };
}
