import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, truncateSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./files.ts";
import { agentEnvironment, selfCommand } from "./setup.ts";
import { CONFIG_DIR, liveOnly, LOCAL_URL } from "./store.ts";

const LABEL = "dev.agentgate";
const LOGS = join(CONFIG_DIR, "logs");
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const UNIT = join(homedir(), ".config", "systemd", "user", "agentgate.service");
const mac = process.platform === "darwin";
const uid = process.getuid?.() ?? 0;

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// The service gets the PATH of the shell that installed it, so stdio MCP servers find npx/uvx.
export function plist() {
  const args = [...selfCommand(), "serve"].map((a) => `<string>${xml(a)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args}</array>
  <key>EnvironmentVariables</key><dict>${Object.entries({ PATH: process.env.PATH ?? "", ...agentEnvironment() }).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(LOGS)}/agentgate.log</string>
  <key>StandardErrorPath</key><string>${xml(LOGS)}/agentgate.log</string>
</dict></plist>
`;
}

export function unit(command = selfCommand(), environment = { PATH: process.env.PATH ?? "", ...agentEnvironment() }) {
  const systemd = (s: string) => JSON.stringify(s).replace(/%/g, "%%").replace(/\$/g, () => "$$");
  const exec = [...command, "serve"].map(systemd).join(" ");
  return `[Unit]
Description=agentgate
After=network-online.target

[Service]
ExecStart=${exec}
${Object.entries(environment).map(([key, value]) => `Environment=${JSON.stringify(`${key}=${value}`).replace(/%/g, "%%")}`).join("\n")}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
}

const run = (cmd: string[]) => Bun.spawnSync(cmd, { stdio: ["inherit", "inherit", "inherit"] }).exitCode;

/** launchctl/systemctl can accept a job that subsequently fails to start. */
export async function waitForService(url = `${LOCAL_URL}/api/status`, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))), redirect: "error" });
      await response.body?.cancel();
      if (response.ok) return;
    } catch { /* The listener may not have started yet. */ }
    const remaining = deadline - Date.now();
    if (remaining > 0) await Bun.sleep(Math.min(100, remaining));
  }
  throw new Error(`agentgate did not become ready at ${url}; check ${mac ? join(LOGS, "agentgate.log") : "journalctl --user -u agentgate"}. Claude/Codex cannot connect until the daemon is running.`);
}

/** launchd can still be tearing the old job down right after bootout; bootstrap then fails with EIO. */
async function bootstrap() {
  for (let attempt = 1; ; attempt++) {
    const cmd = ["launchctl", "bootstrap", `gui/${uid}`, PLIST];
    // Only the final attempt's error is worth showing; earlier ones are the expected teardown race.
    if (attempt === 5) return run(cmd);
    if (Bun.spawnSync(cmd, { stdio: ["inherit", "ignore", "ignore"] }).exitCode === 0) return 0;
    await Bun.sleep(1000);
  }
}

export async function service(action: string) {
  if (action !== "logs") liveOnly(`agentgate service ${action}`);
  mkdirSync(LOGS, { recursive: true });
  // Whatever launchctl/systemctl said, only a reachable daemon counts: until then Claude/Codex get ECONNREFUSED.
  const ready = async (_code: number) => {
    await waitForService();
    console.log(`agentgate is running at ${LOCAL_URL}`);
    return 0;
  };
  switch (action) {
    case "install":
      if (mac) {
        mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
        atomicWrite(PLIST, plist());
        // Fails harmlessly ("No such process") on a first install.
        Bun.spawnSync(["launchctl", "bootout", `gui/${uid}/${LABEL}`], { stdio: ["ignore", "ignore", "ignore"] });
        return ready(await bootstrap());
      }
      mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
      atomicWrite(UNIT, unit());
      if (run(["systemctl", "--user", "daemon-reload"]) !== 0) throw new Error("systemd reload failed");
      // Keeps the user service running with nobody logged in, and across reboots.
      if (run(["loginctl", "enable-linger", process.env.USER ?? ""]) !== 0) throw new Error("could not enable lingering; run loginctl enable-linger for this user, then retry");
      if (run(["systemctl", "--user", "enable", "agentgate"]) !== 0) throw new Error("systemd enable failed");
      // Reinstalling must apply the new executable/environment to an already running service.
      return ready(run(["systemctl", "--user", "restart", "agentgate"]));
    case "start":
      return ready(mac ? await bootstrap() : run(["systemctl", "--user", "start", "agentgate"]));
    case "restart":
      return ready(mac ? run(["launchctl", "kickstart", "-k", `gui/${uid}/${LABEL}`]) : run(["systemctl", "--user", "restart", "agentgate"]));
    case "stop":
      return mac ? run(["launchctl", "bootout", `gui/${uid}/${LABEL}`]) : run(["systemctl", "--user", "stop", "agentgate"]);
    case "logs":
      return mac ? run(["tail", "-n", "200", "-f", join(LOGS, "agentgate.log")]) : run(["journalctl", "--user", "-u", "agentgate", "-f"]);
    default:
      throw new Error("service install|start|restart|stop|logs");
  }
}

/** Whether the installed service runs the binary at `path`. */
export function serviceRuns(path: string) {
  const file = mac ? PLIST : UNIT;
  return existsSync(file) && readFileSync(file, "utf8").includes(mac ? xml(path) : path);
}

/** Keep launchd's open log descriptor while bounding disk usage. Linux uses journald. */
export function rotateLogs(dir = LOGS, maxBytes = 5 * 1024 * 1024) {
  const file = join(dir, "agentgate.log");
  if (!existsSync(file) || statSync(file).size < maxBytes) return;
  for (let i = 4; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
  copyFileSync(file, `${file}.1`); truncateSync(file, 0);
}
