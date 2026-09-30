import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { selfCommand } from "./setup.ts";
import { CONFIG_DIR } from "./store.ts";

const LABEL = "dev.agentgate";
const LOGS = join(CONFIG_DIR, "logs");
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const UNIT = join(homedir(), ".config", "systemd", "user", "agentgate.service");
const mac = process.platform === "darwin";
const uid = process.getuid?.() ?? 0;

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// The service gets the PATH of the shell that installed it, so stdio MCP servers find npx/uvx.
function plist() {
  const args = [...selfCommand(), "serve"].map((a) => `<string>${xml(a)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args}</array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? "")}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOGS}/agentgate.log</string>
  <key>StandardErrorPath</key><string>${LOGS}/agentgate.log</string>
</dict></plist>
`;
}

function unit() {
  const exec = [...selfCommand(), "serve"].map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");
  return `[Unit]
Description=agentgate
After=network-online.target

[Service]
ExecStart=${exec}
Environment=PATH=${process.env.PATH ?? ""}
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
        writeFileSync(PLIST, plist());
        run(["launchctl", "bootout", `gui/${uid}/${LABEL}`]);
        return run(["launchctl", "bootstrap", `gui/${uid}`, PLIST]);
      }
      mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
      writeFileSync(UNIT, unit());
      run(["systemctl", "--user", "daemon-reload"]);
      // Keeps the user service running with nobody logged in, and across reboots.
      run(["loginctl", "enable-linger", process.env.USER ?? ""]);
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
