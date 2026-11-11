import { typedSwitch } from "hanzio";
import { relevant } from "../llm/quota.ts";
import { store } from "../store.ts";
import { die, initialized, showHelp, type Run } from "./common.ts";

/** `desktop`: Claude Desktop on this Mac. */
export const run: Run = async (_cmd, [sub, ...rest]) => {
  const s = initialized(store());
  const desktop = await import("../desktop.ts");
  const st = desktop.status(s);
  if (!st.available) die("Claude Desktop is not installed on this Mac.");
  const name = (l: { label?: string; email?: string; accountUuid: string }) =>
    l.label ?? l.email ?? l.accountUuid.slice(0, 8);
  const find = (arg?: string) => {
    const q = arg ?? die(`desktop ${sub} <account>`);
    const l = st.logins.find(
      (l) => [l.accountId, l.label, l.email, l.accountUuid].includes(q) || l.accountUuid.startsWith(q),
    );
    return (
      l?.accountUuid ??
      die(`No saved Claude Desktop login matches ${q}. Saved: ${st.logins.map(name).join(", ") || "none"}`)
    );
  };
  if (!sub) {
    console.log(`Claude Desktop ${st.version ?? ""}${st.running ? "" : " (not running)"}`);
    console.log(
      typedSwitch(st.mode, {
        pool: () => "mode: Code tab uses the pool (gateway mode)",
        "other-gateway": () => "mode: another company gateway",
        "signed-in": () =>
          `mode: signed in${st.current ? ` as ${name(st.current)}${st.current.saved ? "" : " (not saved: agentgate desktop capture)"}` : st.signedOut ? ", but signed out in Desktop" : " (no account)"}`,
      }),
    );
    for (const l of st.logins) {
      const pct = l.accountId
        ? Math.max(0, ...relevant(s.get("usage", l.accountId), undefined, Date.now()).map((w) => w.usedPct))
        : undefined; // windows that have reset count as 0
      console.log(
        `  ${st.current?.accountUuid === l.accountUuid ? "*" : " "} ${name(l).padEnd(28)} ${pct === undefined ? "not in the pool" : `${Math.round(pct)}% used`}${l.expired ? "  LOGIN EXPIRED" : l.sessionExpiresAt ? `  login valid ${Math.round((l.sessionExpiresAt - Date.now()) / 86_400_000)} days` : ""}${l.problem ? `  ${l.problem}` : ""}`,
      );
    }
    if (st.pendingAdd) console.log("Waiting for you to sign in to Claude Desktop…");
    console.log(`MCP servers in Claude Code / Desktop's Code tab: ${st.mcp ? "on" : "off (agentgate setup --mcp)"}`);
    if (st.cursorMcp !== undefined)
      console.log(`MCP servers in Cursor: ${st.cursorMcp ? "on" : "off (agentgate setup --mcp)"}`);
    return;
  }
  if (sub === "capture") return console.log(`saved ${desktop.capture(s)}`);
  if (sub === "use") {
    await desktop.use(s, find(rest[0]));
    return console.log("switched; Claude Desktop is restarting");
  }
  if (sub === "forget") {
    desktop.forget(s, find(rest[0]));
    return console.log("ok");
  }
  if (sub === "gateway") {
    await desktop.gateway(s, rest[0] !== "off");
    return console.log(
      rest[0] === "off"
        ? "Claude Desktop uses its own sign-in again"
        : "Claude Desktop's Code tab now uses the pool; keep the agentgate service running",
    );
  }
  if (sub === "add") {
    const started = Date.now();
    await desktop.add(s, rest[0]);
    console.log(
      `Claude Desktop restarted signed out. Sign in${rest[0] ? ` with ${rest[0]}` : " with the next account"}; this waits up to 10 minutes. Don't use Log out in Desktop: it ends saved logins.`,
    );
    for (;;) {
      await Bun.sleep(2000);
      // The agentgate service may save it first; then this loop only reports it.
      const uuid = (await desktop.pollDesktopLogin(s)) ?? desktop.addedSince(s, started);
      if (uuid) {
        const wrong = desktop.status(s).addMismatch;
        return console.log(
          wrong
            ? `saved ${name(wrong)}, but you asked for ${wrong.expected}. Run agentgate desktop add ${wrong.expected} to connect it.`
            : `saved ${uuid}`,
        );
      }
      // Gone before the 10 minutes were up: cancelled in the app, or another switch replaced it.
      if (!s.local("desktop:pendingAdd"))
        die(
          `${Date.now() - started < 10 * 60_000 ? "The sign-in was cancelled" : "Timed out waiting for the sign-in"}. Try again with: agentgate desktop add${rest[0] ? ` ${rest[0]}` : ""}`,
        );
    }
  }
  return showHelp();
};
