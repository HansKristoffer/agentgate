import { expect, test } from "bun:test";
import { accountStatusSchema, type AccountStatus } from "@agentgate/protocol";
import { problems } from "@agentgate/protocol/attention";
import { attentionLines } from "../src/cli.ts";

const account = (id: string, state: object) =>
  accountStatusSchema.parse({
    account: { id, provider: "claude", label: id },
    windows: [],
    active: false,
    exhausted: false,
    needsLogin: false,
    expired: false,
    ...state,
  });
const node = (id: string, online: boolean, state: object) => ({
  id,
  online,
  alwaysOn: false,
  healthDashboard: false,
  lastSeen: 1,
  ...state,
});

test("needs attention lists what the user must fix and leaves out what clears on its own", () => {
  const found = problems({
    accounts: [
      account("signed-out", { needsLogin: true }),
      account("expired-here", { expired: true }),
      // Another machine holds this login and refreshes it, a reached limit resets, and disabling was a choice.
      account("other-holder", { expired: true, waitingFor: "server" }),
      account("full", { exhausted: true }),
      account("off", { account: { id: "off", provider: "claude", label: "off", enabled: false } }),
    ],
    servers: [
      {
        id: "posthog",
        label: "PostHog",
        template: "posthog",
        transport: "http",
        mode: "shared",
        endpoint: "",
        loggedIn: false,
        needsLogin: true,
        available: false,
      },
    ],
    skillHealth: { errors: [] },
    skillConflicts: [],
    skillRepos: [],
    fileErrors: {},
    nodes: [
      node("laptop", true, { version: "1.2.0" }),
      node("server", true, { version: "1.1.0", update: { state: "failed", error: "disk full", since: 1 } }),
      // Offline machines fail to sync until they are back.
      node("asleep", false, { version: "1.2.0", syncError: "unreachable" }),
    ],
    // A shared session expires on every machine at once; one row names them all, and signing in again fixes it.
    logins: [
      { id: "github", account: "octocat", from: "laptop", signedIn: true, problems: [] },
      {
        id: "infisical",
        account: "me@example.com",
        from: "laptop",
        signedIn: true,
        problems: [
          { node: "laptop", problem: "the Infisical session expired on 2026-10-27" },
          { node: "server", problem: "the Infisical session expired on 2026-10-27" },
        ],
      },
    ],
  });
  expect(found.map((p) => [p.page, p.title])).toEqual([
    ["accounts", "Sign in to signed-out again"],
    ["accounts", "Sign in to expired-here again"],
    ["servers", "Sign in to PostHog"],
    ["nodes", "1 machine on an older version"],
    ["nodes", "Update failed on server"],
    ["nodes", "The Infisical login doesn't work on laptop, server"],
  ]);
  expect(found.at(-1)).toMatchObject({
    detail: "me@example.com: the Infisical session expired on 2026-10-27",
    signIn: true,
  });
});

test("the daemon's state decides, so a login this machine refreshes asks for no sign-in", () => {
  const found = (accounts: AccountStatus[]) =>
    problems({
      accounts,
      servers: [],
      skillHealth: { errors: [] },
      skillConflicts: [],
      skillRepos: [],
      fileErrors: {},
      nodes: [],
      logins: [],
    }).map((p) => p.title);
  expect(found([account("expired-here", { expired: true, state: { kind: "refreshing" } })])).toEqual([]);
  // A kind from a newer daemon reads as absent, so the flags decide as they did before `state`.
  expect(found([account("newer", { expired: true, state: { kind: "hibernating" } })])).toEqual([
    "Sign in to newer again",
  ]);
});

test("agentgate status prints each problem on one line, and nothing when all is well", () => {
  const status = {
    accounts: [account("work", { refreshError: "invalid_grant" })],
    servers: [],
    skillHealth: { errors: [] },
    skillConflicts: [],
    skillRepos: [],
    fileErrors: {},
    nodes: [node("laptop", true, { version: "1.2.0" })],
    logins: [],
  };
  expect(attentionLines(status)).toEqual(["", "needs attention", "  work couldn't refresh its login: invalid_grant"]);
  expect(attentionLines({ ...status, accounts: [account("work", {})] })).toEqual([]);
});
