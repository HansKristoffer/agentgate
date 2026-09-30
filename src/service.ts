import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, truncateSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./files.ts";
import { agentEnvironment, selfCommand } from "./setup.ts";
import { CONFIG_DIR } from "./store.ts";

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

export function service(action: string) {
  mkdirSync(LOGS, { recursive: true });
  switch (action) {
    case "install":
      if (mac) {
        mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
        atomicWrite(PLIST, plist());
        run(["launchctl", "bootout", `gui/${uid}/${LABEL}`]);
        return run(["launchctl", "bootstrap", `gui/${uid}`, PLIST]);
      }
      mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
      atomicWrite(UNIT, unit());
      if (run(["systemctl", "--user", "daemon-reload"]) !== 0) throw new Error("systemd reload failed");
      // Keeps the user service running with nobody logged in, and across reboots.
      if (run(["loginctl", "enable-linger", process.env.USER ?? ""]) !== 0) throw new Error("could not enable lingering; run loginctl enable-linger for this user, then retry");
      return run(["systemctl", "--user", "enable", "--now", "agentgate"]);
    case "start":
      return mac ? run(["launchctl", "bootstrap", `gui/${uid}`, PLIST]) : run(["systemctl", "--user", "start", "agentgate"]);
    case "stop":
      return mac ? run(["launchctl", "bootout", `gui/${uid}/${LABEL}`]) : run(["systemctl", "--user", "stop", "agentgate"]);
    case "logs":
      return mac ? run(["tail", "-n", "200", "-f", join(LOGS, "agentgate.log")]) : run(["journalctl", "--user", "-u", "agentgate", "-f"]);
    default:
      throw new Error("service install|start|stop|logs");
  }
}

/** Keep launchd's open log descriptor while bounding disk usage. Linux uses journald. */
export function rotateLogs(dir = LOGS, maxBytes = 5 * 1024 * 1024) {
  const file = join(dir, "agentgate.log");
  if (!existsSync(file) || statSync(file).size < maxBytes) return;
  for (let i = 4; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
  copyFileSync(file, `${file}.1`); truncateSync(file, 0);
}
