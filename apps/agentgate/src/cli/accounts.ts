import { loginIdSchema, type RequestPage } from "@agentgate/protocol";
import { buildQueryString, getErrorMessage } from "hanzio";
import { providerLogins } from "../llm/providers.ts";
import { store } from "../store.ts";
import { die, initialized, management, showHelp, stringOption, type Run } from "./common.ts";

/** login, the account list and checks, proxy, tokens, requests and logins. Account writes are operations
 * (ops/accounts.ts). */
export const run: Run = async (cmd, [sub, ...rest], opts) => {
  const s = initialized(store());
  const str = stringOption(opts);
  switch (cmd) {
    case "login": {
      const mod =
        sub === "claude" || sub === "codex" || sub === "cursor"
          ? providerLogins[sub]
          : die("login claude|codex|cursor [--label work]");
      // The provider's own sign-in needs this terminal, so it runs and saves here rather than in the daemon.
      const id = await mod.login(s, str("label"));
      console.log(`added ${id}`);
      await management(`/ops/${encodeURIComponent("accounts signed-in")}`, "POST", { id }).catch((e) => {
        if ((e as { code?: unknown } | null)?.code !== "ECONNREFUSED")
          console.warn(`The running daemon may skip ${id} until its backoff ends: ${getErrorMessage(e)}`);
      });
      return;
    }

    case "accounts": {
      if (!sub) {
        for (const a of s.list("account"))
          console.log(
            `${a.id.padEnd(24)} ${a.provider.padEnd(7)} ${a.label}${a.enabled ? "" : " (disabled)"}${a.pinned ? " (pinned)" : ""}  priority ${a.priority}`,
          );
        return;
      }
      const id = rest[0] ?? die(`accounts ${sub} <id>`);
      if (sub === "verify" && opts.probe)
        return console.log(
          JSON.stringify(
            await management(`/accounts/${encodeURIComponent(id)}/verify`, "POST", {
              probe: true,
              model: str("model") ?? die("--model is required for an inference probe"),
            }),
            null,
            2,
          ),
        );
      if (["quota", "verify", "models", "refresh", "reset-cooldown"].includes(sub))
        return console.log(
          JSON.stringify(await management("/accounts/batch", "POST", { ids: rest, action: sub }), null, 2),
        );
      return showHelp();
    }

    case "proxy": {
      if (sub === "capabilities") {
        const st = await management<{ daemon: unknown }>("/status");
        return console.log(JSON.stringify(st.daemon, null, 2));
      }
      if (sub !== "route" || !["claude", "codex", "cursor"].includes(rest[0] ?? ""))
        die("proxy route claude|codex|cursor [--model <id>]");
      const query = buildQueryString({ provider: rest[0]!, model: str("model") || undefined });
      return console.log(JSON.stringify(await management(`/proxy/route?${query}`), null, 2));
    }
    case "tokens": {
      const days = ({ today: 0, "7d": 7, "30d": 30 } as Record<string, number>)[sub ?? "today"];
      if (days === undefined && sub !== "all") die("tokens [today|7d|30d|all]");
      const since = sub === "all" ? 0 : days ? Date.now() - days * 86400000 : new Date().setHours(0, 0, 0, 0);
      return console.log(JSON.stringify(await management(`/proxy/tokens?since=${since}`), null, 2));
    }
    case "requests": {
      if (sub && sub !== "export")
        return console.log(JSON.stringify(await management(`/requests/${encodeURIComponent(sub)}`), null, 2));
      const query = new URLSearchParams();
      for (const key of [
        "provider",
        "account",
        "model",
        "outcome",
        "failure",
        "search",
        "since",
        "until",
        "limit",
        "cursor",
      ])
        if (str(key)) query.set(key, str(key)!);
      if (sub !== "export") return console.log(JSON.stringify(await management(`/requests?${query}`), null, 2));
      query.set("limit", "100");
      for (let pages = 0; pages < 1000; pages++) {
        const page = await management<RequestPage>(`/requests?${query}`);
        for (const request of page.requests) console.log(JSON.stringify(await management(`/requests/${request.id}`)));
        if (!page.nextCursor) break;
        query.set("cursor", page.nextCursor);
      }
      return;
    }

    case "logins": {
      const lg = await import("../logins.ts");
      const id =
        rest[0] === undefined || sub === "identity"
          ? undefined
          : (loginIdSchema.safeParse(rest[0]).data ??
            die(`${rest[0]}: expected github, infisical, infisical-identity or opencode`));
      try {
        if (sub === "identity") {
          const usage =
            "logins identity --client-id <id> [--site https://eu.infisical.com] (the client secret comes from stdin)";
          const clientId = str("client-id") ?? die(usage);
          // From stdin so it stays out of shell history and process lists.
          const typed = () => {
            Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
            try {
              return prompt("Client secret:") ?? "";
            } finally {
              Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
              console.log();
            }
          };
          const clientSecret = (process.stdin.isTTY ? typed() : await Bun.stdin.text()).trim() || die(usage);
          const siteUrl = str("site") ?? lg.infisicalSite();
          await lg.setInfisicalIdentity(s, { clientId, clientSecret, siteUrl });
          return console.log(
            `Infisical machine identity ${clientId} set; every machine keeps it in ~/.infisical/universal-auth.json`,
          );
        }
        if (sub === "share") {
          for (const r of await lg.shareLogins(s, id)) {
            const account = r.account ? ` (${r.account})` : "";
            console.log(
              r.skipped
                ? `${r.id.padEnd(10)} not shared: ${r.skipped}`
                : `${r.id.padEnd(10)} shared${account}; every machine signs in with it`,
            );
          }
          return;
        }
        if (sub === "signin") {
          if (id !== "infisical") return die("logins signin infisical");
          const account = await lg.signInInfisical(s, { terminal: true });
          return console.log(`Infisical signed in as ${account} and shared; every machine signs in with it`);
        }
        if (sub === "forget") {
          lg.forgetLogin(s, id ?? die("logins forget github|infisical|infisical-identity|opencode"));
          return console.log(
            id === "infisical-identity"
              ? "ok; removed from every machine"
              : "ok; machines already signed in stay signed in",
          );
        }
      } catch (e) {
        return die(getErrorMessage(e));
      }
      if (sub !== undefined && sub !== "ls") return showHelp();

      const list = lg.listLogins(s);
      if (!list.length)
        return console.log(
          "No shared logins. Share this machine's gh and Infisical logins and OpenCode API keys with: agentgate logins share",
        );
      for (const l of list) {
        const broken = l.error ? undefined : l.problems.find((p) => p.node === s.nodeId)?.problem;
        const here = broken
          ? `not working here: ${broken}`
          : l.from === s.nodeId
            ? "shared from here"
            : l.signedIn
              ? "signed in here"
              : "not signed in here yet";
        console.log(
          `${l.id.padEnd(10)} ${(l.account || "-").padEnd(28)} from ${l.from.padEnd(12)} ${here}${l.error ? `: ${l.error}` : ""}`,
        );
        for (const p of l.problems.filter((p) => p.node !== s.nodeId))
          console.log(`${"".padEnd(10)} not working on ${p.node}: ${p.problem}`);
        if (l.id === "infisical" && l.problems.length)
          console.log(`${"".padEnd(10)} to fix, on a machine with a browser: agentgate logins signin infisical`);
      }
      return;
    }
  }
};
