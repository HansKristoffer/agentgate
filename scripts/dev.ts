// `bun run dev`: this checkout's daemon from source plus the desktop app pointed at it. Both use the
// checkout's gitignored .agentgate and derived port (see store.ts), never the live install.
import { CONFIG_DIR, LOCAL_URL, PORT } from "../apps/agentgate/src/store.ts";

const root = new URL("..", import.meta.url).pathname;
const env = { ...process.env, AGENTGATE_HOME: CONFIG_DIR, AGENTGATE_PORT: String(PORT), AGENTGATE_DEV: "1" };
const cli = (...args: string[]) => Bun.spawn([process.execPath, "apps/agentgate/src/cli.ts", ...args], { cwd: root, env, stdio: ["inherit", "inherit", "inherit"] });

if (await cli("init", "--name", "dev").exited) process.exit(1);
console.log(`[dev] daemon ${LOCAL_URL}, state ${CONFIG_DIR}`);
const daemon = cli("serve");
const desktop = Bun.spawn([process.execPath, "run", "--filter", "@agentgate/desktop", "dev"], { cwd: root, env, stdio: ["inherit", "inherit", "inherit"] });
const stop = () => { daemon.kill(); desktop.kill(); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
await Promise.race([daemon.exited, desktop.exited]);
stop();
