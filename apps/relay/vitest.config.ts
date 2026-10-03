import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Runs workers/*.worker.ts inside workerd against real SQLite-backed Durable Objects.
export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.toml" },
    miniflare: { bindings: { RELAY_GROUPS_PER_IP_PER_DAY: "3", RELAY_MAX_GROUPS: "6", RELAY_GROUP_MAX_BYTES: "200000" } },
  })],
  test: { include: ["workers/**/*.worker.ts"] },
});
