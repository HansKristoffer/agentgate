/** Writes factory.schema.json, which editors use to check and complete a factory.yaml. Run after changing factory.ts. */
import { fileURLToPath } from "node:url";
import { factoryJsonSchema } from "../src/factory.ts";

const file = fileURLToPath(new URL("../factory.schema.json", import.meta.url));
await Bun.write(file, JSON.stringify(factoryJsonSchema()));
// Formatted the way CI checks it, so running this again leaves the committed file unchanged.
const fmt = Bun.spawnSync([process.execPath, "fmt", "--no-script", file], { timeout: 30_000, stdout: "ignore" });
if (fmt.exitCode !== 0) throw new Error(`bun fmt failed on ${file}`);
