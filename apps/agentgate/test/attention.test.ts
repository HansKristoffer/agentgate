import { expect, test } from "bun:test";
import { accountStatusSchema } from "@agentgate/protocol";
import { problems } from "../../desktop/src/attention.ts";

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
  });
  expect(found.map((p) => [p.page, p.title])).toEqual([
    ["accounts", "Sign in to signed-out again"],
    ["accounts", "Sign in to expired-here again"],
    ["servers", "Sign in to PostHog"],
    ["nodes", "1 machine on an older version"],
    ["nodes", "Update failed on server"],
  ]);
});
