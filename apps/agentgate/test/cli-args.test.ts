import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseFor } from "../src/cli.ts";
import { terminalOpFor } from "../src/ops/index.ts";

const words = (line: string) => line.match(/"[^"]*"|\S+/g)!.map((w) => w.replace(/^"|"$/g, ""));

describe("parseFor", () => {
  test("a misspelt --no-secrets is rejected instead of exporting secrets", () => {
    expect(() => parseFor(["export", "--no-secret"])).toThrow('Unknown option --no-secret for "agentgate export"');
    expect(parseFor(["export", "--no-secrets"]).values["no-secrets"]).toBe(true);
  });

  test("a string option followed by another flag has no value", () => {
    expect(() => parseFor(words("init --name --always-on"))).toThrow('--name needs a value for "agentgate init"');
    expect(() => parseFor(words("init --name"))).toThrow("--name needs a value");
    expect(parseFor(words("init --name=-srv")).values.name).toBe("-srv");
  });

  test("an option another command reads is unknown here", () => {
    expect(() => parseFor(words("export --force"))).toThrow('Unknown option --force for "agentgate export"');
    expect(() => parseFor(words("init --always-on=yes"))).toThrow("--always-on takes no value");
  });

  test("factory passes its words through untouched", () => {
    expect(parseFor(words("factory use --store agentgate"))).toEqual({ values: {}, positionals: ["factory"] });
  });

  // From README.md and docs/user, plus one use of every option the CLI read before options became per command.
  test.each([
    "init --always-on --name srv",
    "login claude --label work",
    "accounts verify account-a --probe --model claude-sonnet-4-5",
    "settings set --file /absolute/path/patch.json",
    "proxy route claude --model claude-sonnet-4-5",
    "requests --provider claude --outcome failed",
    "requests export --provider codex --account a --model m --failure f --search s --since 1 --until 2 --limit 5 --cursor c",
    'mcp add posthog-lullu posthog --header "x-posthog-project-id: 12345" --header "b: c"',
    'mcp add mytool --command "npx -y @some/mcp-server" --per-session',
    "mcp instructions railway --hide",
    "mcp limit railway 10000 --tool get-logs",
    "skills add vercel-labs/agent-skills --skill web-design-guidelines --project Lullu-ai/lullu --project *",
    "skills new release-notes --file SKILL.md",
    "project files set .env.local --if-sha abc",
    "remote enable @grok --node srv",
    "pair --name srv --tailnet",
    "pair --relay --relay-url https://relay.example",
    "join agr1.x --force",
    "dashboard on --node srv",
    "relay leave --wipe",
    "relay cleanup --abandon",
    "relay key --clear",
    "logins identity --client-id id --site https://infisical.example",
    "t3 connect --url http://t3.example --token t --node srv",
    "t3 pair --tailscale --node srv",
    "t3 dirs --worktrees ~/w --clones ~/c",
    "threads --node srv",
    "handoff thread-1 --to here --no-wait",
    "handoffs cancel h-1 --node srv",
    "setup --primary off --node srv",
    "setup --mcp off",
    "service install --no-routing",
    "status -h",
    "--help",
  ])("%s", (line) => {
    const argv = words(line);
    // A registered operation parses its own words, as main() does.
    const op = terminalOpFor(argv);
    const read = () => (op ? op.terminal.parse(argv.slice(op.name.split(" ").length), undefined, "/") : parseFor(argv));
    expect(read).not.toThrow();
  });
});

test("an unknown option exits with code 2 and names it", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "export", "--no-secret"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(2);
  expect(await new Response(child.stdout).text()).toBe("");
  expect(await new Response(child.stderr).text()).toContain("Unknown option --no-secret");
});
